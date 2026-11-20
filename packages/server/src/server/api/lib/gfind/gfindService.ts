import crypto from "crypto";
import { NEW_FINDMY_DEVICE } from "@server/events";
import { FindMyDevice } from "../findmy/types";
import { getChangedFindMyDevices } from "../findmy/findMyForkHelpers";
import { TrackerCommonDeps, TrackerGeocodedAddress } from "../findmy/trackerCommon";
import { encodeEncryptionUnlockKdi, getEncryptionUnlockUrl, GoogleFindAuthDeps, GoogleFindAuthManager } from "./gfindAuth";
import { GoogleFindClient, GoogleFindClientDeps, extractCanonicIdFromMetadata } from "./gfindClient";
import { generateRollingEids, GoogleFindSoundComponent } from "./gfindCrypto";
import { FcmNotificationEvent, GoogleFindFcmClient, GoogleFindFcmDeps } from "./gfindFcm";
import { GoogleFindBleSpec, GoogleFindInternalRecord, mapProtoDeviceToFindMy } from "./gfindMapper";
import { NovaDeviceType, ProtoDeviceMetadata } from "./gfindProto";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_LOCATE_INTERVAL_MS = 10_000;
const TARGETED_FCM_WAIT_MS = 15_000;
const STAGGER_LOCATE_DELAY_MS = 250;

const newUuid = (): string => {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export interface GoogleFindStatus {
    connected: boolean;
    email: string | null;
    e2eeUnlocked: boolean;
    ownerKeyVersion: number | null;
    ownerKeyMismatch: boolean;
    fcmConnected: boolean;
    tagCount: number;
    androidDeviceCount: number;
    deviceCount: number;
    lastSyncAt: number | null;
    lastError: string | null;
}

export interface GoogleFindServiceDeps {
    authDeps?: GoogleFindAuthDeps;
    fcmDeps?: GoogleFindFcmDeps;
    clientDeps?: GoogleFindClientDeps;
    trackerDeps?: TrackerCommonDeps;
    reverseGeocodeFn?: (lat: number, lon: number) => Promise<TrackerGeocodedAddress | null>;
    emitDevice?: (device: FindMyDevice) => void;
    isEnabled?: () => boolean;
    hasActiveClients?: () => boolean;
    pollIntervalMs?: number;
    locateTimeoutMs?: number;
    minLocateIntervalMs?: number;
    now?: () => number;
}

function defaultEmitDevice(device: FindMyDevice): void {
    try {
        // Lazy require avoids loading Electron/Server internals in standalone unit tests.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Server } = require("@server");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { enrichFindMyDeviceIcon } = require("../findmy/findMyIcons");
        Server()?.emitMessage?.(NEW_FINDMY_DEVICE, enrichFindMyDeviceIcon(device), "normal", false, true);
    } catch {
        // Ignore when Server singleton is unavailable
    }
}

function defaultIsEnabled(): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Server } = require("@server");
        const val = Server()?.repo?.getConfig?.("enable_gfind");
        return val === undefined ? true : Boolean(val);
    } catch {
        return true;
    }
}

function defaultHasActiveClients(): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Server } = require("@server");
        const size = Server()?.httpService?.socketServer?.sockets?.sockets?.size;
        return size == null || size > 0;
    } catch {
        return true;
    }
}

function logGfind(msg: string): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Server } = require("@server");
        Server()?.logger?.info?.(`[GFind] ${msg}`);
    } catch {
        // Ignore when Server singleton is unavailable
    }
}

export function normalizeGfindId(deviceId: string): string {
    return deviceId.startsWith("gfind:") ? deviceId.slice("gfind:".length) : deviceId;
}

interface PendingLocateWaiter {
    canonicId: string;
    requestUuid: string;
    resolve: (updated: boolean) => void;
    timer: NodeJS.Timeout;
}

export class GoogleFindService {
    private deps: GoogleFindServiceDeps;
    private auth: GoogleFindAuthManager;
    private fcm: GoogleFindFcmClient;
    private client: GoogleFindClient;
    private recordsById = new Map<string, GoogleFindInternalRecord>();
    private cachedDevices: FindMyDevice[] = [];
    private lastLocateAt = new Map<string, number>();
    private pendingWaiters = new Set<PendingLocateWaiter>();
    private pollTimer: NodeJS.Timeout | null = null;
    private locateSkipped = false;
    private lastSyncAt: number | null = null;
    private lastError: string | null = null;
    private unsubscribeFcm: (() => void) | null = null;

