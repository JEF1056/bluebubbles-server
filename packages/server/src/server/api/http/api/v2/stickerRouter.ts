import { Next } from "koa";
import KoaRouter, { RouterContext } from "koa-router";
import { isNotEmpty, isTruthyBool } from "@server/helpers/utils";
import { StickerInterface } from "@server/api/interfaces/stickerInterface";
import { MessageSerializer } from "@server/api/serializers/MessageSerializer";
import { Success } from "../v1/responses/success";
import { BadRequest, NotFound, ServerError } from "../v1/responses/errors";
import { MetricsMiddleware } from "../v1/middleware/metricsMiddleware";
import { ErrorMiddleware } from "../v1/middleware/errorMiddleware";
import { LogMiddleware } from "../v1/middleware/logMiddleware";
import { AuthMiddleware } from "../v1/middleware/authMiddleware";
import { BodyMiddleware } from "../v1/middleware/bodyMiddleware";
import { PrivateApiMiddleware } from "../v1/middleware/privateApiMiddleware";

const SAFE_STICKER_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function parseFiniteNumber(val: unknown): number | null {
    if (val === undefined || val === null || val === "") return null;
    const parsed = typeof val === "number" ? val : Number.parseFloat(String(val));
    return Number.isFinite(parsed) ? parsed : null;
}

function getUploadedAttachment(ctx: RouterContext): { path: string; name?: string; type?: string } | null {
    const files = (ctx.request as any)?.files;
    if (!files) return null;
    const raw = files.attachment ?? files.file ?? Object.values(files)[0];
    const file = Array.isArray(raw) ? raw[0] : raw;
    if (!file) return null;
    const filePath = file.filepath ?? file.path;
    if (typeof filePath !== "string" || filePath.length === 0) return null;
    return {
        path: filePath,
        name: file.originalFilename ?? file.name,
        type: file.mimetype ?? file.type
    };
}

function extractStickerUserInfo(body: Record<string, any>): Record<string, any> | null {
    if (body?.stickerUserInfo && typeof body.stickerUserInfo === "object") {
        return body.stickerUserInfo;
    }
    if (typeof body?.stickerUserInfo === "string") {
        try {
            const parsed = JSON.parse(body.stickerUserInfo);
            if (parsed && typeof parsed === "object") return parsed;
        } catch {
            // ignore malformed JSON string
        }
    }

    const x = parseFiniteNumber(body?.xScalar ?? body?.x ?? body?.sxs);
    const y = parseFiniteNumber(body?.yScalar ?? body?.y ?? body?.sys);
    const scale = parseFiniteNumber(body?.scale ?? body?.ssa);
    const rotation = parseFiniteNumber(body?.rotation ?? body?.sro);
    const width = parseFiniteNumber(body?.parentPreviewWidth ?? body?.width ?? body?.spw);
    const height = parseFiniteNumber(body?.parentPreviewHeight ?? body?.height);

    const info: Record<string, number> = {};
    if (x !== null) info.xScalar = x;
    if (y !== null) info.yScalar = y;
    if (scale !== null) info.scale = scale;
    if (rotation !== null) info.rotation = rotation;
    if (width !== null) info.parentPreviewWidth = width;
    if (height !== null) info.parentPreviewHeight = height;
    return Object.keys(info).length > 0 ? info : null;
}

export class StickerRouter {
    static registerRoutes(router: KoaRouter) {
        const protectedMw = [MetricsMiddleware, ErrorMiddleware, LogMiddleware, AuthMiddleware, BodyMiddleware];
        router.get("/api/v2/sticker", ...protectedMw, StickerRouter.list);
        router.get("/api/v2/sticker/:id/thumbnail", ...protectedMw, StickerRouter.thumbnail);
        router.get("/api/v2/sticker/:id/image", ...protectedMw, StickerRouter.image);
        router.post("/api/v2/sticker", ...protectedMw, StickerRouter.create);
        router.delete("/api/v2/sticker/:id", ...protectedMw, StickerRouter.remove);
        router.post("/api/v2/message/sticker", ...protectedMw, PrivateApiMiddleware, StickerRouter.send);
        router.post(
            "/api/v2/message/sticker/:guid/reposition",
            ...protectedMw,
            PrivateApiMiddleware,
            StickerRouter.reposition
        );
    }

