import { Next } from "koa";
import { RouterContext } from "koa-router";
import { ValidateInput } from ".";

export class TranslationValidator {
    static configRules = {
        auto_translate_enabled: "boolean",
        translation_target_language: "string|min:2|max:35",
        translation_cache_max_entries: "integer|min:0|max:1000000"
    };

    static async validateConfig(ctx: RouterContext, next: Next) {
        ValidateInput(ctx.request?.body ?? {}, TranslationValidator.configRules);
        await next();
    }
}
