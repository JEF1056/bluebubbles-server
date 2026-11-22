const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const ts = require("typescript");
const { DatabaseSync } = require("node:sqlite");
require("reflect-metadata");

const srcRoot = path.join(__dirname, "../src/server");

const loadTs = (filePath, overrides = {}) => {
    const source = require("fs").readFileSync(filePath, "utf8");
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
            experimentalDecorators: true,
            emitDecoratorMetadata: true
        },
        fileName: filePath
    });
    const mod = { exports: {} };
    const loader = new Function("module", "exports", "require", "__dirname", "__filename", outputText);
    const customRequire = req => {
        if (overrides[req]) return overrides[req];
        if (req.startsWith("@server/")) {
            const sub = req.slice("@server/".length);
            if (overrides[sub]) return overrides[sub];
        }
        return require(req);
    };
    loader(mod, mod.exports, customRequire, path.dirname(filePath), filePath);
    return mod.exports;
};

const rowToEntity = (MessageTranslation, row) => {
    if (!row) return null;
    const entity = new MessageTranslation();
    entity.messageGuid = row.message_guid;
    entity.chatGuid = row.chat_guid;
    entity.sourceTextHash = row.source_text_hash;
    entity.sourceLanguage = row.source_language;
    entity.targetLanguage = row.target_language;
    entity.translatedText = row.translated_text;
    entity.provider = row.provider;
    entity.autoTranslated = Boolean(row.auto_translated);
    entity.createdAt = Number(row.created_at);
    entity.lastAccessedAt = Number(row.last_accessed_at);
    return entity;
};

const createSqliteTranslationRepo = (sqliteDb, MessageTranslation) => {
    const extractValues = val => (val && val._type === "in" ? val.value : Array.isArray(val) ? val : [val]);
    const isNot = val => val && val._type === "not";

    return {
        findOneBy: async where => {
            const row = sqliteDb
                .prepare("SELECT * FROM message_translation WHERE message_guid = ? LIMIT 1")
                .get(where.messageGuid);
            return rowToEntity(MessageTranslation, row);
        },
        findBy: async where => {
            const guids = extractValues(where.messageGuid);
            if (guids.length === 0) return [];
            const placeholders = guids.map(() => "?").join(",");
            const rows = sqliteDb
                .prepare(`SELECT * FROM message_translation WHERE message_guid IN (${placeholders})`)
                .all(...guids);
            return rows.map(r => rowToEntity(MessageTranslation, r));
        },
        find: async () => {
            const rows = sqliteDb.prepare("SELECT * FROM message_translation").all();
            return rows.map(r => rowToEntity(MessageTranslation, r));
        },
        count: async () => Number(sqliteDb.prepare("SELECT COUNT(*) AS c FROM message_translation").get().c),
        save: async entity => {
            sqliteDb
                .prepare(
                    `INSERT INTO message_translation
                    (message_guid, chat_guid, source_text_hash, source_language, target_language, translated_text, provider, auto_translated, created_at, last_accessed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(message_guid) DO UPDATE SET
                        chat_guid=excluded.chat_guid,
                        source_text_hash=excluded.source_text_hash,
                        source_language=excluded.source_language,
                        target_language=excluded.target_language,
                        translated_text=excluded.translated_text,
                        provider=excluded.provider,
                        auto_translated=excluded.auto_translated,
                        created_at=excluded.created_at,
                        last_accessed_at=excluded.last_accessed_at`
                )
                .run(
                    entity.messageGuid,
                    entity.chatGuid ?? null,
                    entity.sourceTextHash,
                    entity.sourceLanguage,
                    entity.targetLanguage,
                    entity.translatedText,
                    entity.provider,
                    entity.autoTranslated ? 1 : 0,
                    entity.createdAt,
                    entity.lastAccessedAt
                );
            return entity;
        },
        update: async (criteria, partial) => {
            const guids = extractValues(criteria.messageGuid);
            if (guids.length === 0) return;
            const placeholders = guids.map(() => "?").join(",");
            sqliteDb
                .prepare(
                    `UPDATE message_translation SET last_accessed_at = ? WHERE message_guid IN (${placeholders})`
                )
                .run(partial.lastAccessedAt, ...guids);
        },
        delete: async criteria => {
            if (criteria.messageGuid !== undefined) {
                const guids = extractValues(criteria.messageGuid);
                if (guids.length === 0) return;
                const placeholders = guids.map(() => "?").join(",");
                sqliteDb
                    .prepare(`DELETE FROM message_translation WHERE message_guid IN (${placeholders})`)
                    .run(...guids);
                return;
            }
            if (criteria.chatGuid !== undefined) {
                const guids = extractValues(criteria.chatGuid);
                if (guids.length === 0) return;
                const placeholders = guids.map(() => "?").join(",");
                sqliteDb
                    .prepare(`DELETE FROM message_translation WHERE chat_guid IN (${placeholders})`)
                    .run(...guids);
                return;
            }
            if (criteria.autoTranslated !== undefined && isNot(criteria.targetLanguage)) {
                sqliteDb
                    .prepare("DELETE FROM message_translation WHERE auto_translated = ? AND target_language != ?")
                    .run(criteria.autoTranslated ? 1 : 0, criteria.targetLanguage.value);
            }
        },
        clear: async () => {
            sqliteDb.exec("DELETE FROM message_translation");
        },
        createQueryBuilder: () => {
            let limitVal = 100;
            const qb = {
                select: () => qb,
                orderBy: () => qb,
                addOrderBy: () => qb,
                limit: n => {
                    limitVal = n;
                    return qb;
                },
                getRawMany: async () =>
                    sqliteDb
                        .prepare(
                            "SELECT message_guid AS messageGuid FROM message_translation ORDER BY last_accessed_at ASC, created_at ASC LIMIT ?"
                        )
                        .all(limitVal)
            };
            return qb;
        }
    };
};

