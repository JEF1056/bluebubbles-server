import { Server } from "@server";
import * as fs from "fs";
import { FileSystem } from "@server/fileSystem";
import { detectImageExtension, isNotEmpty } from "@server/helpers/utils";
import { v4 as uuidv4 } from "uuid";
import { rimrafSync } from "rimraf";
import type { RichLink } from "@server/api/types";

/**
 * Asks the helper to send a link with a preview balloon.
 *
 * @returns The helper result, or null if the link should be sent as plain text instead. That is the case
 * when the helper is too old to know the action, or when it answered with an error (it sends nothing then).
 * A timeout is thrown, not turned into null, because the link may have been sent by then.
 */
export const sendRichLinkPrivateApi = async (chatGuid: string, richLink: RichLink) => {
    if (!Server().privateApi.supportsAction("send-rich-link")) {
        Server().log("The Private API helper can't send rich links, sending the link as text", "warn");
        return null;
    }

    // The helper reads the image from disk, so it goes in the same folder as the other Private API attachments
    let imageDir: string = null;
    let imagePath: string = null;
    try {
        if (isNotEmpty(richLink.image)) {
            const image = Buffer.from(richLink.image, "base64");
            const ext = detectImageExtension(image);
            if (ext) {
                imageDir = FileSystem.resolveWithin(FileSystem.getAttachmentDirectory("private-api"), uuidv4());
                imagePath = FileSystem.resolveWithin(imageDir, `link-preview.${ext}`);
                fs.mkdirSync(imageDir, { recursive: true });
                fs.writeFileSync(imagePath, image);
            }
        }

        const result = await Server().privateApi.message.sendRichLink(
            chatGuid,
            richLink.url.trim(),
            richLink.title ?? null,
            richLink.siteName ?? null,
            richLink.summary ?? null,
            imagePath
        );

        // The helper only resolves (instead of rejecting) once it has sent, or has sent the link as text itself.
        // An empty identifier means it went out but the guid is unknown, which is no reason to send the text again.
        return result;
    } catch (ex: any) {
        const reason = ex?.message ?? String(ex);
        if (reason === "Transaction timeout") throw ex;

        Server().log(`Failed to send the rich link (${reason}), sending the link as text`, "warn");
        return null;
    } finally {
        if (imageDir) rimrafSync(imageDir);
    }
};
