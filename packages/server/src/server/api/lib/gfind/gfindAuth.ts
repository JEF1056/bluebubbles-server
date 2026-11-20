import axios from "axios";
import crypto from "crypto";
import { deleteEncryptedJson, readEncryptedJson, TrackerCommonDeps, writeEncryptedJson } from "../findmy/trackerCommon";
import {
    AndroidCheckinCredentials,
    decodeAndroidCheckinResponse,
    encodeAndroidCheckinRequest,
    encodeEncryptionUnlockRequestExtras
} from "./gfindProto";
import { decryptOwnerKey, extractFinderHwDomainKey } from "./gfindCrypto";

export const GFIND_AUTH_FILE = "gfind-auth.enc.json";
const DEFAULT_TOKEN_TTL_MS = 50 * 60 * 1000;
const GOOGLE_AUTH_URL = "https://android.clients.google.com/auth";
const GOOGLE_CHECKIN_URL = "https://android.clients.google.com/checkin";
const ADM_CLIENT_SIG = "38918a453d07199354f8b19af05ec6562ced5788";

export interface CachedServiceToken {
    token: string;
    expiresAt: number;
}

export interface FcmKeyPairData {
    privateKeyB64: string;
    publicKeyB64: string;
    authSecretB64: string;
}

export interface GoogleFindAuthState {
    email: string | null;
    aasToken: string | null;
    androidId: string | null;
    securityToken: string | null;
    fcmToken: string | null;
    fcmKeys: FcmKeyPairData | null;
    persistentIds: string[];
    admToken: CachedServiceToken | null;
    spotToken: CachedServiceToken | null;
    ownerKeyHex: string | null;
    ownerKeyVersion: number | null;
    ownerKeyMismatch: boolean;
}

export interface GoogleFindAuthDeps {
    trackerDeps?: TrackerCommonDeps;
    httpPost?: (url: string, body: Buffer | string, headers: Record<string, string>) => Promise<Buffer>;
    now?: () => number;
}

function emptyAuthState(): GoogleFindAuthState {
    return {
        email: null,
        aasToken: null,
        androidId: null,
        securityToken: null,
        fcmToken: null,
        fcmKeys: null,
        persistentIds: [],
        admToken: null,
        spotToken: null,
        ownerKeyHex: null,
        ownerKeyVersion: null,
        ownerKeyMismatch: false
    };
}

