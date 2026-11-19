const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTsModule(relPath, mocks = {}) {
    const absPath = path.join(__dirname, "..", relPath);
    const source = fs.readFileSync(absPath, "utf8");
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true
        }
    });
    const mod = new Module(absPath, module);
    mod.filename = absPath;
    mod.paths = Module._nodeModulePaths(path.dirname(absPath));
    const origRequire = mod.require.bind(mod);
    mod.require = id => (Object.prototype.hasOwnProperty.call(mocks, id) ? mocks[id] : origRequire(id));
    mod._compile(compiled.outputText, absPath);
    return mod.exports;
}

function makeMockCtx(headers = {}) {
    const responseHeaders = {};
    return {
        request: { headers },
        headers,
        status: 0,
        body: null,
        response: {
            set(k, v) {
                responseHeaders[k.toLowerCase()] = v;
            }
        },
        set(k, v) {
            responseHeaders[k.toLowerCase()] = v;
        },
        _headers: responseHeaders
    };
}

function readStream(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", chunk => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        stream.on("error", reject);
    });
}

test("FileStream serves 200 with Accept-Ranges and 206/416 for Range requests", async () => {
    const { FileStream } = loadTsModule("src/server/api/http/api/v1/responses/success.ts", {
        "./types": { ResponseMessages: { SUCCESS: "Success", NO_DATA: "No Data" } }
    });
    const tmpFile = path.join(os.tmpdir(), `bb-range-test-${Date.now()}.bin`);
    fs.writeFileSync(tmpFile, "0123456789");

    try {
        const fullCtx = makeMockCtx();
        new FileStream(fullCtx, tmpFile, "video/mp4").send();
        assert.equal(fullCtx.status, 200);
        assert.equal(fullCtx._headers["accept-ranges"], "bytes");
        assert.equal(fullCtx._headers["content-length"], "10");
        assert.equal(await readStream(fullCtx.body), "0123456789");

        const partialCtx = makeMockCtx({ range: "bytes=2-5" });
        new FileStream(partialCtx, tmpFile, "video/mp4").send();
        assert.equal(partialCtx.status, 206);
        assert.equal(partialCtx._headers["accept-ranges"], "bytes");
        assert.equal(partialCtx._headers["content-range"], "bytes 2-5/10");
        assert.equal(partialCtx._headers["content-length"], "4");
        assert.equal(await readStream(partialCtx.body), "2345");

        const openCtx = makeMockCtx({ range: "bytes=6-" });
        new FileStream(openCtx, tmpFile, "video/mp4").send();
        assert.equal(openCtx.status, 206);
        assert.equal(openCtx._headers["content-range"], "bytes 6-9/10");
        assert.equal(await readStream(openCtx.body), "6789");

        const suffixCtx = makeMockCtx({ range: "bytes=-3" });
        new FileStream(suffixCtx, tmpFile, "video/mp4").send();
        assert.equal(suffixCtx.status, 206);
        assert.equal(suffixCtx._headers["content-range"], "bytes 7-9/10");
        assert.equal(await readStream(suffixCtx.body), "789");

        const badCtx = makeMockCtx({ range: "bytes=20-30" });
        new FileStream(badCtx, tmpFile, "video/mp4").send();
        assert.equal(badCtx.status, 416);
        assert.equal(badCtx._headers["content-range"], "bytes */10");
        assert.equal(badCtx._headers["content-length"], "0");
    } finally {
        fs.unlinkSync(tmpFile);
    }
});

test("convertAudio preserves audio/mp3 default and serves audio/mp4 for format=m4a", async () => {
    const convertDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-audio-test-"));
    try {
        const { convertAudio } = loadTsModule("src/server/databases/imessage/helpers/utils.ts", {
            electron: { nativeImage: {} },
            "@server": { Server: () => ({ log: () => {} }) },
            "@server/fileSystem": {
                FileSystem: {
                    convertDir,
                    toPathComponent: s => s,
                    getRealPath: p => p,
                    convertCafToMp3: async () => {}
                }
            },
            "@server/helpers/utils": {
                isEmpty: v => !v,
                isNotEmpty: v => Boolean(v)
            },
            "../entity/Attachment": {},
            "./constants": { handledImageMimes: [] },
            "./imageConversion": { getConvertedImageName: () => "", getImageConversion: () => null },
            "node-typedstream": { NSAttributedString: {}, Unarchiver: {} }
        });

        const androidAtt = {
            guid: "g1",
            transferName: "memo.caf",
            uti: "com.apple.coreaudio-format",
            getMimeType: () => "audio/x-caf"
        };
        const mp3Path = await convertAudio(androidAtt, { dryRun: true });
        assert.equal(mp3Path.endsWith(".mp3"), true);
        assert.equal(androidAtt.mimeType, "audio/mp3");

        const webAtt = {
            guid: "g2",
            transferName: "memo.caf",
            uti: "com.apple.coreaudio-format",
            getMimeType: () => "audio/x-caf"
        };
        const m4aPath = await convertAudio(webAtt, { dryRun: true, format: "m4a" });
        assert.equal(m4aPath.endsWith(".m4a"), true);
        assert.equal(webAtt.mimeType, "audio/mp4");
    } finally {
        fs.rmSync(convertDir, { recursive: true, force: true });
    }
});

test("HttpService configures Socket.IO CORS and Koa CORP/Expose-Headers middleware", async () => {
    const noop = () => {};
    class FakeRouter {
        routes() {
            return async (_, next) => next();
        }
        allowedMethods() {
            return async (_, next) => next();
        }
    }
    const { HttpService } = loadTsModule("src/server/api/http/index.ts", {
        "@server": () => ({ log: noop }),
        "@server/helpers/utils": { isNotEmpty: Boolean, onlyAlphaNumeric: s => s },
        "@server/eventCache": { EventCache: class {} },
        "@server/services/certificateService": { CertificateService: {} },
        "./api/v1/httpRoutes": { HttpRoutes: { createRoutes: noop } },
        "./api/v1/socketRoutes": { SocketRoutes: {} },
        "./api/v1/middleware/errorMiddleware": { ErrorMiddleware: async (_, next) => next() },
        "./api/v1/responses": { createServerErrorResponse: noop },
        "./passwordAuth": { checkServerPassword: noop, getSocketPassword: noop },
        "@server/events": { HELLO_WORLD: "hello" },
        "../../lib/ScheduledService": { ScheduledService: class {} },
        "../../lib/logging/Loggable": { Loggable: class {} },
        "@server/databases/server/constants": { ProxyServices: {} },
        "@server/lib/ProcessSpawner": { ProcessSpawner: {} },
        "./authThrottle": { AuthThrottle: class {}, resolveClientAddress: noop },
        "koa-router": FakeRouter
    });

    const svc = new HttpService();
    assert.deepEqual(svc.socketOpts.cors, { origin: "*", methods: ["GET", "POST"] });

    const middlewares = [];
    svc.koaApp = { use(fn) { middlewares.push(fn); return this; }, proxy: false };
    svc.configureKoa();

    const ctx = makeMockCtx();
    // Run the CORP / Access-Control-Expose-Headers middleware (index 1, right after koaCors)
    await middlewares[1](ctx, async () => {});
    assert.equal(ctx._headers["cross-origin-resource-policy"], "cross-origin");
    assert.equal(ctx._headers["access-control-expose-headers"], "Content-Length, Content-Range, Accept-Ranges");
});
