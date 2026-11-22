import crypto from "crypto";
import { NEW_FINDMY_DEVICE } from "@server/events";
import { getChangedFindMyDevices } from "@server/api/lib/findmy/findMyForkHelpers";
import type { FindMyDevice } from "@server/api/lib/findmy/types";
import {
    TrackerCommonDeps,
    deleteEncryptedJson,
    readEncryptedJson,
    reverseGeocode,
    writeEncryptedJson
} from "@server/api/lib/findmy/trackerCommon";
import { FmeKeyPair, UTagClient, UTagHttpError, UTagTokens } from "./utagClient";
import {
    SamsungEntryPoint,
    buildSamsungSignInUrl,
    decryptSamsungAuthRedirect,
    generateDeviceId,
    generateState,
    resolveGeoCoordinates,
    unwrapE2ePrivateKey
} from "./utagCrypto";
import {
    SmartThingsTagDevice,
    UTagBleSpec,
    buildUTagBleSpec,
    mapSmartTagToFindMyDevice
} from "./utagMapper";

const UTAG_STORE_FILE = "utag-auth.enc.json";
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 10 * 1000;
const DEFAULT_SEARCH_STOP_MS = 60 * 1000;
const DEFAULT_SEARCH_POLL_INTERVAL_MS = 2 * 1000;
const DEFAULT_SEARCH_POLL_CAP_MS = 12 * 1000;
const DEFAULT_UNTARGETED_SETTLE_MS = 4 * 1000;

interface UTagPersistedState {
    deviceId: string;
    tokens?: UTagTokens | null;
    email?: string | null;
    pin?: string | null;
    keyPair?: FmeKeyPair | null;
}

export interface UTagStatus {
    connected: boolean;
    email: string | null;
    userId: string | null;
    tagCount: number;
    lastSyncAt: number | null;
    hasPin: boolean;
    needsPin: boolean;
    lastError: string | null;
}

export interface UTagServiceDeps {
    storageDeps?: TrackerCommonDeps;
    client?: UTagClient;
    fetchFn?: typeof fetch;
    emitDevice?: (device: FindMyDevice) => Promise<void> | void;
    pollIntervalMs?: number;
    cooldownMs?: number;
    searchStopDelayMs?: number;
    searchPollIntervalMs?: number;
    searchPollCapMs?: number;
    untargetedSettleMs?: number;
    hasActiveClients?: () => boolean;
}

const defaultHasActiveClients = (): boolean => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Server } = require("@server");
        const size = Server()?.httpService?.socketServer?.sockets?.sockets?.size;
        return size == null || size > 0;
    } catch {
        return true;
    }
};

const defaultEmitDevice = async (device: FindMyDevice): Promise<void> => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Server } = require("@server");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { enrichFindMyDeviceIcon } = require("@server/api/lib/findmy/findMyIcons");
        await Server()?.emitMessage?.(NEW_FINDMY_DEVICE, enrichFindMyDeviceIcon(device), "normal", false, true);
    } catch {
        // Server singleton may not be initialized in unit tests.
    }
};

export class UTagService {
    private persisted: UTagPersistedState | null = null;
    private cachedTagsById = new Map<string, SmartThingsTagDevice>();
    private cachedDevices: FindMyDevice[] = [];
    private pollTimer: NodeJS.Timeout | null = null;
    private refreshInFlight: Promise<FindMyDevice[]> | null = null;
    private lastRefreshByDevice = new Map<string, number>();
    private searchStopTimers = new Map<string, { timer: NodeJS.Timeout; stop: () => void }>();
    private needsPinTagIds = new Set<string>();
    private lastSyncAt: number | null = null;
    private lastError: string | null = null;
    private needsPin = false;
    private pendingAuth: {
        state: string;
        codeVerifier: string;
        deviceId: string;
    } | null = null;

    private readonly storageDeps?: TrackerCommonDeps;
    private readonly client: UTagClient;
    private readonly emitDevice: (device: FindMyDevice) => Promise<void> | void;
    private readonly pollIntervalMs: number;
    private readonly cooldownMs: number;
    private readonly searchStopDelayMs: number;
    private readonly searchPollIntervalMs: number;
    private readonly searchPollCapMs: number;
    private readonly untargetedSettleMs: number;
    private readonly hasActiveClients: () => boolean;

