import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { FileSystem } from "@server/fileSystem";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

export type StickerRepresentationDto = {
    role: string;
    uti: string;
    mime_type: string;
    is_preferred: boolean;
    width: number;
    height: number;
    size: number;
};

export type LibraryStickerDto = {
    identifier: string;
    shelf: "saved" | "recent";
    type: number;
    effect: number;
    name: string | null;
    accessibility_name: string | null;
    library_index: number | null;
    representations: StickerRepresentationDto[];
};

export type StickerImageResult = {
    data: Buffer;
    mimeType: string;
};

export type ConvertToPngFn = (originalPath: string, outputPath: string) => Promise<void>;

const DEFAULT_STICKERS_DB_PATH = path.join(
    os.homedir(),
    "Library",
    "Group Containers",
    "com.apple.stickersd.group",
    "Stickers",
    "stickers.stickerdb"
);

const DEFAULT_FALLBACK_DIR = path.join(os.homedir(), "Library", "Application Support", "bluebubbles-server", "stickers");

export function formatUuidBuffer(buf: Buffer | Uint8Array | null | undefined): string {
    if (!buf || buf.length !== 16) return "";
    const hex = Buffer.from(buf).toString("hex").toUpperCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function parseUuidToBuffer(identifier: string): Buffer | null {
    const clean = (identifier ?? "").replace(/-/g, "").trim();
    if (!/^[0-9a-fA-F]{32}$/.test(clean)) return null;
    return Buffer.from(clean, "hex");
}

export function utiToMimeType(uti?: string | null): string {
    switch ((uti ?? "").toLowerCase()) {
        case "public.png":
            return "image/png";
        case "public.heic":
            return "image/heic";
        case "public.heics":
            return "image/heics";
        case "public.jpeg":
        case "public.jpg":
            return "image/jpeg";
        case "com.compuserve.gif":
            return "image/gif";
        case "org.webmproject.webp":
            return "image/webp";
        default:
            return "image/png";
    }
}

function extensionForMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case "image/heic":
            return ".heic";
        case "image/heics":
            return ".heics";
        case "image/jpeg":
            return ".jpg";
        case "image/gif":
            return ".gif";
        case "image/webp":
            return ".webp";
        default:
            return ".png";
    }
}

const ALLOWED_FALLBACK_MIME_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heics"
]);

function normalizeStickerMimeType(mimeType?: string, fileName?: string): string {
    const raw = (mimeType ?? "").split(";")[0].trim().toLowerCase();
    const mapped = raw === "image/jpg" ? "image/jpeg" : raw;
    if (ALLOWED_FALLBACK_MIME_TYPES.has(mapped)) return mapped;
    switch (path.extname(fileName ?? "").toLowerCase()) {
        case ".heic":
            return "image/heic";
        case ".heics":
            return "image/heics";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".gif":
            return "image/gif";
        case ".webp":
            return "image/webp";
        default:
            return "image/png";
    }
}

function mimeToUti(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case "image/heic":
            return "public.heic";
        case "image/heics":
            return "public.heics";
        case "image/jpeg":
            return "public.jpeg";
        case "image/gif":
            return "com.compuserve.gif";
        case "image/webp":
            return "org.webmproject.webp";
        default:
            return "public.png";
    }
}

type FallbackEntry = LibraryStickerDto & {
    fileName: string;
    mimeType: string;
};

export class StickerDatabase {
    private dbPath: string;
    private fallbackDir: string;
    private convertToPngFn: ConvertToPngFn;

    constructor(opts?: { dbPath?: string; fallbackDir?: string; convertToPng?: ConvertToPngFn }) {
        this.dbPath = opts?.dbPath ?? DEFAULT_STICKERS_DB_PATH;
        this.fallbackDir = opts?.fallbackDir ?? DEFAULT_FALLBACK_DIR;
        this.convertToPngFn = opts?.convertToPng ?? FileSystem.convertToPng;
    }

    private openReadOnly(): any | null {
        if (!fs.existsSync(this.dbPath)) return null;
        return new Database(this.dbPath, { readonly: true, fileMustExist: true });
    }

