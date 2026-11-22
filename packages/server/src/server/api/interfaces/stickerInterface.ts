import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { Server } from "@server";
import { FileSystem } from "@server/fileSystem";
import { StickerDatabase, stickerDb, LibraryStickerDto, StickerImageResult } from "@server/databases/stickers";
import { PrivateApiSticker } from "@server/api/privateApi/apis/PrivateApiSticker";

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
                const identifier = res?.data?.identifier;
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
        const safeName = path.basename(params.fileName ?? params.filePath) || "sticker.png";
        const savedPath = FileSystem.saveAttachment(`${uuidv4()}-${safeName}`, buf);

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

        const msgGuid = result?.data?.identifier;
        if (typeof msgGuid === "string" && msgGuid.length > 0) {
            const msg = await Server().iMessageRepo.getMessage(msgGuid, false, true);
            if (msg) return msg;
        }

        return { identifier: msgGuid ?? null };
    }
}