const setupContext = async ({ googleTranslateFn, appleTranslateFn, initialConfig = {} } = {}) => {
    const serverRef = { current: null };
    const serverStub = { Server: () => serverRef.current };
    const loggableStub = {
        Loggable: class {
            log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
        }
    };
    const envStub = {
        isMinHighSierra: true,
        isMinMonterey: true,
        isMinVentura: true,
        isMinBigSur: true
    };

    const { BooleanTransformer } = loadTs(path.join(srcRoot, "databases/transformers/BooleanTransformer.ts"));
    const { MessageTranslation } = loadTs(path.join(srcRoot, "databases/server/entity/MessageTranslation.ts"), {
        "@server/databases/transformers/BooleanTransformer": { BooleanTransformer }
    });
    const { MessageTranslationTable1793059200000 } = loadTs(
        path.join(srcRoot, "databases/server/migrations/1793059200000-MessageTranslationTable.ts"),
        { "@server": serverStub }
    );
    const { getChatGuidCandidates } = loadTs(path.join(srcRoot, "databases/imessage/helpers/chatGuid.ts"));

    const sqliteDb = new DatabaseSync(":memory:");
    const configMap = new Map(
        Object.entries({
            auto_translate_enabled: false,
            translation_target_language: "en",
            translation_cache_max_entries: 10000,
            ...initialConfig
        })
    );

    const repo = createSqliteTranslationRepo(sqliteDb, MessageTranslation);

    const translationMod = loadTs(path.join(srcRoot, "services/translationService/index.ts"), {
        "@server": serverStub,
        "@server/api/lib/facetime/FaceTimeAudioBridge": { FaceTimeAudioBridge: { resolveToolBinary: () => null } },
        "@server/lib/logging/Loggable": loggableStub,
        "@server/databases/imessage/entity/Message": { Message: class {} },
        "@server/databases/server/entity/MessageTranslation": { MessageTranslation },
        "@server/databases/imessage/helpers/chatGuid": { getChatGuidCandidates }
    });

    const adapter = {
        translations: () => repo,
        getConfig: key => configMap.get(key),
        setConfig: async (key, value) => {
            configMap.set(key, value);
        }
    };

    const service = new translationMod.TranslationService({
        adapter,
        googleTranslateFn,
        appleTranslateFn
    });

    const emitted = [];
    const messagesByGuid = new Map();

    serverRef.current = {
        log: () => {},
        translationService: service,
        repo: {
            db: { isInitialized: true },
            messageTranslations: () => repo,
            getConfig: key => configMap.get(key),
            setConfig: async (key, value) => configMap.set(key, value)
        },
        iMessageRepo: {
            getMessage: async guid => messagesByGuid.get(guid) ?? null
        },
        emitMessage: async (type, data) => {
            emitted.push({ type, data });
        }
    };

    // Execute the real TypeORM migration SQL on SQLite
    const migration = new MessageTranslationTable1793059200000();
    await migration.up({
        query: async sql => sqliteDb.exec(sql)
    });

    const { MessageSerializer } = loadTs(path.join(srcRoot, "api/serializers/MessageSerializer.ts"), {
        "@server": serverStub,
        "@server/helpers/utils": { isEmpty: v => !v || v.length === 0, isNotEmpty: v => Boolean(v && v.length > 0) },
        "@server/env": envStub,
        "@server/types": {},
        "./AttachmentSerializer": { AttachmentSerializer: { serializeList: async () => [] } },
        "./ChatSerializer": {
            ChatSerializer: { serializeList: async ({ chats }) => chats.map(c => ({ guid: c.guid })) },
            resolveEffectiveChatServiceName: (_g, s) => s
        },
        "./constants": {
            DEFAULT_ATTACHMENT_CONFIG: {},
            DEFAULT_MESSAGE_CONFIG: { parseAttributedBody: true, parseMessageSummary: true, parsePayloadData: true }
        },
        "./HandleSerializer": { HandleSerializer: { serialize: async () => null, serializeList: async () => [] } }
    });

    return {
        sqliteDb,
        repo,
        configMap,
        service,
        translationMod,
        MessageTranslation,
        MessageSerializer,
        emitted,
        messagesByGuid,
        serverStub,
        envStub
    };
};

