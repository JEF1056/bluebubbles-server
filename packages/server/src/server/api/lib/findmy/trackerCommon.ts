import fs from "fs";
import path from "path";

export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
}

export interface TrackerCommonDeps {
    baseDir?: string;
    safeStorage?: SafeStorageLike;
    fetchFn?: typeof fetch;
    nominatimMinIntervalMs?: number;
}

export interface TrackerGeocodedAddress {
    label?: string;
    mapItemFullAddress?: string;
    streetAddress?: string;
    locality?: string;
    stateCode?: string;
    country?: string;
}

const GEOCODE_CACHE_FILE = "tracker-geocode-cache.json";
const GEOCODE_CACHE_MAX_ENTRIES = 300;
const DEFAULT_NOMINATIM_INTERVAL_MS = 1100;

let globalDeps: TrackerCommonDeps = {};
let geocodeCache: Map<string, TrackerGeocodedAddress> | null = null;
let geocodeCacheDir: string | null = null;
const inFlightGeocode = new Map<string, Promise<TrackerGeocodedAddress | null>>();
let nominatimQueue: Promise<void> = Promise.resolve();
let lastNominatimRequestAt = 0;

export const setTrackerCommonDeps = (deps: TrackerCommonDeps): void => {
    globalDeps = { ...globalDeps, ...deps };
};

export const resetTrackerCommonForTests = (): void => {
    globalDeps = {};
    geocodeCache = null;
    geocodeCacheDir = null;
    inFlightGeocode.clear();
    nominatimQueue = Promise.resolve();
    lastNominatimRequestAt = 0;
};

export const getTrackerBaseDir = (overrideBaseDir?: string): string => {
    const dir = overrideBaseDir ?? globalDeps.baseDir;
    if (dir) return dir;
    // Lazy require avoids loading Electron app paths during unit tests when baseDir is injected.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FileSystem } = require("@server/fileSystem");
    return FileSystem.baseDir;
};

const getSafeStorage = (override?: SafeStorageLike): SafeStorageLike | null => {
    if (override) return override;
    if (globalDeps.safeStorage) return globalDeps.safeStorage;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const electron = require("electron");
        return electron?.safeStorage ?? null;
    } catch {
        return null;
    }
};

const resolveSafePath = (fileName: string, baseDir: string): string => {
    const safeName = path.basename(fileName);
    if (!safeName || safeName === "." || safeName === "..") {
        throw new Error(`Invalid tracker storage file name: ${fileName}`);
    }
    return path.join(baseDir, safeName);
};

export const readEncryptedJson = <T = unknown>(fileName: string, deps?: TrackerCommonDeps): T | null => {
    const baseDir = getTrackerBaseDir(deps?.baseDir);
    const filePath = resolveSafePath(fileName, baseDir);
    if (!fs.existsSync(filePath)) return null;

    const storage = getSafeStorage(deps?.safeStorage);
    if (!storage || !storage.isEncryptionAvailable()) {
        throw new Error("Electron safeStorage encryption is unavailable");
    }

    const encrypted = fs.readFileSync(filePath);
    if (encrypted.length === 0) return null;
    const decrypted = storage.decryptString(encrypted);
    return JSON.parse(decrypted) as T;
};

export const writeEncryptedJson = (fileName: string, data: unknown, deps?: TrackerCommonDeps): void => {
    const baseDir = getTrackerBaseDir(deps?.baseDir);
    fs.mkdirSync(baseDir, { recursive: true });
    const filePath = resolveSafePath(fileName, baseDir);

    const storage = getSafeStorage(deps?.safeStorage);
    if (!storage || !storage.isEncryptionAvailable()) {
        throw new Error("Electron safeStorage encryption is unavailable");
    }

    const encrypted = storage.encryptString(JSON.stringify(data));
    fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
};

export const deleteEncryptedJson = (fileName: string, deps?: TrackerCommonDeps): boolean => {
    const baseDir = getTrackerBaseDir(deps?.baseDir);
    const filePath = resolveSafePath(fileName, baseDir);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
};

const loadGeocodeCache = (baseDir: string): Map<string, TrackerGeocodedAddress> => {
    if (geocodeCache && geocodeCacheDir === baseDir) return geocodeCache;
    geocodeCacheDir = baseDir;
    geocodeCache = new Map<string, TrackerGeocodedAddress>();
    const cachePath = resolveSafePath(GEOCODE_CACHE_FILE, baseDir);
    if (!fs.existsSync(cachePath)) return geocodeCache;

    try {
        const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        if (Array.isArray(raw)) {
            for (const entry of raw.slice(-GEOCODE_CACHE_MAX_ENTRIES)) {
                if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1] && typeof entry[1] === "object") {
                    geocodeCache.set(entry[0], entry[1] as TrackerGeocodedAddress);
                }
            }
        }
    } catch {
        // Corrupt cache should not block reverse geocoding.
    }
    return geocodeCache;
};

let geocodeSaveTimer: NodeJS.Timeout | null = null;
let pendingGeocodeSave: { baseDir: string; cache: Map<string, TrackerGeocodedAddress> } | null = null;
const GEOCODE_SAVE_DEBOUNCE_MS = 2_000;

