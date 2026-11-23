import { Server } from "@server";
import * as fs from "fs";
import * as base64 from "byte-base64";
import bplistParser from "bplist-parser";
import { parse as parseXmlPlist } from "plist";
import { Metadata } from "@server/fileSystem/types";
import { convertAudio, convertImage, getAttachmentMetadata } from "@server/databases/imessage/helpers/utils";
import { FileSystem } from "@server/fileSystem";
import { AttachmentResponse, StickerPlacementResponse } from "@server/types";
import { DEFAULT_ATTACHMENT_CONFIG } from "./constants";
import type { AttachmentSerializerMultiParams, AttachmentSerializerSingleParams } from "./types";
import { AttachmentInterface } from "../interfaces/attachmentInterface";

const BPLIST_MAGIC = Buffer.from("bplist", "ascii");

function parseFiniteNumber(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) return null;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

export function decodeStickerUserInfo(raw: unknown): Record<string, unknown> | null {
    if (!raw) return null;
    let decoded: unknown = raw;
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (buf.length === 0) return null;
        try {
            if (buf.length >= BPLIST_MAGIC.length && buf.subarray(0, BPLIST_MAGIC.length).equals(BPLIST_MAGIC)) {
                decoded = bplistParser.parseBuffer(buf);
            } else {
                const text = buf.toString("utf8").trimStart();
                if (!text.startsWith("<")) return null;
                decoded = parseXmlPlist(text);
            }
        } catch {
            return null;
        }
    }
    if (Array.isArray(decoded)) {
        decoded = decoded[0];
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        return null;
    }
    return decoded as Record<string, unknown>;
}

/**
 * Parses Apple's `attachment.sticker_user_info` binary/XML plist into the
 * normalized sticker placement geometry expected by BlueBubbles clients.
 *
 * Apple stores placement values as numeric strings when `spv=0` (e.g.
 * `sxs="0.64425055"`) and as IEEE numbers when `spv>=1`. Standalone stickers
 * and emoji tapbacks omit the placement keys and return `null`.
 */
export function parseStickerPlacement(raw: unknown): StickerPlacementResponse | null {
    const info = decodeStickerUserInfo(raw);
    if (!info) return null;

    const xScalar = parseFiniteNumber(info.sxs ?? info.xScalar);
    const yScalar = parseFiniteNumber(info.sys ?? info.yScalar);
    const scale = parseFiniteNumber(info.ssa ?? info.scale);
    const rotation = parseFiniteNumber(info.sro ?? info.rotation);
    const parentPreviewWidth = parseFiniteNumber(info.spw ?? info.parentPreviewWidth);

    if (
        xScalar === null ||
        yScalar === null ||
        scale === null ||
        rotation === null ||
        parentPreviewWidth === null ||
        scale <= 0 ||
        parentPreviewWidth < 0
    ) {
        return null;
    }

    return {
        xScalar,
        yScalar,
        scale,
        rotation,
        parentPreviewWidth
    };
}

export class AttachmentSerializer {
    static async serialize({
        attachment,
        config = DEFAULT_ATTACHMENT_CONFIG,
        isForNotification = false
    }: AttachmentSerializerSingleParams): Promise<AttachmentResponse> {
        return (
            await AttachmentSerializer.serializeList({
                attachments: [attachment],
                config: { ...DEFAULT_ATTACHMENT_CONFIG, ...config },
                isForNotification
            })
        )[0];
    }

    static async serializeList({
        attachments,
        config = DEFAULT_ATTACHMENT_CONFIG,
        isForNotification = false
    }: AttachmentSerializerMultiParams): Promise<AttachmentResponse[]> {
        return Promise.all(
            attachments.map(
                async attachment =>
                    await AttachmentSerializer.convert({
                        attachment,
                        config: { ...DEFAULT_ATTACHMENT_CONFIG, ...config },
                        isForNotification
                    })
            )
        );
    }

    private static async convert({
        attachment,
        config = DEFAULT_ATTACHMENT_CONFIG,
        isForNotification = false
    }: AttachmentSerializerSingleParams): Promise<AttachmentResponse> {
        let data: Uint8Array | string = null;
        let metadata: Metadata = null;

        // Get the fully qualified path
        let fPath = FileSystem.getRealPath(attachment.filePath);
        const mimeType = attachment.getMimeType();
        // Before convertImage rewrites filePath (Live Photo .mov is beside the original).
        const hasLivePhoto = !!AttachmentInterface.getLivePhotoPath(attachment);

        // If the attachment isn't finished downloading, the path will be null
        if (fPath) {
            try {
                // If we want to convert the attachment, do so here.
                // So long as we haven't done it yet.
                if (config.convert && !fPath.includes(FileSystem.convertDir)) {
                    const converters = [convertImage, convertAudio];
                    for (const conversion of converters) {
                        // Try to convert the attachments using available converters
                        const newPath = await conversion(attachment, { originalMimeType: mimeType });
                        if (newPath) {
                            fPath = newPath;
                            break;
                        }
                    }
                }

                // If the attachment exists, do some things
                const exists = fs.existsSync(fPath);
                if (exists) {
                    // If we want data, get the data
                    if (config.loadData) {
                        data = Uint8Array.from(fs.readFileSync(fPath));
                    }

                    // Fetch the attachment metadata if there is a mimeType
                    if (config.loadMetadata) {
                        metadata = await getAttachmentMetadata(attachment);
                    }

                    // If there is no data, return null for the data
                    // Otherwise, convert it to a base64 string
                    if (data) {
                        data = base64.bytesToBase64(data as Uint8Array);
                    }
                }
            } catch (ex: any) {
                Server().log(`Could not read file [${fPath}]: ${ex?.message ?? String(ex)}`, "error");
            }
        } else {
            Server().log("Attachment hasn't been downloaded yet!", "debug");
        }

        const stickerPlacement = parseStickerPlacement(attachment.stickerUserInfo);

        let output: AttachmentResponse = {
            originalROWID: attachment.ROWID,
            guid: attachment.guid,
            uti: attachment.uti,
            mimeType: attachment.mimeType,
            transferName: attachment.transferName,
            totalBytes: attachment.totalBytes
        };

        // Emit placement unconditionally (including live Socket.IO `isForNotification: true` payloads)
        // so newly received stickers render positioned over their target bubble immediately.
        if (stickerPlacement) {
            output.stickerPlacement = stickerPlacement;
        }

        if (!isForNotification) {
            output = {
                ...output,
                ...{
                    transferState: attachment.transferState,
                    isOutgoing: attachment.isOutgoing,
                    hideAttachment: attachment.hideAttachment,
                    isSticker: attachment.isSticker,
                    originalGuid: attachment.originalGuid,
                    hasLivePhoto
                }
            };
        }

        if (config.includeMessageGuids) {
            output.messages = attachment.messages ? attachment.messages.map(item => item.guid) : [];
        }

        if (config.loadMetadata) {
            output = {
                ...output,
                ...{
                    height: (metadata?.height ?? 0) as number,
                    width: (metadata?.width ?? 0) as number,
                    metadata
                }
            };
        }

        if (config.loadData) {
            output.data = data as string;
        }

        return output;
    }
}
