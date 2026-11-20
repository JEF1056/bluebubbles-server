import axios from "axios";
import crypto from "crypto";
import tls from "tls";
import { GoogleFindAuthManager } from "./gfindAuth";
import { hkdfSha256 } from "./gfindCrypto";
import {
    decodeDeviceUpdate,
    decodeMcsDataMessageStanza,
    decodeMcsLoginResponse,
    encodeMcsHeartbeatAck,
    encodeMcsHeartbeatPing,
    encodeMcsLoginRequest,
    encodeMcsSelectiveAck,
    MCS_TAG_CLOSE,
    MCS_TAG_DATA_MESSAGE_STANZA,
    MCS_TAG_HEARTBEAT_ACK,
    MCS_TAG_HEARTBEAT_PING,
    MCS_TAG_LOGIN_RESPONSE,
    MCS_TAG_STREAM_ERROR_STANZA,
    MCS_VERSION,
    McsDataMessageStanza,
    McsFrameReader,
    ProtoDeviceUpdate
} from "./gfindProto";

const C2DM_REGISTER_URL = "https://android.clients.google.com/c2dm/register3";
const FCM_PROJECT_ID = "google.com:api-project-289722593072";
const FIS_INSTALL_URL = `https://firebaseinstallations.googleapis.com/v1/projects/${FCM_PROJECT_ID}/installations`;
const FCM_REGISTER_URL = `https://fcmregistrations.googleapis.com/v1/projects/${FCM_PROJECT_ID}/registrations`;
const GCM_SERVER_KEY_B64 =
    "BDOU99-h67HcA6JeFXHbSNMu7e2yNNu3RzoMj8TM4W88jITfq7ZmPvIM1Iv-4_l2LxQcYwhqby2xGpWwzjfAnG4";
const FCM_APP_ID = "1:289722593072:android:3cfcf5bc359f0308";
const FCM_API_KEY = "AIzaSyD_gko3P392v6how2H7UpdeXQ0v2HLettc";
const ADM_PACKAGE = "com.google.android.apps.adm";
const ADM_CERT_SHA1 = "38918a453d07199354f8b19af05ec6562ced5788";

function randomUuidV4(): string {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const MCS_HOST = "mtalk.google.com";
const MCS_PORT = 5228;
const HEARTBEAT_INTERVAL_MS = 240_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 120_000;

export interface FcmNotificationEvent {
    stanza: McsDataMessageStanza;
    deviceUpdate?: ProtoDeviceUpdate;
}

export interface GoogleFindFcmDeps {
    httpPost?: (url: string, body: string, headers: Record<string, string>) => Promise<string>;
    connectTls?: (host: string, port: number) => tls.TLSSocket;
}

function fromBase64Url(input: string): Buffer {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + pad, "base64");
}

function decryptWebPushAes128Gcm(params: {
    payload: Buffer;
    privateKeyB64: string;
    publicKeyB64: string;
    authSecretB64: string;
}): Buffer {
    if (params.payload.length < 21) {
        throw new Error("RFC 8291 WebPush payload too short");
    }
    const salt = params.payload.subarray(0, 16);
    const rs = params.payload.readUInt32BE(16);
    const idLen = params.payload[20];
    const headerLen = 21 + idLen;
    if (rs < 18 || headerLen >= params.payload.length) {
        throw new Error("Invalid RFC 8291 header");
    }
    const serverPub = params.payload.subarray(21, headerLen);
    const encrypted = params.payload.subarray(headerLen);

    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(params.privateKeyB64, "base64"));
    const sharedSecret = ecdh.computeSecret(serverPub);
    const uaPublic = Buffer.from(params.publicKeyB64, "base64");
    const authSecret = Buffer.from(params.authSecretB64, "base64");

    const keyInfo = Buffer.concat([Buffer.from("WebPush: info\x00", "latin1"), uaPublic, serverPub]);
    const ikm = hkdfSha256(sharedSecret, authSecret, keyInfo, 32);
    const cek = hkdfSha256(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\x00", "latin1"), 16);
    const nonceBase = hkdfSha256(ikm, salt, Buffer.from("Content-Encoding: nonce\x00", "latin1"), 12);

    const ciphertext = encrypted.subarray(0, encrypted.length - 16);
    const tag = encrypted.subarray(encrypted.length - 16);
    const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonceBase);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Strip RFC 8291 record delimiter (0x02 followed by trailing 0x00 padding)
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0) end -= 1;
    if (end > 0 && plain[end - 1] === 2) end -= 1;
    return plain.subarray(0, end);
}

