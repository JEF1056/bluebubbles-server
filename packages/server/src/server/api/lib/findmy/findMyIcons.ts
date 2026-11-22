import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import type { FindMyDevice } from "./types";

type FindMyRole = NonNullable<FindMyDevice["role"]>;

export type FindMyIconCategory =
    | "phone"
    | "tablet"
    | "laptop"
    | "desktop"
    | "watch"
    | "headphones"
    | "earbuds"
    | "tracker"
    | "speaker"
    | "car"
    | "accessory";

export interface ResolvedDeviceIcon {
    bytes: Buffer;
    contentType: string;
}

const ALLOWED_ICON_HOSTS = [
    ".googleusercontent.com",
    ".gstatic.com",
    "statici.icloud.com",
    ".icloud.com",
    "client.smartthings.com",
    ".smartthings.com",
    ".samsungiotcloud.com",
    ".samsung.com"
];

const APPLE_PREFIX_CASING: Array<[RegExp, string]> = [
    [/^iphone/i, "iPhone"],
    [/^ipad/i, "iPad"],
    [/^ipod/i, "iPod"],
    [/^macbookpro/i, "MacBookPro"],
    [/^macbookair/i, "MacBookAir"],
    [/^macbook/i, "MacBook"],
    [/^macmini/i, "Macmini"],
    [/^macstudio/i, "MacStudio"],
    [/^macpro/i, "MacPro"],
    [/^imac/i, "iMac"],
    [/^watch/i, "Watch"],
    [/^appletv/i, "AppleTV"],
    [/^audioaccessory/i, "AudioAccessory"],
    [/^airpods/i, "AirPods"],
    [/^realitydevice/i, "RealityDevice"]
];

const APPLE_IMAGECACHE_DIR = path.join(os.homedir(), "Library", "Caches", "com.apple.findmy.imagecache", "devices");
const DISK_ICON_CACHE_DIR = path.join(os.tmpdir(), "bb-findmy-icons");
const ICON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const MAX_MEM_ICONS = 128;

const memIconCache = new Map<string, { data: ResolvedDeviceIcon; expiresAt: number }>();
const failureCache = new Map<string, number>();
const inflightFetches = new Map<string, Promise<ResolvedDeviceIcon | null>>();
let appleImageCacheFiles: { at: number; files: string[] } | null = null;

export function normalizeAppleDeviceModel(rawModel?: string | null): string | null {
    const trimmed = rawModel?.trim();
    if (!trimmed) return null;

    let normalized = trimmed;
    for (const [re, canonical] of APPLE_PREFIX_CASING) {
        if (re.test(normalized)) {
            normalized = normalized.replace(re, canonical);
            break;
        }
    }
    // Convert Apple's serialized underscore/hyphen comma substitute back to `<Family><Major>,<Minor>`
    normalized = normalized.replace(/^([A-Za-z]+\d+)[_-](\d+)/, "$1,$2");
    return normalized;
}

function normalizeAppleClass(device: Partial<FindMyDevice>): string | null {
    const cls = device.deviceClass?.trim();
    if (cls) {
        if (cls.toLowerCase() === "b389") return "Accessory";
        return cls;
    }
    const raw = (device.rawDeviceModel ?? device.deviceModel ?? "").toLowerCase();
    if (raw.startsWith("iphone")) return "iPhone";
    if (raw.startsWith("ipad")) return "iPad";
    if (raw.startsWith("macbookpro")) return "MacBookPro";
    if (raw.startsWith("macbookair")) return "MacBookAir";
    if (raw.startsWith("macbook")) return "MacBook";
    if (raw.startsWith("macmini")) return "Macmini";
    if (raw.startsWith("macstudio")) return "MacStudio";
    if (raw.startsWith("macpro")) return "MacPro";
    if (raw.startsWith("imac")) return "iMac";
    if (raw.startsWith("watch")) return "Watch";
    if (raw.startsWith("airpods") || raw.startsWith("accessory")) return "Accessory";
    if (raw.startsWith("audioaccessory")) return "AudioAccessory";
    return null;
}

function listAppleImageCacheFiles(): string[] {
    const now = Date.now();
    if (appleImageCacheFiles && now - appleImageCacheFiles.at < 60_000) {
        return appleImageCacheFiles.files;
    }
    try {
        const files = fs.readdirSync(APPLE_IMAGECACHE_DIR).filter(f => f.toLowerCase().endsWith(".png"));
        appleImageCacheFiles = { at: now, files };
        return files;
    } catch {
        appleImageCacheFiles = { at: now, files: [] };
        return [];
    }
}

