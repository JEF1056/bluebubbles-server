import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";
import { Socket } from "socket.io";
import {
    MediaStreamTrack,
    RTCIceCandidate,
    RTCIceServer,
    RTCPeerConnection,
    RTCRtpCodecParameters,
    RTCRtpTransceiver,
    RtpHeader,
    RtpPacket,
    useAbsSendTime,
    useFIR,
    useH264,
    useOPUS,
    usePLI,
    useREMB,
    useTWCC,
    useTransportWideCC
} from "werift";
import { ensureAbortSignalAny } from "../../../lib/abortSignalPolyfill";
import { Server } from "@server";

ensureAbortSignalAny();
import { FileSystem } from "@server/fileSystem";
import { Loggable } from "@server/lib/logging/Loggable";
import { setCameraHookActiveFlag } from "./FaceTimeCameraHook";
import { FaceTimeAdaptiveController } from "./FaceTimeAdaptiveController";

const FACETIME_STATUS_OUTGOING = 3;
let sessionManagerModule: typeof import("./FacetimeSessionManager") | null = null;
try {
    sessionManagerModule = require("./FacetimeSessionManager");
} catch {
    sessionManagerModule = null;
}
function getFaceTimeSessionStatus(callUuid: string): number | null {
    try {
        sessionManagerModule ??= require("./FacetimeSessionManager");
        const ftSession = sessionManagerModule.FaceTimeSessionManager().findSession(callUuid);
        return ftSession ? ftSession.status : null;
    } catch {
        return null;
    }
}

const DEFAULT_ORPHAN_TIMEOUT_MS = 120_000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RESPAWN_BASE_DELAY_MS = 1_000;
const MAX_RESPAWN_RETRIES = 3;
const OPUS_PAYLOAD_TYPE = 111;
const OPUS_SAMPLES_PER_FRAME = 960; // 20ms @ 48kHz
const H264_PAYLOAD_TYPE = 96;
const H264_FRAME_DURATION_90KHZ = 3_000; // initial 30fps @ 90kHz fallback
const H264_MIN_FRAME_DURATION_90KHZ = 900;
const H264_MAX_FRAME_DURATION_90KHZ = 18_000;
const H264_MAX_RTP_PAYLOAD = 1200;
const MAX_VIDEO_FRAME_BYTES = 4 * 1024 * 1024;
const ANNEX_B_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const PLI_INTERVAL_MS = 2_000;
const PLI_GAP_COOLDOWN_MS = 500;
const ADAPT_TICK_INTERVAL_MS = 500;

const H264_PROFILE_LEVEL_PREFERENCE = [
    "640032",
    "64002a",
    "640028",
    "4d002a",
    "4d0028",
    "42e02a",
    "42e028",
    "42e01f"
] as const;

export type BridgeSignalPayload = {
    callUuid: string;
    sdp?: string;
    type?: "offer" | "answer";
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    muted?: boolean;
    answerCall?: boolean;
    video?: boolean;
    uplinkVideo?: boolean;
    enabled?: boolean;
    voiceIsolation?: boolean;
};

export function getAdditionalIceHostAddresses(): string[] {
    const addrs = new Set<string>();
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
        if (!entries) continue;
        for (const info of entries) {
            const isIpv4 = info.family === "IPv4" || (info.family as unknown) === 4;
            if (!isIpv4 || info.internal) continue;
            if (!info.address || info.address.startsWith("169.254.")) continue;
            addrs.add(info.address);
        }
    }
    return Array.from(addrs);
}

export function summarizeIceCandidateSdp(candidate?: string): string {
    if (!candidate) return "unknown";
    const parts = candidate.trim().split(/\s+/);
    const ip = parts[4] ?? "?";
    const port = parts[5] ?? "?";
    const typIdx = parts.indexOf("typ");
    const type = typIdx >= 0 ? (parts[typIdx + 1] ?? "?") : "?";
    return `${type} ${ip}:${port}`;
}

function h264CodecRank(codec: RTCRtpCodecParameters): number {
    if (codec.mimeType.toLowerCase() !== "video/h264") return 10_000;
    const params = codec.parameters ?? "";
    const match = /profile-level-id=([0-9a-f]{6})/i.exec(params);
    if (!match) return 5_000;
    const profileLevel = match[1].toLowerCase();
    const explicitIdx = (H264_PROFILE_LEVEL_PREFERENCE as readonly string[]).indexOf(profileLevel);
    if (explicitIdx >= 0) return explicitIdx;

    // Fallback ordering for vendor-specific IOP bytes (e.g., 640c2a): Level >= 4.0 first, higher profile first.
    const profileIdc = parseInt(profileLevel.slice(0, 2), 16);
    const levelIdc = parseInt(profileLevel.slice(4, 6), 16);
    const packetModePenalty = /packetization-mode=0\b/.test(params) ? 500 : 0;
    return 100 + packetModePenalty + (255 - levelIdc) * 4 + (profileIdc === 0x64 ? 0 : profileIdc === 0x4d ? 1 : 2);
}

export function sortPreferredVideoCodecs(codecs: readonly RTCRtpCodecParameters[]): RTCRtpCodecParameters[] {
    const primaries: RTCRtpCodecParameters[] = [];
    const rtxByApt = new Map<number, RTCRtpCodecParameters[]>();
    const otherAux: RTCRtpCodecParameters[] = [];

    for (const codec of codecs) {
        const mime = codec.mimeType.toLowerCase();
        if (mime === "video/rtx") {
            const aptMatch = /\bapt=(\d+)\b/.exec(codec.parameters ?? "");
            if (aptMatch) {
                const apt = Number(aptMatch[1]);
                const list = rtxByApt.get(apt) ?? [];
                list.push(codec);
                rtxByApt.set(apt, list);
                continue;
            }
            otherAux.push(codec);
            continue;
        }
        primaries.push(codec);
    }

    primaries.sort((a, b) => h264CodecRank(a) - h264CodecRank(b));

    const ordered: RTCRtpCodecParameters[] = [];
    for (const primary of primaries) {
        ordered.push(primary);
        const rtxList = rtxByApt.get(primary.payloadType);
        if (rtxList) ordered.push(...rtxList);
    }
    ordered.push(...otherAux);
    return ordered;
}

/** Split an Annex-B H.264 access unit into raw NALUs (without 3/4-byte start codes). */
export function splitAnnexBNalus(accessUnit: Buffer): Buffer[] {
    const nalus: Buffer[] = [];
    const len = accessUnit.length;
    if (len === 0) return nalus;

    let i = 0;
    let naluStart = -1;
    while (i < len) {
        let startCodeLen = 0;
        if (
            i + 3 < len &&
            accessUnit[i] === 0 &&
            accessUnit[i + 1] === 0 &&
            accessUnit[i + 2] === 0 &&
            accessUnit[i + 3] === 1
        ) {
            startCodeLen = 4;
        } else if (i + 2 < len && accessUnit[i] === 0 && accessUnit[i + 1] === 0 && accessUnit[i + 2] === 1) {
            startCodeLen = 3;
        }

        if (startCodeLen > 0) {
            if (naluStart >= 0 && i > naluStart) {
                nalus.push(accessUnit.subarray(naluStart, i));
            }
            i += startCodeLen;
            naluStart = i;
        } else {
            i += 1;
        }
    }

    if (naluStart >= 0 && naluStart < len) {
        nalus.push(accessUnit.subarray(naluStart));
    } else if (naluStart < 0) {
        nalus.push(accessUnit);
    }

    return nalus;
}

