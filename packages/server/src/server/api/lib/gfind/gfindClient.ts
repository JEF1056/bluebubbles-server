import axios from "axios";
import crypto from "crypto";
import http2 from "http2";
import zlib from "zlib";
import { GoogleFindAuthManager } from "./gfindAuth";
import { GoogleFindSoundComponent, componentToProtoEnum } from "./gfindCrypto";
import {
    decodeDevicesList,
    decodeGetEidInfoForE2eeDevicesResponse,
    encodeDevicesListRequest,
    encodeExecuteActionRequest,
    encodeGetEidInfoForE2eeDevicesRequest,
    ExecuteActionLocationType,
    GetEidInfoResponse,
    NovaDeviceType,
    ProtoDeviceMetadata
} from "./gfindProto";

const NOVA_BASE_URL = "https://android.googleapis.com/nova";
const SPOT_GRPC_ORIGIN = "https://spot-pa.googleapis.com";
const SPOT_GRPC_PATH = "/google.internal.spot.v1.SpotService/GetEidInfoForE2eeDevices";
const NOVA_USER_AGENT = "fmd/20006320; gzip";
const SPOT_GRPC_USER_AGENT = "com.google.android.gms/244433022 grpc-java-cronet/1.69.0-SNAPSHOT";

function logGfindClient(msg: string, level: "info" | "warn" = "info"): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Server } = require("@server");
        const logger = Server()?.logger;
        if (logger) {
            if (level === "warn") logger.warn(msg);
            else logger.info(msg);
            return;
        }
    } catch {
        // Ignore when Server singleton is unavailable (e.g. unit tests)
    }
    if (level === "warn") console.warn(msg);
    else console.log(msg);
}

export interface GoogleFindClientDeps {
    novaPost?: (endpoint: string, body: Buffer, bearerToken: string) => Promise<{ status: number; data: Buffer }>;
    spotGrpcCall?: (path: string, frame: Buffer, bearerToken: string) => Promise<Buffer>;
}

function randomUuid(): string {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function encodeGrpcFrame(payload: Buffer): Buffer {
    const header = Buffer.allocUnsafe(5);
    header[0] = 0x00; // uncompressed
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

function decodeGrpcFrame(frame: Buffer): Buffer {
    if (frame.length < 5) {
        throw new Error(`Truncated gRPC frame (${frame.length} bytes)`);
    }
    const compressed = frame[0];
    if (compressed !== 0 && compressed !== 1) {
        throw new Error(`Unsupported compressed gRPC frame flag: ${compressed}`);
    }
    const len = frame.readUInt32BE(1);
    if (5 + len > frame.length) {
        throw new Error(`Incomplete gRPC frame body: expected ${len}, got ${frame.length - 5}`);
    }
    const payload = frame.subarray(5, 5 + len);
    return compressed === 1 ? zlib.gunzipSync(payload) : payload;
}

async function defaultNovaPost(
    endpoint: string,
    body: Buffer,
    bearerToken: string
): Promise<{ status: number; data: Buffer }> {
    const res = await axios.post(`${NOVA_BASE_URL}/${endpoint}`, body, {
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Accept-Language": "en-US",
            "User-Agent": NOVA_USER_AGENT
        },
        responseType: "arraybuffer",
        timeout: 20_000,
        validateStatus: () => true
    });
    return {
        status: res.status,
        data: Buffer.from(res.data ?? [])
    };
}

async function defaultSpotGrpcCall(path: string, frame: Buffer, bearerToken: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const client = http2.connect(SPOT_GRPC_ORIGIN);
        let settled = false;
        const finish = (err?: Error, out?: Buffer) => {
            if (settled) return;
            settled = true;
            try {
                client.close();
            } catch {
                // Ignore close errors
            }
            if (err) reject(err);
            else resolve(out ?? Buffer.alloc(0));
        };

        client.on("error", err => finish(err));

        const req = client.request({
            ":method": "POST",
            ":path": path,
            "content-type": "application/grpc",
            "grpc-accept-encoding": "gzip",
            te: "trailers",
            authorization: `Bearer ${bearerToken}`,
            "user-agent": SPOT_GRPC_USER_AGENT
        });

        const chunks: Buffer[] = [];
        let grpcStatus: string | undefined;
        let grpcMessage: string | undefined;
        let httpStatus: number | undefined;

        req.setTimeout(20_000, () => {
            req.close();
            finish(new Error("Spot gRPC request timed out"));
        });

        req.on("response", headers => {
            httpStatus = Number(headers[":status"] ?? 0);
            if (headers["grpc-status"] !== undefined) grpcStatus = String(headers["grpc-status"]);
            if (headers["grpc-message"] !== undefined) grpcMessage = String(headers["grpc-message"]);
        });

        req.on("trailers", trailers => {
            if (trailers["grpc-status"] !== undefined) grpcStatus = String(trailers["grpc-status"]);
            if (trailers["grpc-message"] !== undefined) grpcMessage = String(trailers["grpc-message"]);
        });

        req.on("data", chunk => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        req.on("error", err => finish(err));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            if (httpStatus && httpStatus >= 400) {
                finish(new Error(`Spot gRPC HTTP ${httpStatus}${grpcMessage ? `: ${grpcMessage}` : ""}`));
                return;
            }
            if (grpcStatus !== undefined && grpcStatus !== "0") {
                finish(new Error(`Spot gRPC error ${grpcStatus}${grpcMessage ? `: ${grpcMessage}` : ""}`));
                return;
            }
            finish(undefined, body);
        });

        req.end(frame);
    });
}

