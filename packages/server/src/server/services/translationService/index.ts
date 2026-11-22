import axios from "axios";
import crypto from "crypto";
import { execFile } from "child_process";
import fs from "fs";
import { In, Not, Repository } from "typeorm";
import { Server } from "@server";
import { FaceTimeAudioBridge } from "@server/api/lib/facetime/FaceTimeAudioBridge";
import { Loggable } from "@server/lib/logging/Loggable";
import { Message } from "@server/databases/imessage/entity/Message";
import { MessageTranslation } from "@server/databases/server/entity/MessageTranslation";
import { getChatGuidCandidates } from "@server/databases/imessage/helpers/chatGuid";
import { MessageTranslationResponse } from "@server/types";

export const DEFAULT_TRANSLATION_TARGET_LANGUAGE = "en";
export const DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES = 10000;
const REQUEST_TIMEOUT_MS = 4000;
const GOOGLE_GTX_URL = "https://translate.googleapis.com/translate_a/single";

export type TranslationConfig = {
    auto_translate_enabled: boolean;
    translation_target_language: string;
    translation_cache_max_entries: number;
};

export type TranslationProviderResult = {
    translatedText: string;
    sourceLanguage: string;
    targetLanguage: string;
    provider: "google" | "apple";
};

export type TranslationRepoAdapter = {
    translations: () => Repository<MessageTranslation>;
    getConfig: (key: string) => any;
    setConfig: (key: string, value: any) => Promise<void>;
};

export const cleanTranslatableText = (raw: string | null | undefined): string =>
    (raw ?? "").replace(/\ufffc/g, "").trim();

export const hashSourceText = (text: string): string =>
    crypto.createHash("sha256").update(text, "utf8").digest("hex");

export const baseLanguageCode = (lang: string | null | undefined): string =>
    (lang ?? "").trim().toLowerCase().split(/[-_]/)[0];

export const shouldSkipAutoTranslation = (rawText: string): boolean => {
    const cleaned = cleanTranslatableText(rawText);
    if (!cleaned) return true;

    const withoutUrls = cleaned.replace(/(?:https?:\/\/|www\.)\S+/gi, "").trim();
    if (!withoutUrls) return true;

    // Must contain at least one Unicode letter (filters out pure numbers, emoji, punctuation)
    if (!/\p{L}/u.test(withoutUrls)) return true;

    const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(withoutUrls);
    if (!hasCjk) {
        const alphanumeric = withoutUrls.replace(/[\s\p{P}\p{S}]/gu, "");
        if (alphanumeric.length <= 2) return true;
    }

    return false;
};