    private readFallbackIndex(): FallbackEntry[] {
        const indexPath = path.join(this.fallbackDir, "index.json");
        if (!fs.existsSync(indexPath)) return [];
        try {
            const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    private writeFallbackIndex(entries: FallbackEntry[]): void {
        fs.mkdirSync(this.fallbackDir, { recursive: true });
        const indexPath = path.join(this.fallbackDir, "index.json");
        const tmpPath = path.join(this.fallbackDir, `.index.json.tmp.${process.pid}.${uuidv4()}`);
        fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf8");
        fs.renameSync(tmpPath, indexPath);
    }

    listStickers(opts?: { limit?: number; offset?: number }): {
        stickers: LibraryStickerDto[];
        total: number;
        reason?: string;
    } {
        const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
        const offset = Math.max(0, opts?.offset ?? 0);
        const fallback = this.readFallbackIndex();
        const combined: LibraryStickerDto[] = [];
        let reason: string | undefined;

        let db: any = null;
        try {
            db = this.openReadOnly();
            if (!db) {
                if (fallback.length === 0) {
                    reason = "macOS iCloud sticker database not found (no stickers added or Full Disk Access not granted).";
                }
            } else {
                const stickerRows = db
                    .prepare(
                        `SELECT Z_PK, ZIDENTIFIER, ZTYPE, ZEFFECT, ZNAME, ZACCESSIBILITYNAME, ZLIBRARYINDEX
                         FROM ZMANAGEDSTICKER
                         ORDER BY COALESCE(ZLIBRARYINDEX, 0) DESC, Z_PK DESC`
                    )
                    .all() as any[];

                const repRows = db
                    .prepare(
                        `SELECT ZSTICKER, ZROLE, ZUTI, ZISPREFERRED, ZSIZE_W, ZSIZE_H, COALESCE(ZBYTECOUNT, length(ZDATA), 0) AS ZSIZE
                         FROM ZMANAGEDREPRESENTATION
                         ORDER BY ZISPREFERRED DESC, ZINDEX ASC, Z_PK ASC`
                    )
                    .all() as any[];

                const repsBySticker = new Map<number, StickerRepresentationDto[]>();
                for (const rep of repRows) {
                    const list = repsBySticker.get(rep.ZSTICKER) ?? [];
                    list.push({
                        role: rep.ZROLE ?? "com.apple.stickers.role.still",
                        uti: rep.ZUTI ?? "public.png",
                        mime_type: utiToMimeType(rep.ZUTI),
                        is_preferred: Boolean(rep.ZISPREFERRED),
                        width: Number(rep.ZSIZE_W ?? 0),
                        height: Number(rep.ZSIZE_H ?? 0),
                        size: Number(rep.ZSIZE ?? 0)
                    });
                    repsBySticker.set(rep.ZSTICKER, list);
                }

                for (const row of stickerRows) {
                    const identifier = formatUuidBuffer(row.ZIDENTIFIER);
                    if (!identifier) continue;
                    const reps = repsBySticker.get(row.Z_PK) ?? [];
                    if (reps.length === 0) continue;
                    combined.push({
                        identifier,
                        shelf: row.ZTYPE === 0 ? "saved" : "recent",
                        type: Number(row.ZTYPE ?? 1),
                        effect: Number(row.ZEFFECT ?? 0),
                        name: row.ZNAME ?? null,
                        accessibility_name: row.ZACCESSIBILITYNAME ?? null,
                        library_index: row.ZLIBRARYINDEX != null ? Number(row.ZLIBRARYINDEX) : null,
                        representations: reps
                    });
                }
            }
        } catch (ex: any) {
            if (fallback.length === 0) {
                reason = `Unable to read macOS sticker database: ${ex?.message ?? String(ex)}`;
            }
        } finally {
            try {
                db?.close();
            } catch {
                // ignore close errors
            }
        }

        for (const item of fallback) {
            combined.push({
                identifier: item.identifier,
                shelf: item.shelf,
                type: item.type,
                effect: item.effect,
                name: item.name,
                accessibility_name: item.accessibility_name,
                library_index: item.library_index,
                representations: item.representations
            });
        }

        const total = combined.length;
        const page = combined.slice(offset, offset + limit);
        return reason ? { stickers: page, total, reason } : { stickers: page, total };
    }

    async getStickerImage(
        identifier: string,
        opts?: { role?: string; original?: boolean }
    ): Promise<StickerImageResult | null> {
        const normalizedId = identifier.trim().toUpperCase();
        const fallback = this.readFallbackIndex().find(e => e.identifier.toUpperCase() === normalizedId);
        if (fallback) {
            const filePath = path.join(this.fallbackDir, fallback.fileName);
            if (!fs.existsSync(filePath)) return null;
            const raw = fs.readFileSync(filePath);
            const fallbackMime = normalizeStickerMimeType(fallback.mimeType, fallback.fileName);
            if (
                opts?.original ||
                fallbackMime === "image/png" ||
                fallbackMime === "image/jpeg" ||
                fallbackMime === "image/gif" ||
                fallbackMime === "image/webp"
            ) {
                return { data: raw, mimeType: fallbackMime };
            }
            return await this.convertBufferToPng(raw, fallbackMime);
        }

        const idBuf = parseUuidToBuffer(normalizedId);
        if (!idBuf) return null;

        let db: any = null;
        let chosen: { ZROLE: string; ZUTI: string; ZDATA: Buffer } | null = null;
        try {
            db = this.openReadOnly();
            if (!db) return null;

            const sticker = db
                .prepare("SELECT Z_PK FROM ZMANAGEDSTICKER WHERE ZIDENTIFIER = ? LIMIT 1")
                .get(idBuf) as { Z_PK: number } | undefined;
            if (!sticker) return null;

            const reps = db
                .prepare(
                    `SELECT ZROLE, ZUTI, ZISPREFERRED, ZDATA
                     FROM ZMANAGEDREPRESENTATION
                     WHERE ZSTICKER = ? AND ZDATA IS NOT NULL
                     ORDER BY ZISPREFERRED DESC, ZINDEX ASC, Z_PK ASC`
                )
                .all(sticker.Z_PK) as Array<{ ZROLE: string; ZUTI: string; ZISPREFERRED: number; ZDATA: Buffer }>;

            if (reps.length === 0) return null;

            if (opts?.role === "keyboard") {
                chosen =
                    reps.find(r => r.ZROLE === "com.apple.stickers.role.keyboard") ??
                    reps.find(r => Boolean(r.ZISPREFERRED)) ??
                    reps[0];
            } else {
                chosen =
                    reps.find(r => Boolean(r.ZISPREFERRED) && r.ZROLE !== "com.apple.stickers.role.keyboard") ??
                    reps.find(r => r.ZROLE !== "com.apple.stickers.role.keyboard") ??
                    reps[0];
            }
        } finally {
            try {
                db?.close();
            } catch {
                // ignore close errors
            }
        }

        if (!chosen || !chosen.ZDATA) return null;
        const mimeType = utiToMimeType(chosen.ZUTI);
        const passthroughMime =
            mimeType === "image/png" ||
            mimeType === "image/jpeg" ||
            mimeType === "image/gif" ||
            mimeType === "image/webp";
        if (opts?.original || passthroughMime) {
            return { data: Buffer.from(chosen.ZDATA), mimeType };
        }

        return await this.convertBufferToPng(Buffer.from(chosen.ZDATA), mimeType);
    }

    private async convertBufferToPng(buf: Buffer, mimeType: string): Promise<StickerImageResult> {
        const tmpBase = path.join(os.tmpdir(), `bb-sticker-${uuidv4()}`);
        const srcPath = `${tmpBase}${extensionForMime(mimeType)}`;
        const outPath = `${tmpBase}.png`;
        try {
            fs.writeFileSync(srcPath, buf);
            await this.convertToPngFn(srcPath, outPath);
            const pngData = fs.readFileSync(outPath);
            return { data: pngData, mimeType: "image/png" };
        } finally {
            fs.promises.unlink(srcPath).catch((): void => null);
            fs.promises.unlink(outPath).catch((): void => null);
        }
    }

    addFallbackSticker(opts: {
        buffer: Buffer;
        fileName?: string;
        name?: string | null;
        mimeType?: string;
        width?: number;
        height?: number;
    }): LibraryStickerDto {
        fs.mkdirSync(this.fallbackDir, { recursive: true });
        const identifier = uuidv4().toUpperCase();
        const mimeType = normalizeStickerMimeType(opts.mimeType, opts.fileName);
        const ext = extensionForMime(mimeType);
        const storedName = `${identifier}${ext}`;
        fs.writeFileSync(path.join(this.fallbackDir, storedName), opts.buffer);

        const entry: FallbackEntry = {
            identifier,
            shelf: "recent",
            type: 1,
            effect: 0,
            name: opts.name ?? null,
            accessibility_name: opts.name ?? null,
            library_index: Date.now(),
            fileName: storedName,
            mimeType,
            representations: [
                {
                    role: "com.apple.stickers.role.still",
                    uti: mimeToUti(mimeType),
                    mime_type: mimeType,
                    is_preferred: true,
                    width: opts.width ?? 512,
                    height: opts.height ?? 512,
                    size: opts.buffer.length
                }
            ]
        };

        const index = this.readFallbackIndex();
        index.unshift(entry);
        this.writeFallbackIndex(index);

        const { fileName: _f, mimeType: _m, ...dto } = entry;
        return dto;
    }

    deleteFallbackSticker(identifier: string): boolean {
        const normalizedId = identifier.trim().toUpperCase();
        const index = this.readFallbackIndex();
        const target = index.find(e => e.identifier.toUpperCase() === normalizedId);
        if (!target) return false;

        const filePath = path.join(this.fallbackDir, target.fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        this.writeFallbackIndex(index.filter(e => e.identifier.toUpperCase() !== normalizedId));
        return true;
    }
}

export const stickerDb = new StickerDatabase();
