const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
const authThrottle = loadTypeScriptModule(path.join(srcRoot, "api/http/authThrottle.ts"));
const constants = loadTypeScriptModule(path.join(srcRoot, "databases/server/constants.ts"));

const createHttpHarness = (initialConfig = {}) => {
    const config = {
        server_address: "https://bb.jessfan.com",
        lan_proof_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        ...initialConfig
    };
    const noop = () => {};
    class FakeRouter {
        routes() {
            return async (_, next) => next();
        }
        allowedMethods() {
            return async (_, next) => next();
        }
    }

    const httpMod = loadTypeScriptModule(path.join(srcRoot, "api/http/index.ts"), {
        "@server": {
            Server: () => ({
                log: noop,
                repo: { getConfig: key => config[key] }
            })
        },
        "@server/helpers/utils": { isNotEmpty: Boolean, onlyAlphaNumeric: s => s },
        "@server/eventCache": { EventCache: class {} },
        "@server/services/certificateService": { CertificateService: {} },
        "./api/v1/httpRoutes": { HttpRoutes: { createRoutes: noop } },
        "./api/v1/socketRoutes": { SocketRoutes: {} },
        "./api/v1/middleware/errorMiddleware": { ErrorMiddleware: async (_, next) => next() },
        "./api/v1/responses": { createServerErrorResponse: noop },
        "./passwordAuth": { checkServerPassword: () => "ok", getSocketPassword: q => q?.password ?? "ok" },
        "@server/events": { HELLO_WORLD: "hello" },
        "../../lib/ScheduledService": { ScheduledService: class {} },
        "../../lib/logging/Loggable": { Loggable: class {} },
        "@server/databases/server/constants": { ProxyServices: {} },
        "@server/lib/ProcessSpawner": { ProcessSpawner: {} },
        "./authThrottle": authThrottle,
        "koa-router": FakeRouter
    });

    const svc = new httpMod.HttpService();
    svc.authThrottle = new authThrottle.AuthThrottle();
    const middlewares = [];
    svc.koaApp = {
        use(fn) {
            middlewares.push(fn);
            return this;
        },
        proxy: false
    };
    svc.configureKoa();
    return { config, httpMod, svc, gateMiddleware: middlewares[0] };
};

const makeMockCtx = ({ method = "GET", path: reqPath = "/api/v1/ping", query = {}, headers = {}, remoteAddress = "192.168.1.50" } = {}) => {
    const normalized = {};
    for (const [k, v] of Object.entries(headers)) normalized[k.toLowerCase()] = v;
    const resHeaders = {};
    const varyHeaders = [];
    return {
        method,
        path: reqPath,
        query,
        status: 200,
        body: undefined,
        req: { socket: { remoteAddress } },
        get: name => normalized[name.toLowerCase()] ?? "",
        set: (name, value) => {
            resHeaders[name.toLowerCase()] = value;
        },
        vary: name => {
            varyHeaders.push(name);
        },
        redirect: url => {
            resHeaders.location = url;
        },
        _resHeaders: resHeaders,
        _varyHeaders: varyHeaders
    };
};

test("S1: resolveClientAddress trusts X-Forwarded-For only from loopback peers", () => {
    assert.equal(authThrottle.resolveClientAddress("192.168.1.50", "1.2.3.4"), "192.168.1.50");
    assert.equal(authThrottle.resolveClientAddress("10.0.0.12", "1.2.3.4"), "10.0.0.12");
    assert.equal(authThrottle.resolveClientAddress("172.16.0.5", "1.2.3.4"), "172.16.0.5");
    assert.equal(authThrottle.resolveClientAddress("100.64.0.5", "1.2.3.4"), "100.64.0.5");
    assert.equal(authThrottle.resolveClientAddress("fd7a:115c:a1e0::1", "1.2.3.4"), "fd7a:115c:a1e0::1");

    assert.equal(authThrottle.resolveClientAddress("127.0.0.1", "9.9.9.9, 203.0.113.7"), "203.0.113.7");
    assert.equal(authThrottle.resolveClientAddress("::1", "9.9.9.9, 203.0.113.7"), "203.0.113.7");
    assert.equal(authThrottle.resolveClientAddress("::ffff:127.0.0.1", "203.0.113.7, 127.0.0.1"), "203.0.113.7");

    assert.equal(authThrottle.isTrustedProxy("127.0.0.1"), true);
    assert.equal(authThrottle.isTrustedProxy("::1"), true);
    assert.equal(authThrottle.isTrustedProxy("192.168.1.50"), false);
    assert.equal(authThrottle.isTrustedProxy("100.64.0.5"), false);
});

