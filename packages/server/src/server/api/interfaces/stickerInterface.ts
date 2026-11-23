import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { Server } from "@server";
import { resultAwaiter } from "@server/helpers/utils";
import { FileSystem } from "@server/fileSystem";
import { StickerDatabase, stickerDb, LibraryStickerDto, StickerImageResult } from "@server/databases/stickers";
import { PrivateApiSticker } from "@server/api/privateApi/apis/PrivateApiSticker";
import { decodeStickerUserInfo } from "@server/api/serializers/AttachmentSerializer";

export type SendStickerRequest = {
    chatGuid: string;
    filePath: string;
    fileName?: string;
    selectedMessageGuid?: string | null;
    associatedMessageGuid?: string | null;
    partIndex?: number;
    associatedMessagePart?: number;
    associatedMessageType?: number;
    tapback?: boolean;
    remove?: boolean;
    stickerUserInfo?: Record<string, any> | null;
};

export type RepositionStickerRequest = {
    chatGuid: string;
    messageGuid: string;
    xScalar: number;
    yScalar: number;
    scale: number;
    rotation: number;
    parentPreviewWidth: number;
};

function detectStickerExt(buf: Buffer): string | null {
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
    if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "GIF8") return ".gif";
    if (
        buf.length >= 12 &&
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
        return ".webp";
    }
    if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") {
        const brand = buf.subarray(8, 12).toString("ascii");
        if (brand === "heic" || brand === "heix") return ".heic";
        if (brand === "msf1" || brand === "hevc") return ".heics";
    }
    return null;
}

export class StickerInterface {
    static db: StickerDatabase = stickerDb;

    static listStickers(limit = 100, offset = 0): {
        stickers: LibraryStickerDto[];
        total: number;
        reason?: string;
    } {
        return StickerInterface.db.listStickers({ limit, offset });
    }

    static async getStickerImage(
        identifier: string,
        opts?: { role?: string; original?: boolean }
    ): Promise<StickerImageResult | null> {
        return await StickerInterface.db.getStickerImage(identifier, opts);
    }

    static async addSticker(opts: {
        buffer: Buffer;
        fileName?: string;
        name?: string | null;
        mimeType?: string;
    }): Promise<LibraryStickerDto | null> {
        const privateApi = Server().privateApi;
        if (privateApi?.helper) {
            const baseName = path.basename(opts.fileName ?? "sticker.png") || "sticker.png";
            const tempPath = FileSystem.saveAttachment(`sticker-${uuidv4()}-${baseName}`, opts.buffer);
            try {
                const res = await new PrivateApiSticker(privateApi).addSticker(tempPath, opts.name);
                const identifier = res?.identifier ?? res?.data?.identifier;
                if (typeof identifier === "string" && identifier.length > 0) {
                    const list = StickerInterface.db.listStickers({ limit: 500, offset: 0 });
                    return list.stickers.find(s => s.identifier.toUpperCase() === identifier.toUpperCase()) ?? null;
                }
            } catch {
                // Fall back to server-managed local sticker store when stickersd XPC is unavailable
            } finally {
                fs.promises.unlink(tempPath).catch((): void => null);
            }
        }

        return StickerInterface.db.addFallbackSticker({
            buffer: opts.buffer,
            fileName: opts.fileName,
            name: opts.name,
            mimeType: opts.mimeType
        });
    }

    static async deleteSticker(identifier: string): Promise<void> {
        if (StickerInterface.db.deleteFallbackSticker(identifier)) {
            return;
        }

        const privateApi = Server().privateApi;
        if (!privateApi?.helper) {
            throw new Error("BlueBubblesHelper is not connected to delete iCloud stickers.");
        }

        await new PrivateApiSticker(privateApi).deleteSticker(identifier);
    }

    static async sendSticker(params: SendStickerRequest) {
        const privateApi = Server().privateApi;
        if (!privateApi?.helper) {
            throw new Error("BlueBubblesHelper is not connected!");
        }

        const buf = fs.readFileSync(params.filePath);
        const rawName = path.basename(params.fileName ?? params.filePath) || "sticker.png";
        const detectedExt = detectStickerExt(buf);
        // Converted stickers can arrive with their original extension (e.g. .heics for PNG bytes), which makes imagent tag the wrong UTI.
        const safeName = detectedExt ? `${path.parse(rawName).name}${detectedExt}` : rawName;
        const savedPath = FileSystem.saveAttachment(`${uuidv4()}-${safeName}`, buf);

        try {
            let assocType = params.associatedMessageType ?? 1000;
            if (params.tapback) {
                assocType = params.remove ? 3007 : 2007;
            }

            const result = await new PrivateApiSticker(privateApi).sendSticker({
                chatGuid: params.chatGuid,
                filePath: savedPath,
                selectedMessageGuid: params.selectedMessageGuid,
                associatedMessageGuid: params.associatedMessageGuid ?? params.selectedMessageGuid,
                partIndex: params.partIndex ?? params.associatedMessagePart ?? 0,
                associatedMessagePart: params.associatedMessagePart ?? params.partIndex ?? 0,
                associatedMessageType: assocType,
                stickerUserInfo: params.stickerUserInfo
            });

            const msgGuid = result?.identifier ?? result?.data?.identifier;
            if (typeof msgGuid !== "string" || msgGuid.length === 0) {
                throw new Error("Failed to send sticker! No message GUID returned.");
            }

            const maxWaitMs = 60000;
            const retMessage = await resultAwaiter({
                maxWaitMs,
                getData: async _ => {
                    return await Server().iMessageRepo.getMessage(msgGuid, true, true);
                }
            });

            if (!retMessage) {
                throw new Error(
                    `Failed to send sticker! Sticker message not found in database after ${maxWaitMs / 1000} seconds!`
                );
            }

            return retMessage;
        } finally {
            fs.promises.unlink(savedPath).catch(() => {});
        }
    }

    static async repositionSticker(params: RepositionStickerRequest) {
        const privateApi = Server().privateApi;
        if (!privateApi?.helper) {
            throw new Error("BlueBubblesHelper is not connected!");
        }

        const readStickerSpv = (msg: any): number | undefined => {
            const info = decodeStickerUserInfo(msg?.attachments?.[0]?.stickerUserInfo);
            const spv = info?.spv;
            if (typeof spv === "number" && Number.isFinite(spv)) return spv;
            if (typeof spv === "string" && spv.trim().length > 0) {
                const parsed = Number(spv);
                if (Number.isFinite(parsed)) return parsed;
            }
            return undefined;
        };

        const before = await Server().iMessageRepo.getMessage(params.messageGuid, true, true);
        const currentSpv = readStickerSpv(before);

        await new PrivateApiSticker(privateApi).repositionSticker({
            ...params,
            ...(currentSpv !== undefined ? { currentSpv } : {})
        });

        const retMessage = await resultAwaiter({
            maxWaitMs: 3000,
            initialWaitMs: 50,
            waitMultiplier: 1.5,
            getData: async _ => await Server().iMessageRepo.getMessage(params.messageGuid, true, true),
            extraLoopCondition: data => {
                if (currentSpv === undefined) return false;
                const nextSpv = readStickerSpv(data);
                return nextSpv === undefined || nextSpv <= currentSpv;
            }
        });
        if (!retMessage) {
            throw new Error(`Failed to reposition sticker! Message '${params.messageGuid}' not found in database.`);
        }

        return retMessage;
    }
}
