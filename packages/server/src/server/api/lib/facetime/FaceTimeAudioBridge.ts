import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Socket } from "socket.io";
import {
    MediaStreamTrack,
    RTCIceCandidate,
    RTCPeerConnection,
    RTCRtpCodecParameters,
    RtpHeader,
    RtpPacket
} from "werift";
import { Server } from "@server";
import { FileSystem } from "@server/fileSystem";
import { Loggable } from "@server/lib/logging/Loggable";

const DEFAULT_ORPHAN_TIMEOUT_MS = 30_000;
const OPUS_PAYLOAD_TYPE = 111;
const OPUS_SAMPLES_PER_FRAME = 960; // 20ms @ 48kHz

export type BridgeSignalPayload = {
    callUuid: string;
    sdp?: string;
    type?: "offer" | "answer";
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    muted?: boolean;
    answerCall?: boolean;
};

type BridgeSession = {
    callUuid: string;
    pc: RTCPeerConnection;
    outboundTrack: MediaStreamTrack;
    process?: ChildProcess;
    socketId?: string;
    orphanTimer?: NodeJS.Timeout;
    muted: boolean;
    rtpSeq: number;
    rtpTimestamp: number;
    ssrc: number;
    stdoutBuffer: Buffer;
};

export class FaceTimeAudioBridge extends Loggable {
    tag = "FaceTimeAudioBridge";

    private static instance: FaceTimeAudioBridge | null = null;

    sessions: Map<string, BridgeSession> = new Map();

    orphanTimeoutMs: number = DEFAULT_ORPHAN_TIMEOUT_MS;

    static getInstance(): FaceTimeAudioBridge {
        if (!FaceTimeAudioBridge.instance) {
            FaceTimeAudioBridge.instance = new FaceTimeAudioBridge();
        }
        return FaceTimeAudioBridge.instance;
    }

    static resolveHelperBinary(): string | null {
        const candidates = [
            path.join(FileSystem.resources, "macos", "tools", "BlueBubblesAudioBridge"),
            path.resolve(__dirname, "../../../../../../appResources/macos/tools/BlueBubblesAudioBridge"),
            path.resolve(process.cwd(), "appResources/macos/tools/BlueBubblesAudioBridge")
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    }

    async handleOffer(socket: Socket, payload: BridgeSignalPayload): Promise<void> {
        const callUuid = payload?.callUuid;
        if (!callUuid || !payload?.sdp) return;

        this.cleanupSession(callUuid);

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            codecs: {
                audio: [
                    new RTCRtpCodecParameters({
                        mimeType: "audio/opus",
                        clockRate: 48000,
                        channels: 2,
                        payloadType: OPUS_PAYLOAD_TYPE
                    })
                ]
            }
        });

        const outboundTrack = new MediaStreamTrack({ kind: "audio" });
        const transceiver = pc.addTransceiver(outboundTrack, { direction: "sendrecv" });

        const session: BridgeSession = {
            callUuid,
            pc,
            outboundTrack,
            socketId: socket.id,
            muted: false,
            rtpSeq: 0,
            rtpTimestamp: 0,
            ssrc: Math.floor(Math.random() * 0xffffffff),
            stdoutBuffer: Buffer.alloc(0)
        };
        this.sessions.set(callUuid, session);
        this.armOrphanTimer(session);

        pc.onIceCandidate.subscribe(candidate => {
            if (!candidate) return;
            socket.emit("ft-bridge-ice", {
                callUuid,
                candidate: candidate.candidate,
                sdpMid: candidate.sdpMid ?? null,
                sdpMLineIndex: candidate.sdpMLineIndex ?? null
            });
        });

        transceiver.receiver.track.onReceiveRtp.subscribe(rtp => {
            this.writeUplinkOpusFrame(session, rtp.payload);
        });

        pc.connectionStateChange.subscribe(state => {
            if (state === "connected") {
                this.clearOrphanTimer(session);
            } else if (state === "failed" || state === "closed") {
                this.cleanupSession(callUuid);
            }
        });

        await pc.setRemoteDescription({ sdp: payload.sdp, type: payload.type ?? "offer" });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("ft-bridge-answer", {
            callUuid,
            sdp: answer.sdp,
            type: "answer"
        });

        if (payload.answerCall) {
            try {
                Server()?.privateApi?.facetime?.answerCall(callUuid).catch(() => {});
            } catch {
                // Ignore when Server singleton is not initialized (e.g. unit tests)
            }
        }

        this.spawnAudioProcess(session);
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

    cleanupSession(callUuid: string): void {
        const session = this.sessions.get(callUuid);
        if (!session) return;

        this.clearOrphanTimer(session);
        this.sessions.delete(callUuid);

        if (session.process && !session.process.killed) {
            try {
                session.process.kill("SIGTERM");
            } catch {
                // Ignore kill errors
            }
        }

        try {
            session.pc.close().catch(() => {});
        } catch {
            // Ignore close errors
        }
    }

    private armOrphanTimer(session: BridgeSession): void {
        this.clearOrphanTimer(session);
        session.orphanTimer = setTimeout(() => {
            this.log.info(`Cleaning up orphaned audio bridge session: ${session.callUuid}`);
            this.cleanupSession(session.callUuid);
        }, this.orphanTimeoutMs);
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

    private spawnAudioProcess(session: BridgeSession): void {
        const bin = FaceTimeAudioBridge.resolveHelperBinary();
        if (!bin) {
            this.log.warn("BlueBubblesAudioBridge binary not found; audio bridge running in signaling-only mode");
            return;
        }

        const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
        session.process = proc;

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
        });
    }

    private sendDownlinkOpusFrame(session: BridgeSession, opusFrame: Buffer): void {
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
        if (session.muted || !session.process?.stdin?.writable) return;
        const pkt = Buffer.allocUnsafe(5 + opusFrame.length);
        pkt[0] = 0x01;
        pkt.writeUInt32BE(opusFrame.length, 1);
        opusFrame.copy(pkt, 5);
        session.process.stdin.write(pkt);
    }
}