export function extractCanonicIdFromMetadata(meta: ProtoDeviceMetadata): string | null {
    const trackerId = meta.identifierInformation?.trackerInformation?.canonicIds?.[0];
    if (trackerId) return trackerId;
    const phoneId = meta.identifierInformation?.phoneInformation?.canonicIds?.[0];
    if (phoneId) return phoneId;
    return null;
}

export class GoogleFindClient {
    private auth: GoogleFindAuthManager;
    private deps: GoogleFindClientDeps;
    private readonly fmdClientUuid = randomUuid();

    constructor(auth: GoogleFindAuthManager, deps: GoogleFindClientDeps = {}) {
        this.auth = auth;
        this.deps = deps;
    }

    private async postNova(endpoint: string, body: Buffer): Promise<Buffer> {
        const post = this.deps.novaPost ?? defaultNovaPost;
        let token = await this.auth.getServiceToken("adm", false);
        let res = await post(endpoint, body, token);
        if (res.status === 401) {
            token = await this.auth.getServiceToken("adm", true);
            res = await post(endpoint, body, token);
        }
        if (res.status < 200 || res.status >= 300) {
            const snippet = res.data
                .toString("utf8")
                .replace(/[^\x20-\x7e]+/g, " ")
                .replace(/(Bearer\s+[^\s,;]+|ya29\.[^\s&]+)/gi, "[REDACTED]")
                .trim()
                .slice(0, 160);
            throw new Error(`Nova ${endpoint} failed with HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`);
        }
        return res.data;
    }

    async getEidInfoForE2eeDevices(ownerKeyVersion = -1): Promise<GetEidInfoResponse> {
        const grpcCall = this.deps.spotGrpcCall ?? defaultSpotGrpcCall;
        const reqBuf = encodeGetEidInfoForE2eeDevicesRequest({
            ownerKeyVersion,
            hasOwnerKeyVersion: true
        });
        const frame = encodeGrpcFrame(reqBuf);

        let token = await this.auth.getServiceToken("spot", false);
        let resFrame: Buffer;
        try {
            resFrame = await grpcCall(SPOT_GRPC_PATH, frame, token);
        } catch (err: any) {
            const msg = String(err?.message ?? "");
            if (/\b401\b/.test(msg) || /\berror 16\b/i.test(msg) || /UNAUTHENTICATED/i.test(msg)) {
                token = await this.auth.getServiceToken("spot", true);
                resFrame = await grpcCall(SPOT_GRPC_PATH, frame, token);
            } else {
                throw err;
            }
        }
        return decodeGetEidInfoForE2eeDevicesResponse(decodeGrpcFrame(resFrame));
    }