export const parseGoogleGtxResponse = (
    data: unknown
): { translatedText: string; sourceLanguage: string } | null => {
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
    const translatedText = data[0]
        .map(seg => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
        .join("")
        .trim();
    if (!translatedText) return null;

    const detected =
        (typeof data[2] === "string" && data[2].trim()) ||
        (Array.isArray(data[8]) &&
            Array.isArray(data[8][0]) &&
            typeof data[8][0][0] === "string" &&
            data[8][0][0].trim()) ||
        "auto";

    return { translatedText, sourceLanguage: detected };
};

export const toTranslationResponse = (row: MessageTranslation): MessageTranslationResponse => ({
    text: row.translatedText,
    sourceLanguage: row.sourceLanguage,
    targetLanguage: row.targetLanguage,
    provider: row.provider,
    autoTranslated: row.autoTranslated,
    dateTranslated: row.createdAt
});

type TranslateTextFn = (
    text: string,
    targetLanguage: string
) => Promise<{ translatedText: string; sourceLanguage: string } | null>;

export class TranslationService extends Loggable {
    tag = "TranslationService";

    private readonly customAdapter?: TranslationRepoAdapter;

    private readonly googleTranslateFn?: TranslateTextFn;

    private readonly appleTranslateFn?: TranslateTextFn;

    private readonly translatorBinaryPath?: string;

    constructor(opts?: {
        adapter?: TranslationRepoAdapter;
        googleTranslateFn?: TranslateTextFn;
        appleTranslateFn?: TranslateTextFn;
        translatorBinaryPath?: string;
    }) {
        super();
        this.customAdapter = opts?.adapter;
        this.googleTranslateFn = opts?.googleTranslateFn;
        this.appleTranslateFn = opts?.appleTranslateFn;
        this.translatorBinaryPath = opts?.translatorBinaryPath;
    }

    private getAdapter(): TranslationRepoAdapter | null {
        if (this.customAdapter) return this.customAdapter;
        const repo = Server()?.repo;
        if (!repo?.db?.isInitialized) return null;
        return {
            translations: () => repo.messageTranslations(),
            getConfig: (key: string) => repo.getConfig(key),
            setConfig: (key: string, value: any) => repo.setConfig(key, value)
        };
    }

    getConfig(): TranslationConfig {
        const adapter = this.getAdapter();
        const enabledRaw = adapter?.getConfig("auto_translate_enabled");
        const targetRaw = adapter?.getConfig("translation_target_language");
        const maxRaw = adapter?.getConfig("translation_cache_max_entries");

        const target =
            typeof targetRaw === "string" && targetRaw.trim().length > 0
                ? targetRaw.trim()
                : DEFAULT_TRANSLATION_TARGET_LANGUAGE;
        const maxEntries =
            typeof maxRaw === "number" && Number.isFinite(maxRaw) && maxRaw >= 0
                ? Math.floor(maxRaw)
                : DEFAULT_TRANSLATION_CACHE_MAX_ENTRIES;

        return {
            auto_translate_enabled: Boolean(enabledRaw),
            translation_target_language: target,
            translation_cache_max_entries: maxEntries
        };
    }

    async updateConfig(updates: Partial<TranslationConfig>): Promise<TranslationConfig> {
        const adapter = this.getAdapter();
        if (!adapter) throw new Error("Server repository is not initialized");

        const prev = this.getConfig();

        if (updates.auto_translate_enabled !== undefined) {
            await adapter.setConfig("auto_translate_enabled", Boolean(updates.auto_translate_enabled));
        }
        if (updates.translation_target_language !== undefined) {
            const nextLang = String(updates.translation_target_language).trim() || DEFAULT_TRANSLATION_TARGET_LANGUAGE;
            await adapter.setConfig("translation_target_language", nextLang);
            if (nextLang !== prev.translation_target_language) {
                await adapter.translations().delete({ autoTranslated: true, targetLanguage: Not(nextLang) });
            }
        }
        if (updates.translation_cache_max_entries !== undefined) {
            const nextMax = Math.max(0, Math.floor(Number(updates.translation_cache_max_entries)));
            await adapter.setConfig("translation_cache_max_entries", nextMax);
            await this.evictIfNeeded(nextMax);
        }

        return this.getConfig();
    }

    private resolveTranslatorBinary(): string | null {
        if (this.translatorBinaryPath) {
            return fs.existsSync(this.translatorBinaryPath) ? this.translatorBinaryPath : null;
        }
        return FaceTimeAudioBridge.resolveToolBinary("BlueBubblesTranslator");
    }

    private async translateWithGoogle(
        text: string,
        targetLanguage: string
    ): Promise<{ translatedText: string; sourceLanguage: string } | null> {
        if (this.googleTranslateFn) {
            return await this.googleTranslateFn(text, targetLanguage);
        }
        try {
            const res = await axios.get(GOOGLE_GTX_URL, {
                params: { client: "gtx", sl: "auto", tl: targetLanguage, dt: "t", q: text },
                timeout: REQUEST_TIMEOUT_MS
            });
            return parseGoogleGtxResponse(res.data);
        } catch (ex: any) {
            this.log.debug(`Google gtx translation failed: ${ex?.message ?? String(ex)}`);
            return null;
        }
    }

    private async translateWithApple(
        text: string,
        targetLanguage: string
    ): Promise<{ translatedText: string; sourceLanguage: string } | null> {
        if (this.appleTranslateFn) {
            return await this.appleTranslateFn(text, targetLanguage);
        }
        if (process.platform !== "darwin") return null;

        const bin = this.resolveTranslatorBinary();
        if (!bin) return null;

        return await new Promise(resolve => {
            try {
                const child = execFile(
                    bin,
                    ["--target", targetLanguage],
                    { timeout: REQUEST_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
                    (err, stdout) => {
                        if (err || !stdout) {
                            this.log.debug(`Apple Translation helper unavailable: ${err?.message ?? "empty output"}`);
                            return resolve(null);
                        }
                        try {
                            const parsed = JSON.parse(stdout.trim());
                            if (parsed?.translatedText && parsed?.sourceLanguage) {
                                return resolve({
                                    translatedText: String(parsed.translatedText),
                                    sourceLanguage: String(parsed.sourceLanguage)
                                });
                            }
                        } catch {
                            // Fall through to null
                        }
                        resolve(null);
                    }
                );
                child.stdin?.end(text, "utf8");
            } catch (ex: any) {
                this.log.debug(`Failed to invoke Apple Translation helper: ${ex?.message ?? String(ex)}`);
                resolve(null);
            }
        });
    }

    async translateText(
        text: string,
        targetLanguage: string
    ): Promise<{ status: "translated" | "skipped" | "failed"; result?: TranslationProviderResult }> {
        const cleaned = cleanTranslatableText(text);
        if (!cleaned || shouldSkipAutoTranslation(cleaned)) return { status: "skipped" };

        let provider: "google" | "apple" = "google";
        let result = await this.translateWithGoogle(cleaned, targetLanguage);

        if (!result) {
            provider = "apple";
            result = await this.translateWithApple(cleaned, targetLanguage);
        }

        if (!result || !result.translatedText) return { status: "failed" };

        if (baseLanguageCode(result.sourceLanguage) === baseLanguageCode(targetLanguage)) {
            return { status: "skipped" };
        }

        return {
            status: "translated",
            result: {
                translatedText: result.translatedText,
                sourceLanguage: result.sourceLanguage,
                targetLanguage,
                provider
            }
        };
    }

    private async evictIfNeeded(maxEntriesOverride?: number): Promise<void> {
        const adapter = this.getAdapter();
        if (!adapter) return;
        const maxEntries = maxEntriesOverride ?? this.getConfig().translation_cache_max_entries;
        const repo = adapter.translations();

        if (maxEntries <= 0) {
            await repo.clear();
            return;
        }

        const total = await repo.count();
        if (total <= maxEntries) return;

        const toRemove = total - maxEntries;
        const oldest = await repo
            .createQueryBuilder("t")
            .select("t.messageGuid", "messageGuid")
            .orderBy("t.lastAccessedAt", "ASC")
            .addOrderBy("t.createdAt", "ASC")
            .limit(toRemove)
            .getRawMany();

        const guids = oldest.map(r => r.messageGuid).filter(Boolean);
        if (guids.length > 0) {
            await repo.delete({ messageGuid: In(guids) });
        }
    }

    async translateMessage(
        message: Message,
        opts?: { targetLanguage?: string; force?: boolean; autoTranslated?: boolean }
    ): Promise<{ status: "translated" | "cached" | "skipped" | "failed"; translation: MessageTranslation | null }> {
        const adapter = this.getAdapter();
        if (!adapter || !message?.guid) return { status: "skipped", translation: null };
        if (message.isFromMe || message.dateRetracted != null || message.isFullyUnsent) {
            return { status: "skipped", translation: null };
        }

        const text = cleanTranslatableText(message.universalText(true));
        if (!text || shouldSkipAutoTranslation(text)) return { status: "skipped", translation: null };

        const autoTranslated = opts?.autoTranslated ?? false;
        const targetLanguage = (opts?.targetLanguage ?? this.getConfig().translation_target_language).trim();
        const sourceTextHash = hashSourceText(text);
        const repo = adapter.translations();
        const now = Date.now();

        if (!opts?.force) {
            const cached = await repo.findOneBy({ messageGuid: message.guid });
            if (cached && cached.sourceTextHash === sourceTextHash && cached.targetLanguage === targetLanguage) {
                await repo.update({ messageGuid: message.guid }, { lastAccessedAt: now });
                cached.lastAccessedAt = now;
                return { status: "cached", translation: cached };
            }
        }

        const outcome = await this.translateText(text, targetLanguage);
        if (outcome.status !== "translated" || !outcome.result) {
            return { status: outcome.status === "failed" ? "failed" : "skipped", translation: null };
        }

        const entry = new MessageTranslation();
        entry.messageGuid = message.guid;
        entry.chatGuid = message.chats?.[0]?.guid ?? null;
        entry.sourceTextHash = sourceTextHash;
        entry.sourceLanguage = outcome.result.sourceLanguage;
        entry.targetLanguage = outcome.result.targetLanguage;
        entry.translatedText = outcome.result.translatedText;
        entry.provider = outcome.result.provider;
        entry.autoTranslated = autoTranslated;
        entry.createdAt = now;
        entry.lastAccessedAt = now;

        const saved = await repo.save(entry);
        await this.evictIfNeeded();
        return { status: "translated", translation: saved };
    }

    async handleNewMessage(message: Message): Promise<boolean> {
        try {
            if (!message || message.isFromMe) return false;
            if (message.associatedMessageType || message.itemType !== 0) return false;
            if (!this.getConfig().auto_translate_enabled) return false;
            const outcome = await this.translateMessage(message, { autoTranslated: true });
            return outcome.status === "translated";
        } catch (ex: any) {
            this.log.debug(`Auto-translate failed on new message [${message?.guid}]: ${ex?.message ?? String(ex)}`);
            return false;
        }
    }

    async handleUpdatedMessage(message: Message): Promise<void> {
        try {
            if (!message?.guid) return;
            const adapter = this.getAdapter();
            if (!adapter) return;

            if (message.dateRetracted != null || message.isFullyUnsent) {
                await this.deleteForMessage(message.guid);
                return;
            }

            if (message.isFromMe) return;

            const text = cleanTranslatableText(message.universalText(true));
            const newHash = text ? hashSourceText(text) : "";
            const repo = adapter.translations();
            const existing = await repo.findOneBy({ messageGuid: message.guid });

            if (existing && (!text || existing.sourceTextHash !== newHash)) {
                await repo.delete({ messageGuid: message.guid });
                if (text && (message.dateEdited != null || this.getConfig().auto_translate_enabled)) {
                    await this.translateMessage(message, {
                        targetLanguage: existing.targetLanguage,
                        force: true,
                        autoTranslated: existing.autoTranslated
                    });
                }
            } else if (!existing && message.dateEdited != null && this.getConfig().auto_translate_enabled) {
                await this.translateMessage(message, { autoTranslated: true });
            }
        } catch (ex: any) {
            this.log.debug(`Translation update check failed [${message?.guid}]: ${ex?.message ?? String(ex)}`);
        }
    }

    async getCachedForMessages(messages: Message[]): Promise<Map<string, MessageTranslationResponse>> {
        const result = new Map<string, MessageTranslationResponse>();
        const adapter = this.getAdapter();
        if (!adapter || !messages || messages.length === 0) return result;

        const incoming = messages.filter(
            m => m?.guid && !m.isFromMe && m.dateRetracted == null && !m.isFullyUnsent
        );
        if (incoming.length === 0) return result;

        const guids = incoming.map(m => m.guid);
        const repo = adapter.translations();
        const rows = await repo.findBy({ messageGuid: In(guids) });
        if (rows.length === 0) return result;

        const rowMap = new Map(rows.map(r => [r.messageGuid, r]));
        const hitGuids: string[] = [];

        for (const msg of incoming) {
            const row = rowMap.get(msg.guid);
            if (!row) continue;
            const text = cleanTranslatableText(msg.universalText(true));
            if (!text || row.sourceTextHash !== hashSourceText(text)) continue;

            result.set(msg.guid, toTranslationResponse(row));
            hitGuids.push(msg.guid);
        }

        if (hitGuids.length > 0) {
            await repo.update({ messageGuid: In(hitGuids) }, { lastAccessedAt: Date.now() });
        }

        return result;
    }

    async deleteForMessage(messageGuid: string): Promise<void> {
        const adapter = this.getAdapter();
        if (!adapter || !messageGuid) return;
        await adapter.translations().delete({ messageGuid });
    }

    async deleteForChat(chatGuid: string): Promise<void> {
        const adapter = this.getAdapter();
        if (!adapter || !chatGuid) return;
        const candidates = getChatGuidCandidates(chatGuid);
        await adapter.translations().delete({ chatGuid: In(candidates) });
    }

    async clearCache(): Promise<void> {
        const adapter = this.getAdapter();
        if (!adapter) return;
        await adapter.translations().clear();
    }
}