test("S1: isDirectLanPeer classifies RFC1918 and Tailscale ranges while rejecting loopback and WAN", () => {
    for (const addr of [
        "10.0.0.1",
        "172.16.0.1",
        "172.31.255.254",
        "192.168.1.50",
        "100.64.0.1",
        "100.127.255.254",
        "fd7a:115c:a1e0::1",
        "fe80::1"
    ]) {
        assert.equal(authThrottle.isDirectLanPeer(addr), true, `expected direct LAN/Tailscale for ${addr}`);
    }
    for (const addr of ["127.0.0.1", "::1", "100.63.255.254", "100.128.0.1", "172.15.255.255", "172.32.0.1", "203.0.113.7", "2001:db8::1"]) {
        assert.equal(authThrottle.isDirectLanPeer(addr), false, `expected non-LAN for ${addr}`);
    }
});

test("S2: isAllowedHost allows LAN/Tailscale/configured/env hosts and blocks rebinding hosts", () => {
    const serverAddr = "https://bb.jessfan.com";
    for (const host of [
        undefined,
        "192.168.1.50:1234",
        "[::1]:1234",
        "[fd7a:115c:a1e0::1]:1234",
        "localhost:1234",
        "mac-mini",
        "mac-mini:1234",
        "mac.local",
        "mac.local:1234",
        "x.y.ts.net",
        "bb.jessfan.com",
        "bb.jessfan.com:443"
    ]) {
        assert.equal(authThrottle.isAllowedHost(host, serverAddr), true, `expected allowed host: ${host}`);
    }

    for (const host of [
        "evil.example:1234",
        "127.0.0.1.evil.example",
        "ts.net.evil.example",
        "evil.example@localhost",
        "localhost/foo"
    ]) {
        assert.equal(authThrottle.isAllowedHost(host, serverAddr), false, `expected rejected host: ${host}`);
    }

    const prevEnv = process.env.BB_ALLOWED_HOSTS;
    try {
        process.env.BB_ALLOWED_HOSTS = "custom.example.org, second.example.net";
        assert.equal(authThrottle.isAllowedHost("custom.example.org:8443", serverAddr), true);
        assert.equal(authThrottle.isAllowedHost("evil.example.org", serverAddr), false);
    } finally {
        if (prevEnv === undefined) delete process.env.BB_ALLOWED_HOSTS;
        else process.env.BB_ALLOWED_HOSTS = prevEnv;
    }
});

test("S2: Koa gate and Socket.IO allowRequest enforce Host and Origin", async () => {
    const { httpMod, svc, gateMiddleware } = createHttpHarness();

    assert.equal(httpMod.isAllowedCorsOrigin("https://chat.jessfan.com"), true);
    assert.equal(httpMod.isAllowedCorsOrigin("http://localhost:3000"), true);
    assert.equal(httpMod.isAllowedCorsOrigin("https://evil.example"), false);

    // HTTP Host check rejects rebinding host before next()
    let nextCalled = false;
    const badHostCtx = makeMockCtx({ headers: { host: "evil.example:1234" } });
    await gateMiddleware(badHostCtx, async () => {
        nextCalled = true;
    });
    assert.equal(badHostCtx.status, 403);
    assert.equal(nextCalled, false);

    // HTTP Host check allows configured hostname
    nextCalled = false;
    const goodHostCtx = makeMockCtx({ headers: { host: "bb.jessfan.com" } });
    await gateMiddleware(goodHostCtx, async () => {
        nextCalled = true;
    });
    assert.equal(nextCalled, true);

    // Socket.IO allowRequest: rejects bad Host
    await new Promise(resolve => {
        svc.socketOpts.allowRequest(
            { headers: { host: "evil.example:1234" }, socket: { remoteAddress: "127.0.0.1" }, url: "/socket.io/?password=ok" },
            (err, ok) => {
                assert.equal(err, "Forbidden");
                assert.equal(ok, false);
                resolve();
            }
        );
    });

    // Socket.IO allowRequest: rejects bad Origin
    await new Promise(resolve => {
        svc.socketOpts.allowRequest(
            {
                headers: { host: "bb.jessfan.com", origin: "https://evil.example" },
                socket: { remoteAddress: "127.0.0.1" },
                url: "/socket.io/?password=ok"
            },
            (err, ok) => {
                assert.equal(err, "Forbidden");
                assert.equal(ok, false);
                resolve();
            }
        );
    });

    // Socket.IO allowRequest: allows native client (no Origin) and allowed Origin
    for (const headers of [
        { host: "192.168.1.50:1234" },
        { host: "bb.jessfan.com", origin: "https://chat.jessfan.com" }
    ]) {
        await new Promise(resolve => {
            svc.socketOpts.allowRequest(
                { headers, socket: { remoteAddress: "192.168.1.50" }, url: "/socket.io/?password=ok" },
                (err, ok) => {
                    assert.equal(err, null);
                    assert.equal(ok, true);
                    resolve();
                }
            );
        });
    }
});