    constructor(deps: GoogleFindServiceDeps = {}) {
        this.deps = deps;
        this.auth = new GoogleFindAuthManager({
            ...deps.authDeps,
            trackerDeps: deps.trackerDeps ?? deps.authDeps?.trackerDeps
        });
        this.fcm = new GoogleFindFcmClient(this.auth, deps.fcmDeps);
        this.client = new GoogleFindClient(this.auth, deps.clientDeps);
        this.unsubscribeFcm = this.fcm.onNotification(ev => {
            void this.handleFcmEvent(ev);
        });
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    private isEnabled(): boolean {
        return this.deps.isEnabled ? this.deps.isEnabled() : defaultIsEnabled();
    }

    private emitDevice(device: FindMyDevice): void {
        const fn = this.deps.emitDevice ?? defaultEmitDevice;
        fn(device);
    }

    getEncryptionUnlockKdi(): string {
        return encodeEncryptionUnlockKdi("finder_hw");
    }

    getEncryptionUnlockUrl(): string {
        return getEncryptionUnlockUrl("finder_hw");
    }

    getStatus(): GoogleFindStatus {
        const state = this.auth.load();
        const records = [...this.recordsById.values()];
        const tagCount = records.filter(r => r.isSpotAccessory).length;
        const androidDeviceCount = records.filter(r => !r.isSpotAccessory).length;
        return {
            connected: Boolean(state.aasToken),
            email: state.email,
            e2eeUnlocked: Boolean(state.ownerKeyHex),
            ownerKeyVersion: state.ownerKeyVersion,
            ownerKeyMismatch: Boolean(state.ownerKeyMismatch),
            fcmConnected: this.fcm.isConnected(),
            tagCount,
            androidDeviceCount,
            deviceCount: records.length,
            lastSyncAt: this.lastSyncAt,
            lastError: this.lastError
        };
    }

    start(): void {
        this.auth.load();
        if (!this.isEnabled() || !this.auth.isSignedIn()) {
            return;
        }
        this.fcm.start();
        if (!this.pollTimer) {
            const interval = this.deps.pollIntervalMs ?? POLL_INTERVAL_MS;
            this.pollTimer = setInterval(() => {
                void this.pollAllDevices();
            }, interval);
            this.pollTimer.unref?.();
            void this.refreshDevices().catch(() => undefined);
        }
    }

    stop(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        for (const w of this.pendingWaiters) {
            clearTimeout(w.timer);
            w.resolve(false);
        }
        this.pendingWaiters.clear();
        this.fcm.stop();
    }

    destroy(): void {
        this.stop();
        if (this.unsubscribeFcm) {
            this.unsubscribeFcm();
            this.unsubscribeFcm = null;
        }
    }

    async completeOAuthToken(oauthToken: string, emailHint?: string | null): Promise<GoogleFindStatus & { kdi: string }> {
        const prev = this.auth.getState();
        const prevEmail = prev.email;
        const prevAas = prev.aasToken;
        const next = await this.auth.exchangeOAuthToken(oauthToken, emailHint);
        const sameEmail = Boolean(prevEmail && next.email && prevEmail.toLowerCase() === next.email.toLowerCase());
        if ((prevEmail || prevAas) && !sameEmail) {
            this.stop();
            this.recordsById.clear();
            this.cachedDevices = [];
            this.lastLocateAt.clear();
            this.lastSyncAt = null;
            this.locateSkipped = false;
        }
        this.lastError = null;
        this.start();
        return {
            ...this.getStatus(),
            kdi: this.getEncryptionUnlockKdi()
        };
    }

    async completeVaultUnlock(payload: unknown): Promise<GoogleFindStatus> {
        const eidInfo = await this.client.getEidInfoForE2eeDevices(-1);
        const finderEntry =
            eidInfo.ownerKeys.find(k => k.securityDomain === "finder_hw") ?? eidInfo.ownerKeys[0];
        if (!finderEntry) {
            throw new Error("Google Spot service returned no encrypted owner key");
        }
        this.auth.unwrapAndStoreOwnerKey({
            vaultKeysPayload: payload,
            encryptedOwnerKey: finderEntry.encryptedOwnerKey,
            ownerKeyVersion: finderEntry.ownerKeyVersion
        });
        this.lastError = null;
        if (this.auth.isSignedIn()) {
            await this.refreshDevices().catch(err => {
                this.lastError = String(err?.message ?? err);
            });
        }
        return this.getStatus();
    }

    disconnect(): void {
        this.stop();
        this.auth.clear();
        this.recordsById.clear();
        this.cachedDevices = [];
        this.lastLocateAt.clear();
        this.lastSyncAt = null;
        this.lastError = null;
        this.locateSkipped = false;
    }

    getCachedDevices(): FindMyDevice[] {
        return this.cachedDevices;
    }

    private getRecord(canonicId: string): GoogleFindInternalRecord | undefined {
        return this.recordsById.get(canonicId.toLowerCase());
    }

    getBleSpec(deviceId: string): GoogleFindBleSpec {
        const rawId = normalizeGfindId(deviceId);
        const record = this.getRecord(rawId);
        if (!record) {
            throw new Error(`Unknown Google Find Hub device: ${deviceId}`);
        }
        if (!record.eik) {
            throw new Error(
                record.ownerKeyVersionMismatch
                    ? `Device ${deviceId} requires E2EE vault re-unlock (ownerKeyVersion mismatch)`
                    : `Device ${deviceId} E2EE identity key is locked`
            );
        }

        const nowSec = Math.floor(this.now() / 1000);
        const { eidsHex, expiresAt } = generateRollingEids({
            eik: record.eik,
            nowSec,
            rotationExponent: record.rotationExponent,
            curve: record.curve
        });

        return {
            deviceId: record.deviceId,
            rawId: record.canonicId,
            provider: "gfind",
            serviceUuid: "feaa",
            expiresAt,
            eidsHex,
            ringKeyHex: record.ringKey ? record.ringKey.toString("hex") : null,
            ringComponents: record.isEarbuds ? ["left", "right", "case"] : [],
            supportsUwb: record.isSpotAccessory,
            uwbPackage: "com.google.android.apps.adm"
        };
    }

    async ringDevice(
        deviceId: string,
        action: "start" | "stop",
        component: GoogleFindSoundComponent = "all"
    ): Promise<void> {
        const canonicId = normalizeGfindId(deviceId);
        const existing = this.getRecord(canonicId);
        const deviceType = existing?.novaDeviceType ?? NovaDeviceType.SPOT_DEVICE;
        let fcmRegistrationId = this.auth.getState().fcmToken ?? undefined;
        if (!fcmRegistrationId && this.isEnabled()) {
            fcmRegistrationId = (await this.fcm.ensureReady(5_000).catch(() => null)) ?? undefined;
        }
        await this.client.ringDevice({
            canonicId,
            action,
            deviceType,
            component,
            fcmRegistrationId
        });
    }

    async refreshDevices(targetDeviceId?: string, options?: { force?: boolean }): Promise<FindMyDevice[]> {
        if (!this.auth.isSignedIn()) {
            return this.cachedDevices;
        }

        try {
            if (!this.fcm.isConnected() && this.isEnabled()) {
                await this.fcm.ensureReady(5_000).catch(() => null);
            }

            if (targetDeviceId) {
                const canonicId = normalizeGfindId(targetDeviceId);
                const key = canonicId.toLowerCase();
                if (!this.getRecord(canonicId)) {
                    const initialList = await this.client.listDevices();
                    await this.applyMetadataList(initialList, true);
                }

                const nowMs = this.now();
                const minInterval = this.deps.minLocateIntervalMs ?? MIN_LOCATE_INTERVAL_MS;
                const prevLocate = this.lastLocateAt.get(key) ?? 0;

                if (options?.force || nowMs - prevLocate >= minInterval) {
                    this.lastLocateAt.set(key, nowMs);
                    const existing = this.getRecord(canonicId);
                    const fcmToken = this.auth.getState().fcmToken ?? undefined;
                    const requestUuid = newUuid();
                    const canWaitFcm = this.fcm.isConnected() || Boolean(fcmToken);
                    const handle = canWaitFcm ? this.createFcmWaiter(existing?.canonicId ?? canonicId, requestUuid) : null;
                    try {
                        await this.client.locateDevice({
                            canonicId: existing?.canonicId ?? canonicId,
                            deviceType: existing?.novaDeviceType ?? NovaDeviceType.SPOT_DEVICE,
                            fcmRegistrationId: fcmToken,
                            requestUuid
                        });
                    } catch (err) {
                        handle?.cancel();
                        throw err;
                    }

                    const pushed = handle ? await handle.promise : false;
                    if (pushed) {
                        this.lastSyncAt = this.now();
                        this.lastError = null;
                        return this.cachedDevices;
                    }
                } else if (this.getRecord(canonicId)) {
                    return this.cachedDevices;
                }
            }

            const metadataList = await this.client.listDevices();
            await this.applyMetadataList(metadataList, true);

            if (!targetDeviceId && this.recordsById.size > 0) {
                const fcmToken = this.auth.getState().fcmToken ?? undefined;
                const minInterval = this.deps.minLocateIntervalMs ?? MIN_LOCATE_INTERVAL_MS;
                const canWaitFcm = this.fcm.isConnected() || Boolean(fcmToken);
                const waiters: Array<Promise<boolean>> = [];

                for (const record of this.recordsById.values()) {
                    const key = record.canonicId.toLowerCase();
                    const nowMs = this.now();
                    if (!options?.force && nowMs - (this.lastLocateAt.get(key) ?? 0) < minInterval) continue;
                    this.lastLocateAt.set(key, nowMs);
                    const requestUuid = newUuid();
                    const handle = canWaitFcm ? this.createFcmWaiter(record.canonicId, requestUuid) : null;
                    const ok = await this.client
                        .locateDevice({
                            canonicId: record.canonicId,
                            deviceType: record.novaDeviceType,
                            fcmRegistrationId: fcmToken,
                            requestUuid
                        })
                        .then(() => true)
                        .catch(() => false);
                    if (ok && handle) {
                        waiters.push(handle.promise);
                    } else {
                        handle?.cancel();
                    }
                    if (STAGGER_LOCATE_DELAY_MS > 0) {
                        await new Promise(r => setTimeout(r, STAGGER_LOCATE_DELAY_MS));
                    }
                }

                if (waiters.length > 0) {
                    await Promise.all(waiters);
                }
            }

            this.lastSyncAt = this.now();
            this.lastError = null;
            return this.cachedDevices;
        } catch (err: any) {
            this.lastError = String(err?.message ?? err);
            throw err;
        }
    }

    onClientConnected(): void {
        if (!this.locateSkipped) return;
        this.locateSkipped = false;
        void this.pollAllDevices();
    }

    private async pollAllDevices(): Promise<void> {
        if (!this.isEnabled() || !this.auth.isSignedIn()) return;
        try {
            const metadataList = await this.client.listDevices();
            await this.applyMetadataList(metadataList, true);
            this.lastSyncAt = this.now();
            this.lastError = null;

            // Active locates wake trackers; skip them on passive polls when no clients are connected.
            if (!(this.deps.hasActiveClients ?? defaultHasActiveClients)()) {
                this.locateSkipped = true;
                return;
            }
            this.locateSkipped = false;

            const fcmToken = this.auth.getState().fcmToken ?? undefined;
            const minInterval = this.deps.minLocateIntervalMs ?? MIN_LOCATE_INTERVAL_MS;
            for (const record of this.recordsById.values()) {
                const key = record.canonicId.toLowerCase();
                const nowMs = this.now();
                if (nowMs - (this.lastLocateAt.get(key) ?? 0) < minInterval) continue;
                this.lastLocateAt.set(key, nowMs);
                await this.client
                    .locateDevice({
                        canonicId: record.canonicId,
                        deviceType: record.novaDeviceType,
                        fcmRegistrationId: fcmToken
                    })
                    .catch(() => undefined);
                if (STAGGER_LOCATE_DELAY_MS > 0) {
                    await new Promise(r => setTimeout(r, STAGGER_LOCATE_DELAY_MS));
                }
            }
        } catch (err: any) {
            this.lastError = String(err?.message ?? err);
        }
    }

    private createFcmWaiter(canonicId: string, requestUuid: string): { promise: Promise<boolean>; cancel: () => void } {
        const timeoutMs = this.deps.locateTimeoutMs ?? TARGETED_FCM_WAIT_MS;
        let waiter!: PendingLocateWaiter;
        const promise = new Promise<boolean>(resolve => {
            waiter = {
                canonicId: canonicId.toLowerCase(),
                requestUuid,
                resolve: updated => {
                    clearTimeout(waiter.timer);
                    this.pendingWaiters.delete(waiter);
                    resolve(updated);
                },
                timer: setTimeout(() => {
                    waiter.resolve(false);
                }, timeoutMs)
            };
            waiter.timer.unref?.();
            this.pendingWaiters.add(waiter);
        });
        return {
            promise,
            cancel: () => waiter.resolve(false)
        };
    }

    private async handleFcmEvent(event: FcmNotificationEvent): Promise<void> {
        const update = event.deviceUpdate;
        if (!update?.deviceMetadata) return;
        const canonicId = extractCanonicIdFromMetadata(update.deviceMetadata)?.toLowerCase();
        const reqUuid = update.fcmMetadata?.requestUuid;
        const repCount =
            (update.deviceMetadata.information?.reports?.length ?? 0) +
            (update.deviceMetadata.phoneInformation?.deviceInformation?.reports?.length ?? 0);
        logGfind(`FCM push id=${canonicId ?? "?"} reqUuid=${reqUuid ?? "?"} reports=${repCount}`);
        await this.applyMetadataList([update.deviceMetadata], false);
        this.lastSyncAt = this.now();

        for (const waiter of [...this.pendingWaiters]) {
            if ((reqUuid && waiter.requestUuid === reqUuid) || (canonicId && waiter.canonicId === canonicId)) {
                waiter.resolve(true);
            }
        }
    }

    private async applyMetadataList(metadataList: ProtoDeviceMetadata[], replaceAll: boolean): Promise<void> {
        const previousDevices = this.cachedDevices;
        const startRecords = new Map(this.recordsById);
        const ownerKey = this.auth.getOwnerKey();
        const ownerKeyVersion = this.auth.getOwnerKeyVersion();

        const nextMap = replaceAll ? new Map<string, GoogleFindInternalRecord>() : new Map(this.recordsById);
        let sawMismatch = false;

        for (const meta of metadataList) {
            const rawId = extractCanonicIdFromMetadata(meta);
            const prev = rawId ? this.recordsById.get(rawId.toLowerCase()) ?? nextMap.get(rawId.toLowerCase()) : undefined;
            const record = await mapProtoDeviceToFindMy(meta, {
                ownerKey,
                ownerKeyVersion,
                trackerDeps: this.deps.trackerDeps,
                reverseGeocodeFn: this.deps.reverseGeocodeFn,
                fallbackRecord: prev
            });
            if (!record) continue;
            if (record.ownerKeyVersionMismatch) sawMismatch = true;
            if (!replaceAll || !record.device.location) {
                logGfind(`${replaceAll ? "list" : "fcm"} ${record.device.name} (${record.canonicId}): ${record.debugSummary ?? ""}`);
            }
            const key = record.canonicId.toLowerCase();
            if (prev && !record.device.location && !record.device.crowdSourcedLocation && (prev.device.location || prev.device.crowdSourcedLocation)) {
                record.device.location = prev.device.location;
                record.device.crowdSourcedLocation = prev.device.crowdSourcedLocation;
                record.device.address = record.device.address ?? prev.device.address;
                record.device.short_address = record.device.short_address ?? prev.device.short_address;
                record.device.long_address = record.device.long_address ?? prev.device.long_address;
                record.device.street = record.device.street ?? prev.device.street;
                record.device.city = record.device.city ?? prev.device.city;
                record.device.state = record.device.state ?? prev.device.state;
                record.device.zip = record.device.zip ?? prev.device.zip;
                record.device.country = record.device.country ?? prev.device.country;
                record.device.last_updated = prev.device.last_updated;
                record.curve = prev.curve;
            }
            nextMap.set(key, record);
        }

        if (sawMismatch) {
            this.auth.setOwnerKeyMismatch(true);
        }

        // Preserve updates (e.g., FCM fixes) that landed while reverse geocoding awaited.
        for (const [key, live] of this.recordsById) {
            if (live !== startRecords.get(key) && nextMap.has(key)) {
                nextMap.set(key, live);
            }
        }

        this.recordsById = nextMap;
        this.cachedDevices = [...nextMap.values()].map(r => r.device);

        const changed = getChangedFindMyDevices(previousDevices, this.cachedDevices);
        for (const dev of changed) {
            this.emitDevice(dev);
        }
    }
}

export const gfindService = new GoogleFindService();