export function findLocalAppleImageCachePath(device: Partial<FindMyDevice>): string | null {
    const rawModel = device.rawDeviceModel ?? device.deviceModel;
    const normModel = normalizeAppleDeviceModel(rawModel);
    if (!normModel) return null;

    const baseModel = normModel.split("-")[0];
    const cls = normalizeAppleClass(device);
    const files = listAppleImageCacheFiles();
    if (files.length === 0) return null;

    const prefixes = [
        cls ? `${cls}-${normModel}-`.toLowerCase() : null,
        cls && baseModel !== normModel ? `${cls}-${baseModel}-`.toLowerCase() : null
    ].filter((x): x is string => Boolean(x));

    for (const prefix of prefixes) {
        const match = files.find(f => f.toLowerCase().startsWith(prefix));
        if (match) return path.join(APPLE_IMAGECACHE_DIR, match);
    }

    const needle = `-${normModel.toLowerCase()}-`;
    const fallback = files.find(f => f.toLowerCase().includes(needle));
    return fallback ? path.join(APPLE_IMAGECACHE_DIR, fallback) : null;
}

export function buildAppleImageCandidateUrls(device: Partial<FindMyDevice>): string[] {
    const cls = normalizeAppleClass(device);
    const norm = normalizeAppleDeviceModel(device.rawDeviceModel ?? device.deviceModel);
    if (!cls || !norm) return [];

    const out: string[] = [];
    const seen = new Set<string>();
    const add = (c: string, m: string) => {
        const u = `https://statici.icloud.com/fmipmobile/deviceImages-9.0/${encodeURIComponent(c)}/${encodeURIComponent(m).replace(/%2C/gi, ",")}/online-infobox__2x.png`;
        if (!seen.has(u)) {
            seen.add(u);
            out.push(u);
        }
    };

    add(cls, norm);
    const base = norm.split("-")[0];
    if (base && base !== norm) {
        add(cls, base);
    }
    return out;
}

export function inferIconCategory(device: Partial<FindMyDevice>): FindMyIconCategory {
    const existing = typeof device.iconCategory === "string" ? device.iconCategory.trim().toLowerCase() : "";
    if (existing) {
        if (
            existing === "phone" ||
            existing === "tablet" ||
            existing === "laptop" ||
            existing === "desktop" ||
            existing === "watch" ||
            existing === "headphones" ||
            existing === "earbuds" ||
            existing === "tracker" ||
            existing === "speaker" ||
            existing === "car" ||
            existing === "accessory"
        ) {
            return existing;
        }
        if (existing === "tag" || existing === "smarttag" || existing === "airtag") return "tracker";
        if (existing === "smartwatch") return "watch";
        if (existing === "headset" || existing === "audio") return "headphones";
    }

    const cls = (device.deviceClass ?? "").toLowerCase();
    const model = (device.rawDeviceModel ?? device.deviceModel ?? device.modelDisplayName ?? "").toLowerCase();
    const name = (device.name ?? "").toLowerCase();
    const combined = `${cls} ${model} ${name}`;

    if (device.id?.startsWith("utag:")) return "tracker";
    if (cls === "b389" || combined.includes("airtag") || combined.includes("smarttag") || combined.includes("tile")) {
        return "tracker";
    }
    if (combined.includes("watch") || cls === "watch") return "watch";
    if (
        combined.includes("airpods") ||
        combined.includes("earbud") ||
        combined.includes("buds") ||
        combined.includes("wf-1000") ||
        combined.includes("wf1000")
    ) {
        return "earbuds";
    }
    if (
        combined.includes("headphone") ||
        combined.includes("headset") ||
        combined.includes("wh-1000") ||
        combined.includes("wh1000") ||
        combined.includes("beats")
    ) {
        return "headphones";
    }
    if (combined.includes("ipad") || combined.includes("tablet")) return "tablet";
    if (combined.includes("macbook") || combined.includes("laptop")) return "laptop";
    if (
        combined.includes("imac") ||
        combined.includes("macmini") ||
        combined.includes("mac mini") ||
        combined.includes("macstudio") ||
        combined.includes("mac studio") ||
        combined.includes("macpro") ||
        combined.includes("mac pro") ||
        combined.includes("desktop")
    ) {
        return "desktop";
    }
    if (combined.includes("homepod") || combined.includes("audioaccessory") || combined.includes("speaker")) {
        return "speaker";
    }
    if (combined.includes("iphone") || combined.includes("pixel") || combined.includes("phone") || combined.includes("galaxy s")) {
        return "phone";
    }
    if (combined.includes("car") || combined.includes("vehicle")) return "car";
    if (device.isConsideredAccessory) return "accessory";
    return "accessory";
}