const flushGeocodeCache = async (baseDir: string, cache: Map<string, TrackerGeocodedAddress>): Promise<void> => {
    try {
        await fs.promises.mkdir(baseDir, { recursive: true });
        const cachePath = resolveSafePath(GEOCODE_CACHE_FILE, baseDir);
        const entries = Array.from(cache.entries()).slice(-GEOCODE_CACHE_MAX_ENTRIES);
        await fs.promises.writeFile(cachePath, JSON.stringify(entries), { mode: 0o600 });
    } catch {
        // Best-effort cache persistence.
    }
};

const saveGeocodeCache = (baseDir: string, cache: Map<string, TrackerGeocodedAddress>): void => {
    pendingGeocodeSave = { baseDir, cache };
    if (geocodeSaveTimer) clearTimeout(geocodeSaveTimer);
    geocodeSaveTimer = setTimeout(() => {
        geocodeSaveTimer = null;
        const pending = pendingGeocodeSave;
        pendingGeocodeSave = null;
        if (pending) {
            void flushGeocodeCache(pending.baseDir, pending.cache);
        }
    }, GEOCODE_SAVE_DEBOUNCE_MS);
    geocodeSaveTimer.unref?.();
};

const touchLru = (cache: Map<string, TrackerGeocodedAddress>, key: string, value: TrackerGeocodedAddress): void => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > GEOCODE_CACHE_MAX_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
    }
};

const parseNominatimAddress = (payload: any): TrackerGeocodedAddress | null => {
    if (!payload || typeof payload !== "object") return null;
    const addr = payload.address && typeof payload.address === "object" ? payload.address : {};
    const streetParts = [addr.house_number, addr.road].filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0
    );
    const streetAddress =
        streetParts.length > 0
            ? streetParts.join(" ")
            : typeof addr.road === "string" && addr.road.trim()
            ? addr.road.trim()
            : typeof addr.suburb === "string" && addr.suburb.trim()
            ? addr.suburb.trim()
            : undefined;
    const locality =
        [addr.city, addr.town, addr.village, addr.hamlet, addr.municipality, addr.county].find(
            (v): v is string => typeof v === "string" && v.trim().length > 0
        ) ?? undefined;
    const isoState = typeof addr["ISO3166-2-lvl4"] === "string" ? addr["ISO3166-2-lvl4"].split("-")[1] : undefined;
    const stateCode =
        (isoState && isoState.trim()) || (typeof addr.state === "string" && addr.state.trim()) || undefined;
    const country = typeof addr.country === "string" && addr.country.trim() ? addr.country.trim() : undefined;
    const mapItemFullAddress =
        typeof payload.display_name === "string" && payload.display_name.trim()
            ? payload.display_name.trim()
            : undefined;
    const labelParts = [streetAddress, locality, stateCode].filter((v): v is string => Boolean(v));
    const label = labelParts.length > 0 ? labelParts.join(", ") : mapItemFullAddress;

    if (!label && !mapItemFullAddress && !streetAddress && !locality && !stateCode && !country) {
        return null;
    }
    return { label, mapItemFullAddress, streetAddress, locality, stateCode, country };
};

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const reverseGeocode = async (
    lat: number,
    lon: number,
    deps?: TrackerCommonDeps
): Promise<TrackerGeocodedAddress | null> => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    const baseDir = getTrackerBaseDir(deps?.baseDir);
    const cache = loadGeocodeCache(baseDir);
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;

    const cached = cache.get(key);
    if (cached) {
        touchLru(cache, key, cached);
        return cached;
    }

    const existing = inFlightGeocode.get(key);
    if (existing) return existing;

    const task = (async (): Promise<TrackerGeocodedAddress | null> => {
        const minInterval = deps?.nominatimMinIntervalMs ?? globalDeps.nominatimMinIntervalMs ?? DEFAULT_NOMINATIM_INTERVAL_MS;
        const fetchFn = deps?.fetchFn ?? globalDeps.fetchFn ?? fetch;

        const runRequest = async (): Promise<TrackerGeocodedAddress | null> => {
            const elapsed = Date.now() - lastNominatimRequestAt;
            if (elapsed < minInterval) {
                await wait(minInterval - elapsed);
            }
            lastNominatimRequestAt = Date.now();

            try {
                const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
                    lat.toFixed(6)
                )}&lon=${encodeURIComponent(lon.toFixed(6))}&addressdetails=1`;
                const res = await fetchFn(url, {
                    headers: {
                        "User-Agent": "BlueBubbles-Server/1.0 (tracker-geocode)",
                        Accept: "application/json"
                    }
                });
                if (!res.ok) return null;
                const json = await res.json();
                const parsed = parseNominatimAddress(json);
                if (parsed) {
                    touchLru(cache, key, parsed);
                    saveGeocodeCache(baseDir, cache);
                }
                return parsed;
            } catch {
                return null;
            }
        };

        const queued = nominatimQueue.then(runRequest, runRequest);
        nominatimQueue = queued.then(
            () => undefined,
            () => undefined
        );
        return queued;
    })();

    inFlightGeocode.set(key, task);
    try {
        return await task;
    } finally {
        inFlightGeocode.delete(key);
    }
};