    static async list(ctx: RouterContext, _: Next) {
        const limitRaw = Number.parseInt(String(ctx.request.query?.limit ?? "100"), 10);
        const offsetRaw = Number.parseInt(String(ctx.request.query?.offset ?? "0"), 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
        const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

        const { stickers, total, reason } = StickerInterface.listStickers(limit, offset);
        return new Success(ctx, {
            message: "Successfully fetched stickers!",
            data: stickers,
            metadata: { total, limit, offset, ...(reason ? { reason } : {}) }
        }).send();
    }

    static async thumbnail(ctx: RouterContext, next: Next) {
        ctx.request.query = { ...ctx.request.query, role: "keyboard" };
        return StickerRouter.image(ctx, next);
    }

    static async image(ctx: RouterContext, _: Next) {
        const { id } = ctx.params;
        if (!isNotEmpty(id)) throw new BadRequest({ error: "Sticker identifier is required!" });

        const role = typeof ctx.request.query?.role === "string" ? ctx.request.query.role : undefined;
        const original = isTruthyBool(ctx.request.query?.original as string);
        const result = await StickerInterface.getStickerImage(id, { role, original });
        if (!result) throw new NotFound({ error: `Sticker '${id}' not found!` });

        const normalizedMime = (result.mimeType ?? "").toLowerCase();
        ctx.status = 200;
        if (typeof ctx.set === "function") ctx.set("X-Content-Type-Options", "nosniff");
        ctx.type = SAFE_STICKER_MIME_TYPES.has(normalizedMime) ? normalizedMime : "application/octet-stream";
        ctx.body = result.data;
    }

    static async create(ctx: RouterContext, _: Next) {
        const uploaded = getUploadedAttachment(ctx);
        if (!uploaded) throw new BadRequest({ error: "Sticker attachment file is required!" });

        const fs = require("fs");
        const buffer = fs.readFileSync(uploaded.path);
        const name = typeof (ctx.request.body as any)?.name === "string" ? (ctx.request.body as any).name : null;
        const created = await StickerInterface.addSticker({
            buffer,
            fileName: uploaded.name,
            name,
            mimeType: uploaded.type
        });

        return new Success(ctx, {
            message: "Successfully added sticker!",
            data: created
        }).send();
    }

    static async remove(ctx: RouterContext, _: Next) {
        const { id } = ctx.params;
        if (!isNotEmpty(id)) throw new BadRequest({ error: "Sticker identifier is required!" });

        try {
            await StickerInterface.deleteSticker(id);
        } catch (ex: any) {
            throw new ServerError({ error: ex?.message ?? "Failed to delete sticker" });
        }

        return new Success(ctx, {
            message: "Successfully deleted sticker!"
        }).send();
    }

    static async send(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const uploaded = getUploadedAttachment(ctx);
        if (!uploaded) throw new BadRequest({ error: "Sticker attachment file is required!" });

        const chatGuid = body.chatGuid;
        if (!isNotEmpty(chatGuid)) throw new BadRequest({ error: "chatGuid is required!" });

        const partIndexRaw = Number.parseInt(String(body.associatedMessagePart ?? body.partIndex ?? "0"), 10);
        const partIndex = Number.isFinite(partIndexRaw) && partIndexRaw >= 0 ? partIndexRaw : 0;
        const assocTypeRaw = Number.parseInt(String(body.associatedMessageType ?? "1000"), 10);
        const associatedMessageType = Number.isFinite(assocTypeRaw) ? assocTypeRaw : 1000;

        const sent = await StickerInterface.sendSticker({
            chatGuid,
            filePath: uploaded.path,
            fileName: uploaded.name,
            selectedMessageGuid: body.selectedMessageGuid ?? body.associatedMessageGuid ?? null,
            associatedMessageGuid: body.associatedMessageGuid ?? body.selectedMessageGuid ?? null,
            partIndex,
            associatedMessagePart: partIndex,
            associatedMessageType,
            tapback: isTruthyBool(body.tapback),
            remove: isTruthyBool(body.remove),
            stickerUserInfo: extractStickerUserInfo(body)
        });

        if (!sent || typeof (sent as any).guid !== "string" || (sent as any).guid.trim().length === 0) {
            throw new ServerError({ error: "Failed to send sticker! No serialized message returned." });
        }

        const data = await MessageSerializer.serialize({ message: sent as any });

        return new Success(ctx, {
            message: "Successfully sent sticker!",
            data
        }).send();
    }

    static async reposition(ctx: RouterContext, _: Next) {
        const { guid } = ctx.params ?? {};
        if (!isNotEmpty(guid)) throw new BadRequest({ error: "Sticker message guid is required!" });

        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const chatGuid = body.chatGuid;
        if (!isNotEmpty(chatGuid)) throw new BadRequest({ error: "chatGuid is required!" });

        const xScalar = parseFiniteNumber(body.xScalar);
        const yScalar = parseFiniteNumber(body.yScalar);
        const scale = parseFiniteNumber(body.scale);
        const rotation = parseFiniteNumber(body.rotation);
        const parentPreviewWidth = parseFiniteNumber(body.parentPreviewWidth);

        if (
            xScalar === null ||
            yScalar === null ||
            scale === null ||
            rotation === null ||
            parentPreviewWidth === null
        ) {
            throw new BadRequest({
                error: "xScalar, yScalar, scale, rotation, and parentPreviewWidth must be finite numbers!"
            });
        }
        if (scale <= 0 || parentPreviewWidth <= 0) {
            throw new BadRequest({ error: "scale and parentPreviewWidth must be greater than 0!" });
        }

        const updated = await StickerInterface.repositionSticker({
            chatGuid,
            messageGuid: guid,
            xScalar,
            yScalar,
            scale,
            rotation,
            parentPreviewWidth
        });

        if (!updated || typeof (updated as any).guid !== "string" || (updated as any).guid.trim().length === 0) {
            throw new ServerError({ error: "Failed to reposition sticker! No serialized message returned." });
        }

        const data = await MessageSerializer.serialize({ message: updated as any });

        return new Success(ctx, {
            message: "Successfully repositioned sticker!",
            data
        }).send();
    }
}
