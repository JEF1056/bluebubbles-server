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
const managerRef = { current: null };

const { FaceTimeSession, FaceTimeSessionStatus } = loadTypeScriptModule(
    path.join(srcRoot, "api/lib/facetime/FaceTimeSession.ts"),
    {
        "@server": {
            Server: () => ({
                log: () => {},
                emitMessage: () => {},
                privateApi: { facetime: {} }
            })
        },
        "./FacetimeSessionManager": { FaceTimeSessionManager: () => managerRef.current },
        "@server/databases/notificationCenter/NotiicationCenterRepository": { NotificationCenterDB: class {} },
        "@server/databases/imessage/helpers/dateUtil": { convertDateToCocoaTime: d => d },
        "@server/helpers/utils": { waitMs: async () => {} },
        "@server/types": {},
        uuid: { v4: () => "generated-uuid" },
        "../../../lib/ScheduledService": { ScheduledService: class {} },
        "../../../lib/logging/Loggable": {
            Loggable: class {
                log() {}
                emit() {}
            }
        }
    }
);

const { FaceTimeSessionManager } = loadTypeScriptModule(
    path.join(srcRoot, "api/lib/facetime/FacetimeSessionManager.ts"),
    {
        "@server": {
            Server: () => ({
                log: () => {},
                emitMessage: () => {}
            })
        },
        "@server/events": { FT_CALL_STATUS_CHANGED: "ft-call-status-changed" },
        "@server/helpers/utils": { isNotEmpty: v => v !== null && v !== undefined && String(v).length > 0 },
        "./FaceTimeSession": { FaceTimeSession, FaceTimeSessionStatus }
    }
);

test("FaceTimeSession & FaceTimeSessionManager alias uniqueProxyIdentifier across late callUUID assignment", () => {
    const mgr = FaceTimeSessionManager();
    mgr.sessions = [];
    managerRef.current = mgr;
    const initial = FaceTimeSession.fromEvent({
        call_status: 3,
        call_uuid: null,
        unique_proxy_identifier: "UPI-1111",
        is_outgoing: true,
        is_video: false
    });
    assert.equal(initial.callUuid, "UPI-1111");
    assert.equal(initial.uniqueProxyIdentifier, "UPI-1111");
    assert.equal(mgr.addSession(initial), true);
    assert.equal(mgr.findSession("UPI-1111"), initial);

    // Later callservicesd event populates a distinct call_uuid while keeping unique_proxy_identifier.
    const updated = FaceTimeSession.fromEvent({
        call_status: 1,
        call_uuid: "REAL-UUID-2222",
        unique_proxy_identifier: "UPI-1111",
        is_outgoing: true,
        is_video: false
    });
    const existing = mgr.findSession(updated.callUuid, updated.uniqueProxyIdentifier);
    assert.equal(existing, initial);
    existing.update(updated);

    // Canonical callUuid stays stable for clients & audio bridges, while both IDs resolve to the session.
    assert.equal(existing.callUuid, "UPI-1111");
    assert.equal(mgr.findSession("UPI-1111"), initial);
    assert.equal(mgr.findSession("REAL-UUID-2222"), initial);
    assert.equal(mgr.addSession(updated), false);
});

