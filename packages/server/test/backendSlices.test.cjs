const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const babel = require("@babel/core");

const serverSrcRoot = path.resolve(__dirname, "../src/server");

function createLoader(stubs = {}) {
    const cache = new Map();
    function loadTs(absPath) {
        if (cache.has(absPath)) return cache.get(absPath).exports;

        const source = fs.readFileSync(absPath, "utf8");
        const transformed = babel.transformSync(source, {
            filename: absPath,
            presets: [
                ["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }],
                "@babel/preset-typescript"
            ],
            plugins: [
                ["@babel/plugin-proposal-decorators", { legacy: true }],
                ["@babel/plugin-transform-class-properties", { loose: true }]
            ]
        });

        const mod = new Module(absPath);
        mod.filename = absPath;
        mod.paths = Module._nodeModulePaths(path.dirname(absPath));
        cache.set(absPath, mod);

        const origRequire = mod.require.bind(mod);
        mod.require = req => {
            if (Object.prototype.hasOwnProperty.call(stubs, req)) {
                return stubs[req];
            }
            if (req.startsWith("@server/")) {
                const rel = req.slice("@server/".length);
                for (const c of [`${rel}.ts`, `${rel}/index.ts`, `${rel}.js`]) {
                    const target = path.join(serverSrcRoot, c);
                    if (fs.existsSync(target)) {
                        return target.endsWith(".ts") ? loadTs(target) : origRequire(target);
                    }
                }
            }
            if (req.startsWith(".")) {
                const base = path.resolve(path.dirname(absPath), req);
                for (const ext of [".ts", "/index.ts", ".js"]) {
                    const target = `${base}${ext}`;
                    if (fs.existsSync(target)) {
                        return target.endsWith(".ts") ? loadTs(target) : origRequire(target);
                    }
                }
            }
            return origRequire(req);
        };

        mod._compile(transformed.code, absPath);
        return mod.exports;
    }
    return loadTs;
}

const commonSerializerStubs = {
    "@server": {
        Server: () => ({
            pinnedChatsCache: { getPinInfo: () => null },
            log: () => {}
        })
    },
    "@server/helpers/utils": {
        isNotEmpty: v => v !== undefined && v !== null && (Array.isArray(v) ? v.length > 0 : String(v).length > 0),
        isEmpty: v => v === undefined || v === null || (Array.isArray(v) ? v.length === 0 : String(v).length === 0)
    },
    "@server/env": { isMinHighSierra: true, isMinMonterey: true, isMinVentura: true },
    "./HandleSerializer": { HandleSerializer: { serialize: async () => null, serializeList: async () => [] } },
    "./AttachmentSerializer": { AttachmentSerializer: { serializeList: async () => [] } }
};

test("Unread (#4): ChatSerializer serializes lastReadMessageTimestamp and guards 0/null", async () => {
    const loadTs = createLoader(commonSerializerStubs);
    const { ChatSerializer } = loadTs(path.join(serverSrcRoot, "api/serializers/ChatSerializer.ts"));

    const baseChat = {
        ROWID: 1,
        guid: "iMessage;-;+15551234567",
        style: 45,
        chatIdentifier: "+15551234567",
        serviceName: "iMessage",
        isArchived: false,
        displayName: "",
        isFiltered: false,
        properties: null,
        groupId: "g1",
        lastAddressedHandle: null
    };

    const readDate = new Date(Date.UTC(2026, 9, 28, 5, 35, 8, 971));
    const withDate = await ChatSerializer.serialize({
        chat: { ...baseChat, lastReadMessageTimestamp: readDate }
    });
    assert.equal(withDate.lastReadMessageTimestamp, readDate.getTime());

    const withRawPointer = await ChatSerializer.serialize({
        chat: { ...baseChat, lastReadMessageTimestamp: "814858508971925760" }
    });
    assert.equal(withRawPointer.lastReadMessageTimestamp, Date.UTC(2026, 9, 28, 5, 35, 8, 971));

    for (const emptyVal of [null, undefined, 0, "0", new Date(0)]) {
        const res = await ChatSerializer.serialize({
            chat: { ...baseChat, lastReadMessageTimestamp: emptyVal }
        });
        assert.equal(res.lastReadMessageTimestamp, null);
    }
});

test("Unread (#4): MessageSerializer includes isRead with null fallback", async () => {
    const loadTs = createLoader(commonSerializerStubs);
    const { MessageSerializer } = loadTs(path.join(serverSrcRoot, "api/serializers/MessageSerializer.ts"));

    const baseMsg = {
        ROWID: 10,
        guid: "MSG-1",
        universalText: () => "hi",
        attributedBody: null,
        handle: null,
        handleId: 0,
        otherHandle: 0,
        attachments: [],
        subject: null,
        error: 0,
        dateCreated: new Date(1700000000000),
        dateRead: null,
        dateDelivered: null,
        isDelivered: true,
        isFromMe: false,
        hasDdResults: false,
        isArchived: false,
        itemType: 0,
        groupTitle: null,
        groupActionType: 0,
        balloonBundleId: null,
        associatedMessageGuid: null,
        associatedMessageType: null,
        associatedMessageEmoji: null,
        expressiveSendStyleId: null,
        threadOriginatorGuid: null,
        threadOriginatorPart: null,
        payloadData: null,
        service: "RCS"
    };

    const unread = await MessageSerializer.serialize({ message: { ...baseMsg, isRead: false } });
    assert.equal(unread.isRead, false);

    const read = await MessageSerializer.serialize({ message: { ...baseMsg, isRead: true } });
    assert.equal(read.isRead, true);

    const missing = await MessageSerializer.serialize({ message: { ...baseMsg } });
    assert.equal(missing.isRead, null);
});

test("RCS CloudKit backfill (#8): MessagePoller emits updated-entry via ROWID IN check when date columns don't change", async () => {
    const loadTs = createLoader({
        "@server": {
            Server: () => ({
                messageManager: { resolve: () => {} },
                log: () => {}
            })
        },
        "@server/helpers/utils": {
            isEmpty: v => v === undefined || v === null || String(v).length === 0
        },
        "@server/env": {
            isMinBigSur: true,
            isMinSierra: true
        },
        "@server/events": {
            CHAT_READ_STATUS_CHANGED: "chat-read-status-changed"
        },
        "@server/lib/logging/Loggable": {
            Loggable: class {}
        },
        "@server/eventCache": {
            EventCache: class {
                constructor() {
                    this.items = new Set();
                }
                add(k) {
                    this.items.add(k);
                }
                find(k) {
                    return this.items.has(k);
                }
                trim() {}
            }
        }
    });

    const { IMessageCache } = loadTs(path.join(serverSrcRoot, "databases/imessage/pollers/index.ts"));
    const { MessagePoller } = loadTs(path.join(serverSrcRoot, "databases/imessage/pollers/MessagePoller.ts"));

    const createdAt = new Date(Date.now() - 1000 * 60 * 60); // 1h ago (outside 30m fast lookback)
    const initialRow = {
        ROWID: 69684,
        guid: "RCS-MSG-69684",
        text: "❤️",
        dateCreated: createdAt,
        dateDelivered: null,
        dateRead: null,
        dateEdited: null,
        dateRetracted: null,
        isDelivered: true,
        isFromMe: false,
        isSent: true,
        error: 0,
        didNotifyRecipient: false,
        hasUnsentParts: false,
        itemType: 0,
        threadOriginatorGuid: null,
        threadOriginatorPart: null,
        associatedMessageGuid: null,
        associatedMessageType: null,
        associatedMessageEmoji: null,
        chats: [{ isGroup: false }]
    };

    const queries = [];
    let backfilled = false;
    const fakeRepo = {
        getMessages: async opts => {
            queries.push(opts);
            const whereStmt = opts.where?.[0]?.statement ?? "";
            if (whereStmt.includes("message.ROWID in (69684)")) {
                const row = backfilled
                    ? {
                          ...initialRow,
                          associatedMessageGuid: "p:0/TARGET-GUID",
                          associatedMessageType: "2000",
                          associatedMessageEmoji: "❤️"
                      }
                    : initialRow;
                return [[row], 1];
            }
            return [[], 0];
        }
    };

    const cache = new IMessageCache();
    const poller = new MessagePoller(fakeRepo, cache);
    poller.lastReconcileAt = Date.now(); // force fast poll

    // Seed initial state as if previously polled
    assert.equal(poller.processMessageEvent(initialRow), "new-entry");

    // Poll before CloudKit backfill: ROWID IN check runs with SQL backfill predicate, no update emitted
    const res1 = await poller.poll(new Date());
    assert.equal(res1.length, 0);
    const backfillQuery = queries.find(q => q.where?.[0]?.statement?.includes("message.ROWID in (69684)"));
    assert.ok(backfillQuery);
    assert.match(backfillQuery.where[0].statement, /message\.thread_originator_guid IS NOT NULL/);
    assert.match(backfillQuery.where[0].statement, /message\.associated_message_guid IS NOT NULL/);
    assert.match(backfillQuery.where[0].statement, /COALESCE\(message\.associated_message_type, 0\) != 0/);

    // Simulate in-place CloudKit backfill without touching any date columns
    backfilled = true;
    const res2 = await poller.poll(new Date());
    assert.equal(res2.length, 1);
    assert.equal(res2[0].eventType, "updated-entry");
    assert.equal(res2[0].data.guid, "RCS-MSG-69684");
    assert.equal(res2[0].data.associatedMessageType, "2000");
});

test("Stickers (#6): StickerInterface.sendSticker awaits getMessage(guid, true, true) and throws on timeout", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-sticker-iface-"));
    const tmpFile = path.join(tmpDir, "s.png");
    fs.writeFileSync(tmpFile, Buffer.from("png"));

    let getMessageCalls = [];
    let getMessageResult = { guid: "STICKER-MSG-1", ROWID: 1 };
    let helperIdentifier = "STICKER-MSG-1";
    let awaiterOpts = null;

    const loadTs = createLoader({
        "@server": {
            Server: () => ({
                privateApi: { helper: {} },
                iMessageRepo: {
                    getMessage: async (guid, withChats, withAttachments) => {
                        getMessageCalls.push({ guid, withChats, withAttachments });
                        return getMessageResult;
                    }
                }
            })
        },
        "@server/helpers/utils": {
            resultAwaiter: async opts => {
                awaiterOpts = opts;
                return await opts.getData(1);
            }
        },
        "@server/fileSystem": {
            FileSystem: {
                saveAttachment: name => path.join(tmpDir, name)
            }
        },
        "@server/databases/stickers": {
            StickerDatabase: class {},
            stickerDb: {}
        },
        "@server/api/privateApi/apis/PrivateApiSticker": {
            PrivateApiSticker: class {
                async sendSticker() {
                    return { data: { identifier: helperIdentifier } };
                }
            }
        }
    });

    try {
        const { StickerInterface } = loadTs(path.join(serverSrcRoot, "api/interfaces/stickerInterface.ts"));

        const msg = await StickerInterface.sendSticker({
            chatGuid: "iMessage;-;+15551234567",
            filePath: tmpFile
        });
        assert.equal(msg.guid, "STICKER-MSG-1");
        assert.equal(awaiterOpts.maxWaitMs, 60000);
        assert.deepEqual(getMessageCalls[0], {
            guid: "STICKER-MSG-1",
            withChats: true,
            withAttachments: true
        });

        getMessageResult = null;
        await assert.rejects(
            () =>
                StickerInterface.sendSticker({
                    chatGuid: "iMessage;-;+15551234567",
                    filePath: tmpFile
                }),
            /Sticker message not found in database after 60 seconds/
        );

        helperIdentifier = null;
        await assert.rejects(
            () =>
                StickerInterface.sendSticker({
                    chatGuid: "iMessage;-;+15551234567",
                    filePath: tmpFile
                }),
            /No message GUID returned/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("Stickers (#6): StickerRouter.send throws ServerError instead of returning raw {identifier}", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-sticker-router-"));
    const tmpFile = path.join(tmpDir, "s.png");
    fs.writeFileSync(tmpFile, Buffer.from("png"));

    const passThroughMw = async (_ctx, next) => next();
    const loadTs = createLoader({
        "@server/helpers/utils": {
            isNotEmpty: v => v !== undefined && v !== null && String(v).length > 0,
            isTruthyBool: v => v === true || v === "true" || v === "1"
        },
        "@server/api/interfaces/stickerInterface": {
            StickerInterface: {
                sendSticker: async () => ({ identifier: "RAW-ID-ONLY" })
            }
        },
        "@server/api/serializers/MessageSerializer": {
            MessageSerializer: { serialize: async ({ message }) => message }
        },
        "../v1/responses/success": { Success: class {} },
        "../v1/responses/errors": {
            BadRequest: class extends Error {},
            NotFound: class extends Error {},
            ServerError: class extends Error {
                constructor(opts) {
                    super(opts?.error ?? "ServerError");
                }
            }
        },
        "../v1/middleware/metricsMiddleware": { MetricsMiddleware: passThroughMw },
        "../v1/middleware/errorMiddleware": { ErrorMiddleware: passThroughMw },
        "../v1/middleware/logMiddleware": { LogMiddleware: passThroughMw },
        "../v1/middleware/authMiddleware": { AuthMiddleware: passThroughMw },
        "../v1/middleware/bodyMiddleware": { BodyMiddleware: passThroughMw },
        "../v1/middleware/privateApiMiddleware": { PrivateApiMiddleware: passThroughMw }
    });

    try {
        const { StickerRouter } = loadTs(path.join(serverSrcRoot, "api/http/api/v2/stickerRouter.ts"));
        const ctx = {
            request: {
                files: { attachment: { filepath: tmpFile, originalFilename: "s.png", mimetype: "image/png" } },
                body: { chatGuid: "iMessage;-;+15551234567" }
            }
        };
        await assert.rejects(() => StickerRouter.send(ctx, async () => {}), /No serialized message returned/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("Stickers: StickerInterface.sendSticker rewrites extension from magic bytes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-sticker-magic-"));
    const pngFile = path.join(tmpDir, "input.bin");
    const heicsFile = path.join(tmpDir, "input.heics");
    fs.writeFileSync(pngFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(heicsFile, Buffer.from("\x00\x00\x00\x18ftypmsf1\x00\x00\x00\x00", "latin1"));

    const savedNames = [];
    const loadTs = createLoader({
        "@server": {
            Server: () => ({
                privateApi: { helper: {} },
                iMessageRepo: {
                    getMessage: async guid => ({ guid, ROWID: 1 })
                }
            })
        },
        "@server/helpers/utils": {
            resultAwaiter: async opts => await opts.getData(1)
        },
        "@server/fileSystem": {
            FileSystem: {
                saveAttachment: name => {
                    savedNames.push(name);
                    return path.join(tmpDir, name);
                }
            }
        },
        "@server/databases/stickers": {
            StickerDatabase: class {},
            stickerDb: {}
        },
        "@server/api/privateApi/apis/PrivateApiSticker": {
            PrivateApiSticker: class {
                async sendSticker({ filePath }) {
                    if (filePath.endsWith(".png")) return { identifier: "STICKER-MSG-MAGIC" };
                    return { data: { identifier: "STICKER-MSG-HEICS" } };
                }
            }
        }
    });

    try {
        const { StickerInterface } = loadTs(path.join(serverSrcRoot, "api/interfaces/stickerInterface.ts"));

        await StickerInterface.sendSticker({
            chatGuid: "iMessage;-;+15551234567",
            filePath: pngFile,
            fileName: "sticker.heics"
        });
        assert.match(savedNames[0], /-sticker\.png$/);

        await StickerInterface.sendSticker({
            chatGuid: "iMessage;-;+15551234567",
            filePath: heicsFile,
            fileName: "sticker.heics"
        });
        assert.match(savedNames[1], /-sticker\.heics$/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("Stickers: PrivateApiSticker.repositionSticker sends reposition-sticker with TransactionType.OTHER", async () => {
    const sent = [];
    const loadTs = createLoader({
        "@server/managers/transactionManager/transactionPromise": {
            TransactionType: { OTHER: "OTHER", MESSAGE: "MESSAGE" },
            TransactionPromise: class {
                constructor(type) {
                    this.type = type;
                }
            }
        },
        ".": {
            PrivateApiAction: class {
                constructor(api) {
                    this.api = api;
                }
                throwForNoMissingFields(action, fields) {
                    for (const f of fields) {
                        if (typeof f === "number" || typeof f === "boolean") continue;
                        if (f === undefined || f === null || String(f).length === 0) {
                            throw new Error(`Missing fields for ${action}`);
                        }
                    }
                }
                async sendApiMessage(action, data, request) {
                    sent.push({ action, data, request });
                    return { identifier: data.messageGuid };
                }
            }
        }
    });

    const { PrivateApiSticker } = loadTs(path.join(serverSrcRoot, "api/privateApi/apis/PrivateApiSticker.ts"));
    const api = new PrivateApiSticker({});
    const res = await api.repositionSticker({
        chatGuid: "iMessage;-;+15551234567",
        messageGuid: "STICKER-MSG-1",
        xScalar: 0,
        yScalar: 0,
        scale: 1.5,
        rotation: 0,
        parentPreviewWidth: 240
    });

    assert.equal(res.identifier, "STICKER-MSG-1");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].action, "reposition-sticker");
    assert.equal(sent[0].request.type, "OTHER");
    assert.deepEqual(sent[0].data, {
        chatGuid: "iMessage;-;+15551234567",
        messageGuid: "STICKER-MSG-1",
        xScalar: 0,
        yScalar: 0,
        scale: 1.5,
        rotation: 0,
        parentPreviewWidth: 240
    });

    await api.repositionSticker({
        chatGuid: "iMessage;-;+15551234567",
        messageGuid: "STICKER-MSG-1",
        xScalar: 0.2,
        yScalar: 0.3,
        scale: 1.2,
        rotation: 0.1,
        parentPreviewWidth: 240,
        currentSpv: 2
    });
    assert.equal(sent[1].data.currentSpv, 2);
});

test("Stickers: StickerInterface.repositionSticker forwards currentSpv and awaits spv increment", async () => {
    let hasHelper = true;
    let getMessageResults = [
        { guid: "STICKER-MSG-2", ROWID: 2, attachments: [{ stickerUserInfo: { spv: 1 } }] },
        { guid: "STICKER-MSG-2", ROWID: 2, attachments: [{ stickerUserInfo: { spv: 1 } }] },
        { guid: "STICKER-MSG-2", ROWID: 2, attachments: [{ stickerUserInfo: { spv: 2 } }] }
    ];
    let idx = 0;
    const calls = [];
    const repoCalls = [];
    let awaiterOpts = null;

    const loadTs = createLoader({
        "@server": {
            Server: () => ({
                privateApi: hasHelper ? { helper: {} } : null,
                iMessageRepo: {
                    getMessage: async (guid, withChats, withAttachments) => {
                        repoCalls.push({ guid, withChats, withAttachments });
                        return getMessageResults[Math.min(idx++, getMessageResults.length - 1)];
                    }
                }
            })
        },
        "@server/helpers/utils": {
            resultAwaiter: async opts => {
                awaiterOpts = opts;
                let data = await opts.getData(null);
                while (opts.extraLoopCondition && opts.extraLoopCondition(data)) {
                    data = await opts.getData(data);
                }
                return data;
            }
        },
        "@server/fileSystem": { FileSystem: {} },
        "@server/databases/stickers": { StickerDatabase: class {}, stickerDb: {} },
        "@server/api/serializers/AttachmentSerializer": {
            decodeStickerUserInfo: raw => (raw && typeof raw === "object" ? raw : null)
        },
        "@server/api/privateApi/apis/PrivateApiSticker": {
            PrivateApiSticker: class {
                async repositionSticker(params) {
                    calls.push(params);
                    return { identifier: params.messageGuid };
                }
            }
        }
    });

    const { StickerInterface } = loadTs(path.join(serverSrcRoot, "api/interfaces/stickerInterface.ts"));
    const payload = {
        chatGuid: "iMessage;-;+15551234567",
        messageGuid: "STICKER-MSG-2",
        xScalar: 0.25,
        yScalar: 0.75,
        scale: 1.2,
        rotation: -0.3,
        parentPreviewWidth: 300
    };

    const msg = await StickerInterface.repositionSticker(payload);
    assert.equal(msg.guid, "STICKER-MSG-2");
    assert.equal(msg.attachments[0].stickerUserInfo.spv, 2);
    assert.deepEqual(calls, [{ ...payload, currentSpv: 1 }]);
    assert.equal(awaiterOpts.maxWaitMs, 3000);
    assert.equal(awaiterOpts.initialWaitMs, 50);
    assert.equal(awaiterOpts.waitMultiplier, 1.5);
    assert.equal(repoCalls.length, 3);
    assert.deepEqual(repoCalls[0], { guid: "STICKER-MSG-2", withChats: true, withAttachments: true });

    getMessageResults = [null];
    idx = 0;
    await assert.rejects(() => StickerInterface.repositionSticker(payload), /not found in database/);

    hasHelper = false;
    await assert.rejects(() => StickerInterface.repositionSticker(payload), /BlueBubblesHelper is not connected/);
});

test("Stickers: StickerRouter.reposition validates input and returns serialized message", async () => {
    const passThroughMw = async (_ctx, next) => next();
    const calls = [];
    const routes = [];

    class FakeBadRequest extends Error {
        constructor(opts) {
            super(opts?.error ?? "BadRequest");
            this.status = 400;
        }
    }

    const loadTs = createLoader({
        "@server/helpers/utils": {
            isNotEmpty: v => v !== undefined && v !== null && String(v).length > 0,
            isTruthyBool: v => v === true || v === "true" || v === "1"
        },
        "@server/api/interfaces/stickerInterface": {
            StickerInterface: {
                repositionSticker: async params => {
                    calls.push(params);
                    return { guid: params.messageGuid, attachments: [{ guid: "ATT-1" }] };
                }
            }
        },
        "@server/api/serializers/MessageSerializer": {
            MessageSerializer: {
                serialize: async ({ message }) => ({ ...message, serialized: true })
            }
        },
        "../v1/responses/success": {
            Success: class {
                constructor(ctx, body) {
                    this.ctx = ctx;
                    this.body = body;
                }
                send() {
                    this.ctx.status = 200;
                    this.ctx.body = this.body;
                    return this.ctx.body;
                }
            }
        },
        "../v1/responses/errors": {
            BadRequest: FakeBadRequest,
            NotFound: class extends Error {},
            ServerError: class extends Error {
                constructor(opts) {
                    super(opts?.error ?? "ServerError");
                }
            }
        },
        "../v1/middleware/metricsMiddleware": { MetricsMiddleware: passThroughMw },
        "../v1/middleware/errorMiddleware": { ErrorMiddleware: passThroughMw },
        "../v1/middleware/logMiddleware": { LogMiddleware: passThroughMw },
        "../v1/middleware/authMiddleware": { AuthMiddleware: passThroughMw },
        "../v1/middleware/bodyMiddleware": { BodyMiddleware: passThroughMw },
        "../v1/middleware/privateApiMiddleware": { PrivateApiMiddleware: passThroughMw }
    });

    const { StickerRouter } = loadTs(path.join(serverSrcRoot, "api/http/api/v2/stickerRouter.ts"));

    StickerRouter.registerRoutes({
        get: (p, ...mw) => routes.push({ method: "GET", path: p, mw }),
        post: (p, ...mw) => routes.push({ method: "POST", path: p, mw }),
        delete: (p, ...mw) => routes.push({ method: "DELETE", path: p, mw })
    });
    const repositionRoute = routes.find(r => r.path === "/api/v2/message/sticker/:guid/reposition");
    assert.ok(repositionRoute);
    assert.equal(repositionRoute.method, "POST");
    assert.ok(repositionRoute.mw.includes(passThroughMw));

    const validBody = {
        chatGuid: "iMessage;-;+15551234567",
        xScalar: 0.5,
        yScalar: -0.25,
        scale: 1.5,
        rotation: 0.4,
        parentPreviewWidth: 260
    };

    const invalidCases = [
        { params: {}, body: validBody },
        { params: { guid: "MSG-1" }, body: { ...validBody, chatGuid: "" } },
        { params: { guid: "MSG-1" }, body: { ...validBody, xScalar: "NaN" } },
        { params: { guid: "MSG-1" }, body: { ...validBody, yScalar: Infinity } },
        { params: { guid: "MSG-1" }, body: { ...validBody, scale: 0 } },
        { params: { guid: "MSG-1" }, body: { ...validBody, scale: -1 } },
        { params: { guid: "MSG-1" }, body: { ...validBody, parentPreviewWidth: 0 } }
    ];

    for (const c of invalidCases) {
        await assert.rejects(
            () => StickerRouter.reposition({ params: c.params, request: { body: c.body } }, async () => {}),
            FakeBadRequest
        );
    }

    const okCtx = { params: { guid: "STICKER-MSG-3" }, request: { body: validBody } };
    const res = await StickerRouter.reposition(okCtx, async () => {});
    assert.equal(okCtx.status, 200);
    assert.equal(res.data.guid, "STICKER-MSG-3");
    assert.equal(res.data.serialized, true);
    assert.deepEqual(calls, [
        {
            chatGuid: "iMessage;-;+15551234567",
            messageGuid: "STICKER-MSG-3",
            xScalar: 0.5,
            yScalar: -0.25,
            scale: 1.5,
            rotation: 0.4,
            parentPreviewWidth: 260
        }
    ]);
});