const DEFAULT_ROLE_EMOJI: Record<FindMyIconCategory, string> = {
    phone: "📱",
    tablet: "📱",
    laptop: "💻",
    desktop: "🖥️",
    watch: "⌚",
    headphones: "🎧",
    earbuds: "🎧",
    tracker: "🏷️",
    speaker: "🔊",
    car: "🚗",
    accessory: "📍"
};

export function inferDeviceRole(device: Partial<FindMyDevice>, category: FindMyIconCategory): FindMyRole | undefined {
    const existing = device.role;
    if (existing && typeof existing.emoji === "string" && existing.emoji.trim().length > 0) {
        return existing;
    }

    const name = (device.name ?? "").toLowerCase();
    let emoji = DEFAULT_ROLE_EMOJI[category];
    if (category === "tracker" || category === "accessory") {
        if (name.includes("key")) emoji = "🔑";
        else if (name.includes("wallet") || name.includes("purse")) emoji = "👛";
        else if (name.includes("backpack")) emoji = "🎒";
        else if (name.includes("briefcase")) emoji = "💼";
        else if (name.includes("bag") || name.includes("luggage") || name.includes("suitcase")) emoji = "🧳";
        else if (name.includes("bike") || name.includes("bicycle")) emoji = "🚲";
        else if (name.includes("car") || name.includes("auto")) emoji = "🚗";
        else if (name.includes("camera")) emoji = "📷";
    }

    return {
        name: existing?.name?.trim() || category,
        emoji,
        identifier: existing?.identifier ?? 0
    };
}

export function enrichFindMyDeviceIcon(device: FindMyDevice): FindMyDevice {
    const category = inferIconCategory(device);
    const role = inferDeviceRole(device, category);

    let iconUrl = typeof device.iconUrl === "string" && device.iconUrl.trim().length > 0 ? device.iconUrl.trim() : undefined;
    if (!iconUrl && !device.id?.startsWith("gfind:") && !device.id?.startsWith("utag:")) {
        const candidates = buildAppleImageCandidateUrls(device);
        if (candidates.length > 0) {
            iconUrl = candidates[0];
        } else if (findLocalAppleImageCachePath(device)) {
            const id = device.id ?? device.deviceDiscoveryId ?? device.serialNumber ?? device.identifier;
            if (id) iconUrl = `/api/v1/icloud/findmy/devices/icon?id=${encodeURIComponent(id)}`;
        }
    }

    return {
        ...device,
        iconCategory: category,
        ...(iconUrl ? { iconUrl } : {}),
        ...(role ? { role } : {})
    };
}

export function isAllowedUpstreamIconUrl(rawUrl: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) {
        return false;
    }
    return ALLOWED_ICON_HOSTS.some(allowed =>
        allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed
    );
}

export function detectRasterContentType(bytes: Buffer, headerType?: string | null): string | null {
    if (!bytes || bytes.length < 12) return null;

    // Reject HTML/JSON/XML/SVG error pages even when returned with HTTP 200
    let firstNonWs = 0;
    while (firstNonWs < Math.min(bytes.length, 64)) {
        const b = bytes[firstNonWs];
        if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) break;
        firstNonWs++;
    }
    const lead = bytes[firstNonWs];
    if (lead === 0x3c /* '<' */ || lead === 0x7b /* '{' */ || lead === 0x5b /* '[' */) {
        return null;
    }

    const ct = (headerType ?? "").split(";")[0].trim().toLowerCase();
    if (ct && (ct.includes("html") || ct.includes("json") || ct.includes("xml") || ct.includes("svg") || ct.startsWith("text/"))) {
        return null;
    }

    if (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }
    if (
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
        return "image/webp";
    }
    if (bytes.subarray(0, 4).toString("ascii") === "GIF8") {
        return "image/gif";
    }
    return null;
}

export function findDeviceForIconLookup(devices: FindMyDevice[], requestedId: string): FindMyDevice | undefined {
    const target = requestedId.trim();
    if (!target) return undefined;
    return devices.find(
        d =>
            d.id === target ||
            d.deviceDiscoveryId === target ||
            d.serialNumber === target ||
            d.identifier === target
    );
}

function storeMemCache(key: string, data: ResolvedDeviceIcon): void {
    memIconCache.delete(key);
    memIconCache.set(key, { data, expiresAt: Date.now() + ICON_CACHE_TTL_MS });
    while (memIconCache.size > MAX_MEM_ICONS) {
        const oldest = memIconCache.keys().next().value;
        if (!oldest) break;
        memIconCache.delete(oldest);
    }
}

function diskCachePaths(key: string): { bin: string; meta: string } {
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    return {
        bin: path.join(DISK_ICON_CACHE_DIR, `${hash}.bin`),
        meta: path.join(DISK_ICON_CACHE_DIR, `${hash}.json`)
    };
}

