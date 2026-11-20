import {
    CLIENT_ID_LOGIN,
    CLIENT_ID_ONECONNECT,
    ONECONNECT_SCOPE,
    SamsungEntryPoint,
    UTagGeoPayload,
    generatePkcePair,
    generateState
} from "./utagCrypto";
import type { SmartThingsTagDevice } from "./utagMapper";

function logUtag(msg: string, level: "info" | "warn" = "info"): void {
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

export interface UTagTokens {
    userAuthToken: string;
    userAuthRefreshToken?: string;
    iotToken: string;
    iotRefreshToken?: string;
    userId?: string;
    loginId?: string;
    authServerUrl: string;
    deviceId: string;
    expiresAt?: number;
}

export interface UTagClientDeps {
    fetchFn?: typeof fetch;
    onTokensUpdated?: (tokens: UTagTokens) => void | Promise<void>;
}

export interface FmeGeolocationEntry extends UTagGeoPayload {
    deviceId?: string;
    lastUpdateTime?: number;
    battery?: string | number;
    [key: string]: unknown;
}

export interface FmeKeyPair {
    userId?: string | null;
    privateKey?: string | null;
    publicKey?: string | null;
    iv?: string | null;
    regDate?: string | null;
}

export interface FmeGeolocationResult {
    geo: FmeGeolocationEntry | null;
    keyPair: FmeKeyPair | null;
}

const SMARTTHINGS_CLIENT_API = "https://client.smartthings.com";
const SMARTTHINGS_API = "https://api.smartthings.com";
const FME_PLUGIN_ID = "com.samsung.android.plugin.fme";
const SAMSUNG_ENTRY_POINT_URL = "https://account.samsung.com/accounts/ANDROIDSDK/getEntryPoint";

const ospHeaders = (): Record<string, string> => ({
    "X-Osp-Clientosversion": "34",
    "X-Osp-Clientmodel": "Pixel",
    "X-Osp-Appid": CLIENT_ID_LOGIN,
    "X-Osp-Packagename": "com.samsung.android.oneconnect",
    "X-Osp-Packageversion": "1.8.21.28"
});

const formatErrorReason = (data: unknown): string => {
    if (!data) return "";
    if (typeof data === "string") {
        const trimmed = data.replace(/\s+/g, " ").trim();
        return trimmed ? `: ${trimmed.slice(0, 120)}` : "";
    }
    if (typeof data === "object") {
        const obj = data as Record<string, unknown>;
        const reason = obj.error_description ?? obj.error ?? obj.message ?? obj.error_code;
        if (typeof reason === "string" && reason.trim()) {
            return `: ${reason.trim().slice(0, 160)}`;
        }
    }
    return "";
};

export class UTagHttpError extends Error {
    status: number;
    body: unknown;

    constructor(message: string, status: number, body?: unknown) {
        super(message);
        this.name = "UTagHttpError";
        this.status = status;
        this.body = body;
    }
}

const parseJsonSafe = async (res: Response): Promise<any> => {
    const text = await res.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

export class UTagClient {
    private tokens: UTagTokens | null = null;
    private fmeInstalledAppId: string | null = null;
    private refreshInFlight: Promise<UTagTokens> | null = null;
    private termsAgreedDenied = false;
    private shareableDeniedDevices = new Set<string>();
    private readonly fetchFn: typeof fetch;
    private readonly onTokensUpdated?: (tokens: UTagTokens) => void | Promise<void>;

    constructor(tokens?: UTagTokens | null, deps?: UTagClientDeps) {
        this.tokens = tokens ?? null;
        this.fetchFn = deps?.fetchFn ?? fetch;
        this.onTokensUpdated = deps?.onTokensUpdated;
    }

    setTokens(tokens: UTagTokens | null): void {
        const prevUserId = this.tokens?.userId;
        const prevAuthToken = this.tokens?.userAuthToken;
        this.tokens = tokens;
        if (!tokens || tokens.userId !== prevUserId || tokens.userAuthToken !== prevAuthToken) {
            this.termsAgreedDenied = false;
            this.shareableDeniedDevices.clear();
        }
        if (!tokens) this.fmeInstalledAppId = null;
    }

    getTokens(): UTagTokens | null {
        return this.tokens;
    }

    private normalizeAuthBase(authServerUrl: string): string {
        const trimmed = authServerUrl.trim().replace(/\/+$/, "");
        return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
    }

    async fetchEntryPoint(): Promise<SamsungEntryPoint> {
        const res = await this.fetchFn(SAMSUNG_ENTRY_POINT_URL, {
            method: "GET",
            headers: { Accept: "application/json", ...ospHeaders() }
        });
        const data = await parseJsonSafe(res);
        if (!res.ok || !data?.pkiPublicKey || !data?.chkDoNum) {
            throw new UTagHttpError(
                `Failed to fetch Samsung sign-in entryPoint (${res.status})${formatErrorReason(data)}`,
                res.status,
                data
            );
        }
        return {
            signInUrl: data.signInURI ?? data.signInUrl,
            pkiPublicKey: String(data.pkiPublicKey),
            chkDoNum: String(data.chkDoNum),
            countryCode: data.countryCode
        };
    }

    async exchangeAuthCode(params: {
        code: string;
        codeVerifier: string;
        authServerUrl: string;
        deviceId: string;
        username?: string;
    }): Promise<{ userAuthToken: string; userAuthRefreshToken?: string; userId?: string; authServerUrl: string }> {
        const authBase = this.normalizeAuthBase(params.authServerUrl);
        const body = new URLSearchParams({
            grant_type: "authorization_code",
            serviceType: "M",
            code: params.code,
            client_id: CLIENT_ID_LOGIN,
            code_verifier: params.codeVerifier,
            physical_address_text: params.deviceId,
            ...(params.username ? { username: params.username } : {})
        });

        const res = await this.fetchFn(`${authBase}/auth/oauth2/authenticate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
                ...ospHeaders()
            },
            body: body.toString()
        });
        const data = await parseJsonSafe(res);
        const userAuthToken = data?.userauth_token ?? data?.access_token;
        if (!res.ok || !userAuthToken) {
            throw new UTagHttpError(
                `Samsung auth code exchange failed (${res.status})${formatErrorReason(data)}`,
                res.status,
                data
            );
        }
        return {
            userAuthToken,
            userAuthRefreshToken: data.refresh_token,
            userId: data.userId ?? data.user_id,
            authServerUrl: authBase
        };
    }

    async authorizeOneConnect(params: {
        userAuthToken: string;
        authServerUrl: string;
        deviceId: string;
        userId?: string;
        loginId?: string;
        userAuthRefreshToken?: string;
    }): Promise<UTagTokens> {
        const authBase = this.normalizeAuthBase(params.authServerUrl);
        const pkce = generatePkcePair();

        const requestAuthorize = async (includeLoginId: boolean): Promise<any> => {
            const query = new URLSearchParams({
                response_type: "code",
                serviceType: "M",
                client_id: CLIENT_ID_ONECONNECT,
                code_challenge_method: "S256",
                childAccountSupported: "Y",
                userauth_token: params.userAuthToken,
                code_challenge: pkce.codeChallenge,
                physical_address_text: params.deviceId,
                scope: ONECONNECT_SCOPE
            });
            if (includeLoginId && params.loginId) {
                query.set("login_id", params.loginId);
            }
            const res = await this.fetchFn(`${authBase}/auth/oauth2/v2/authorize?${query.toString()}`, {
                method: "GET",
                headers: { Accept: "application/json", ...ospHeaders() }
            });
            const data = await parseJsonSafe(res);
            return { ok: res.ok, status: res.status, data };
        };

        let authRes = await requestAuthorize(Boolean(params.loginId));
        if (
            !authRes.data?.code &&
            params.loginId &&
            (authRes.data?.privacyAccepted === "N" || authRes.data?.error === "privacy_not_accepted")
        ) {
            authRes = await requestAuthorize(false);
        }
        if (!authRes.ok || !authRes.data?.code) {
            throw new UTagHttpError(
                `OneConnect PKCE authorize failed (${authRes.status})${formatErrorReason(authRes.data)}`,
                authRes.status,
                authRes.data
            );
        }

        const tokenBody = new URLSearchParams({
            grant_type: "authorization_code",
            code: authRes.data.code,
            client_id: CLIENT_ID_ONECONNECT,
            code_verifier: pkce.codeVerifier,
            physical_address_text: params.deviceId
        });

        const tokenRes = await this.fetchFn(`${authBase}/auth/oauth2/token`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
                ...ospHeaders()
            },
            body: tokenBody.toString()
        });
        const tokenData = await parseJsonSafe(tokenRes);
        if (!tokenRes.ok || !tokenData?.access_token) {
            throw new UTagHttpError(
                `OneConnect token exchange failed (${tokenRes.status})${formatErrorReason(tokenData)}`,
                tokenRes.status,
                tokenData
            );
        }

        const nextTokens: UTagTokens = {
            userAuthToken: params.userAuthToken,
            userAuthRefreshToken: params.userAuthRefreshToken,
            iotToken: tokenData.access_token,
            iotRefreshToken: tokenData.refresh_token,
            userId: params.userId ?? tokenData.userId ?? tokenData.user_id,
            loginId: params.loginId,
            authServerUrl: authBase,
            deviceId: params.deviceId,
            expiresAt: tokenData.expires_in ? Date.now() + Number(tokenData.expires_in) * 1000 : undefined
        };

        this.tokens = nextTokens;
        await this.onTokensUpdated?.(nextTokens);
        return nextTokens;
    }

    async refreshIotToken(): Promise<UTagTokens> {
        if (this.refreshInFlight) return this.refreshInFlight;

        this.refreshInFlight = (async (): Promise<UTagTokens> => {
            if (!this.tokens) throw new Error("Not signed in to Samsung SmartThings Find");
            const current = this.tokens;
            const authBase = this.normalizeAuthBase(current.authServerUrl);

            if (current.iotRefreshToken) {
                const res = await this.fetchFn(`${authBase}/auth/oauth2/token`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Accept: "application/json",
                        ...ospHeaders()
                    },
                    body: new URLSearchParams({
                        grant_type: "refresh_token",
                        refresh_token: current.iotRefreshToken,
                        client_id: CLIENT_ID_ONECONNECT
                    }).toString()
                });
                const data = await parseJsonSafe(res);
                if (res.ok && data?.access_token) {
                    const updated: UTagTokens = {
                        ...current,
                        iotToken: data.access_token,
                        iotRefreshToken: data.refresh_token ?? current.iotRefreshToken,
                        expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : current.expiresAt
                    };
                    this.tokens = updated;
                    await this.onTokensUpdated?.(updated);
                    return updated;
                }
            }

            // Fallback: re-authorize OneConnect using userauth_token
            return this.authorizeOneConnect({
                userAuthToken: current.userAuthToken,
                userAuthRefreshToken: current.userAuthRefreshToken,
                authServerUrl: current.authServerUrl,
                deviceId: current.deviceId,
                userId: current.userId,
                loginId: current.loginId
            });
        })();

        try {
            return await this.refreshInFlight;
        } finally {
            this.refreshInFlight = null;
        }
    }

    private async authedRequest(url: string, init: RequestInit = {}, retried401 = false): Promise<any> {
        if (!this.tokens?.iotToken) {
            throw new Error("Missing SmartThings IoT access token");
        }
        const res = await this.fetchFn(url, {
            ...init,
            headers: {
                Accept: "application/json",
                ...(init.body ? { "Content-Type": "application/json" } : {}),
                ...(init.headers ?? {}),
                Authorization: `Bearer ${this.tokens.iotToken}`
            }
        });

        if (res.status === 401 && !retried401) {
            await this.refreshIotToken();
            return this.authedRequest(url, init, true);
        }

        const data = await parseJsonSafe(res);
        if (!res.ok) {
            throw new UTagHttpError(`SmartThings request failed (${res.status})`, res.status, data);
        }
        return data;
    }

    async getSmartTagDevices(): Promise<SmartThingsTagDevice[]> {
        const tags: SmartThingsTagDevice[] = [];
        let nextUrl: string | null = `${SMARTTHINGS_CLIENT_API}/devices?includeAllowedActions=false`;

        while (nextUrl) {
            const page = await this.authedRequest(nextUrl);
            const items: any[] = Array.isArray(page?.items) ? page.items : [];
            for (const item of items) {
                if (item?.ocfDeviceType === "x.com.st.d.tag") {
                    tags.push({
                        deviceId: String(item.deviceId),
                        label: item.label,
                        name: item.name,
                        ocfDeviceType: item.ocfDeviceType,
                        deviceManufacturerCode: item.deviceManufacturerCode,
                        manufacturerName: item.manufacturerName,
                        presentationId: item.presentationId,
                        modelName:
                            item.modelName ??
                            item.bleD2D?.metadata?.vendor?.modelName ??
                            item.ocf?.modelNumber ??
                            item.presentationId,
                        icon:
                            item.icon ??
                            item.icons?.iconKey ??
                            item.components?.[0]?.icon ??
                            item.components?.[0]?.categories?.[0]?.name,
                        iconUrl:
                            typeof item.icons?.coloredIcon === "string" && item.icons.coloredIcon.trim()
                                ? item.icons.coloredIcon.trim()
                                : undefined,
                        batteryLevel: item.batteryLevel ?? item.bleD2D?.metadata?.battery?.level,
                        bleD2D: item.bleD2D ?? item.ocf?.bleD2D
                    });
                }
            }
            nextUrl = typeof page?._links?.next?.href === "string" ? page._links.next.href : null;
        }

        // Best-effort single-device fetch when list endpoint omits bleD2D.privacyId for BLE nearby finding
        for (const tag of tags) {
            if (tag.bleD2D?.privacyId) continue;
            try {
                const detail = await this.authedRequest(
                    `${SMARTTHINGS_CLIENT_API}/devices/${encodeURIComponent(tag.deviceId)}`
                );
                let bleD2D = detail?.bleD2D ?? detail?.ocf?.bleD2D;
                if (!bleD2D) {
                    const v1Detail = await this.authedRequest(
                        `${SMARTTHINGS_API}/devices/${encodeURIComponent(tag.deviceId)}`
                    ).catch(() => null);
                    bleD2D = v1Detail?.bleD2D ?? v1Detail?.ocf?.bleD2D;
                }
                if (bleD2D) {
                    tag.bleD2D = bleD2D;
                }
            } catch {
                // Non-fatal: cloud location and ringing still work without bleD2D
            }
        }

        return tags;
    }

    async getFmeInstalledAppId(forceRefresh = false): Promise<string> {
        if (this.fmeInstalledAppId && !forceRefresh) return this.fmeInstalledAppId;

        let nextUrl: string | null = `${SMARTTHINGS_API}/installedapps?allowed=true`;
        while (nextUrl) {
            const data = await this.authedRequest(nextUrl);
            const items: any[] = Array.isArray(data?.items) ? data.items : [];
            const fmeApp = items.find(app => app?.ui?.pluginId === FME_PLUGIN_ID);
            if (fmeApp?.installedAppId) {
                this.fmeInstalledAppId = String(fmeApp.installedAppId);
                return this.fmeInstalledAppId;
            }
            nextUrl = typeof data?._links?.next?.href === "string" ? data._links.next.href : null;
        }
        throw new Error("SmartThings Find (FME) installed app not found on account");
    }

    async executeFme(
        installedAppId: string,
        options: {
            uri: string;
            method: "GET" | "POST" | "PUT" | "DELETE";
            extraUri?: string;
            extraParameters?: Record<string, string>;
            body?: unknown;
        }
    ): Promise<any> {
        const offsetMin = -new Date().getTimezoneOffset();
        const sign = offsetMin >= 0 ? "+" : "-";
        const absMin = Math.abs(offsetMin);
        const timeZoneOffset = `UTC${sign}${String(Math.floor(absMin / 60)).padStart(2, "0")}:${String(
            absMin % 60
        ).padStart(2, "0")}`;

        const payload = {
            client: {
                displayMode: "LIGHT",
                language: "en-US",
                mobileDeviceId: this.tokens?.deviceId ?? "",
                os: "Android",
                samsungAccountId: this.tokens?.userId ?? null,
                supportedTemplates: [
                    "BASIC_V1",
                    "BASIC_V2",
                    "BASIC_V3",
                    "BASIC_V4",
                    "BASIC_V5",
                    "BASIC_V6",
                    "BASIC_V7"
                ],
                timeZoneOffset,
                version: "1.8.21.28"
            },
            parameters: {
                requester: this.tokens?.userId ?? "",
                requesterToken: this.tokens?.iotToken ?? "",
                clientType: "aPlugin",
                clientVersion: "1",
                method: options.method,
                uri: options.uri,
                ...(options.extraUri !== undefined ? { extraUri: options.extraUri } : {}),
                encodedHeaders: "",
                encodedBody:
                    options.body !== undefined
                        ? Buffer.from(JSON.stringify(options.body), "utf8").toString("base64")
                        : "",
                ...(options.extraParameters ?? {})
            }
        };

        const envelope = await this.authedRequest(
            `${SMARTTHINGS_API}/installedapps/${encodeURIComponent(installedAppId)}/execute`,
            {
                method: "POST",
                body: JSON.stringify(payload)
            }
        );
        if (envelope && typeof envelope === "object" && "statusCode" in envelope) {
            const statusCode = Number(envelope.statusCode);
            if (statusCode !== 200) {
                const errCode = envelope.errorCode ? `${envelope.errorCode}: ` : "";
                const msg = typeof envelope.message === "string" ? envelope.message : "";
                throw new UTagHttpError(
                    `FME execute failed (${statusCode})${errCode || msg ? `: ${errCode}${msg}` : ""}`,
                    statusCode,
                    envelope
                );
            }
            const inner = envelope.message ?? null;
            if (inner && typeof inner === "object") {
                const innerCode = Number((inner as any).resultCode ?? (inner as any).statusCode ?? 200);
                if (Number.isFinite(innerCode) && innerCode >= 400) {
                    const innerMsg =
                        (inner as any).resultMessage ?? (inner as any).message ?? (inner as any).error ?? "";
                    throw new UTagHttpError(
                        `FME inner error (${innerCode})${innerMsg ? `: ${innerMsg}` : ""}`,
                        innerCode,
                        inner
                    );
                }
            }
            return inner;
        }
        return envelope;
    }

    async setShareableMembers(installedAppId: string, deviceId: string, userId: string): Promise<void> {
        const trimmedUserId = userId?.trim();
        if (!trimmedUserId) return;
        await this.executeFme(installedAppId, {
            method: "POST",
            uri: "/trackerapi",
            extraUri: `/trackers/${encodeURIComponent(deviceId)}/shareable/members`,
            body: { saGuid: trimmedUserId }
        });
    }

    async setTermsAgreed(installedAppId: string, countryCode = "US"): Promise<void> {
        const encodedAgreement = Buffer.from(
            JSON.stringify([
                { type: "service.location", agreed: true },
                { type: "service.pp", agreed: true }
            ]),
            "utf8"
        ).toString("base64");

        await this.executeFme(installedAppId, {
            method: "POST",
            uri: "/user/options",
            extraParameters: {
                ppVersion: "1.0.0",
                saCountryCode: countryCode,
                fmmAgreement: "true",
                encodedAgreement
            }
        });
    }

    async getTagGeolocation(
        installedAppId: string,
        deviceId: string
    ): Promise<FmeGeolocationResult> {
        const fetchGeo = () =>
            this.executeFme(installedAppId, {
                method: "GET",
                uri: "/trackers/geolocation",
                extraParameters: { stDids: deviceId }
            });

        let data: any;
        try {
            data = await fetchGeo();
        } catch (err) {
            if (err instanceof UTagHttpError && err.status === 403 && !this.termsAgreedDenied) {
                // Remember 403 for this session unless agreeing clears it on retry.
                this.termsAgreedDenied = true;
                await this.setTermsAgreed(installedAppId);
                data = await fetchGeo();
                this.termsAgreedDenied = false;
            } else {
                throw err;
            }
        }

        const pickKeyPair = (raw: any): FmeKeyPair | null => {
            if (!Array.isArray(raw?.keyPairs) || raw.keyPairs.length === 0) return null;
            const userId = this.tokens?.userId;
            return (userId ? raw.keyPairs.find((kp: any) => kp?.userId === userId) : null) ?? raw.keyPairs[0];
        };

        let keyPair: FmeKeyPair | null = pickKeyPair(data);

        let list: FmeGeolocationEntry[] = [];
        if (Array.isArray(data?.items)) {
            const matchedItem = data.items.find((it: any) => it?.deviceId === deviceId) ?? data.items[0];
            const userId = this.tokens?.userId?.trim();
            if (Number(matchedItem?.resultCode) === 403 && userId && !this.shareableDeniedDevices.has(deviceId)) {
                this.shareableDeniedDevices.add(deviceId);
                try {
                    await this.setShareableMembers(installedAppId, deviceId, userId);
                    data = await fetchGeo();
                    keyPair = pickKeyPair(data) ?? keyPair;
                    const retryItem = Array.isArray(data?.items)
                        ? data.items.find((it: any) => it?.deviceId === deviceId) ?? data.items[0]
                        : null;
                    if (Number(retryItem?.resultCode) !== 403) {
                        this.shareableDeniedDevices.delete(deviceId);
                    }
                } catch (shareErr) {
                    if (!(shareErr instanceof UTagHttpError && shareErr.status === 403)) {
                        this.shareableDeniedDevices.delete(deviceId);
                    }
                    throw shareErr;
                }
            }
            const itemAfter =
                (Array.isArray(data?.items)
                    ? data.items.find((it: any) => it?.deviceId === deviceId) ?? data.items[0]
                    : null) ?? matchedItem;
            if (Array.isArray(itemAfter?.geolocations)) {
                list = itemAfter.geolocations;
            }
        } else if (Array.isArray(data?.geolocations)) {
            list = data.geolocations;
        } else if (Array.isArray(data)) {
            list = data;
        } else if (data && typeof data === "object" && ("latitude" in data || "encLatitude" in data)) {
            list = [data];
        }

        if (list.length === 0) return { geo: null, keyPair };

        let newest = list[0];
        let newestTime = Number(newest?.lastUpdateTime ?? 0);
        for (let i = 1; i < list.length; i += 1) {
            const t = Number(list[i]?.lastUpdateTime ?? 0);
            if (t >= newestTime) {
                newest = list[i];
                newestTime = t;
            }
        }
        return { geo: newest, keyPair };
    }

    async setSearchingStatus(installedAppId: string, deviceId: string, searching = true): Promise<void> {
        await this.executeFme(installedAppId, {
            method: "PUT",
            uri: "/trackerapi",
            extraUri: `/trackers/${encodeURIComponent(deviceId)}/searchingstatus`,
            body: { searchingStatus: searching ? "searching" : "stop" }
        });
    }

    async ringTag(installedAppId: string, deviceId: string, command: "start" | "stop"): Promise<void> {
        logUtag(`[UTag] ringTag request deviceId=${deviceId} command=${command}`);
        try {
            const res = await this.executeFme(installedAppId, {
                method: "PUT",
                uri: "/trackerapi",
                extraUri: `/trackers/${encodeURIComponent(deviceId)}/ring`,
                body: { command }
            });
            logUtag(
                `[UTag] ringTag ok deviceId=${deviceId} command=${command} res=${res !== undefined ? JSON.stringify(res) : "undefined"}`
            );
        } catch (err: any) {
            logUtag(`[UTag] ringTag failed deviceId=${deviceId} command=${command}: ${err?.message ?? err}`, "warn");
            throw err;
        }
    }
}