test("FaceTimeInterface.startCall uses unique_proxy_identifier fallback and keeps session matched", async () => {
    const mgr = FaceTimeSessionManager();
    mgr.sessions = [];
    managerRef.current = mgr;
    const { FaceTimeInterface } = loadTypeScriptModule(
        path.join(srcRoot, "api/interfaces/facetimeInterface.ts"),
        {
            "@server": {
                Server: () => ({
                    log: () => {},
                    privateApi: {
                        facetime: {
                            startCall: async () => ({
                                data: {
                                    call_uuid: null,
                                    unique_proxy_identifier: "UPI-DIAL-3333",
                                    url: "https://facetime.apple.com/join#v=1&p=test"
                                }
                            })
                        }
                    }
                })
            },
            "../lib/facetime/FaceTimeSession": { FaceTimeSession, FaceTimeSessionStatus: { OUTGOING: 3, DISCONNECTED: 6 } },
            "../lib/facetime/FacetimeSessionManager": { FaceTimeSessionManager: () => mgr },
            "../lib/facetime/FaceTimeAudioBridge": { FaceTimeAudioBridge: () => ({ cleanupSession: () => {} }) },
            "@server/env": { isMinMonterey: true },
            "@server/helpers/utils": { checkPrivateApiStatus: () => {} }
        }
    );

    const res = await FaceTimeInterface.call({ addresses: ["+16266165776"], video: true, isTelephony: false });
    assert.equal(res.call.call_uuid, "UPI-DIAL-3333");
    assert.equal(res.session.uuid, "UPI-DIAL-3333");
    assert.equal(res.link?.url, "https://facetime.apple.com/join#v=1&p=test");
    const session = mgr.findSession("UPI-DIAL-3333");
    assert.ok(session);
    assert.equal(session.url, "https://facetime.apple.com/join#v=1&p=test");
});

test("PrivateApiFaceTimeStatusHandler merges late call_uuid update and cleans up audio bridge under all IDs", async () => {
    const mgr = FaceTimeSessionManager();
    mgr.sessions = [];
    managerRef.current = mgr;
    const cleaned = [];
    const { PrivateApiFaceTimeStatusHandler } = loadTypeScriptModule(
        path.join(srcRoot, "api/privateApi/eventHandlers/PrivateApiFaceTimeStatusHandler.ts"),
        {
            "@server": {
                Server: () => ({
                    log: () => {},
                    emitMessage: () => {},
                    repo: { getConfig: () => true },
                    iMessageRepo: {
                        getHandles: async () => []
                    }
                })
            },
            "@server/events": { INCOMING_FACETIME: "incoming-facetime" },
            "@server/helpers/utils": { slugifyAddress: a => a },
            "@server/api/serializers/HandleSerializer": { HandleSerializer: { serialize: async () => null } },
            "@server/api/lib/facetime/FaceTimeSession": {
                FaceTimeSession,
                FaceTimeSessionStatus
            },
            "@server/api/lib/facetime/FacetimeSessionManager": { FaceTimeSessionManager: () => mgr },
            "@server/api/lib/facetime/FaceTimeAudioBridge": {
                FaceTimeAudioBridge: {
                    getInstance: () => ({
                        cleanupSession: id => cleaned.push(id)
                    })
                }
            },
            "@server/lib/logging/Loggable": {
                Loggable: class {
                    log = { info() {}, debug() {}, warn() {}, error() {} };
                }
            },
            ".": {}
        }
    );

    const handler = new PrivateApiFaceTimeStatusHandler();
    await handler.handle({
        event: "ft-call-status-changed",
        data: {
            call_status: 3,
            call_uuid: null,
            unique_proxy_identifier: "UPI-4444",
            is_outgoing: true,
            is_video: false,
            handle: { value: "+16266165776" }
        }
    });
    assert.ok(mgr.findSession("UPI-4444"));

    await handler.handle({
        event: "ft-call-status-changed",
        data: {
            call_status: 1,
            call_uuid: "REAL-UUID-5555",
            unique_proxy_identifier: "UPI-4444",
            is_outgoing: true,
            is_video: false,
            handle: { value: "+16266165776" }
        }
    });
    assert.equal(mgr.sessions.length, 1);
    assert.equal(mgr.findSession("REAL-UUID-5555")?.callUuid, "UPI-4444");

    await handler.handle({
        event: "ft-call-status-changed",
        data: {
            call_status: 6,
            call_uuid: "REAL-UUID-5555",
            unique_proxy_identifier: "UPI-4444",
            is_outgoing: true,
            is_video: false,
            handle: { value: "+16266165776" }
        }
    });
    assert.deepEqual(cleaned.sort(), ["REAL-UUID-5555", "UPI-4444"]);
});
