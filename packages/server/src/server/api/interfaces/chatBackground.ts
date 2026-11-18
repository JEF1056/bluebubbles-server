import * as fs from "fs";
import * as path from "path";
import bplistParser from "bplist-parser";

const SAFE_BG_GUID_RE = /^[A-Za-z0-9-]+$/;
const IMAGE_EXTS = new Set([".heic", ".heif", ".jpg", ".jpeg", ".png"]);

/**
 * Extracts and validates the current wallpaper GUID (`trabaid` / `backgroundChannelGUID`)
 * from a chat's decoded `properties` plist array or dict.
 */
export function extractBackgroundGuid(properties: unknown): string | null {
    const entries = Array.isArray(properties)
        ? properties
        : properties && typeof properties === "object"
          ? [properties]
          : [];

    let found: string | null = null;
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const bgProps = record.backgroundProperties;
        const trabaid =
            bgProps && typeof bgProps === "object" ? (bgProps as Record<string, unknown>).trabaid : undefined;
        const candidate =
            typeof trabaid === "string" && trabaid.length > 0
                ? trabaid
                : typeof record.backgroundChannelGUID === "string" && record.backgroundChannelGUID.length > 0
                  ? record.backgroundChannelGUID
                  : null;
        if (candidate && SAFE_BG_GUID_RE.test(candidate)) {
            found = candidate;
        }
    }

    return found;
}

/**
 * Finds the extracted background image inside an unpacked Apple Archive (`AA01`)
 * TranscriptBackgroundCache directory, preferring `portrait-layer_background.*`.
 */
export function findLayerStackImage(rootDir: string, maxDepth = 8): string | null {
    let fallback: string | null = null;

    const walk = (dir: string, depth: number): string | null => {
        if (depth > maxDepth) return null;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return null;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const match = walk(fullPath, depth + 1);
                if (match) return match;
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!IMAGE_EXTS.has(ext)) continue;
                if (entry.name.startsWith("portrait-layer_background")) {
                    return fullPath;
                }
                if (!fallback && path.basename(dir) === "output.layerStack") {
                    fallback = fullPath;
                }
            }
        }
        return null;
    };

    return walk(rootDir, 0) ?? fallback;
}

/**
 * Extracts `backgroundImageData` PNG bytes from a `-watchBackground` binary plist buffer.
 */
export function extractWatchBackgroundImage(plistBuffer: Buffer): Buffer | null {
    if (!plistBuffer || plistBuffer.length === 0) return null;
    try {
        const parsed = bplistParser.parseBuffer(plistBuffer);
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (first && typeof first === "object") {
            const data = (first as Record<string, unknown>).backgroundImageData;
            if (Buffer.isBuffer(data) && data.length > 0) {
                return data;
            }
        }
    } catch {
        return null;
    }
    return null;
}
