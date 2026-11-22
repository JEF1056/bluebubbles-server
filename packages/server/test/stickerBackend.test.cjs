const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const Database = require("better-sqlite3");
const KoaRouter = require("koa-router");

const dbSrcPath = path.resolve(__dirname, "../src/server/databases/stickers/index.ts");
const routerSrcPath = path.resolve(__dirname, "../src/server/api/http/api/v2/stickerRouter.ts");

function transpileTs(filePath, mocks) {
    const source = fs.readFileSync(filePath, "utf8");
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true
        }
    });
    const fakeModule = { exports: {} };
    const req = Module.createRequire(filePath);
    const customRequire = id => (mocks && Object.prototype.hasOwnProperty.call(mocks, id) ? mocks[id] : req(id));
    const fn = new Function("exports", "require", "module", "__filename", "__dirname", outputText);
    fn(fakeModule.exports, customRequire, fakeModule, filePath, path.dirname(filePath));
    return fakeModule.exports;
}

const { StickerDatabase } = transpileTs(dbSrcPath, {
    "@server/fileSystem": { FileSystem: { convertToPng: async () => {} } }
});

function createTempFixtureDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-sticker-test-"));
    const dbPath = path.join(dir, "stickers.stickerdb");
    const fallbackDir = path.join(dir, "fallback");
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE ZMANAGEDSTICKER (
            Z_PK INTEGER PRIMARY KEY,
            ZIDENTIFIER BLOB,
            ZTYPE INTEGER,
            ZEFFECT INTEGER,
            ZNAME VARCHAR,
            ZACCESSIBILITYNAME VARCHAR,
            ZLIBRARYINDEX FLOAT
        );
        CREATE TABLE ZMANAGEDREPRESENTATION (
            Z_PK INTEGER PRIMARY KEY,
            ZSTICKER INTEGER,
            ZROLE VARCHAR,
            ZUTI VARCHAR,
            ZISPREFERRED INTEGER,
            ZINDEX INTEGER,
            ZSIZE_W FLOAT,
            ZSIZE_H FLOAT,
            ZBYTECOUNT INTEGER,
            ZDATA BLOB
        );
    `);

    const uuid1 = Buffer.from("F4303D5EE0FF4D96B13F65C92F815F3F", "hex");
    const uuid2 = Buffer.from("38EAB38A924944B29DEBCA184CB3BA02", "hex");

    db.prepare(
        "INSERT INTO ZMANAGEDSTICKER (Z_PK, ZIDENTIFIER, ZTYPE, ZEFFECT, ZNAME, ZACCESSIBILITYNAME, ZLIBRARYINDEX) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(1, uuid1, 0, 0, "SavedCat", "Cat sticker", 100.0);
    db.prepare(
        "INSERT INTO ZMANAGEDSTICKER (Z_PK, ZIDENTIFIER, ZTYPE, ZEFFECT, ZNAME, ZACCESSIBILITYNAME, ZLIBRARYINDEX) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(2, uuid2, 1, 2, "RecentSparkle", null, 200.0);

    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const heicBytes = Buffer.from("FAKE_HEIC_PAYLOAD");

    db.prepare(
        "INSERT INTO ZMANAGEDREPRESENTATION (Z_PK, ZSTICKER, ZROLE, ZUTI, ZISPREFERRED, ZINDEX, ZSIZE_W, ZSIZE_H, ZBYTECOUNT, ZDATA) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(1, 1, "com.apple.stickers.role.keyboard", "public.png", 0, 0, 100, 100, pngHeader.length, pngHeader);
    db.prepare(
        "INSERT INTO ZMANAGEDREPRESENTATION (Z_PK, ZSTICKER, ZROLE, ZUTI, ZISPREFERRED, ZINDEX, ZSIZE_W, ZSIZE_H, ZBYTECOUNT, ZDATA) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(2, 1, "com.apple.stickers.role.still", "public.heic", 1, 1, 512, 512, heicBytes.length, heicBytes);
    db.prepare(
        "INSERT INTO ZMANAGEDREPRESENTATION (Z_PK, ZSTICKER, ZROLE, ZUTI, ZISPREFERRED, ZINDEX, ZSIZE_W, ZSIZE_H, ZBYTECOUNT, ZDATA) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(3, 2, "com.apple.stickers.role.keyboard", "public.png", 1, 0, 120, 120, pngHeader.length, pngHeader);

    db.close();
    return { dir, dbPath, fallbackDir, pngHeader, heicBytes };
}

test("StickerDatabase parses SQLite stickers newest-first and formats UUIDs + shelves", () => {
    const fx = createTempFixtureDb();
    try {
        const reader = new StickerDatabase({ dbPath: fx.dbPath, fallbackDir: fx.fallbackDir });
        const { stickers, total, reason } = reader.listStickers({ limit: 10, offset: 0 });
        assert.equal(reason, undefined);
        assert.equal(total, 2);
        assert.equal(stickers[0].identifier, "38EAB38A-9249-44B2-9DEB-CA184CB3BA02");
        assert.equal(stickers[0].shelf, "recent");
        assert.equal(stickers[0].effect, 2);
        assert.equal(stickers[1].identifier, "F4303D5E-E0FF-4D96-B13F-65C92F815F3F");
        assert.equal(stickers[1].shelf, "saved");
        assert.equal(stickers[1].accessibility_name, "Cat sticker");
    } finally {
        fs.rmSync(fx.dir, { recursive: true, force: true });
    }
});

test("StickerDatabase serves role.keyboard PNG directly and converts HEIC->PNG for full image", async () => {
    const fx = createTempFixtureDb();
    const convertedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
    let convertCalled = 0;

    try {
        const reader = new StickerDatabase({
            dbPath: fx.dbPath,
            fallbackDir: fx.fallbackDir,
            convertToPng: async (_src, out) => {
                convertCalled += 1;
                fs.writeFileSync(out, convertedPng);
            }
        });

        const thumb = await reader.getStickerImage("F4303D5E-E0FF-4D96-B13F-65C92F815F3F", { role: "keyboard" });
        assert.equal(thumb.mimeType, "image/png");
        assert.deepEqual(thumb.data, fx.pngHeader);
        assert.equal(convertCalled, 0);

        const fullPng = await reader.getStickerImage("F4303D5E-E0FF-4D96-B13F-65C92F815F3F");
        assert.equal(fullPng.mimeType, "image/png");
        assert.deepEqual(fullPng.data, convertedPng);
        assert.equal(convertCalled, 1);

        const rawHeic = await reader.getStickerImage("F4303D5E-E0FF-4D96-B13F-65C92F815F3F", { original: true });
        assert.equal(rawHeic.mimeType, "image/heic");
        assert.deepEqual(rawHeic.data, fx.heicBytes);
    } finally {
        fs.rmSync(fx.dir, { recursive: true, force: true });
    }
});

test("StickerDatabase fallback store supports add/list/get/delete when stickersd DB is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-sticker-fb-"));
    try {
        const reader = new StickerDatabase({
            dbPath: path.join(dir, "missing.stickerdb"),
            fallbackDir: path.join(dir, "fallback")
        });

        const empty = reader.listStickers();
        assert.equal(empty.total, 0);
        assert.ok(empty.reason);

        const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
        const added = reader.addFallbackSticker({ buffer: pngBuf, fileName: "wave.png", name: "Wave" });
        assert.ok(added.identifier);
        assert.equal(added.shelf, "recent");

        const listed = reader.listStickers();
        assert.equal(listed.total, 1);
        assert.equal(listed.reason, undefined);

        const img = await reader.getStickerImage(added.identifier);
        assert.deepEqual(img.data, pngBuf);

        assert.equal(reader.deleteFallbackSticker(added.identifier), true);
        assert.equal(reader.listStickers().total, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("StickerRouter mounts all /api/v2/sticker* and /api/v2/message/sticker routes and matches StickerApi contract", async () => {
    const fx = createTempFixtureDb();
    const sentCalls = [];
    const reader = new StickerDatabase({ dbPath: fx.dbPath, fallbackDir: fx.fallbackDir });
    const tmpUpload = path.join(fx.dir, "upload.png");
    fs.writeFileSync(tmpUpload, fx.pngHeader);

    const passThroughMw = async (_ctx, next) => next();
    const { StickerRouter } = transpileTs(routerSrcPath, {
        "@server/helpers/utils": {
            isNotEmpty: v => v !== undefined && v !== null && String(v).length > 0,
            isTruthyBool: v => v === true || v === "true" || v === "1"
        },
        "@server/api/interfaces/stickerInterface": {
            StickerInterface: {
                listStickers: (limit, offset) => reader.listStickers({ limit, offset }),
                getStickerImage: (id, opts) => reader.getStickerImage(id, opts),
                addSticker: opts => reader.addFallbackSticker(opts),
                deleteSticker: async id => {
                    if (!reader.deleteFallbackSticker(id)) throw new Error("Not found");
                },
                sendSticker: async params => {
                    sentCalls.push(params);
                    return { identifier: "SENT-MSG-GUID-1" };
                }
            }
        },
        "@server/api/serializers/MessageSerializer": { MessageSerializer: { serialize: async ({ message }) => message } },
        "../v1/responses/success": {
            Success: class {
                constructor(ctx, res) {
                    this.ctx = ctx;
                    this.res = res;
                }
                send() {
                    this.ctx.status = 200;
                    this.ctx.body = { status: 200, ...this.res };
                }
            }
        },
        "../v1/responses/errors": {
            BadRequest: class extends Error {},
            NotFound: class extends Error {},
            ServerError: class extends Error {}
        },
        "../v1/middleware/metricsMiddleware": { MetricsMiddleware: passThroughMw },
        "../v1/middleware/errorMiddleware": { ErrorMiddleware: passThroughMw },
        "../v1/middleware/logMiddleware": { LogMiddleware: passThroughMw },
        "../v1/middleware/authMiddleware": { AuthMiddleware: passThroughMw },
        "../v1/middleware/bodyMiddleware": { BodyMiddleware: passThroughMw },
        "../v1/middleware/privateApiMiddleware": { PrivateApiMiddleware: passThroughMw }
    });

    try {
        const router = new KoaRouter();
        StickerRouter.registerRoutes(router);
        const paths = router.stack.map(r => `${r.methods.filter(m => m !== "HEAD").join(",")}:${r.path}`);
        assert.ok(paths.includes("GET:/api/v2/sticker"));
        assert.ok(paths.includes("GET:/api/v2/sticker/:id/thumbnail"));
        assert.ok(paths.includes("GET:/api/v2/sticker/:id/image"));
        assert.ok(paths.includes("POST:/api/v2/sticker"));
        assert.ok(paths.includes("DELETE:/api/v2/sticker/:id"));
        assert.ok(paths.includes("POST:/api/v2/message/sticker"));

        const listCtx = { request: { query: { limit: "10", offset: "0" } } };
        await StickerRouter.list(listCtx, async () => {});
        assert.equal(listCtx.status, 200);
        assert.equal(listCtx.body.data.length, 2);
        assert.equal(listCtx.body.metadata.total, 2);

        const thumbHeaders = {};
        const thumbCtx = {
            params: { id: "F4303D5E-E0FF-4D96-B13F-65C92F815F3F" },
            request: { query: {} },
            set: (k, v) => {
                thumbHeaders[k] = v;
            }
        };
        await StickerRouter.thumbnail(thumbCtx, async () => {});
        assert.equal(thumbCtx.status, 200);
        assert.equal(thumbCtx.type, "image/png");
        assert.equal(thumbHeaders["X-Content-Type-Options"], "nosniff");
        assert.deepEqual(thumbCtx.body, fx.pngHeader);

        const createCtx = {
            request: {
                files: { attachment: { filepath: tmpUpload, originalFilename: "new.png", mimetype: "image/png" } },
                body: { name: "NewOne" }
            }
        };
        await StickerRouter.create(createCtx, async () => {});
        assert.equal(createCtx.status, 200);
        assert.equal(createCtx.body.data.name, "NewOne");

        const sendCtx = {
            request: {
                files: { attachment: { filepath: tmpUpload, originalFilename: "placed.png", mimetype: "image/png" } },
                body: {
                    chatGuid: "iMessage;-;+15551234567",
                    selectedMessageGuid: "MSG-TARGET-1",
                    partIndex: "1",
                    xScalar: "0.5",
                    yScalar: "0.25",
                    scale: "1.2",
                    rotation: "-0.3",
                    parentPreviewWidth: "240"
                }
            }
        };
        await StickerRouter.send(sendCtx, async () => {});
        assert.equal(sendCtx.status, 200);
        assert.equal(sentCalls.length, 1);
        assert.equal(sentCalls[0].associatedMessageGuid, "MSG-TARGET-1");
        assert.equal(sentCalls[0].associatedMessagePart, 1);
        assert.equal(sentCalls[0].associatedMessageType, 1000);
        assert.deepEqual(sentCalls[0].stickerUserInfo, {
            xScalar: 0.5,
            yScalar: 0.25,
            scale: 1.2,
            rotation: -0.3,
            parentPreviewWidth: 240
        });
    } finally {
        fs.rmSync(fx.dir, { recursive: true, force: true });
    }
});