const makeMessage = ({
    guid,
    text,
    isFromMe = false,
    chatGuid = "iMessage;-;+15551234567",
    dateEdited = null,
    dateRetracted = null,
    isFullyUnsent = false,
    associatedMessageType = null,
    itemType = 0
}) => ({
    ROWID: 1,
    guid,
    text,
    universalText: () => text,
    isFromMe,
    chats: chatGuid ? [{ guid: chatGuid }] : [],
    handleId: isFromMe ? 0 : 1,
    otherHandle: 0,
    error: 0,
    dateCreated: new Date(1700000000000),
    dateRead: null,
    dateDelivered: null,
    dateEdited,
    dateRetracted,
    isFullyUnsent,
    isDelivered: true,
    isArchived: false,
    itemType,
    groupTitle: null,
    groupActionType: 0,
    balloonBundleId: null,
    associatedMessageGuid: null,
    associatedMessageType,
    expressiveSendStyleId: null,
    service: "iMessage"
});

test("shouldSkipAutoTranslation filters empty, emoji, URL, numbers, and <=2 non-CJK chars", async () => {
    const ctx = await setupContext();
    const { shouldSkipAutoTranslation, parseGoogleGtxResponse } = ctx.translationMod;
    try {
        assert.equal(shouldSkipAutoTranslation(""), true);
        assert.equal(shouldSkipAutoTranslation("   \ufffc  "), true);
        assert.equal(shouldSkipAutoTranslation("😂🔥👍"), true);
        assert.equal(shouldSkipAutoTranslation("1234567890"), true);
        assert.equal(shouldSkipAutoTranslation("https://example.com/foo?bar=1"), true);
        assert.equal(shouldSkipAutoTranslation("ok"), true);
        assert.equal(shouldSkipAutoTranslation("hi!"), true);
        assert.equal(shouldSkipAutoTranslation("你好"), false);
        assert.equal(shouldSkipAutoTranslation("はい"), false);
        assert.equal(shouldSkipAutoTranslation("Hola amigo"), false);

        const parsed = parseGoogleGtxResponse([
            [
                ["Hello ", "Hola ", null, null, 1],
                ["friend", "amigo", null, null, 1]
            ],
            null,
            "es"
        ]);
        assert.deepEqual(parsed, { translatedText: "Hello friend", sourceLanguage: "es" });
    } finally {
        ctx.sqliteDb.close();
    }
});