/** Packetize H.264 NALUs for a single access unit into RFC 6184 Single-NALU / FU-A RTP packets. */
export function packetizeH264Nalus(
    nalus: Buffer[],
    options: {
        payloadType: number;
        ssrc: number;
        timestamp: number;
        startSeq: number;
        maxPayloadSize?: number;
    }
): { packets: RtpPacket[]; nextSeq: number } {
    const maxPayloadSize = options.maxPayloadSize ?? H264_MAX_RTP_PAYLOAD;
    const nonEmpty = nalus.filter(n => n.length > 0);
    const packets: RtpPacket[] = [];
    let seq = options.startSeq & 0xffff;

    for (let i = 0; i < nonEmpty.length; i++) {
        const nalu = nonEmpty[i];
        const isLastNalu = i === nonEmpty.length - 1;

        if (nalu.length <= maxPayloadSize) {
            seq = (seq + 1) & 0xffff;
            const header = new RtpHeader({
                payloadType: options.payloadType,
                sequenceNumber: seq,
                timestamp: options.timestamp,
                ssrc: options.ssrc,
                marker: isLastNalu
            });
            packets.push(new RtpPacket(header, nalu));
            continue;
        }

        // FU-A fragmentation (RFC 6184 §5.8)
        const nalHeader = nalu[0];
        const fuIndicator = (nalHeader & 0xe0) | 28;
        const nalType = nalHeader & 0x1f;
        const maxFragmentPayload = Math.max(1, maxPayloadSize - 2);

        for (let offset = 1; offset < nalu.length; offset += maxFragmentPayload) {
            const end = Math.min(offset + maxFragmentPayload, nalu.length);
            const isStart = offset === 1;
            const isEnd = end >= nalu.length;
            const fuHeader = (isStart ? 0x80 : 0) | (isEnd ? 0x40 : 0) | nalType;

            const payload = Buffer.allocUnsafe(2 + (end - offset));
            payload[0] = fuIndicator;
            payload[1] = fuHeader;
            nalu.copy(payload, 2, offset, end);

            seq = (seq + 1) & 0xffff;
            const header = new RtpHeader({
                payloadType: options.payloadType,
                sequenceNumber: seq,
                timestamp: options.timestamp,
                ssrc: options.ssrc,
                marker: isLastNalu && isEnd
            });
            packets.push(new RtpPacket(header, payload));
        }
    }

    return { packets, nextSeq: seq };
}

/** Reassembles RFC 6184 H.264 RTP packets (Single NALU, STAP-A, FU-A) into Annex-B access units. */
export class H264RtpDepacketizer {
    private lastSeq: number | null = null;
    private currentTimestamp: number | null = null;
    private pendingNalus: Buffer[] = [];
    private pendingBytes = 0;
    private sawIdr = false;
    private fuChunks: Buffer[] = [];
    private fuBytes = 0;
    private fuActive = false;
    private fuNalType = 0;
    private needIdr = false;

    constructor(
        private readonly onAccessUnit: (accessUnit: Buffer, info: { isIdr: boolean }) => void,
        private readonly onSeqGap?: () => void
    ) {}

    reset(needIdr = false): void {
        this.lastSeq = null;
        this.discardPending();
        this.needIdr = needIdr;
    }

    private discardPending(): void {
        this.currentTimestamp = null;
        this.pendingNalus = [];
        this.pendingBytes = 0;
        this.sawIdr = false;
        this.clearFu();
    }

    pushPacket(rtp: RtpPacket): void {
        const payload = rtp.payload;
        const seq = rtp.header.sequenceNumber & 0xffff;

        if (this.lastSeq !== null) {
            const expected = (this.lastSeq + 1) & 0xffff;
            if (((seq - expected) & 0xffff) >= 0x8000) {
                return;
            }
            if (seq !== expected) {
                this.discardPending();
                this.needIdr = true;
                this.onSeqGap?.();
            }
        }
        this.lastSeq = seq;

        if (!payload || payload.length === 0) return;

        const timestamp = rtp.header.timestamp >>> 0;

        if (this.currentTimestamp !== null && timestamp !== this.currentTimestamp) {
            this.clearFu();
            this.flush();
        }
        this.currentTimestamp = timestamp;

        const nalHeader = payload[0];
        const nalType = nalHeader & 0x1f;

        if (nalType >= 1 && nalType <= 23) {
            this.clearFu();
            this.pushPendingNalu(payload, nalType === 5);
        } else if (nalType === 24) {
            // STAP-A
            this.clearFu();
            let offset = 1;
            while (offset + 2 <= payload.length) {
                const naluSize = payload.readUInt16BE(offset);
                offset += 2;
                if (naluSize === 0 || offset + naluSize > payload.length) break;
                const nalu = payload.subarray(offset, offset + naluSize);
                offset += naluSize;
                if (!this.pushPendingNalu(nalu, (nalu[0] & 0x1f) === 5)) break;
            }
        } else if (nalType === 28 && payload.length >= 2) {
            // FU-A
            const fuHeader = payload[1];
            const startBit = (fuHeader & 0x80) !== 0;
            const endBit = (fuHeader & 0x40) !== 0;
            const origNalType = fuHeader & 0x1f;
            const fragment = payload.subarray(2);

            if (startBit) {
                this.clearFu();
                if (1 + fragment.length <= MAX_VIDEO_FRAME_BYTES) {
                    const reconstructedHeader = (nalHeader & 0xe0) | origNalType;
                    this.fuChunks = [Buffer.from([reconstructedHeader]), fragment];
                    this.fuBytes = 1 + fragment.length;
                    this.fuActive = true;
                    this.fuNalType = origNalType;
                }
            } else if (this.fuActive) {
                if (this.fuBytes + fragment.length > MAX_VIDEO_FRAME_BYTES) {
                    this.clearFu();
                } else {
                    this.fuChunks.push(fragment);
                    this.fuBytes += fragment.length;
                }
            }

            if (endBit && this.fuActive) {
                const assembled = Buffer.concat(this.fuChunks, this.fuBytes);
                const isIdr = this.fuNalType === 5;
                this.clearFu();
                this.pushPendingNalu(assembled, isIdr);
            }
        }

        if (rtp.header.marker) {
            this.flush();
        }
    }

    private pushPendingNalu(nalu: Buffer, isIdr: boolean): boolean {
        const nextBytes = this.pendingBytes + ANNEX_B_START_CODE.length + nalu.length;
        if (nextBytes > MAX_VIDEO_FRAME_BYTES) {
            this.pendingNalus = [];
            this.pendingBytes = 0;
            this.sawIdr = false;
            return false;
        }
        this.pendingNalus.push(nalu);
        this.pendingBytes = nextBytes;
        if (isIdr) this.sawIdr = true;
        return true;
    }

    private clearFu(): void {
        this.fuChunks = [];
        this.fuBytes = 0;
        this.fuActive = false;
        this.fuNalType = 0;
    }

