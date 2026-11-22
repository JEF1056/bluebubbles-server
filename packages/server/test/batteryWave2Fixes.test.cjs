const assert = require("node:assert/strict");
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

test("ScheduledService calls unref() on its interval handle and clears on stop()", () => {
    const { ScheduledService } = loadTypeScriptModule(path.join(srcRoot, "lib/ScheduledService.ts"));
    let unrefCalled = false;
    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;
    let cleared = false;
    global.setInterval = (fn, ms) => {
        return {
            unref() {
                unrefCalled = true;
            }
        };
    };
    global.clearInterval = () => {
        cleared = true;
    };
    try {
        const svc = new ScheduledService(() => {}, 1000);
        assert.equal(unrefCalled, true);
        svc.stop();
        assert.equal(cleared, true);
    } finally {
        global.setInterval = origSetInterval;
        global.clearInterval = origClearInterval;
    }
});

test("GoogleFindFcmClient.ensureReady() waits via promise/waiter and wakes immediately on stop()", async () => {
    const { GoogleFindFcmClient } = loadTypeScriptModule(path.join(srcRoot, "api/lib/gfind/gfindFcm.ts"), {
        "@server": { Server: () => ({}) },
        "./gfindCrypto": { hkdfSha256: () => Buffer.alloc(0) },
        "./gfindAuth": { GoogleFindAuthManager: class {} },
        "./gfindProto": {
            decodeDeviceUpdate: () => ({}),
            decodeMcsDataMessageStanza: () => ({}),
            decodeMcsLoginResponse: () => ({}),
            encodeMcsHeartbeatAck: () => Buffer.alloc(0),
            encodeMcsHeartbeatPing: () => Buffer.alloc(0),
            encodeMcsLoginRequest: () => Buffer.alloc(0),
            encodeMcsSelectiveAck: () => Buffer.alloc(0),
            MCS_TAG_CLOSE: 0,
            MCS_TAG_DATA_MESSAGE_STANZA: 8,
            MCS_TAG_HEARTBEAT_PING: 0,
            MCS_TAG_HEARTBEAT_ACK: 1,
            MCS_TAG_LOGIN_RESPONSE: 3,
            MCS_TAG_STREAM_ERROR_STANZA: 4,
            MCS_VERSION: 41,
            McsFrameReader: class {
                push() {
                    return [];
                }
            }
        }
    });
    const fakeAuth = {
        getState: () => ({ fcmToken: "tok-123", persistentIds: [] }),
        ensureCheckin: async () => ({ androidId: 1n, securityToken: 2n }),
        getOrCreateFcmKeys: () => ({})
    };
    const fcm = new GoogleFindFcmClient(fakeAuth, {
        connectTls: () => ({
            once: () => {},
            on: () => {},
            write: () => {},
            removeAllListeners: () => {},
            destroy: () => {}
        })
    });
    const startMs = Date.now();
    const readyPromise = fcm.ensureReady(5000);
    setTimeout(() => fcm.stop(), 15);
    const token = await readyPromise;
    assert.equal(token, "tok-123");
    assert.ok(Date.now() - startMs < 500, "ensureReady should wake immediately on stop() instead of waiting timeout");
});

test("UTagService.start() gates refresh on hasActiveClients()", async () => {
    const { UTagService } = loadTypeScriptModule(path.join(srcRoot, "api/lib/utag/utagService.ts"), {
        "@server": { Server: () => ({}) },
        "@server/events": { NEW_FINDMY_DEVICE: "new-findmy-device" },
        "@server/api/lib/findmy/findMyForkHelpers": { getChangedFindMyDevices: () => [] },
        "@server/api/lib/findmy/trackerCommon": {
            readEncryptedJson: () => ({ deviceId: "d1", tokens: { iotToken: "tok" } }),
            writeEncryptedJson: () => {},
            deleteEncryptedJson: () => false,
            reverseGeocode: async () => null
        },
        "./utagCrypto": {
            buildSamsungSignInUrl: () => "",
            decryptSamsungAuthRedirect: () => ({}),
            generateDeviceId: () => "dev-1",
            generateState: () => "state-1",
            resolveGeoCoordinates: () => null,
            unwrapE2ePrivateKey: () => Buffer.alloc(0)
        },
        "./utagMapper": {
            buildUTagBleSpec: () => ({}),
            mapSmartTagToFindMyDevice: () => ({})
        },
        "./utagClient": {
            UTagClient: class {
                setTokens() {}
                getTokens() {
                    return { iotToken: "tok" };
                }
            },
            UTagHttpError: Error
        }
    });
    let active = false;
    let refreshCalls = 0;
    const svc = new UTagService({
        pollIntervalMs: 60_000,
        hasActiveClients: () => active
    });
    svc.refreshDevices = async () => {
        refreshCalls += 1;
        return [];
    };
    svc.start();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(refreshCalls, 0);
    svc.stop();

    active = true;
    svc.start();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(refreshCalls, 1);
    svc.stop();
});