    constructor(deps?: UTagServiceDeps) {
        this.storageDeps = deps?.storageDeps;
        this.emitDevice = deps?.emitDevice ?? defaultEmitDevice;
        this.pollIntervalMs = deps?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.cooldownMs = deps?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        this.searchStopDelayMs = deps?.searchStopDelayMs ?? DEFAULT_SEARCH_STOP_MS;
        this.searchPollIntervalMs = deps?.searchPollIntervalMs ?? DEFAULT_SEARCH_POLL_INTERVAL_MS;
        this.searchPollCapMs = deps?.searchPollCapMs ?? DEFAULT_SEARCH_POLL_CAP_MS;
        this.untargetedSettleMs = deps?.untargetedSettleMs ?? DEFAULT_UNTARGETED_SETTLE_MS;
        this.hasActiveClients = deps?.hasActiveClients ?? defaultHasActiveClients;
        this.client =
            deps?.client ??
            new UTagClient(null, {
                fetchFn: deps?.fetchFn,
                onTokensUpdated: tokens => this.handleTokensUpdated(tokens)
            });
    }

    private ensureLoaded(): UTagPersistedState {
        if (this.persisted) return this.persisted;
        const loaded = readEncryptedJson<UTagPersistedState>(UTAG_STORE_FILE, this.storageDeps);
        if (loaded && loaded.deviceId) {
            this.persisted = loaded;
            if (loaded.tokens) this.client.setTokens(loaded.tokens);
            return loaded;
        }
        const fresh: UTagPersistedState = { deviceId: generateDeviceId() };
        this.persisted = fresh;
        return fresh;
    }

    private savePersisted(state: UTagPersistedState): void {
        this.persisted = state;
        writeEncryptedJson(UTAG_STORE_FILE, state, this.storageDeps);
    }

    private handleTokensUpdated(tokens: UTagTokens): void {
        const current = this.ensureLoaded();
        this.savePersisted({ ...current, tokens });
    }

    private getPrivateKey(keyPairOverride?: FmeKeyPair | null): crypto.KeyObject | null {
        const state = this.ensureLoaded();
        const kp = keyPairOverride ?? state.keyPair;
        if (!state.pin || !kp?.privateKey || !kp?.iv) return null;
        try {
            return unwrapE2ePrivateKey(kp.privateKey, state.pin, {
                userId: kp.userId ?? state.tokens?.userId,
                iv: kp.iv
            });
        } catch {
            return null;
        }
    }

    getStatus(): UTagStatus {
        const state = this.ensureLoaded();
        return {
            connected: Boolean(state.tokens?.iotToken),
            email: state.email ?? null,
            userId: state.tokens?.userId ?? null,
            tagCount: this.cachedDevices.length,
            lastSyncAt: this.lastSyncAt,
            hasPin: Boolean(state.pin),
            needsPin: this.needsPin,
            lastError: this.lastError
        };
    }

    beginSignIn(entryPoint: SamsungEntryPoint, options?: { countryCode?: string; locale?: string }): {
        url: string;
        state: string;
    } {
        const current = this.ensureLoaded();
        const state = generateState(20);
        const req = buildSamsungSignInUrl(entryPoint, state, {
            deviceId: current.deviceId,
            countryCode: options?.countryCode,
            locale: options?.locale
        });
        this.pendingAuth = {
            state: req.state,
            codeVerifier: req.codeVerifier,
            deviceId: req.deviceId
        };
        return { url: req.url, state: req.state };
    }

    async startSignIn(options?: {
        entryPoint?: SamsungEntryPoint;
        countryCode?: string;
        locale?: string;
    }): Promise<{ url: string; state: string }> {
        try {
            const entryPoint = options?.entryPoint ?? (await this.client.fetchEntryPoint());
            return this.beginSignIn(entryPoint, options);
        } catch (err: any) {
            this.lastError = err?.message ?? String(err);
            throw err;
        }
    }

