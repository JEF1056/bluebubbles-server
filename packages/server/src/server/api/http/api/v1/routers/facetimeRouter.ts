import { execFile } from "child_process";
import { promisify } from "util";
import { Next } from "koa";
import { RouterContext } from "koa-router";
import { Server } from "@server";
import { FaceTimeAudioBridge } from "@server/api/lib/facetime/FaceTimeAudioBridge";
import { BadRequest } from "../responses/errors";
import { NoData, Success } from "../responses/success";
import { CallMetadataOptions, FaceTimeInterface } from "@server/api/interfaces/facetimeInterface";

const execFileAsync = promisify(execFile);

const extractMetadata = (body: Record<string, any> = {}): CallMetadataOptions => {
    const addresses = Array.isArray(body.addresses)
        ? body.addresses.map(String)
        : body.address
          ? [String(body.address)]
          : undefined;
    return {
        deviceId: body.deviceId ?? body.device_id ?? undefined,
        deviceName: body.deviceName ?? body.device_name ?? undefined,
        displayName: body.displayName ?? body.display_name ?? undefined,
        chatGuid: body.chatGuid ?? body.chat_guid ?? undefined,
        addresses
    };
};

export class FaceTimeRouter {
    static async listSessions(ctx: RouterContext, _: Next) {
        const sessions = FaceTimeInterface.listSessions();
        return new Success(ctx, { data: { sessions } }).send();
    }

    static async answer(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const audioOnly = ctx.request.query?.audioOnly === "true" || Boolean(body.audioOnly);
        const result = await FaceTimeInterface.answer(ctx.params.call_uuid, audioOnly, extractMetadata(body));
        return new Success(ctx, {
            data: audioOnly
                ? { audioOnly: true, callUuid: ctx.params.call_uuid, session: result.session }
                : { link: result.link, session: result.session }
        }).send();
    }

    static async handoff(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const modeRaw = body.mode;
        const mode = modeRaw === "video" || modeRaw === "audio" ? modeRaw : undefined;
        const data = await FaceTimeInterface.handoff(ctx.params.call_uuid, {
            deviceId: body.deviceId ?? body.device_id,
            deviceName: body.deviceName ?? body.device_name,
            mode
        });
        return new Success(ctx, { data }).send();
    }

    static async leave(ctx: RouterContext, _: Next) {
        await FaceTimeInterface.leave(ctx.params.call_uuid);
        return new NoData(ctx, {}).send();
    }

    static async end(ctx: RouterContext, _: Next) {
        await FaceTimeInterface.end(ctx.params.call_uuid);
        return new NoData(ctx, {}).send();
    }

    static async newSession(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const data = await FaceTimeInterface.create(extractMetadata(body));
        return new Success(ctx, { data }).send();
    }

    static async call(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const meta = extractMetadata(body);
        const addresses = meta.addresses ?? [];
        const video = body.video !== undefined ? Boolean(body.video) : true;
        const isTelephony = Boolean(body.isTelephony ?? body.is_telephony ?? false);
        const data = await FaceTimeInterface.call({ ...meta, addresses, video, isTelephony });
        return new Success(ctx, { data }).send();
    }

    static async decline(ctx: RouterContext, _: Next) {
        await FaceTimeInterface.decline(ctx.params.call_uuid);
        return new NoData(ctx, {}).send();
    }

    static async setMuted(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        await FaceTimeInterface.setMuted(ctx.params.call_uuid, Boolean(body.muted));
        return new NoData(ctx, {}).send();
    }

    static async dtmf(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const callUuid = String(body.callUuid ?? body.call_uuid ?? "").trim();
        const digit = String(body.digit ?? "").trim().toUpperCase();
        if (!callUuid) throw new BadRequest({ message: "callUuid is required" });
        if (!/^[0-9*#ABCD]$/.test(digit)) {
            throw new BadRequest({ message: "Invalid DTMF digit: must be one of 0-9, *, #, A-D" });
        }
        const data = await FaceTimeInterface.dtmf(callUuid, digit);
        return new Success(ctx, { data }).send();
    }

    static async bridgeStatus(ctx: RouterContext, _: Next) {
        const bin = FaceTimeAudioBridge.resolveHelperBinary();
        let check: Record<string, any> = { ok: false, processTapSupported: false, blackHoleFound: false, targetProcessCount: 0 };
        if (bin) {
            try {
                const { stdout } = await execFileAsync(bin, ["--check"], { timeout: 3000 });
                check = JSON.parse(stdout.trim());
            } catch (ex: any) {
                check.error = ex?.message ?? String(ex);
            }
        }
        return new Success(ctx, {
            data: {
                ...check,
                binaryFound: Boolean(bin),
                facetime_calling: Boolean(Server().repo.getConfig("facetime_calling")),
                helper_connected: Boolean(Server().privateApi?.helper),
                activeSessions: FaceTimeAudioBridge.getInstance().sessions.size
            }
        }).send();
    }
}