test("Proxy.restart() deduplicates concurrent calls and NgrokService.disconnect() clears refreshTimer", async () => {
    const { Proxy } = loadTypeScriptModule(path.join(srcRoot, "services/proxyServices/proxy.ts"), {
        "@server": { Server: () => ({ repo: { getConfig: () => "ngrok", setConfig: async () => {} } }) },
        "@server/helpers/utils": { onlyAlphaNumeric: s => String(s).toLowerCase(), waitMs: async () => {} },
        "@server/lib/logging/Loggable": {
            Loggable: class {
                log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
            }
        }
    });
    let restartHandlerCalls = 0;
    class TestProxy extends Proxy {
        async connect() {
            return "https://example.ngrok.io";
        }
        async disconnect() {
            if (this.refreshTimer) {
                clearTimeout(this.refreshTimer);
                this.refreshTimer = null;
            }
        }
        async restartHandler() {
            restartHandlerCalls += 1;
            await new Promise(r => setTimeout(r, 20));
            return true;
        }
    }
    const p = new TestProxy({ name: "Ngrok", autoRefresh: true, refreshTimerMs: 60_000 });
    const [r1, r2] = await Promise.all([p.restart(), p.restart()]);
    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(restartHandlerCalls, 1);

    p.refreshTimer = setTimeout(() => {}, 60_000);
    await p.disconnect();
    assert.equal(p.refreshTimer, null);
});

test("MessageRepository.getMediaCounts queries attachment.created_date with CoreData seconds", async () => {
    let capturedSql = "";
    let capturedParams = [];
    const { MessageRepository } = loadTypeScriptModule(path.join(srcRoot, "databases/imessage/index.ts"), {
        typeorm: { Brackets: class {}, DataSource: class {}, SelectQueryBuilder: class {} },
        "@server/databases/imessage/types": {},
        "@server/databases/imessage/helpers/dateUtil": {
            convertDateTo2001Time: () => 999_000_000_000,
            convertDateToCocoaTime: d => Math.floor((d.getTime() - Date.UTC(2001, 0, 1)) / 1000)
        },
        "@server/databases/imessage/helpers/chatGuid": { getChatGuidCandidates: () => [] },
        "@server/databases/imessage/entity/Chat": { Chat: class {} },
        "@server/databases/imessage/entity/Handle": { Handle: class {} },
        "@server/databases/imessage/entity/Message": { Message: class {} },
        "@server/databases/imessage/entity/Attachment": { Attachment: class {} },
        "@server/databases/imessage/helpers/whereClauseValidator": { buildQueryableColumns: () => ({}) },
        "@server/helpers/utils": { isNotEmpty: v => Boolean(v) },
        "@server/env": { isMinHighSierra: () => true, isMinVentura: () => true },
        "@server/lib/logging/Loggable": { Loggable: class {} }
    });
    const repo = new MessageRepository();
    repo.db = {
        getRepository: () => ({
            query: async (sql, params) => {
                capturedSql = sql;
                capturedParams = params ?? [];
                return [{ media_count: 42 }];
            }
        })
    };
    const after = new Date("2026-01-01T00:00:00Z");
    const res = await repo.getMediaCounts({ mediaType: "image", after });
    assert.deepEqual(res, [{ media_count: 42 }]);
    assert.match(capturedSql, /attachment\.created_date\s*>=\s*\?/);
    assert.doesNotMatch(capturedSql, /attachment\.date\b/);
    assert.doesNotMatch(capturedSql, /GROUP\s+BY/i);
    assert.equal(capturedParams[0], Math.floor((after.getTime() - Date.UTC(2001, 0, 1)) / 1000));
});
