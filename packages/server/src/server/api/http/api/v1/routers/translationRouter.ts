import { Next } from "koa";
import { RouterContext } from "koa-router";
import { Server } from "@server";
import { Success } from "../responses/success";

export class TranslationRouter {
    static async getConfig(ctx: RouterContext, _: Next) {
        return new Success(ctx, { data: Server().translationService.getConfig() }).send();
    }

    static async updateConfig(ctx: RouterContext, _: Next) {
        const body = (ctx.request?.body ?? {}) as Record<string, any>;
        const updates: Record<string, any> = {};

        if (body.auto_translate_enabled !== undefined) {
            updates.auto_translate_enabled = body.auto_translate_enabled;
        }
        if (body.translation_target_language !== undefined) {
            updates.translation_target_language = body.translation_target_language;
        }
        if (body.translation_cache_max_entries !== undefined) {
            updates.translation_cache_max_entries = body.translation_cache_max_entries;
        }

        const data = await Server().translationService.updateConfig(updates);
        return new Success(ctx, { data, message: "Successfully updated translation configuration!" }).send();
    }

    static async clearCache(ctx: RouterContext, _: Next) {
        await Server().translationService.clearCache();
        return new Success(ctx, { message: "Successfully cleared translation cache!" }).send();
    }
}