function decryptWebPushLegacyAesGcm(params: {
    ciphertextWithTag: Buffer;
    saltB64Url: string;
    serverPubB64Url: string;
    privateKeyB64: string;
    publicKeyB64: string;
    authSecretB64: string;
}): Buffer {
    const salt = fromBase64Url(params.saltB64Url);
    const serverPub = fromBase64Url(params.serverPubB64Url);
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(params.privateKeyB64, "base64"));
    const sharedSecret = ecdh.computeSecret(serverPub);
    const uaPublic = Buffer.from(params.publicKeyB64, "base64");
    const authSecret = Buffer.from(params.authSecretB64, "base64");

    const prk = hkdfSha256(sharedSecret, authSecret, Buffer.from("Content-Encoding: auth\x00", "latin1"), 32);
    const context = Buffer.concat([
        Buffer.from("P-256\x00", "latin1"),
        Buffer.from([0, uaPublic.length]),
        uaPublic,
        Buffer.from([0, serverPub.length]),
        serverPub
    ]);
    const cek = hkdfSha256(prk, salt, Buffer.concat([Buffer.from("Content-Encoding: aesgcm\x00", "latin1"), context]), 16);
    const nonce = hkdfSha256(prk, salt, Buffer.concat([Buffer.from("Content-Encoding: nonce\x00", "latin1"), context]), 12);

    const ct = params.ciphertextWithTag.subarray(0, params.ciphertextWithTag.length - 16);
    const tag = params.ciphertextWithTag.subarray(params.ciphertextWithTag.length - 16);
    const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    if (plain.length >= 2) {
        const padLen = plain.readUInt16BE(0);
        if (2 + padLen <= plain.length) {
            return plain.subarray(2 + padLen);
        }
    }
    return plain;
}

function toBase64Url(buf: Buffer): string {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateFirebaseFid(): string {
    const fid = crypto.randomBytes(17);
    fid[0] = 0b01110000 + (fid[0] % 0b00010000);
    return fid.toString("base64");
}

function sanitizeFcmBody(text: string): string {
    return text
        .replace(/(Bearer|AidLogin)\s+[^\s,;]+/gi, "$1 [REDACTED]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
}

function appendJsonFcmCandidates(buf: Buffer, out: Buffer[]): void {
    const text = buf.toString("utf8").trim();
    if (text.startsWith("{")) {
        try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            const data = parsed?.data;
            if (typeof data === "string" && data.trim()) {
                try {
                    out.push(fromBase64Url(data.trim()));
                } catch {
                    // Ignore non-base64 strings
                }
            } else if (data && typeof data === "object" && !Array.isArray(data)) {
                const dataObj = data as Record<string, unknown>;
                const seen = new Set<string>();
                for (const key of ["com.google.android.apps.adm.FCM_PAYLOAD", "payload", "update"]) {
                    const val = dataObj[key];
                    if (typeof val === "string" && val.trim()) {
                        seen.add(key);
                        try {
                            out.push(fromBase64Url(val.trim()));
                        } catch {
                            // Ignore malformed base64
                        }
                    }
                }
                for (const [key, val] of Object.entries(dataObj)) {
                    if (seen.has(key) || typeof val !== "string" || !val.trim()) continue;
                    try {
                        out.push(fromBase64Url(val.trim()));
                    } catch {
                        // Ignore non-base64 strings
                    }
                }
            }
            for (const key of ["com.google.android.apps.adm.FCM_PAYLOAD", "payload", "update", "fcm_payload"]) {
                const val = parsed?.[key];
                if (typeof val === "string" && val.trim()) {
                    try {
                        out.push(fromBase64Url(val.trim()));
                    } catch {
                        // Ignore non-base64 strings
                    }
                }
            }
        } catch {
            // Not JSON
        }
    }
    out.push(buf);
}

export function extractDeviceUpdateFromStanza(
    stanza: McsDataMessageStanza,
    keys?: { privateKeyB64: string; publicKeyB64: string; authSecretB64: string } | null
): ProtoDeviceUpdate | undefined {
    const candidates: Buffer[] = [];
    const lowerMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(stanza.appData)) {
        lowerMap[k.toLowerCase()] = v;
    }

    if (stanza.rawData && stanza.rawData.length > 0) {
        const hasWebPushEnc = Boolean(lowerMap["encryption"] || lowerMap["crypto-key"]);
        let decryptedOk = false;
        // Attempt WebPush decryption when keys exist
        if (keys) {
            const encHeader = lowerMap["encryption"];
            const cryptoKeyHeader = lowerMap["crypto-key"];
            const saltMatch = encHeader?.match(/salt="?([^";,\s]+)"?/i);
            const dhMatch = cryptoKeyHeader?.match(/dh="?([^";,\s]+)"?/i);
            try {
                if (saltMatch && dhMatch) {
                    appendJsonFcmCandidates(
                        decryptWebPushLegacyAesGcm({
                            ciphertextWithTag: stanza.rawData,
                            saltB64Url: saltMatch[1],
                            serverPubB64Url: dhMatch[1],
                            ...keys
                        }),
                        candidates
                    );
                    decryptedOk = true;
                } else {
                    appendJsonFcmCandidates(
                        decryptWebPushAes128Gcm({
                            payload: stanza.rawData,
                            ...keys
                        }),
                        candidates
                    );
                    decryptedOk = true;
                }
            } catch {
                // Decryption failed; only treat rawData as plaintext if it wasn't WebPush-encrypted.
            }
        }
        if (!hasWebPushEnc || !decryptedOk) {
            // Only parse rawData directly when unencrypted (or JSON), avoiding feeding ciphertext into proto decoder.
            if (!hasWebPushEnc) {
                appendJsonFcmCandidates(stanza.rawData, candidates);
            } else {
                try {
                    const asUtf8 = stanza.rawData.toString("utf8").trim();
                    if (asUtf8.startsWith("{")) {
                        appendJsonFcmCandidates(stanza.rawData, candidates);
                    }
                } catch {
                    // Ignore encrypted binary rawData
                }
            }
        }
    }

    for (const [k, v] of Object.entries(stanza.appData)) {
        const kl = k.toLowerCase();
        if (
            kl.includes("fcm_payload") ||
            kl.includes("update") ||
            kl.includes("fmdn") ||
            kl.includes("nova") ||
            kl === "data" ||
            kl === "payload"
        ) {
            const trimmed = v.trim();
            if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
                candidates.push(Buffer.from(trimmed, "hex"));
            } else {
                try {
                    candidates.push(fromBase64Url(trimmed));
                } catch {
                    // Ignore non-base64 strings
                }
            }
        }
    }

    for (const buf of candidates) {
        if (!buf || buf.length === 0) continue;
        try {
            const parsed = decodeDeviceUpdate(buf);
            if (parsed.deviceMetadata || parsed.fcmMetadata) {
                return parsed;
            }
        } catch {
            // Try next candidate
        }
    }
    return undefined;
}