function readDiskCache(key: string): ResolvedDeviceIcon | null {
    try {
        const { bin, meta } = diskCachePaths(key);
        const stat = fs.statSync(bin);
        if (Date.now() - stat.mtimeMs > ICON_CACHE_TTL_MS) return null;
        const metaRaw = JSON.parse(fs.readFileSync(meta, "utf8")) as { contentType?: string };
        const bytes = fs.readFileSync(bin);
        const ct = detectRasterContentType(bytes, metaRaw.contentType);
        if (!ct) return null;
        return { bytes, contentType: ct };
    } catch {
        return null;
    }
}

function writeDiskCache(key: string, icon: ResolvedDeviceIcon): void {
    try {
        fs.mkdirSync(DISK_ICON_CACHE_DIR, { recursive: true });
        const { bin, meta } = diskCachePaths(key);
        fs.writeFileSync(bin, icon.bytes);
        fs.writeFileSync(meta, JSON.stringify({ contentType: icon.contentType }));
    } catch {
        // Disk cache is best-effort
    }
}

export async function resolveFindMyDeviceIconBytes(
    device: FindMyDevice,
    fetchFn: typeof fetch = fetch
): Promise<ResolvedDeviceIcon | null> {
    const isApple = !device.id?.startsWith("gfind:") && !device.id?.startsWith("utag:");

    if (isApple) {
        const localPath = findLocalAppleImageCachePath(device);
        if (localPath) {
            try {
                const bytes = fs.readFileSync(localPath);
                const contentType = detectRasterContentType(bytes, "image/png");
                if (contentType) return { bytes, contentType };
            } catch {
                // Fall through to remote statici fetch
            }
        }
    }

    const candidateUrls: string[] = [];
    if (typeof device.iconUrl === "string" && isAllowedUpstreamIconUrl(device.iconUrl)) {
        candidateUrls.push(device.iconUrl);
    }
    if (isApple) {
        for (const u of buildAppleImageCandidateUrls(device)) {
            if (!candidateUrls.includes(u) && isAllowedUpstreamIconUrl(u)) {
                candidateUrls.push(u);
            }
        }
    }
    if (candidateUrls.length === 0) return null;

    const cacheKey = candidateUrls.join("|");
    const now = Date.now();
    const memHit = memIconCache.get(cacheKey);
    if (memHit && memHit.expiresAt > now) {
        return memHit.data;
    }
    const failedUntil = failureCache.get(cacheKey);
    if (failedUntil && failedUntil > now) {
        return null;
    }

    const diskHit = readDiskCache(cacheKey);
    if (diskHit) {
        storeMemCache(cacheKey, diskHit);
        return diskHit;
    }

    const pending = inflightFetches.get(cacheKey);
    if (pending) return pending;

    const task = (async (): Promise<ResolvedDeviceIcon | null> => {
        for (const url of candidateUrls) {
            try {
                let currentUrl = url;
                let res: Response | null = null;
                for (let hop = 0; hop <= 5; hop++) {
                    const attempt = await fetchFn(currentUrl, { redirect: "manual" });
                    if (attempt.status >= 300 && attempt.status < 400) {
                        const location = attempt.headers.get("location");
                        if (!location || hop === 5) {
                            res = null;
                            break;
                        }
                        let nextUrl: string;
                        try {
                            nextUrl = new URL(location, currentUrl).toString();
                        } catch {
                            res = null;
                            break;
                        }
                        if (!isAllowedUpstreamIconUrl(nextUrl)) {
                            res = null;
                            break;
                        }
                        currentUrl = nextUrl;
                        continue;
                    }
                    res = attempt;
                    break;
                }
                if (!res || !res.ok) continue;
                if (res.url && !isAllowedUpstreamIconUrl(res.url)) continue;
                const ab = await res.arrayBuffer();
                const bytes = Buffer.from(ab);
                const contentType = detectRasterContentType(bytes, res.headers.get("content-type"));
                if (!contentType) continue;
                const resolved = { bytes, contentType };
                storeMemCache(cacheKey, resolved);
                writeDiskCache(cacheKey, resolved);
                return resolved;
            } catch {
                // Try next candidate
            }
        }
        failureCache.set(cacheKey, Date.now() + FAILURE_COOLDOWN_MS);
        return null;
    })();

    inflightFetches.set(cacheKey, task);
    try {
        return await task;
    } finally {
        if (inflightFetches.get(cacheKey) === task) {
            inflightFetches.delete(cacheKey);
        }
    }
}

export function clearFindMyIconCacheForTest(): void {
    memIconCache.clear();
    failureCache.clear();
    inflightFetches.clear();
    appleImageCacheFiles = null;
}