test("TranslationService routes google primary, apple fallback, skips same base lang & outgoing", async () => {
    let googleCalls = 0;
    let appleCalls = 0;
    const ctx = await setupContext({
        initialConfig: { auto_translate_enabled: true },
        googleTranslateFn: async text => {
            googleCalls += 1;
            if (text === "Bonjour tout le monde") {
                return null; // Force Apple fallback
            }
            if (text === "Already English") {
                return { translatedText: "Already English", sourceLanguage: "en-US" };
            }
            return { translatedText: "Hello world", sourceLanguage: "es" };
        },
        appleTranslateFn: async text => {
            appleCalls += 1;
            if (text === "Bonjour tout le monde") {
                return { translatedText: "Hello everyone", sourceLanguage: "fr" };
            }
            return null;
        }
    });

    try {
        await ctx.service.handleNewMessage(makeMessage({ guid: "m-out", text: "Hola mundo", isFromMe: true }));
        assert.equal(googleCalls, 0);

        await ctx.service.handleNewMessage(makeMessage({ guid: "m-es", text: "Hola mundo" }));
        assert.equal(googleCalls, 1);
        assert.equal(appleCalls, 0);

        await ctx.service.handleNewMessage(makeMessage({ guid: "m-fr", text: "Bonjour tout le monde" }));
        assert.equal(googleCalls, 2);
        assert.equal(appleCalls, 1);

        await ctx.service.handleNewMessage(makeMessage({ guid: "m-en", text: "Already English" }));
        const rows = await ctx.repo.find();
        assert.equal(rows.length, 2);
        const byGuid = new Map(rows.map(r => [r.messageGuid, r]));
        assert.equal(byGuid.get("m-es")?.provider, "google");
        assert.equal(byGuid.get("m-fr")?.provider, "apple");
        assert.equal(byGuid.get("m-fr")?.translatedText, "Hello everyone");
    } finally {
        ctx.sqliteDb.close();
    }
});

test("Bounded LRU eviction touches lastAccessedAt on serializeList reads and evicts oldest", async () => {
    const ctx = await setupContext({
        initialConfig: { auto_translate_enabled: true, translation_cache_max_entries: 2 },
        googleTranslateFn: async text => ({ translatedText: `EN:${text}`, sourceLanguage: "es" })
    });

    try {
        const m1 = makeMessage({ guid: "m1", text: "Uno dos tres" });
        const m2 = makeMessage({ guid: "m2", text: "Cuatro cinco seis" });
        const m3 = makeMessage({ guid: "m3", text: "Siete ocho nueve" });

        await ctx.service.handleNewMessage(m1);
        await new Promise(r => setTimeout(r, 5));
        await ctx.service.handleNewMessage(m2);
        await new Promise(r => setTimeout(r, 5));

        const serialized = await ctx.MessageSerializer.serializeList({ messages: [m1] });
        assert.equal(serialized[0].translation.text, "EN:Uno dos tres");
        assert.equal(serialized[0].translation.sourceLanguage, "es");
        assert.equal(serialized[0].translation.targetLanguage, "en");
        assert.equal(serialized[0].translation.autoTranslated, true);
        assert.equal(typeof serialized[0].translation.dateTranslated, "number");

        await new Promise(r => setTimeout(r, 5));
        await ctx.service.handleNewMessage(m3);

        const remaining = await ctx.repo.find();
        const remainingGuids = new Set(remaining.map(r => r.messageGuid));
        assert.equal(remaining.length, 2);
        assert.equal(remainingGuids.has("m1"), true);
        assert.equal(remainingGuids.has("m3"), true);
        assert.equal(remainingGuids.has("m2"), false);
    } finally {
        ctx.sqliteDb.close();
    }
});

test("Lifecycle: dateEdited re-translates, unsend/retract and delete cascade-delete", async () => {
    const ctx = await setupContext({
        initialConfig: { auto_translate_enabled: true },
        googleTranslateFn: async text => ({ translatedText: `EN:${text}`, sourceLanguage: "es" })
    });

    try {
        const m1 = makeMessage({ guid: "m1", text: "Hola uno", chatGuid: "any;-;+15550001" });
        const m2 = makeMessage({ guid: "m2", text: "Hola dos", chatGuid: "iMessage;-;+15550002" });
        await ctx.service.handleNewMessage(m1);
        await ctx.service.handleNewMessage(m2);

        const m1Edited = makeMessage({
            guid: "m1",
            text: "Hola editado",
            chatGuid: "any;-;+15550001",
            dateEdited: new Date()
        });
        await ctx.service.handleUpdatedMessage(m1Edited);
        const row1 = await ctx.repo.findOneBy({ messageGuid: "m1" });
        assert.equal(row1?.translatedText, "EN:Hola editado");

        await ctx.service.handleUpdatedMessage(
            makeMessage({ guid: "m1", text: "", dateRetracted: new Date(), isFullyUnsent: true })
        );
        assert.equal(await ctx.repo.findOneBy({ messageGuid: "m1" }), null);

        await ctx.service.deleteForChat("any;-;+15550002");
        assert.equal(await ctx.repo.findOneBy({ messageGuid: "m2" }), null);
    } finally {
        ctx.sqliteDb.close();
    }
});