export class GoogleFindFcmClient {
    private auth: GoogleFindAuthManager;
    private deps: GoogleFindFcmDeps;
    private socket: tls.TLSSocket | null = null;
    private reader: McsFrameReader | null = null;
    private running = false;
    private connected = false;
    private backoffMs = BASE_BACKOFF_MS;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private heartbeatWatchdog: NodeJS.Timeout | null = null;
    private lastStreamIdReceived = 0;
    private listeners = new Set<(event: FcmNotificationEvent) => void>();

    constructor(auth: GoogleFindAuthManager, deps: GoogleFindFcmDeps = {}) {
        this.auth = auth;
        this.deps = deps;
    }

    isConnected(): boolean {
        return this.connected;
    }

    async ensureReady(timeoutMs = 8_000): Promise<string | null> {
        if (!this.running) {
            this.start();
        }
        const existing = this.auth.getState().fcmToken;
        if (existing && this.connected) {
            return existing;
        }
        try {
            await this.ensureRegistered();
        } catch {
            // Proceed to wait on active MCS connection if registration fails transiently
        }
        if (this.connected) {
            return this.auth.getState().fcmToken;
        }
        const deadline = Date.now() + timeoutMs;
        while (!this.connected && this.running && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 100));
        }
        return this.auth.getState().fcmToken;
    }

    onNotification(listener: (event: FcmNotificationEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private async postText(url: string, body: string, headers: Record<string, string>): Promise<string> {
        if (this.deps.httpPost) {
            return this.deps.httpPost(url, body, headers);
        }
        const res = await axios.post(url, body, {
            headers,
            responseType: "text",
            timeout: 15_000,
            validateStatus: () => true,
            transformResponse: [d => d]
        });
        const text = typeof res.data === "string" ? res.data : String(res.data ?? "");
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`FCM HTTP ${res.status} (${url.split("?")[0]}): ${sanitizeFcmBody(text) || res.statusText}`);
        }
        return text;
    }

    async ensureRegistered(): Promise<string> {
        const state = this.auth.getState();
        if (state.fcmToken) return state.fcmToken;

        const checkin = await this.auth.ensureCheckin();
        const keys = this.auth.getOrCreateFcmKeys();

        // 1. GCM register for WebPush subtype
        const gcmForm = new URLSearchParams({
            app: "org.chromium.linux",
            "X-subtype": `wp:${ADM_PACKAGE}#${randomUuidV4()}`,
            device: checkin.androidId.toString(),
            sender: GCM_SERVER_KEY_B64
        });
        const gcmText = await this.postText(C2DM_REGISTER_URL, gcmForm.toString(), {
            Authorization: `AidLogin ${checkin.androidId.toString()}:${checkin.securityToken.toString()}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Android-GCM/1.5 (generic_x86 QP1A.190711.020)"
        });
        const gcmMatch = gcmText.match(/token=([^\s]+)/);
        if (!gcmMatch || !gcmMatch[1]?.trim() || /Error=/i.test(gcmText)) {
            throw new Error(`GCM registration failed: ${sanitizeFcmBody(gcmText)}`);
        }
        const gcmToken = gcmMatch[1].trim();

        // 2. Firebase Installations API
        const installHeaders = {
            "Content-Type": "application/json",
            "x-firebase-client": Buffer.from(JSON.stringify({ heartbeats: [], version: 2 })).toString("base64"),
            "x-goog-api-key": FCM_API_KEY,
            "X-Android-Package": ADM_PACKAGE,
            "X-Android-Cert": ADM_CERT_SHA1
        };
        const installText = await this.postText(
            FIS_INSTALL_URL,
            JSON.stringify({
                appId: FCM_APP_ID,
                authVersion: "FIS_v2",
                fid: generateFirebaseFid(),
                sdkVersion: "w:0.6.6"
            }),
            installHeaders
        );
        let fisAuthToken = "";
        try {
            const installJson = JSON.parse(installText) as { authToken?: { token?: string } };
            fisAuthToken = String(installJson?.authToken?.token ?? "").trim();
        } catch {
            throw new Error(`Firebase installation returned invalid JSON: ${sanitizeFcmBody(installText)}`);
        }
        if (!fisAuthToken) {
            throw new Error(`Firebase installation missing authToken: ${sanitizeFcmBody(installText)}`);
        }

        // 3. FCM WebPush Registration API
        const regText = await this.postText(
            FCM_REGISTER_URL,
            JSON.stringify({
                web: {
                    auth: toBase64Url(Buffer.from(keys.authSecretB64, "base64")),
                    endpoint: `https://fcm.googleapis.com/fcm/send/${gcmToken}`,
                    p256dh: toBase64Url(Buffer.from(keys.publicKeyB64, "base64"))
                }
            }),
            {
                "Content-Type": "application/json",
                "x-goog-api-key": FCM_API_KEY,
                "x-goog-firebase-installations-auth": fisAuthToken,
                "X-Android-Package": ADM_PACKAGE,
                "X-Android-Cert": ADM_CERT_SHA1
            }
        );
        let fcmToken = "";
        try {
            const regJson = JSON.parse(regText) as { token?: string };
            fcmToken = String(regJson?.token ?? "").trim();
        } catch {
            throw new Error(`FCM registration returned invalid JSON: ${sanitizeFcmBody(regText)}`);
        }
        if (!fcmToken) {
            throw new Error(`FCM registration missing token: ${sanitizeFcmBody(regText)}`);
        }

        this.auth.setFcmToken(fcmToken);
        return fcmToken;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.backoffMs = BASE_BACKOFF_MS;
        void this.connectOnce();
    }

    stop(): void {
        this.running = false;
        this.connected = false;
        this.clearTimers();
        this.destroySocket();
    }

    private clearTimers(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.heartbeatWatchdog) {
            clearTimeout(this.heartbeatWatchdog);
            this.heartbeatWatchdog = null;
        }
    }

    private destroySocket(): void {
        if (this.socket) {
            try {
                this.socket.removeAllListeners();
                this.socket.destroy();
            } catch {
                // Ignore socket cleanup errors
            }
            this.socket = null;
        }
        this.reader = null;
    }

    private scheduleReconnect(): void {
        if (!this.running || this.reconnectTimer) return;
        const jitter = Math.floor(Math.random() * 500);
        const delay = Math.min(MAX_BACKOFF_MS, this.backoffMs) + jitter;
        this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.running) void this.connectOnce();
        }, delay);
        this.reconnectTimer.unref?.();
    }

    private async connectOnce(): Promise<void> {
        if (!this.running) return;
        try {
            const checkin = await this.auth.ensureCheckin();
            if (!this.running) return;
            await this.ensureRegistered().catch(() => undefined);
            if (!this.running) return;

            const sock = this.deps.connectTls
                ? this.deps.connectTls(MCS_HOST, MCS_PORT)
                : tls.connect({ host: MCS_HOST, port: MCS_PORT, servername: MCS_HOST });

            this.socket = sock;
            this.reader = new McsFrameReader(true);
            this.lastStreamIdReceived = 0;

            const onConnect = () => {
                if (!this.running || this.socket !== sock) return;
                const state = this.auth.getState();
                const loginFrame = encodeMcsLoginRequest({
                    androidId: checkin.androidId,
                    securityToken: checkin.securityToken,
                    receivedPersistentIds: state.persistentIds.slice(-50)
                });
                sock.write(Buffer.concat([Buffer.from([MCS_VERSION]), loginFrame]));
            };

            sock.once("secureConnect", onConnect);
            sock.on("data", chunk => {
                this.handleChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            sock.on("error", () => {
                this.handleDisconnect();
            });
            sock.on("close", () => {
                this.handleDisconnect();
            });
        } catch {
            this.handleDisconnect();
        }
    }

    private handleDisconnect(): void {
        const wasConnected = this.connected;
        this.connected = false;
        this.clearTimers();
        this.destroySocket();
        if (wasConnected) {
            this.backoffMs = BASE_BACKOFF_MS;
        }
        this.scheduleReconnect();
    }

    private resetHeartbeatWatchdog(): void {
        if (this.heartbeatWatchdog) {
            clearTimeout(this.heartbeatWatchdog);
            this.heartbeatWatchdog = null;
        }
    }

    private startHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            if (!this.socket || !this.connected) return;
            try {
                this.socket.write(encodeMcsHeartbeatPing(undefined, this.lastStreamIdReceived || undefined));
                if (this.heartbeatWatchdog) clearTimeout(this.heartbeatWatchdog);
                this.heartbeatWatchdog = setTimeout(() => {
                    this.handleDisconnect();
                }, HEARTBEAT_TIMEOUT_MS);
                this.heartbeatWatchdog.unref?.();
            } catch {
                this.handleDisconnect();
            }
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimer.unref?.();
    }

    private handleChunk(chunk: Buffer): void {
        if (!this.reader) return;
        let frames;
        try {
            frames = this.reader.push(chunk);
        } catch {
            this.handleDisconnect();
            return;
        }

        for (const frame of frames) {
            this.resetHeartbeatWatchdog();
            if (frame.tag === MCS_TAG_LOGIN_RESPONSE) {
                const login = decodeMcsLoginResponse(frame.payload);
                if (login.errorCode && login.errorCode !== 0) {
                    this.handleDisconnect();
                    return;
                }
                this.connected = true;
                this.backoffMs = BASE_BACKOFF_MS;
                this.startHeartbeat();
            } else if (frame.tag === MCS_TAG_HEARTBEAT_PING) {
                this.socket?.write(encodeMcsHeartbeatAck(undefined, this.lastStreamIdReceived || undefined));
            } else if (frame.tag === MCS_TAG_HEARTBEAT_ACK) {
                // Keepalive acknowledged
            } else if (frame.tag === MCS_TAG_CLOSE || frame.tag === MCS_TAG_STREAM_ERROR_STANZA) {
                this.handleDisconnect();
                return;
            } else if (frame.tag === MCS_TAG_DATA_MESSAGE_STANZA) {
                const stanza = decodeMcsDataMessageStanza(frame.payload);
                if (stanza.streamId !== undefined) {
                    this.lastStreamIdReceived = stanza.streamId;
                }
                if (stanza.persistentId) {
                    try {
                        this.socket?.write(encodeMcsSelectiveAck([stanza.persistentId]));
                    } catch {
                        // Ignore socket write failures during shutdown
                    }
                    if (!this.auth.recordPersistentId(stanza.persistentId)) {
                        continue;
                    }
                }
                const deviceUpdate = extractDeviceUpdateFromStanza(stanza, this.auth.getState().fcmKeys);
                const event: FcmNotificationEvent = { stanza, deviceUpdate };
                for (const listener of this.listeners) {
                    try {
                        listener(event);
                    } catch {
                        // Isolate listener failures
                    }
                }
            }
        }
    }
}