    async completeOAuthCallback(callbackUrl: string, email?: string | null): Promise<UTagStatus> {
        if (!this.pendingAuth) {
            throw new Error("No pending Samsung sign-in session");
        }
        const pending = this.pendingAuth;
        try {
            const redirected = decryptSamsungAuthRedirect(callbackUrl, pending.state);
            const loginId = email ?? redirected.retValue;
            const loginTokens = await this.client.exchangeAuthCode({
                code: redirected.code,
                codeVerifier: pending.codeVerifier,
                authServerUrl: redirected.authServerUrl,
                deviceId: pending.deviceId,
                username: loginId
            });
            const tokens = await this.client.authorizeOneConnect({
                userAuthToken: loginTokens.userAuthToken,
                userAuthRefreshToken: loginTokens.userAuthRefreshToken,
                authServerUrl: loginTokens.authServerUrl,
                deviceId: pending.deviceId,
                userId: loginTokens.userId,
                loginId
            });
            this.pendingAuth = null;

            const current = this.ensureLoaded();
            this.savePersisted({
                ...current,
                deviceId: pending.deviceId,
                tokens,
                email: loginId ?? current.email ?? null
            });
            this.lastError = null;
            return this.getStatus();
        } catch (err: any) {
            this.lastError = err?.message ?? String(err);
            throw err;
        }
    }

    setE2eePin(pin: string): UTagStatus {
        const current = this.ensureLoaded();
        const trimmed = pin.trim() || null;
        if (trimmed && current.keyPair?.privateKey && current.keyPair?.iv) {
            // Validate immediately so invalid PIN surfaces synchronously to UI
            unwrapE2ePrivateKey(current.keyPair.privateKey, trimmed, {
                userId: current.keyPair.userId ?? current.tokens?.userId,
                iv: current.keyPair.iv
            });
            this.needsPin = false;
            this.needsPinTagIds.clear();
        }
        this.savePersisted({ ...current, pin: trimmed });
        return this.getStatus();
    }

    disconnect(): void {
        this.stop();
        this.pendingAuth = null;
        this.cachedTagsById.clear();
        this.cachedDevices = [];
        this.lastSyncAt = null;
        this.lastError = null;
        this.needsPin = false;
        this.needsPinTagIds.clear();
        this.persisted = null;
        this.client.setTokens(null);
        deleteEncryptedJson(UTAG_STORE_FILE, this.storageDeps);
    }

    start(): void {
        if (this.pollTimer) return;
        const state = this.ensureLoaded();
        if (state.tokens?.iotToken && this.hasActiveClients()) {
            void this.refreshDevices().catch(() => undefined);
        }
        this.pollTimer = setInterval(() => {
            if (this.ensureLoaded().tokens?.iotToken && this.hasActiveClients()) {
                void this.refreshDevices().catch(() => undefined);
            }
        }, this.pollIntervalMs);
        this.pollTimer.unref?.();
    }

    onClientConnected(): void {
        if (!this.pollTimer || !this.ensureLoaded().tokens?.iotToken) return;
        if (this.cachedDevices.length === 0) {
            void this.refreshDevices().catch(() => undefined);
        }
    }

    stop(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        for (const { timer, stop } of [...this.searchStopTimers.values()]) {
            clearTimeout(timer);
            stop();
        }
    }

    getCachedDevices(): FindMyDevice[] {
        return this.cachedDevices;
    }

