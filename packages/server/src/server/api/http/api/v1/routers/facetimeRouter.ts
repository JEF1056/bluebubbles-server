import { Next } from "koa";
import { RouterContext } from "koa-router";
import { NoData, Success } from "../responses/success";
import { FaceTimeInterface } from "@server/api/interfaces/facetimeInterface";

export class FaceTimeRouter {
    static async answer(ctx: RouterContext, _: Next) {
        const audioOnly =
            ctx.request.query?.audioOnly === "true" || Boolean((ctx.request.body as Record<string, any>)?.audioOnly);
        const link = await FaceTimeInterface.answer(ctx.params.call_uuid, audioOnly);
        return new Success(ctx, { data: audioOnly ? { audioOnly: true, callUuid: ctx.params.call_uuid } : { link } }).send();
    }

    static async leave(ctx: RouterContext, _: Next) {
        await FaceTimeInterface.leave(ctx.params.call_uuid);
        return new NoData(ctx, {}).send();
    }

    static async newSession(ctx: RouterContext, _: Next) {
        const link = await FaceTimeInterface.create();
        return new Success(ctx, { data: { link }}).send();
    }

    static async call(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const addresses = Array.isArray(body.addresses)
            ? body.addresses
            : body.address
              ? [String(body.address)]
              : [];
        const video = body.video !== undefined ? Boolean(body.video) : true;
        const isTelephony = Boolean(body.isTelephony ?? body.is_telephony ?? false);
        const data = await FaceTimeInterface.call({ addresses, video, isTelephony });
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
}