    private flush(): void {
        if (this.pendingNalus.length === 0) return;
        const isIdr = this.sawIdr;
        if (this.needIdr && !isIdr) {
            this.pendingNalus = [];
            this.pendingBytes = 0;
            this.sawIdr = false;
            return;
        }
        const parts: Buffer[] = [];
        let totalBytes = 0;
        for (const nalu of this.pendingNalus) {
            totalBytes += ANNEX_B_START_CODE.length + nalu.length;
            if (totalBytes > MAX_VIDEO_FRAME_BYTES) {
                this.pendingNalus = [];
                this.pendingBytes = 0;
                this.sawIdr = false;
                return;
            }
            parts.push(ANNEX_B_START_CODE, nalu);
        }
        this.needIdr = false;
        this.pendingNalus = [];
        this.pendingBytes = 0;
        this.sawIdr = false;
        this.onAccessUnit(Buffer.concat(parts, totalBytes), { isIdr });
    }
}

type HelperKind = "audio" | "video" | "camera";

type BridgeSession = {
    callUuid: string;
    closed: boolean;
    pc: RTCPeerConnection;
    outboundTrack: MediaStreamTrack;
    outboundVideoTrack?: MediaStreamTrack;
    videoTransceiver?: RTCRtpTransceiver;
    videoNegotiated?: boolean;
    videoBin?: string;
    cameraBin?: string;
    process?: ChildProcess;
    videoProcess?: ChildProcess;
    cameraProcess?: ChildProcess;
    audioRestartAttempts: number;
    videoRestartAttempts: number;
    cameraRestartAttempts: number;
    audioRestartTimer?: NodeJS.Timeout;
    videoRestartTimer?: NodeJS.Timeout;
    cameraRestartTimer?: NodeJS.Timeout;
    socketId?: string;
    orphanTimer?: NodeJS.Timeout;
    muted: boolean;
    voiceIsolation: boolean;
    audioAnsweredSent?: boolean;
    uplinkRtpPackets: number;
    uplinkRtpBytes: number;
    downlinkOpusFrames: number;
    audioStatsTimer?: NodeJS.Timeout;
    cameraEnabled: boolean;
    cameraBackpressured: boolean;
    depacketizer?: H264RtpDepacketizer;
    uplinkVideoSsrc?: number;
    receivedFirstIdr: boolean;
    pliTimer?: NodeJS.Timeout;
    lastPliSentAt: number;
    adaptiveController?: FaceTimeAdaptiveController;
    adaptTimer?: NodeJS.Timeout;
    lastDownlinkVideoFrameAtMs?: number;
    rtpSeq: number;
    rtpTimestamp: number;
    ssrc: number;
    stdoutBuffer: Buffer;
    videoRtpSeq: number;
    videoRtpTimestamp: number;
    videoSsrc: number;
    videoPayloadType: number;
    videoStdoutBuffer: Buffer;
};

export class FaceTimeAudioBridge extends Loggable {
    tag = "FaceTimeAudioBridge";

    private static instance: FaceTimeAudioBridge | null = null;

    sessions: Map<string, BridgeSession> = new Map();

    orphanTimeoutMs: number = DEFAULT_ORPHAN_TIMEOUT_MS;

    disconnectTimeoutMs: number = DEFAULT_DISCONNECT_TIMEOUT_MS;

    respawnBaseDelayMs: number = DEFAULT_RESPAWN_BASE_DELAY_MS;

    maxRespawnRetries: number = MAX_RESPAWN_RETRIES;

    private stoppedProcesses = new WeakSet<ChildProcess>();

    static getInstance(): FaceTimeAudioBridge {
        if (!FaceTimeAudioBridge.instance) {
            FaceTimeAudioBridge.instance = new FaceTimeAudioBridge();
        }
        return FaceTimeAudioBridge.instance;
    }