    async refreshDevices(targetDeviceId?: string, options?: { force?: boolean }): Promise<FindMyDevice[]> {
        const rawTarget = targetDeviceId?.startsWith("utag:") ? targetDeviceId.slice(5) : targetDeviceId;
        if (rawTarget && !options?.force) {
            const lastAt = this.lastRefreshByDevice.get(rawTarget) ?? 0;
            if (Date.now() - lastAt < this.cooldownMs && this.cachedDevices.length > 0) {
                return this.cachedDevices;
            }
        }

        if (this.refreshInFlight) {
            if (!rawTarget) return this.refreshInFlight;
            await this.refreshInFlight.catch(() => undefined);
            return this.refreshDevices(targetDeviceId, options);
        }

        this.refreshInFlight = (async (): Promise<FindMyDevice[]> => {
            const state = this.ensureLoaded();
            if (!state.tokens?.iotToken) return this.cachedDevices;

            try {
                const tags = await this.client.getSmartTagDevices();
                const installedAppId = await this.client.getFmeInstalledAppId();
                const privateKey = this.getPrivateKey();
                const prevDevices = this.cachedDevices;
                let lastGeoError: string | null = null;
                const nextDevices: FindMyDevice[] = [];
                const nextTagsById = new Map<string, SmartThingsTagDevice>();

                const untargetedForced = !rawTarget && Boolean(options?.force) && tags.length > 0;
                if (untargetedForced) {
                    await Promise.all(
                        tags.map(t => this.client.setSearchingStatus(installedAppId, t.deviceId, true).catch(() => undefined))
                    );
                }

                try {
                    if (untargetedForced && this.untargetedSettleMs > 0) {
                        await new Promise(r => setTimeout(r, this.untargetedSettleMs));
                    }

                    for (const tag of tags) {
                        nextTagsById.set(tag.deviceId, tag);
                        const existing = prevDevices.find(d => d.id === `utag:${tag.deviceId}`);
                        if (rawTarget && tag.deviceId !== rawTarget) {
                            if (existing) {
                                nextDevices.push(existing);
                                continue;
                            }
                        }

                        let geoRes = null;
                        let geoFailed = false;
                        if (rawTarget === tag.deviceId) {
                            const baseline = existing?.location?.timeStamp ?? existing?.last_updated ?? 0;
                            await this.client.setSearchingStatus(installedAppId, tag.deviceId, true).catch(() => undefined);
                            try {
                                const deadline = Date.now() + this.searchPollCapMs;
                                while (true) {
                                    try {
                                        geoRes = await this.client.getTagGeolocation(installedAppId, tag.deviceId);
                                        geoFailed = false;
                                    } catch (geoErr: any) {
                                        geoFailed = true;
                                        lastGeoError = geoErr?.message ?? String(geoErr);
                                        console.warn(`[UTagService] Geolocation failed for ${tag.deviceId}: ${lastGeoError}`);
                                    }
                                    const candidateKey = this.getPrivateKey(geoRes?.keyPair) ?? privateKey;
                                    const candidateCoords = resolveGeoCoordinates(geoRes?.geo ?? null, candidateKey).coords;
                                    const rawUpdateTime = Number(geoRes?.geo?.lastUpdateTime ?? 0);
                                    const nextUpdateTime =
                                        candidateCoords?.lastUpdateTime ?? (Number.isFinite(rawUpdateTime) ? rawUpdateTime : 0);
                                    if (nextUpdateTime > baseline || Date.now() >= deadline) {
                                        break;
                                    }
                                    const waitMs = Math.min(this.searchPollIntervalMs, Math.max(0, deadline - Date.now()));
                                    if (waitMs > 0) {
                                        await new Promise(r => setTimeout(r, waitMs));
                                    }
                                }
                            } finally {
                                await this.client
                                    .setSearchingStatus(installedAppId, tag.deviceId, false)
                                    .catch(() => undefined);
                            }
                        } else {
                            try {
                                geoRes = await this.client.getTagGeolocation(installedAppId, tag.deviceId);
                            } catch (geoErr: any) {
                                geoFailed = true;
                                lastGeoError = geoErr?.message ?? String(geoErr);
                                console.warn(`[UTagService] Geolocation failed for ${tag.deviceId}: ${lastGeoError}`);
                            }
                        }
                        if (geoRes) {
                            this.lastRefreshByDevice.set(tag.deviceId, Date.now());
                        }
                        if (geoRes?.keyPair && geoRes.keyPair.privateKey && geoRes.keyPair.iv) {
                            const latest = this.ensureLoaded();
                            if (
                                latest.keyPair?.privateKey !== geoRes.keyPair.privateKey ||
                                latest.keyPair?.iv !== geoRes.keyPair.iv
                            ) {
                                this.savePersisted({ ...latest, keyPair: geoRes.keyPair });
                            }
                        }
                        const effectiveKey = this.getPrivateKey(geoRes?.keyPair) ?? privateKey;
                        const { coords, needsPin } = resolveGeoCoordinates(geoRes?.geo ?? null, effectiveKey);
                        if (needsPin) this.needsPinTagIds.add(tag.deviceId);
                        else this.needsPinTagIds.delete(tag.deviceId);

                        const geocoded = coords
                            ? await reverseGeocode(coords.latitude, coords.longitude, this.storageDeps)
                            : null;

                        const mapped = mapSmartTagToFindMyDevice(tag, {
                            coords,
                            geocoded,
                            needsPin,
                            batteryLevel: geoRes?.geo?.battery as string | number | undefined
                        });
                        if (geoFailed && existing?.location) {
                            mapped.location = existing.location;
                            mapped.crowdSourcedLocation = existing.crowdSourcedLocation ?? existing.location;
                            mapped.address = existing.address;
                            mapped.last_updated = existing.last_updated;
                            mapped.short_address = existing.short_address ?? existing.address?.label ?? null;
                            mapped.long_address =
                                existing.long_address ??
                                existing.address?.mapItemFullAddress ??
                                existing.address?.label ??
                                null;
                            mapped.street = existing.street ?? existing.address?.streetAddress ?? null;
                            mapped.city = existing.city ?? existing.address?.locality ?? null;
                            mapped.state = existing.state ?? existing.address?.stateCode ?? null;
                            mapped.country = existing.country ?? existing.address?.country ?? null;
                        }
                        nextDevices.push(mapped);
                    }
                } finally {
                    if (untargetedForced) {
                        await Promise.all(
                            tags.map(t =>
                                this.client.setSearchingStatus(installedAppId, t.deviceId, false).catch(() => undefined)
                            )
                        );
                    }
                }

                for (const id of this.needsPinTagIds) {
                    if (!nextTagsById.has(id)) this.needsPinTagIds.delete(id);
                }

                this.cachedTagsById = nextTagsById;
                this.cachedDevices = nextDevices;
                this.needsPin = this.needsPinTagIds.size > 0;
                this.lastSyncAt = Date.now();
                this.lastError = lastGeoError;

                for (const changed of getChangedFindMyDevices(prevDevices, nextDevices)) {
                    await this.emitDevice(changed);
                }
                return nextDevices;
            } catch (err: any) {
                this.lastError = err?.message ?? String(err);
                throw err;
            }
        })();

        try {
            return await this.refreshInFlight;
        } finally {
            this.refreshInFlight = null;
        }
    }