test("REST controllers: MessageRouter.translateMessage and TranslationRouter config/cache", async () => {
    const ctx = await setupContext({
        googleTranslateFn: async () => ({ translatedText: "Hello!", sourceLanguage: "es" })
    });

    const { Success } = loadTs(path.join(srcRoot, "api/http/api/v1/responses/success.ts"), {
        "./types": { ResponseMessages: { SUCCESS: "Success" } }
    });
    const errors = loadTs(path.join(srcRoot, "api/http/api/v1/responses/errors.ts"), {
        "./types": {
            ErrorTypes: {
                VALIDATION_ERROR: "Validation Error",
                DATABSE_ERROR: "Database Error",
                SERVER_ERROR: "Server Error",
                IMESSAGE_ERROR: "iMessage Error",
                AUTHENTICATION_ERROR: "Authentication Error",
                GATEWAY_TIMEOUT: "Gateway Timeout"
            },
            ResponseMessages: {
                BAD_REQUEST: "Bad Request",
                NOT_FOUND: "Not Found",
                SERVER_ERROR: "Server Error",
                UNKNOWN_IMESSAGE_ERROR: "Unknown iMessage Error",
                UNAUTHORIZED: "Unauthorized",
                FORBIDDEN: "Forbidden",
                TOO_MANY_REQUESTS: "Too Many Requests",
                GATEWAY_TIMEOUT: "Gateway Timeout"
            }
        }
    });

    const { TranslationRouter } = loadTs(path.join(srcRoot, "api/http/api/v1/routers/translationRouter.ts"), {
        "@server": ctx.serverStub,
        "../responses/success": { Success }
    });

    const { MessageRouter } = loadTs(path.join(srcRoot, "api/http/api/v1/routers/messageRouter.ts"), {
        "@server": ctx.serverStub,
        "@server/fileSystem": { FileSystem: {} },
        "@server/helpers/utils": { isEmpty: v => !v || v.length === 0, isNotEmpty: v => Boolean(v && v.length > 0) },
        "@server/databases/imessage/entity/Message": { Message: class {} },
        "@server/api/interfaces/messageInterface": { MessageInterface: {} },
        "@server/managers/outgoingMessageManager/messagePromise": { MessagePromiseRejection: class {} },
        "@server/api/serializers/MessageSerializer": { MessageSerializer: ctx.MessageSerializer },
        "@server/utils/CollectionUtils": { arrayHasOne: () => false },
        "../responses/success": { FileStream: class {}, Success },
        "../responses/errors": errors,
        "../utils": { parseWithQuery: () => [] },
        "@server/env": ctx.envStub,
        "@server/events": { MESSAGE_UPDATED: "updated-message" },
        "@server/services/translationService": ctx.translationMod
    });

    const makeKoaCtx = (params = {}, body = {}) => ({
        params,
        request: { body, query: {} },
        status: 0,
        body: null
    });

    try {
        ctx.messagesByGuid.set("out-1", makeMessage({ guid: "out-1", text: "Hola!", isFromMe: true }));
        await assert.rejects(() => MessageRouter.translateMessage(makeKoaCtx({ guid: "out-1" }), async () => {}), {
            name: "BadRequest"
        });

        ctx.messagesByGuid.set("in-1", makeMessage({ guid: "in-1", text: "¡Hola!" }));
        const trCtx = makeKoaCtx({ guid: "in-1" }, {});
        await MessageRouter.translateMessage(trCtx, async () => {});
        assert.equal(trCtx.status, 200);
        assert.equal(trCtx.body.data.translation.text, "Hello!");
        assert.equal(trCtx.body.data.translation.autoTranslated, false);
        assert.equal(ctx.emitted.length, 1);
        assert.equal(ctx.emitted[0].type, "updated-message");

        const cfgCtx = makeKoaCtx();
        await TranslationRouter.updateConfig(
            makeKoaCtx({}, { auto_translate_enabled: true, translation_target_language: "fr" }),
            async () => {}
        );
        await TranslationRouter.getConfig(cfgCtx, async () => {});
        assert.deepEqual(cfgCtx.body.data, {
            auto_translate_enabled: true,
            translation_target_language: "fr",
            translation_cache_max_entries: 10000
        });

        const delCtx = makeKoaCtx();
        await TranslationRouter.clearCache(delCtx, async () => {});
        assert.equal(delCtx.status, 200);
        assert.equal(await ctx.repo.count(), 0);
    } finally {
        ctx.sqliteDb.close();
    }
});