test("S3: lanProof, DEFAULT_DB_ITEMS.lan_proof_key, GeneralInterface metadata, and GET /api/v1/lan-proof", async () => {
    const generatedKey = constants.DEFAULT_DB_ITEMS.lan_proof_key();
    assert.match(generatedKey, /^[0-9a-f]{64}$/);
    assert.notEqual(generatedKey, constants.DEFAULT_DB_ITEMS.lan_proof_key());

    const nonce = "00112233445566778899aabbccddeeff";
    const expected = crypto.createHmac("sha256", generatedKey).update(nonce).digest("hex");

    assert.equal(authThrottle.lanProof(generatedKey, nonce, "127.0.0.1"), null);
    assert.equal(authThrottle.lanProof(generatedKey, nonce, "::1"), null);
    assert.equal(authThrottle.lanProof(generatedKey, nonce, "203.0.113.7"), null);
    assert.equal(authThrottle.lanProof(generatedKey, "bad-nonce", "192.168.1.50"), null);
    assert.equal(authThrottle.lanProof(generatedKey, nonce.toUpperCase(), "192.168.1.50"), null);
    assert.equal(authThrottle.lanProof(generatedKey, nonce, "192.168.1.50"), expected);
    assert.equal(authThrottle.lanProof(generatedKey, nonce, "100.64.0.5"), expected);
    assert.equal(authThrottle.lanProof(generatedKey, nonce, "fd7a:115c:a1e0::1"), expected);
    assert.equal(authThrottle.lanProof(generatedKey, nonce, "::ffff:192.168.1.50"), expected);

    // Authenticated metadata includes lan_proof_key
    const generalMod = loadTypeScriptModule(path.join(srcRoot, "api/interfaces/generalInterface.ts"), {
        electron: { app: { getVersion: () => "1.9.9" } },
        "macos-version": () => "15.0",
        "@server": {
            Server: () => ({
                computerIdentifier: "mac-test",
                repo: {
                    getConfig: key => (key === "lan_proof_key" ? generatedKey : key === "enable_private_api" ? true : "cloudflare")
                },
                privateApi: { helper: {} },
                iMessageRepo: { getiMessageAccount: async () => "test@example.com" }
            })
        },
        "@server/types": {},
        "@server/databases/server/entity": {},
        "@server/api/http/types": {},
        "@server/fileSystem": {
            FileSystem: {
                getIcloudAccount: async () => "test@icloud.com",
                getTimeSync: async () => 0,
                getLocalIps: () => ["192.168.1.10"]
            }
        },
        "@server/env": { isMinMonterey: true }
    });
    const metadata = await generalMod.GeneralInterface.getServerMetadata();
    assert.equal(metadata.lan_proof_key, generatedKey);

    // HTTP GET /api/v1/lan-proof behavior
    const { gateMiddleware } = createHttpHarness({ lan_proof_key: generatedKey });

    // Direct LAN peer + valid nonce -> 200 HMAC proof
    const lanCtx = makeMockCtx({
        path: "/api/v1/lan-proof",
        query: { nonce },
        headers: { host: "192.168.1.10:1234" },
        remoteAddress: "192.168.1.50"
    });
    await gateMiddleware(lanCtx, async () => {
        throw new Error("should not call next()");
    });
    assert.equal(lanCtx.status, 200);
    assert.equal(lanCtx._resHeaders["cache-control"], "no-store");
    assert.deepEqual(lanCtx.body, { status: 200, message: "Success", data: { proof: expected } });

    // Direct Tailscale IPv4 & IPv6 peers -> 200
    for (const remoteAddress of ["100.64.0.5", "fd7a:115c:a1e0::1"]) {
        const tsCtx = makeMockCtx({
            path: "/api/v1/lan-proof",
            query: { nonce },
            headers: { host: "mac-mini:1234" },
            remoteAddress
        });
        await gateMiddleware(tsCtx, async () => {});
        assert.equal(tsCtx.status, 200);
        assert.equal(tsCtx.body.data.proof, expected);
    }

    // Loopback / tunnel peer (even with spoofed X-Forwarded-For!) -> 403
    const loopbackCtx = makeMockCtx({
        path: "/api/v1/lan-proof",
        query: { nonce },
        headers: { host: "bb.jessfan.com", "x-forwarded-for": "192.168.1.50" },
        remoteAddress: "127.0.0.1"
    });
    await gateMiddleware(loopbackCtx, async () => {});
    assert.equal(loopbackCtx.status, 403);

    // WAN peer -> 403
    const wanCtx = makeMockCtx({
        path: "/api/v1/lan-proof",
        query: { nonce },
        headers: { host: "bb.jessfan.com" },
        remoteAddress: "203.0.113.7"
    });
    await gateMiddleware(wanCtx, async () => {});
    assert.equal(wanCtx.status, 403);

    // Direct LAN peer with invalid nonce -> 400
    for (const badQuery of [{}, { nonce: "too-short" }, { nonce: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }, { nonce: [nonce, nonce] }]) {
        const badNonceCtx = makeMockCtx({
            path: "/api/v1/lan-proof",
            query: badQuery,
            headers: { host: "192.168.1.10:1234" },
            remoteAddress: "192.168.1.50"
        });
        await gateMiddleware(badNonceCtx, async () => {});
        assert.equal(badNonceCtx.status, 400);
    }
});