function sanitizeHttpBody(text: string): string {
    return text
        .replace(/(Bearer|AidLogin)\s+[^\s,;]+/gi, "$1 [REDACTED]")
        .replace(/(oauth2rt_[^\s&]+|aas_et\/[^\s&]+|ya29\.[^\s&]+)/gi, "[REDACTED]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
}

async function defaultHttpPost(url: string, body: Buffer | string, headers: Record<string, string>): Promise<Buffer> {
    const res = await axios.post(url, body, {
        headers,
        responseType: "arraybuffer",
        timeout: 20_000,
        validateStatus: () => true
    });
    const buf = Buffer.from(res.data ?? "");
    if (res.status < 200 || res.status >= 300) {
        const text = buf.toString("utf8");
        const parsed = parseKeyValueResponse(text);
        const detail = parsed.Error || sanitizeHttpBody(text) || res.statusText || "Request failed";
        throw new Error(`Google HTTP ${res.status} (${url.split("?")[0]}): ${detail}`);
    }
    return buf;
}

function parseKeyValueResponse(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const idx = rawLine.indexOf("=");
        if (idx <= 0) continue;
        const k = rawLine.slice(0, idx).trim();
        const v = rawLine.slice(idx + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

export function encodeEncryptionUnlockKdi(securityDomain = "finder_hw"): string {
    return encodeEncryptionUnlockRequestExtras(securityDomain).toString("base64");
}

export function getEncryptionUnlockUrl(securityDomain = "finder_hw"): string {
    const kdi = encodeEncryptionUnlockKdi(securityDomain);
    return `https://accounts.google.com/encryption/unlock/android?kdi=${encodeURIComponent(kdi)}`;
}

export class GoogleFindAuthManager {
    private state: GoogleFindAuthState = emptyAuthState();
    private loaded = false;
    private deps: GoogleFindAuthDeps;

    constructor(deps: GoogleFindAuthDeps = {}) {
        this.deps = deps;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    private post(url: string, body: Buffer | string, headers: Record<string, string>): Promise<Buffer> {
        const fn = this.deps.httpPost ?? defaultHttpPost;
        return fn(url, body, headers);
    }

    load(): GoogleFindAuthState {
        if (this.loaded) return this.state;
        const stored = readEncryptedJson<Partial<GoogleFindAuthState>>(GFIND_AUTH_FILE, this.deps.trackerDeps);
        this.state = { ...emptyAuthState(), ...(stored ?? {}) };
        if (!Array.isArray(this.state.persistentIds)) {
            this.state.persistentIds = [];
        }
        this.loaded = true;
        return this.state;
    }

    private save(): void {
        writeEncryptedJson(GFIND_AUTH_FILE, this.state, this.deps.trackerDeps);
    }

    getState(): GoogleFindAuthState {
        return this.load();
    }

    isSignedIn(): boolean {
        const s = this.load();
        return Boolean(s.aasToken);
    }

    getOwnerKey(): Buffer | null {
        const s = this.load();
        if (!s.ownerKeyHex) return null;
        return Buffer.from(s.ownerKeyHex, "hex");
    }

    getOwnerKeyVersion(): number | null {
        return this.load().ownerKeyVersion;
    }

    setOwnerKeyMismatch(mismatch: boolean): void {
        const s = this.load();
        if (s.ownerKeyMismatch !== mismatch) {
            s.ownerKeyMismatch = mismatch;
            this.save();
        }
    }

    getOrCreateFcmKeys(): FcmKeyPairData {
        const s = this.load();
        if (s.fcmKeys?.privateKeyB64 && s.fcmKeys?.publicKeyB64 && s.fcmKeys?.authSecretB64) {
            return s.fcmKeys;
        }
        const ecdh = crypto.createECDH("prime256v1");
        ecdh.generateKeys();
        const keys: FcmKeyPairData = {
            privateKeyB64: (ecdh.getPrivateKey() as Buffer).toString("base64"),
            publicKeyB64: (ecdh.getPublicKey() as Buffer).toString("base64"),
            authSecretB64: crypto.randomBytes(16).toString("base64")
        };
        s.fcmKeys = keys;
        this.save();
        return keys;
    }

    setFcmToken(token: string): void {
        const s = this.load();
        s.fcmToken = token;
        this.save();
    }

    recordPersistentId(id: string): boolean {
        const s = this.load();
        if (s.persistentIds.includes(id)) return false;
        s.persistentIds.push(id);
        if (s.persistentIds.length > 200) {
            s.persistentIds = s.persistentIds.slice(-200);
        }
        this.save();
        return true;
    }

    async ensureCheckin(): Promise<AndroidCheckinCredentials> {
        const s = this.load();
        if (s.androidId && s.securityToken) {
            return {
                androidId: BigInt(s.androidId),
                securityToken: BigInt(s.securityToken)
            };
        }

        const reqBuf = encodeAndroidCheckinRequest();
        const resBuf = await this.post(GOOGLE_CHECKIN_URL, reqBuf, {
            "Content-Type": "application/x-protobuf",
            "User-Agent": "Android-Checkin/2.0 (generic_x86 QP1A.190711.020); gzip"
        });
        const creds = decodeAndroidCheckinResponse(resBuf);
        s.androidId = creds.androidId.toString();
        s.securityToken = creds.securityToken.toString();
        this.save();
        return creds;
    }

    async exchangeOAuthToken(oauthToken: string, emailHint?: string | null): Promise<GoogleFindAuthState> {
        const token = String(oauthToken ?? "").trim();
        if (!token) {
            throw new Error("Missing oauth_token");
        }
        const checkin = await this.ensureCheckin();

        const form = new URLSearchParams({
            accountType: "HOSTED_OR_GOOGLE",
            ACCESS_TOKEN: "1",
            Token: token,
            service: "ac2dm",
            add_account: "1",
            get_accountid: "1",
            has_permission: "1",
            source: "android",
            google_play_services_version: "240913000",
            client_sig: ADM_CLIENT_SIG,
            callerPkg: "com.google.android.gms",
            callerSig: ADM_CLIENT_SIG,
            androidId: checkin.androidId.toString(16),
            device_country: "us",
            operatorCountry: "us",
            lang: "en",
            sdk_version: "17",
            droidguard_results: "dummy123"
        });
        if (emailHint) {
            form.set("Email", emailHint);
        }

        const resBuf = await this.post(GOOGLE_AUTH_URL, form.toString(), {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "GoogleAuth/1.4",
            "Accept-Encoding": "identity"
        });
        const parsed = parseKeyValueResponse(resBuf.toString("utf8"));
        const aasToken = parsed.Token || parsed.Auth;
        if (parsed.Error || !aasToken) {
            throw new Error(`Google gpsoauth exchange failed: ${parsed.Error || "missing AAS Token"}`);
        }

        const s = this.load();
        const nextEmail = parsed.Email || emailHint || null;
        const sameEmail = Boolean(s.email && nextEmail && s.email.toLowerCase() === nextEmail.toLowerCase());
        const accountChanged = Boolean((s.email || s.aasToken) && !sameEmail);
        if (accountChanged) {
            s.ownerKeyHex = null;
            s.ownerKeyVersion = null;
            s.ownerKeyMismatch = false;
            s.fcmToken = null;
            s.persistentIds = [];
            s.email = nextEmail;
        } else {
            s.email = nextEmail || s.email || null;
        }
        s.aasToken = aasToken;
        s.admToken = null;
        s.spotToken = null;
        this.save();
        return s;
    }

    async getServiceToken(kind: "adm" | "spot", forceRefresh = false): Promise<string> {
        const s = this.load();
        if (!s.aasToken) {
            throw new Error("Google Find Hub is not signed in");
        }
        const existing = kind === "adm" ? s.admToken : s.spotToken;
        if (!forceRefresh && existing && existing.expiresAt > this.now() + 30_000) {
            return existing.token;
        }

        const checkin = await this.ensureCheckin();
        const scope =
            kind === "adm"
                ? "oauth2:https://www.googleapis.com/auth/android_device_manager"
                : "oauth2:https://www.googleapis.com/auth/spot";
        const app = kind === "adm" ? "com.google.android.apps.adm" : "com.google.android.gms";

        const form = new URLSearchParams({
            accountType: "HOSTED_OR_GOOGLE",
            EncryptedPasswd: s.aasToken,
            service: scope,
            app,
            client_sig: ADM_CLIENT_SIG,
            callerPkg: "com.google.android.gms",
            callerSig: ADM_CLIENT_SIG,
            has_permission: "1",
            source: "android",
            google_play_services_version: "240913000",
            androidId: checkin.androidId.toString(16),
            device_country: "us",
            operatorCountry: "us",
            lang: "en",
            sdk_version: "17"
        });
        if (s.email) {
            form.set("Email", s.email);
        }

        const resBuf = await this.post(GOOGLE_AUTH_URL, form.toString(), {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "GoogleAuth/1.4",
            "Accept-Encoding": "identity"
        });
        const parsed = parseKeyValueResponse(resBuf.toString("utf8"));
        const serviceToken = parsed.Auth || parsed.Token;
        if (parsed.Error || !serviceToken) {
            throw new Error(`Google service token exchange (${kind}) failed: ${parsed.Error || "missing Auth"}`);
        }

        const expirySec = parsed.Expiry ? Number(parsed.Expiry) : NaN;
        const expiresAt = Number.isFinite(expirySec) && expirySec > 1_000_000_000
            ? expirySec * 1000
            : this.now() + DEFAULT_TOKEN_TTL_MS;

        const tokenObj: CachedServiceToken = { token: serviceToken, expiresAt };
        if (kind === "adm") s.admToken = tokenObj;
        else s.spotToken = tokenObj;
        this.save();
        return tokenObj.token;
    }

    unwrapAndStoreOwnerKey(params: {
        vaultKeysPayload: unknown;
        encryptedOwnerKey: Buffer;
        ownerKeyVersion: number;
    }): { ownerKey: Buffer; ownerKeyVersion: number } {
        const domainKey = extractFinderHwDomainKey(params.vaultKeysPayload);
        const ownerKey = decryptOwnerKey(domainKey, params.encryptedOwnerKey);
        const s = this.load();
        s.ownerKeyHex = ownerKey.toString("hex");
        s.ownerKeyVersion = params.ownerKeyVersion;
        s.ownerKeyMismatch = false;
        this.save();
        return { ownerKey, ownerKeyVersion: params.ownerKeyVersion };
    }

    clear(): void {
        this.state = emptyAuthState();
        this.loaded = true;
        deleteEncryptedJson(GFIND_AUTH_FILE, this.deps.trackerDeps);
    }
}