    async ringDevice(deviceId: string, action: "start" | "stop"): Promise<void> {
        this.ensureLoaded();
        const rawId = deviceId.startsWith("utag:") ? deviceId.slice(5) : deviceId;
        let tag = this.cachedTagsById.get(rawId);
        if (!tag && this.client.getTokens()) {
            const tags = await this.client.getSmartTagDevices().catch(() => [] as SmartThingsTagDevice[]);
            for (const t of tags) this.cachedTagsById.set(t.deviceId, t);
            tag = this.cachedTagsById.get(rawId);
        }
        if (tag && (tag.bleD2D as any)?.metadata?.remoteRing?.enabled !== true) {
            throw new UTagHttpError(
                "SmartTag remote ring is disabled for this tag; ring it over Bluetooth via SmartThings / uTag on Android.",
                400
            );
        }
        const installedAppId = await this.client.getFmeInstalledAppId();
        await this.client.ringTag(installedAppId, rawId, action);
    }

    getBleSpec(deviceId: string): UTagBleSpec {
        const rawId = deviceId.startsWith("utag:") ? deviceId.slice(5) : deviceId;
        const tag = this.cachedTagsById.get(rawId) ?? { deviceId: rawId };
        const expectedPrivacyIdsHex: string[] = [];
        const rawPrivacyId =
            tag.bleD2D?.privacyId ??
            (tag.bleD2D as any)?.chameleon?.privacyId ??
            (tag.bleD2D as any)?.metadata?.privacyId;
        if (typeof rawPrivacyId === "string" && rawPrivacyId.trim()) {
            expectedPrivacyIdsHex.push(rawPrivacyId.trim().toLowerCase());
        }
        return buildUTagBleSpec(tag, expectedPrivacyIdsHex);
    }
}

export const utagService = new UTagService();