    async listDevices(deviceTypes: NovaDeviceType[] = [NovaDeviceType.SPOT_DEVICE, NovaDeviceType.ANDROID_DEVICE]): Promise<ProtoDeviceMetadata[]> {
        const byId = new Map<string, ProtoDeviceMetadata>();
        const unkeyed: ProtoDeviceMetadata[] = [];

        for (const type of deviceTypes) {
            const reqBuf = encodeDevicesListRequest({
                type,
                devicesListRequestUuid: randomUuid()
            });
            const resBuf = await this.postNova("nbe_list_devices", reqBuf);
            const list = decodeDevicesList(resBuf);
            for (const meta of list.deviceMetadata) {
                const canonicId = extractCanonicIdFromMetadata(meta);
                if (!canonicId) {
                    unkeyed.push(meta);
                    continue;
                }
                const key = canonicId.toLowerCase();
                const existing = byId.get(key);
                if (!existing) {
                    byId.set(key, meta);
                } else {
                    // Prefer whichever copy carries richer information/reports while preserving metadata/images
                    const existingReports =
                        existing.information?.reports?.length ??
                        existing.phoneInformation?.deviceInformation?.reports?.length ??
                        existing.identifierInformation?.phoneInformation?.deviceInformation?.reports?.length ??
                        0;
                    const nextReports =
                        meta.information?.reports?.length ??
                        meta.phoneInformation?.deviceInformation?.reports?.length ??
                        meta.identifierInformation?.phoneInformation?.deviceInformation?.reports?.length ??
                        0;
                    const primary = nextReports > existingReports ? meta : existing;
                    const secondary = nextReports > existingReports ? existing : meta;
                    byId.set(key, {
                        ...secondary,
                        ...primary,
                        userDefinedDeviceName: primary.userDefinedDeviceName || secondary.userDefinedDeviceName,
                        phoneInformation: primary.phoneInformation ?? secondary.phoneInformation,
                        information: primary.information ?? secondary.information,
                        imageInformation: primary.imageInformation ?? secondary.imageInformation,
                        deviceCategory: primary.deviceCategory ?? secondary.deviceCategory
                    });
                }
            }
        }

        return [...byId.values(), ...unkeyed];
    }

    async locateDevice(params: {
        canonicId: string;
        deviceType?: NovaDeviceType;
        fcmRegistrationId?: string;
        requestUuid?: string;
    }): Promise<string> {
        const requestUuid = params.requestUuid ?? randomUuid();
        const reqBuf = encodeExecuteActionRequest({
            deviceType: params.deviceType ?? NovaDeviceType.SPOT_DEVICE,
            canonicId: params.canonicId,
            requestUuid,
            fmdClientUuid: this.fmdClientUuid,
            fcmRegistrationId: params.fcmRegistrationId,
            action: {
                kind: "locateTracker",
                contributors: [ExecuteActionLocationType.FMDN_ALL_LOCATIONS],
                lastHighPrecisionLocation: true
            }
        });
        await this.postNova("nbe_execute_action", reqBuf);
        return requestUuid;
    }

    async ringDevice(params: {
        canonicId: string;
        action: "start" | "stop";
        deviceType?: NovaDeviceType;
        component?: GoogleFindSoundComponent;
        fcmRegistrationId?: string;
        requestUuid?: string;
    }): Promise<string> {
        const requestUuid = params.requestUuid ?? randomUuid();
        const protoComponent = componentToProtoEnum(params.component ?? "all");
        const reqBuf = encodeExecuteActionRequest({
            deviceType: params.deviceType ?? NovaDeviceType.SPOT_DEVICE,
            canonicId: params.canonicId,
            requestUuid,
            fmdClientUuid: this.fmdClientUuid,
            fcmRegistrationId: params.fcmRegistrationId,
            action:
                params.action === "start"
                    ? { kind: "startSound", component: protoComponent }
                    : { kind: "stopSound", component: protoComponent }
        });
        logGfindClient(
            `[GFind] ringDevice request canonicId=${params.canonicId} action=${params.action} deviceType=${params.deviceType ?? NovaDeviceType.SPOT_DEVICE} component=${params.component ?? "all"} requestUuid=${requestUuid} hasFcm=${Boolean(params.fcmRegistrationId)}`
        );
        try {
            const resBuf = await this.postNova("nbe_execute_action", reqBuf);
            logGfindClient(
                `[GFind] ringDevice ok canonicId=${params.canonicId} action=${params.action} requestUuid=${requestUuid} resBytes=${resBuf.length} resHex=${resBuf.toString("hex").slice(0, 200)}`
            );
            return requestUuid;
        } catch (err: any) {
            logGfindClient(
                `[GFind] ringDevice failed canonicId=${params.canonicId} action=${params.action} requestUuid=${requestUuid}: ${err?.message ?? err}`,
                "warn"
            );
            throw err;
        }
    }
}
