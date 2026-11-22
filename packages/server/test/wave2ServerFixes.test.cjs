const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const babel = require("@babel/core");

const loadTypeScriptModule = (modulePath, overrides = {}) => {
    const transformed = babel.transformFileSync(modulePath, {
        presets: [
            [require.resolve("@babel/preset-env"), { targets: { node: "20" }, modules: "commonjs" }],
            require.resolve("@babel/preset-typescript")
        ]
    });
    const loadedModule = { exports: {} };
    const loadModule = new Function("module", "exports", "require", "__dirname", "__filename", transformed.code);
    const customRequire = request => overrides[request] ?? require(request);
    loadModule(loadedModule, loadedModule.exports, customRequire, path.dirname(modulePath), modulePath);
    return loadedModule.exports;
};

const srcRoot = path.join(__dirname, "../src/server");

test("findMyIcons blocks redirects to disallowed hosts and follows allowed hosts", async () => {
    const findMyIcons = loadTypeScriptModule(path.join(srcRoot, "api/lib/findmy/findMyIcons.ts"));
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

    // 1. Disallowed redirect target must be rejected
    findMyIcons.clearFindMyIconCacheForTest();
    const evilCalls = [];
    const blockedRes = await findMyIcons.resolveFindMyDeviceIconBytes(
        { id: "dev-1", iconUrl: "https://statici.icloud.com/a.png" },
        async (url, init) => {
            evilCalls.push({ url, redirect: init?.redirect });
            if (url === "https://statici.icloud.com/a.png") {
                return {
                    ok: false,
                    status: 302,
                    headers: new Map([["location", "https://evil.example.com/ssrf.png"]])
                };
            }
            throw new Error(`Unexpected fetch to ${url}`);
        }
    );
    assert.equal(blockedRes, null);
    assert.equal(evilCalls.length, 1);
    assert.equal(evilCalls[0].redirect, "manual");

    // 2. Allowed redirect target must succeed
    findMyIcons.clearFindMyIconCacheForTest();
    const okCalls = [];
    const startUrl = `https://statici.icloud.com/start-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const cacheHash = crypto.createHash("sha256").update(startUrl).digest("hex");
    const diskCacheDir = path.join(os.tmpdir(), "bb-findmy-icons");
    try {
        const allowedRes = await findMyIcons.resolveFindMyDeviceIconBytes(
            { id: "dev-2", iconUrl: startUrl },
            async (url, init) => {
                okCalls.push({ url, redirect: init?.redirect });
                if (url === startUrl) {
                    return {
                        ok: false,
                        status: 302,
                        headers: new Map([["location", "https://statici.icloud.com/final.png"]])
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    url,
                    headers: new Map([["content-type", "image/png"]]),
                    arrayBuffer: async () => pngBytes
                };
            }
        );
        assert.ok(allowedRes);
        assert.equal(allowedRes.contentType, "image/png");
        assert.equal(okCalls.length, 2);
    } finally {
        fs.rmSync(path.join(diskCacheDir, `${cacheHash}.bin`), { force: true });
        fs.rmSync(path.join(diskCacheDir, `${cacheHash}.json`), { force: true });
    }
});

test("CloudflareService.connect returns awaited URL for concurrent callers", async () => {
    const { CloudflareService } = loadTypeScriptModule(
        path.join(srcRoot, "services/proxyServices/cloudflareService/index.ts"),
        {
            "@server/managers/cloudflareManager": { CloudflareManager: class {} },
            "../proxy": {
                Proxy: class {
                    log = { debug: () => {}, info: () => {} };
                    url = null;
                }
            }
        }
    );

    const svc = new CloudflareService();
    let resolveConnect;
    svc._connect = () =>
        new Promise(resolve => {
            resolveConnect = resolve;
        });

    const p1 = svc.connect();
    const p2 = svc.connect();
    resolveConnect("https://tunnel.trycloudflare.com");

    const [u1, u2] = await Promise.all([p1, p2]);
    assert.equal(u1, "https://tunnel.trycloudflare.com");
    assert.equal(u2, "https://tunnel.trycloudflare.com");
});

test("SettingsRouter and ThemeRouter reject non-string query.name", async () => {
    class BadRequestError extends Error {
        constructor(opts) {
            super(opts?.message ?? "Bad Request");
        }
    }
    const stubDeps = {
        "@server/helpers/utils": { isNotEmpty: v => Boolean(v) },
        "@server/api/interfaces/backupsInterface": {
            BackupsInterface: {
                getSettingsByName: async () => null,
                getAllSettings: async () => [],
                getThemeByName: async () => null,
                getAllThemes: async () => []
            }
        },
        "../responses/errors": { BadRequest: BadRequestError },
        "../responses/success": {
            Success: class {
                constructor(ctx, body) {
                    this.ctx = ctx;
                    this.body = body;
                }
                send() {
                    return this.body;
                }
            }
        }
    };

    const { SettingsRouter } = loadTypeScriptModule(
        path.join(srcRoot, "api/http/api/v1/routers/settingsRouter.ts"),
        stubDeps
    );
    const { ThemeRouter } = loadTypeScriptModule(
        path.join(srcRoot, "api/http/api/v1/routers/themeRouter.ts"),
        stubDeps
    );

    await assert.rejects(() => SettingsRouter.get({ query: { name: ["a", "b"] } }), BadRequestError);
    await assert.rejects(() => ThemeRouter.get({ query: { name: ["a", "b"] } }), BadRequestError);
});

test("WebhookRouter.get tolerates malformed webhook.events JSON", async () => {
    const { WebhookRouter } = loadTypeScriptModule(
        path.join(srcRoot, "api/http/api/v1/routers/webhookRouter.ts"),
        {
            "@server": {
                Server: () => ({
                    repo: {
                        getWebhooks: async () => [
                            { id: 1, url: "https://example.com/hook", events: "{bad-json" }
                        ]
                    }
                })
            },
            "@server/helpers/utils": { isEmpty: v => !v || v.length === 0 },
            "../responses/success": {
                Success: class {
                    constructor(ctx, body) {
                        this.body = body;
                    }
                    send() {
                        return this.body;
                    }
                }
            },
            "../responses/errors": { NotFound: Error }
        }
    );

    const res = await WebhookRouter.get({ request: { query: {} } });
    assert.deepEqual(res.data[0].events, []);
});