    static getIceServers(): RTCIceServer[] {
        const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
        const turnUrls = (process.env.BB_FACETIME_TURN_URLS ?? "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
        const username = process.env.BB_FACETIME_TURN_USERNAME?.trim() || undefined;
        const credential = process.env.BB_FACETIME_TURN_CREDENTIAL?.trim() || undefined;
        for (const urls of turnUrls) {
            const entry: RTCIceServer = { urls };
            if (username) entry.username = username;
            if (credential) entry.credential = credential;
            servers.push(entry);
        }
        return servers;
    }

    static resolveToolBinary(binaryName: string): string | null {
        const candidates = [
            path.join(FileSystem.resources, "macos", "tools", binaryName),
            path.resolve(__dirname, "../../../../../../appResources/macos/tools", binaryName),
            path.resolve(process.cwd(), "appResources/macos/tools", binaryName)
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    static resolveHelperBinary(): string | null {
        return FaceTimeAudioBridge.resolveToolBinary("BlueBubblesAudioBridge");
    }

    static resolveVideoHelperBinary(): string | null {
        return FaceTimeAudioBridge.resolveToolBinary("BlueBubblesVideoBridge");
    }

    static isVideoSupported(): boolean {
        return FaceTimeAudioBridge.resolveVideoHelperBinary() !== null;
    }

    static resolveCameraHelperBinary(): string | null {
        return FaceTimeAudioBridge.resolveToolBinary("BlueBubblesCameraBridge");
    }

    static isVideoUplinkSupported(): boolean {
        return FaceTimeAudioBridge.resolveCameraHelperBinary() !== null;
    }

    async handleOffer(socket: Socket, payload: BridgeSignalPayload): Promise<void> {
        const callUuid = payload?.callUuid;
        if (!callUuid || !payload?.sdp) return;

        this.cleanupSession(callUuid);

        const wantsVideo = Boolean(payload.video) || /^m=video\b/m.test(payload.sdp);
        const wantsUplinkVideo = wantsVideo && Boolean(payload.uplinkVideo);
        const videoBin = wantsVideo ? FaceTimeAudioBridge.resolveVideoHelperBinary() : null;
        const cameraBin = wantsUplinkVideo ? FaceTimeAudioBridge.resolveCameraHelperBinary() : null;
        if (wantsVideo && !videoBin) {
            this.log.warn("BlueBubblesVideoBridge binary not found; degrading downlink video");
        }
        if (wantsUplinkVideo && !cameraBin) {
            this.log.warn("BlueBubblesCameraBridge binary not found; degrading uplink video");
        }
        const enableVideo = Boolean(wantsVideo && (videoBin || cameraBin));
        const enableUplinkVideo = Boolean(wantsUplinkVideo && cameraBin);
        if (enableUplinkVideo) {
            setCameraHookActiveFlag(true);
        }

        const iceServers = FaceTimeAudioBridge.getIceServers();
        const codecs: { audio: RTCRtpCodecParameters[]; video?: RTCRtpCodecParameters[] } = {
            audio: [
                useOPUS({
                    payloadType: OPUS_PAYLOAD_TYPE,
                    parameters: "minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=64000;stereo=0"
                })
            ]
        };
        if (enableVideo) {
            const videoFeedback = [{ type: "nack" }, usePLI(), useFIR(), useREMB(), useTWCC()];
            codecs.video = H264_PROFILE_LEVEL_PREFERENCE.map((profileLevelId, idx) =>
                useH264({
                    payloadType: H264_PAYLOAD_TYPE + idx,
                    parameters: `profile-level-id=${profileLevelId};packetization-mode=1;level-asymmetry-allowed=1`,
                    rtcpFeedback: videoFeedback
                })
            );
        }

        const additionalHostAddresses = getAdditionalIceHostAddresses();
        const pc = new RTCPeerConnection({
            iceServers,
            ...(additionalHostAddresses.length > 0 ? { iceAdditionalHostAddresses: additionalHostAddresses } : {}),
            codecs,
            bandwidthEstimator: "gcc",
            ...(enableVideo
                ? {
                      headerExtensions: {
                          video: [useTransportWideCC(), useAbsSendTime()]
                      }
                  }
                : {})
        });

        const outboundTrack = new MediaStreamTrack({ kind: "audio" });
        const transceiver = pc.addTransceiver(outboundTrack, { direction: "sendrecv" });

        let outboundVideoTrack: MediaStreamTrack | undefined;
        let videoTransceiver: RTCRtpTransceiver | undefined;
        if (enableVideo) {
            const videoDirection = videoBin && enableUplinkVideo ? "sendrecv" : videoBin ? "sendonly" : "recvonly";
            outboundVideoTrack = videoBin ? new MediaStreamTrack({ kind: "video" }) : undefined;
            videoTransceiver = pc.addTransceiver(outboundVideoTrack ?? "video", { direction: videoDirection });
        }

        const session: BridgeSession = {
            callUuid,
            closed: false,
            pc,
            outboundTrack,
            outboundVideoTrack,
            videoTransceiver,
            audioRestartAttempts: 0,
            videoRestartAttempts: 0,
            cameraRestartAttempts: 0,
            socketId: socket.id,
            muted: false,
            voiceIsolation: payload.voiceIsolation ?? true,
            uplinkRtpPackets: 0,
            uplinkRtpBytes: 0,
            downlinkOpusFrames: 0,
            cameraEnabled: enableUplinkVideo,
            cameraBackpressured: false,
            receivedFirstIdr: false,
            lastPliSentAt: 0,
            rtpSeq: 0,
            rtpTimestamp: 0,
            ssrc: Math.floor(Math.random() * 0xffffffff),
            stdoutBuffer: Buffer.alloc(0),
            videoRtpSeq: 0,
            videoRtpTimestamp: 0,
            videoSsrc: Math.floor(Math.random() * 0xffffffff),
            videoPayloadType: H264_PAYLOAD_TYPE,
            videoStdoutBuffer: Buffer.alloc(0)
        };
        this.sessions.set(callUuid, session);
        this.armOrphanTimer(session);

        pc.onIceCandidate.subscribe(candidate => {
            if (!candidate) return;
            this.log.info(`FaceTime bridge local ICE (${callUuid}): ${summarizeIceCandidateSdp(candidate.candidate)}`);
            socket.emit("ft-bridge-ice", {
                callUuid,
                candidate: candidate.candidate,
                sdpMid: candidate.sdpMid ?? null,
                sdpMLineIndex: candidate.sdpMLineIndex ?? null
            });
        });

        const subscribedAudioTracks = new Set<MediaStreamTrack>();
        const subscribeAudioTrack = (track: MediaStreamTrack | undefined) => {
            if (!track || subscribedAudioTracks.has(track)) return;
            subscribedAudioTracks.add(track);
            this.log.info(`FaceTime bridge subscribed to uplink audio track for ${callUuid} (ssrc=${track.ssrc ?? "unknown"})`);
            track.onReceiveRtp.subscribe(rtp => {
                this.writeUplinkOpusFrame(session, rtp.payload);
            });
        };
        // Subscribe via onTrack because receiver.track before setRemoteDescription is a placeholder defaultTrack.
        transceiver.onTrack.subscribe(track => {
            subscribeAudioTrack(track);
        });

        pc.connectionStateChange.subscribe(state => {
            if (this.sessions.get(callUuid) !== session) return;
            this.log.info(`FaceTime bridge connectionState=${state} for ${callUuid}`);
            if (state === "connected") {
                this.clearOrphanTimer(session);
            } else if (state === "disconnected") {
                this.armOrphanTimer(session, this.disconnectTimeoutMs);
            } else if (state === "failed" || state === "closed") {
                this.cleanupSession(callUuid);
            }
        });

        pc.iceConnectionStateChange?.subscribe(state => {
            if (this.sessions.get(callUuid) !== session) return;
            this.log.info(`FaceTime bridge iceConnectionState=${state} for ${callUuid}`);
        });

        let answer;
        try {
            await pc.setRemoteDescription({ sdp: payload.sdp, type: payload.type ?? "offer" });
            for (const track of transceiver.receiver.tracks) {
                subscribeAudioTrack(track);
            }
            const opusCodec = transceiver.codecs.find(c => c.mimeType.toLowerCase() === "audio/opus");
            if (opusCodec) {
                opusCodec.parameters = "minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=64000;stereo=0";
            }
            if (videoTransceiver && videoTransceiver.codecs.length > 1) {
                videoTransceiver.codecs = sortPreferredVideoCodecs(videoTransceiver.codecs);
            }
            answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
        } catch (err) {
            if (this.sessions.get(callUuid) === session) {
                this.cleanupSession(callUuid);
            } else {
                try {
                    pc.close().catch(() => {});
                } catch {
                    // Ignore close errors
                }
            }
            throw err;
        }

        // Superseded or cleaned up while negotiating: whoever removed us already closed pc.
        if (this.sessions.get(callUuid) !== session) return;

        const videoSection = answer.sdp.split(/^m=/m).find(s => s.startsWith("video ")) ?? "";
        const videoNegotiated = Boolean(videoTransceiver && /^video [1-9]\d*/.test(videoSection));
        if (enableVideo && !videoNegotiated) {
            const offerVideoLine = payload.sdp.split(/\r?\n/).find(l => l.startsWith("m=video")) ?? "none";
            const answerVideoLine = answer.sdp.split(/\r?\n/).find(l => l.startsWith("m=video")) ?? "none";
            this.log.warn(
                `FaceTime bridge video not negotiated for ${callUuid}: offer="${offerVideoLine}" answer="${answerVideoLine}"`
            );
        }
        const uplinkVideoNegotiated = Boolean(
            enableUplinkVideo && videoNegotiated && /\ba=(sendrecv|recvonly)\b/.test(videoSection)
        );
        if (videoNegotiated && videoTransceiver) {
            const negotiatedH264 = videoTransceiver.codecs.find(
                c => c.mimeType.toLowerCase() === "video/h264" && c.payloadType !== undefined
            );
            if (negotiatedH264?.payloadType !== undefined) {
                session.videoPayloadType = negotiatedH264.payloadType;
            }
        }

        socket.emit("ft-bridge-answer", {
            callUuid,
            sdp: answer.sdp,
            type: "answer",
            iceServers,
            uplinkVideo: uplinkVideoNegotiated
        });

        if (payload.answerCall) {
            try {
                Server()?.privateApi?.facetime?.answerCall(callUuid).catch(() => {});
            } catch {
                // Ignore when Server singleton is not initialized (e.g. unit tests)
            }
        }

        this.spawnAudioProcess(session);
        if (payload.voiceIsolation !== undefined) {
            this.writeAudioVoiceIsolation(session);
        }
        if (videoNegotiated && videoBin) {
            session.videoNegotiated = true;
            session.videoBin = videoBin;
            if (getFaceTimeSessionStatus(callUuid) === FACETIME_STATUS_OUTGOING) {
                this.log.info(`Deferring BlueBubblesVideoBridge spawn for ${callUuid} until outgoing call is answered`);
            } else {
                this.spawnVideoProcess(session, videoBin);
                if (videoTransceiver) {
                    this.attachAdaptiveVideoController(session, videoTransceiver);
                }
            }
        }
        if (uplinkVideoNegotiated && cameraBin && videoTransceiver) {
            session.depacketizer = new H264RtpDepacketizer(
                (accessUnit, { isIdr }) => {
                    if (isIdr && !session.receivedFirstIdr) {
                        session.receivedFirstIdr = true;
                        this.clearPliTimer(session);
                    }
                    this.writeUplinkVideoAccessUnit(session, accessUnit);
                },
                () => {
                    this.requestPli(session, false);
                }
            );
            const subscribedVideoTracks = new Set<MediaStreamTrack>();
            const subscribeVideoTrack = (track: MediaStreamTrack | undefined) => {
                if (!track || subscribedVideoTracks.has(track)) return;
                subscribedVideoTracks.add(track);
                track.onReceiveRtp.subscribe(rtp => {
                    session.uplinkVideoSsrc = rtp.header.ssrc;
                    if (!session.cameraEnabled) return;
                    session.depacketizer?.pushPacket(rtp);
                });
            };
            videoTransceiver.onTrack.subscribe(track => {
                subscribeVideoTrack(track);
            });
            for (const track of videoTransceiver.receiver.tracks) {
                subscribeVideoTrack(track);
            }
            this.spawnCameraProcess(session, cameraBin);
            this.startPliLoop(session);
        }
    }

    async handleAnswer(socket: Socket, payload: BridgeSignalPayload): Promise<void> {
        const callUuid = payload?.callUuid;
        if (!callUuid || !payload?.sdp) return;

        // If a client sends an SDP offer on ft-bridge-answer, handle it as an offer
        if (payload.type === "offer" || !this.sessions.has(callUuid)) {
            await this.handleOffer(socket, { ...payload, type: "offer" });
            return;
        }

        const session = this.sessions.get(callUuid);
        if (!session) return;
        await session.pc.setRemoteDescription({ sdp: payload.sdp, type: "answer" });
    }

    async handleIce(payload: BridgeSignalPayload): Promise<void> {
        const callUuid = payload?.callUuid;
        if (!callUuid || !payload?.candidate) return;
        const session = this.sessions.get(callUuid);
        if (!session) return;

        try {
            this.log.info(`FaceTime bridge remote ICE (${callUuid}): ${summarizeIceCandidateSdp(payload.candidate)}`);
            await session.pc.addIceCandidate(
                new RTCIceCandidate({
                    candidate: payload.candidate,
                    sdpMid: payload.sdpMid ?? undefined,
                    sdpMLineIndex: payload.sdpMLineIndex ?? undefined
                })
            );
        } catch (ex: any) {
            this.log.debug(`Failed to add ICE candidate for ${callUuid}: ${ex?.message ?? ex}`);
        }
    }

    handleMute(payload: BridgeSignalPayload): void {
        const callUuid = payload?.callUuid;
        if (!callUuid) return;
        const muted = Boolean(payload.muted);
        const session = this.sessions.get(callUuid);
        if (session) {
            session.muted = muted;
            if (session.process?.stdin?.writable) {
                const pkt = Buffer.alloc(6);
                pkt[0] = 0x02;
                pkt.writeUInt32BE(1, 1);
                pkt[5] = muted ? 1 : 0;
                session.process.stdin.write(pkt);
            }
        }

        try {
            Server()?.privateApi?.facetime?.setMuted(callUuid, muted).catch(() => {});
        } catch {
            // Ignore when Server singleton is not initialized (e.g. unit tests)
        }
    }

    handleHangup(payload: BridgeSignalPayload): void {
        if (!payload?.callUuid) return;
        this.cleanupSession(payload.callUuid);
    }

    handleKeyframe(payload: BridgeSignalPayload): void {
        if (!payload?.callUuid) return;
        const session = this.findSessionCaseInsensitive(payload.callUuid);
        if (!session) return;
        if (session.videoProcess?.stdin?.writable) {
            session.videoProcess.stdin.write(`${JSON.stringify({ cmd: "idr" })}\n`);
        }
        this.requestPli(session, true);
    }

    handleCamera(payload: BridgeSignalPayload): void {
        const callUuid = payload?.callUuid;
        if (!callUuid) return;
        this.setCameraEnabled(callUuid, Boolean(payload.enabled));
    }

    handleAudioConfig(payload: BridgeSignalPayload): void {
        const callUuid = payload?.callUuid;
        if (!callUuid || payload.voiceIsolation === undefined) return;
        this.setVoiceIsolation(callUuid, Boolean(payload.voiceIsolation));
    }

    private findSessionCaseInsensitive(callUuid: string): BridgeSession | undefined {
        const direct = this.sessions.get(callUuid);
        if (direct) return direct;
        const normalized = callUuid.trim().toLowerCase();
        if (!normalized) return undefined;
        for (const [key, session] of this.sessions.entries()) {
            if (key.trim().toLowerCase() === normalized || session.callUuid.trim().toLowerCase() === normalized) {
                return session;
            }
        }
        return undefined;
    }

    onCallAnswered(callUuid: string): boolean {
        if (!callUuid) return false;
        const session = this.findSessionCaseInsensitive(callUuid);
        if (!session || session.closed) return false;

        const connState = session.pc?.connectionState;
        if (connState === "closed" || connState === "failed") return false;

        let didAudioRetap = false;
        if (!session.audioAnsweredSent) {
            session.audioAnsweredSent = true;
            didAudioRetap = this.writeAudioAnswered(session);
        }

        const needsVideoSpawn = Boolean(
            session.videoNegotiated &&
                session.videoBin &&
                !session.videoProcess &&
                !session.videoRestartTimer
        );
        if (needsVideoSpawn && session.videoBin) {
            this.log.info(`Call answered; spawning deferred BlueBubblesVideoBridge for ${callUuid}`);
            this.spawnVideoProcess(session, session.videoBin);
            if (session.videoTransceiver) {
                if (!session.adaptiveController) {
                    this.attachAdaptiveVideoController(session, session.videoTransceiver);
                } else {
                    session.adaptiveController.reset();
                }
            }
        }
        return didAudioRetap || needsVideoSpawn;
    }

    setVoiceIsolation(callUuid: string, enabled: boolean): boolean {
        const session = this.sessions.get(callUuid);
        if (!session) return false;
        session.voiceIsolation = enabled;
        return this.writeAudioVoiceIsolation(session);
    }

    setCameraEnabled(callUuid: string, enabled: boolean): boolean {
        const session = this.sessions.get(callUuid);
        if (!session) return false;
        session.cameraEnabled = enabled;
        if (!enabled) {
            session.depacketizer?.reset();
            this.clearPliTimer(session);
            if (session.cameraProcess?.stdin?.writable) {
                const clearPkt = Buffer.alloc(4, 0);
                session.cameraProcess.stdin.write(clearPkt);
            }
        } else {
            session.receivedFirstIdr = false;
            if (session.videoTransceiver && session.cameraProcess) {
                this.requestPli(session, true);
                this.startPliLoop(session);
            }
        }
        return true;
    }

    sendDtmf(callUuid: string, digit: string): boolean {
        const session = this.sessions.get(callUuid);
        if (!session?.process?.stdin?.writable) return false;
        const char = String(digit ?? "").trim().toUpperCase();
        if (!/^[0-9*#ABCD]$/.test(char)) return false;
        const pkt = Buffer.allocUnsafe(6);
        pkt[0] = 0x03;
        pkt.writeUInt32BE(1, 1);
        pkt[5] = char.charCodeAt(0);
        session.process.stdin.write(pkt);
        return true;
    }

    handleSocketDisconnect(socketId: string): void {
        for (const [callUuid, session] of this.sessions.entries()) {
            if (session.socketId === socketId) {
                this.armOrphanTimer(session);
                this.log.debug(`Socket ${socketId} disconnected; armed orphan timer for ${callUuid}`);
            }
        }
    }

    cleanupAllSessions(): void {
        for (const callUuid of Array.from(this.sessions.keys())) {
            this.cleanupSession(callUuid);
        }
    }

    cleanupSessions(ids: Iterable<string | null | undefined>): void {
        const seen = new Set<string>();
        for (const id of ids) {
            if (!id || seen.has(id)) continue;
            seen.add(id);
            this.cleanupSession(id);
        }
    }

    cleanupSession(callUuid: string): void {
        const session = this.sessions.get(callUuid);
        if (!session) return;

        session.closed = true;
        this.clearOrphanTimer(session);
        this.clearPliTimer(session);
        this.clearAdaptTimer(session);
        this.clearRestartTimers(session);
        if (session.audioStatsTimer) {
            clearInterval(session.audioStatsTimer);
            session.audioStatsTimer = undefined;
        }
        session.adaptiveController = undefined;
        session.depacketizer?.reset();
        this.sessions.delete(callUuid);

        if (session.process) {
            this.stoppedProcesses.add(session.process);
            if (!session.process.killed) {
                try {
                    session.process.kill("SIGTERM");
                } catch {
                    // Ignore kill errors
                }
            }
        }
        session.process = undefined;

        if (session.videoProcess) {
            this.stoppedProcesses.add(session.videoProcess);
            if (!session.videoProcess.killed) {
                try {
                    session.videoProcess.kill("SIGTERM");
                } catch {
                    // Ignore kill errors
                }
            }
        }
        session.videoProcess = undefined;

        if (session.cameraProcess) {
            this.stoppedProcesses.add(session.cameraProcess);
            if (!session.cameraProcess.killed) {
                try {
                    session.cameraProcess.kill("SIGTERM");
                } catch {
                    // Ignore kill errors
                }
            }
        }
        session.cameraProcess = undefined;

        const hasRemainingCameraSession = Array.from(this.sessions.values()).some(s => !s.closed && s.cameraEnabled);
        if (!hasRemainingCameraSession) {
            setCameraHookActiveFlag(false);
        }

        try {
            session.pc.close().catch(() => {});
        } catch {
            // Ignore close errors
        }
    }

    private armOrphanTimer(session: BridgeSession, timeoutMs = this.orphanTimeoutMs): void {
        this.clearOrphanTimer(session);
        session.orphanTimer = setTimeout(() => {
            if (this.sessions.get(session.callUuid) !== session) return;
            this.log.info(`Cleaning up orphaned audio bridge session: ${session.callUuid}`);
            this.cleanupSession(session.callUuid);
        }, timeoutMs);
        if (typeof session.orphanTimer.unref === "function") {
            session.orphanTimer.unref();
        }
    }

    private clearOrphanTimer(session: BridgeSession): void {
        if (session.orphanTimer) {
            clearTimeout(session.orphanTimer);
            session.orphanTimer = undefined;
        }
    }

    private clearRestartTimer(session: BridgeSession, kind: HelperKind): void {
        const timerKey =
            kind === "audio"
                ? "audioRestartTimer"
                : kind === "video"
                  ? "videoRestartTimer"
                  : "cameraRestartTimer";
        const timer = session[timerKey];
        if (timer) {
            clearTimeout(timer);
            session[timerKey] = undefined;
        }
    }

    private clearRestartTimers(session: BridgeSession): void {
        this.clearRestartTimer(session, "audio");
        this.clearRestartTimer(session, "video");
        this.clearRestartTimer(session, "camera");
    }

    private scheduleHelperRespawn(session: BridgeSession, kind: HelperKind, respawn: () => void): void {
        if (session.closed || this.sessions.get(session.callUuid) !== session) return;
        if (session.pc?.connectionState !== "connected") return;

        const attemptsKey =
            kind === "audio"
                ? "audioRestartAttempts"
                : kind === "video"
                  ? "videoRestartAttempts"
                  : "cameraRestartAttempts";
        const timerKey =
            kind === "audio"
                ? "audioRestartTimer"
                : kind === "video"
                  ? "videoRestartTimer"
                  : "cameraRestartTimer";

        if (session[timerKey]) return;
        const attempt = session[attemptsKey];
        if (attempt >= this.maxRespawnRetries) {
            this.log.warn(
                `FaceTime ${kind} helper for ${session.callUuid} reached max respawn retries (${this.maxRespawnRetries})`
            );
            return;
        }

        const delayMs = this.respawnBaseDelayMs * 2 ** attempt;
        session[attemptsKey] = attempt + 1;
        this.log.warn(
            `FaceTime ${kind} helper exited unexpectedly for ${session.callUuid}; respawning in ${delayMs}ms (attempt ${attempt + 1}/${this.maxRespawnRetries})`
        );

        const timer = setTimeout(() => {
            session[timerKey] = undefined;
            if (session.closed || this.sessions.get(session.callUuid) !== session) return;
            if (session.pc?.connectionState !== "connected") return;
            respawn();
        }, delayMs);
        timer.unref?.();
        session[timerKey] = timer;
    }

    private spawnAudioProcess(session: BridgeSession, isRespawn = false): void {
        const bin = FaceTimeAudioBridge.resolveHelperBinary();
        if (!bin) {
            this.log.warn("BlueBubblesAudioBridge binary not found; audio bridge running in signaling-only mode");
            return;
        }

        this.clearRestartTimer(session, "audio");
        session.stdoutBuffer = Buffer.alloc(0);
        const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
        session.process = proc;

        if (!session.audioStatsTimer) {
            session.audioStatsTimer = setInterval(() => {
                if (session.closed || this.sessions.get(session.callUuid) !== session) return;
                const uplinkPackets = session.uplinkRtpPackets;
                const uplinkBytes = session.uplinkRtpBytes;
                const downlinkFrames = session.downlinkOpusFrames;
                session.uplinkRtpPackets = 0;
                session.uplinkRtpBytes = 0;
                session.downlinkOpusFrames = 0;
                this.log.info(
                    `AudioBridge stats (5s) for ${session.callUuid}: uplinkRtpPackets=${uplinkPackets}, uplinkBytes=${uplinkBytes}, downlinkOpusFrames=${downlinkFrames}, muted=${session.muted}, stdinWritable=${Boolean(session.process?.stdin?.writable)}`
                );
            }, 5000);
            session.audioStatsTimer.unref?.();
        }

        if (isRespawn) {
            if (session.muted && proc.stdin?.writable) {
                const pkt = Buffer.alloc(6);
                pkt[0] = 0x02;
                pkt.writeUInt32BE(1, 1);
                pkt[5] = 1;
                proc.stdin.write(pkt);
            }
            this.writeAudioVoiceIsolation(session);
        }

        proc.stdout.on("data", (chunk: Buffer) => {
            session.stdoutBuffer = Buffer.concat([session.stdoutBuffer, chunk]);
            while (session.stdoutBuffer.length >= 4) {
                const frameLen = session.stdoutBuffer.readUInt32BE(0);
                if (frameLen === 0 || frameLen > 65536) {
                    session.stdoutBuffer = Buffer.alloc(0);
                    break;
                }
                if (session.stdoutBuffer.length < 4 + frameLen) break;
                const frame = session.stdoutBuffer.subarray(4, 4 + frameLen);
                session.stdoutBuffer = session.stdoutBuffer.subarray(4 + frameLen);
                this.sendDownlinkOpusFrame(session, frame);
            }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
            this.log.debug(`[AudioBridge ${session.callUuid}] ${chunk.toString().trim()}`);
        });

        proc.on("error", err => {
            this.log.warn(`BlueBubblesAudioBridge process error for ${session.callUuid}: ${err?.message ?? err}`);
            if (session.process === proc) {
                session.process = undefined;
            }
        });

        proc.stdin.on("error", err => {
            this.log.debug(`BlueBubblesAudioBridge stdin error for ${session.callUuid}: ${err?.message ?? err}`);
        });

        proc.on("exit", code => {
            if (session.process === proc) {
                session.process = undefined;
            }
            this.log.debug(`BlueBubblesAudioBridge exited for ${session.callUuid} (code=${code})`);
            if (!this.stoppedProcesses.has(proc)) {
                this.scheduleHelperRespawn(session, "audio", () => {
                    this.spawnAudioProcess(session, true);
                });
            }
        });
    }

    private sendDownlinkOpusFrame(session: BridgeSession, opusFrame: Buffer): void {
        session.downlinkOpusFrames += 1;
        session.rtpSeq = (session.rtpSeq + 1) & 0xffff;
        session.rtpTimestamp = (session.rtpTimestamp + OPUS_SAMPLES_PER_FRAME) >>> 0;
        const header = new RtpHeader({
            payloadType: OPUS_PAYLOAD_TYPE,
            sequenceNumber: session.rtpSeq,
            timestamp: session.rtpTimestamp,
            ssrc: session.ssrc,
            marker: false
        });
        const pkt = new RtpPacket(header, opusFrame);
        session.outboundTrack.writeRtp(pkt);
    }

    private writeUplinkOpusFrame(session: BridgeSession, opusFrame: Buffer): void {
        if (session.muted || opusFrame.length === 0 || !session.process?.stdin?.writable) return;
        session.uplinkRtpPackets += 1;
        session.uplinkRtpBytes += opusFrame.length;
        const pkt = Buffer.allocUnsafe(5 + opusFrame.length);
        pkt[0] = 0x01;
        pkt.writeUInt32BE(opusFrame.length, 1);
        opusFrame.copy(pkt, 5);
        session.process.stdin.write(pkt);
    }

    private spawnVideoProcess(session: BridgeSession, bin: string): void {
        this.clearRestartTimer(session, "video");
        session.videoStdoutBuffer = Buffer.alloc(0);
        const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
        session.videoProcess = proc;

        proc.stdin.on("error", err => {
            this.log.debug(`BlueBubblesVideoBridge stdin error for ${session.callUuid}: ${err?.message ?? err}`);
        });

        proc.stdout.on("data", (chunk: Buffer) => {
            session.videoStdoutBuffer = Buffer.concat([session.videoStdoutBuffer, chunk]);
            while (session.videoStdoutBuffer.length >= 4) {
                const frameLen = session.videoStdoutBuffer.readUInt32BE(0);
                if (frameLen === 0 || frameLen > MAX_VIDEO_FRAME_BYTES) {
                    session.videoStdoutBuffer = Buffer.alloc(0);
                    break;
                }
                if (session.videoStdoutBuffer.length < 4 + frameLen) break;
                const accessUnit = session.videoStdoutBuffer.subarray(4, 4 + frameLen);
                session.videoStdoutBuffer = session.videoStdoutBuffer.subarray(4 + frameLen);
                this.sendDownlinkVideoAccessUnit(session, accessUnit);
            }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
            this.log.debug(`[VideoBridge ${session.callUuid}] ${chunk.toString().trim()}`);
        });

        proc.on("error", err => {
            this.log.warn(`BlueBubblesVideoBridge process error for ${session.callUuid}: ${err?.message ?? err}`);
            if (session.videoProcess === proc) {
                session.videoProcess = undefined;
            }
        });

        proc.on("exit", code => {
            if (session.videoProcess === proc) {
                session.videoProcess = undefined;
            }
            this.log.debug(`BlueBubblesVideoBridge exited for ${session.callUuid} (code=${code})`);
            if (!this.stoppedProcesses.has(proc)) {
                this.scheduleHelperRespawn(session, "video", () => {
                    this.spawnVideoProcess(session, bin);
                });
            }
        });
    }

    private writeAudioVoiceIsolation(session: BridgeSession): boolean {
        if (!session.process?.stdin?.writable) return false;
        const pkt = Buffer.allocUnsafe(6);
        pkt[0] = 0x04;
        pkt.writeUInt32BE(1, 1);
        pkt[5] = session.voiceIsolation ? 1 : 0;
        session.process.stdin.write(pkt);
        return true;
    }

    private writeAudioAnswered(session: BridgeSession): boolean {
        if (!session.process?.stdin?.writable) return false;
        const pkt = Buffer.allocUnsafe(6);
        pkt[0] = 0x05;
        pkt.writeUInt32BE(1, 1);
        pkt[5] = 1;
        session.process.stdin.write(pkt);
        return true;
    }

    private sendDownlinkVideoAccessUnit(session: BridgeSession, accessUnit: Buffer): void {
        if (!session.outboundVideoTrack) return;
        const nalus = splitAnnexBNalus(accessUnit);
        if (nalus.length === 0) return;

        const nowMs = performance.now();
        const delta90k =
            session.lastDownlinkVideoFrameAtMs === undefined
                ? H264_FRAME_DURATION_90KHZ
                : Math.max(
                      H264_MIN_FRAME_DURATION_90KHZ,
                      Math.min(
                          H264_MAX_FRAME_DURATION_90KHZ,
                          Math.round((nowMs - session.lastDownlinkVideoFrameAtMs) * 90)
                      )
                  );
        session.lastDownlinkVideoFrameAtMs = nowMs;
        session.videoRtpTimestamp = (session.videoRtpTimestamp + delta90k) >>> 0;
        const { packets, nextSeq } = packetizeH264Nalus(nalus, {
            payloadType: session.videoPayloadType,
            ssrc: session.videoSsrc,
            timestamp: session.videoRtpTimestamp,
            startSeq: session.videoRtpSeq
        });
        session.videoRtpSeq = nextSeq;

        if (packets.length > 0) {
            session.adaptiveController?.markVideoRtpSent();
        }
        for (const pkt of packets) {
            session.outboundVideoTrack.writeRtp(pkt);
        }
    }

    private attachAdaptiveVideoController(session: BridgeSession, videoTransceiver: RTCRtpTransceiver): void {
        const writeVideoStdin = (msg: object) => {
            if (session.videoProcess?.stdin?.writable) {
                session.videoProcess.stdin.write(`${JSON.stringify(msg)}\n`);
            }
        };

        const controller = new FaceTimeAdaptiveController({
            onAdapt: cmd => writeVideoStdin(cmd),
            onIdr: () => writeVideoStdin({ cmd: "idr" })
        });
        session.adaptiveController = controller;

        const sender = videoTransceiver.sender;
        sender.onAvailableBitrate.subscribe(bps => {
            if (this.sessions.get(session.callUuid) !== session) return;
            controller.updateBitrate(bps);
        });
        sender.onKeyFrameRequest.subscribe(() => {
            if (this.sessions.get(session.callUuid) !== session) return;
            controller.requestIdr();
        });
        sender.onRtcp.subscribe(rtcp => {
            if (this.sessions.get(session.callUuid) !== session) return;
            const packet = rtcp as unknown as {
                type?: number;
                reports?: Array<{ ssrc?: number; fractionLost?: number }>;
            };
            if ((packet.type !== 200 && packet.type !== 201) || !Array.isArray(packet.reports)) return;
            const report = packet.reports.find(r => r.ssrc === sender.ssrc) ?? packet.reports[0];
            if (!report || typeof report.fractionLost !== "number") return;
            const fractionLost = Math.max(0, Math.min(1, report.fractionLost / 256));
            const rawRttSec = (sender as unknown as { stats?: { rtt?: number } }).stats?.rtt;
            const rttMs =
                typeof rawRttSec === "number" && Number.isFinite(rawRttSec) && rawRttSec >= 0
                    ? rawRttSec * 1000
                    : undefined;
            controller.updateRtcpFeedback({ fractionLost, rttMs });
        });

        this.clearAdaptTimer(session);
        session.adaptTimer = setInterval(() => {
            if (this.sessions.get(session.callUuid) !== session) {
                this.clearAdaptTimer(session);
                return;
            }
            controller.tick();
        }, ADAPT_TICK_INTERVAL_MS);
        if (typeof session.adaptTimer.unref === "function") {
            session.adaptTimer.unref();
        }
    }

    private clearAdaptTimer(session: BridgeSession): void {
        if (session.adaptTimer) {
            clearInterval(session.adaptTimer);
            session.adaptTimer = undefined;
        }
    }

    private spawnCameraProcess(session: BridgeSession, bin: string, isRespawn = false): void {
        this.clearRestartTimer(session, "camera");
        session.cameraBin = bin;
        if (session.cameraProcess) {
            this.stoppedProcesses.add(session.cameraProcess);
            try {
                session.cameraProcess.kill("SIGTERM");
            } catch {
                // Ignore kill errors
            }
            session.cameraProcess = undefined;
        }
        const proc = spawn(bin, [], { stdio: ["pipe", "ignore", "pipe"] });
        session.cameraProcess = proc;
        session.cameraBackpressured = false;

        if (isRespawn && session.cameraEnabled) {
            session.receivedFirstIdr = false;
            if (session.videoTransceiver) {
                this.requestPli(session, true);
                this.startPliLoop(session);
            }
        }

        proc.stderr.on("data", (chunk: Buffer) => {
            this.log.debug(`[CameraBridge ${session.callUuid}] ${chunk.toString().trim()}`);
        });

        proc.on("error", err => {
            this.log.warn(`BlueBubblesCameraBridge process error for ${session.callUuid}: ${err?.message ?? err}`);
            if (session.cameraProcess === proc) {
                session.cameraProcess = undefined;
            }
        });

        proc.stdin.on("error", err => {
            this.log.debug(`BlueBubblesCameraBridge stdin error for ${session.callUuid}: ${err?.message ?? err}`);
        });

        proc.on("exit", code => {
            if (session.cameraProcess === proc) {
                session.cameraProcess = undefined;
            }
            this.log.debug(`BlueBubblesCameraBridge exited for ${session.callUuid} (code=${code})`);
            if (!this.stoppedProcesses.has(proc)) {
                this.scheduleHelperRespawn(session, "camera", () => {
                    this.spawnCameraProcess(session, bin, true);
                });
            }
        });
    }

    private writeUplinkVideoAccessUnit(session: BridgeSession, accessUnit: Buffer): void {
        const proc = session.cameraProcess;
        if (!session.cameraEnabled || !proc?.stdin?.writable || session.cameraBackpressured) {
            if (session.cameraEnabled && proc?.stdin?.writable && session.cameraBackpressured) {
                session.depacketizer?.reset(true);
                this.requestPli(session, true);
            }
            return;
        }
        const pkt = Buffer.allocUnsafe(4 + accessUnit.length);
        pkt.writeUInt32BE(accessUnit.length, 0);
        accessUnit.copy(pkt, 4);
        const ok = proc.stdin.write(pkt);
        if (!ok) {
            session.cameraBackpressured = true;
            proc.stdin.once("drain", () => {
                session.cameraBackpressured = false;
            });
        }
    }

    private requestPli(session: BridgeSession, force: boolean): void {
        const receiver = session.videoTransceiver?.receiver;
        if (!receiver) return;
        const ssrc = session.uplinkVideoSsrc ?? receiver.track?.ssrc;
        if (ssrc === undefined) return;
        const now = Date.now();
        if (!force && now - session.lastPliSentAt < PLI_GAP_COOLDOWN_MS) return;
        session.lastPliSentAt = now;
        receiver.sendRtcpPLI(ssrc).catch(() => {});
    }

    private startPliLoop(session: BridgeSession): void {
        this.clearPliTimer(session);
        if (!session.videoTransceiver) return;
        this.requestPli(session, true);
        session.pliTimer = setInterval(() => {
            if (this.sessions.get(session.callUuid) !== session || session.receivedFirstIdr || !session.cameraEnabled) {
                this.clearPliTimer(session);
                return;
            }
            this.requestPli(session, true);
        }, PLI_INTERVAL_MS);
        if (typeof session.pliTimer.unref === "function") {
            session.pliTimer.unref();
        }
    }

    private clearPliTimer(session: BridgeSession): void {
        if (session.pliTimer) {
            clearInterval(session.pliTimer);
            session.pliTimer = undefined;
        }
    }
}
