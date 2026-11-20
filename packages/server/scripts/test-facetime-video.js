const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const path = require("node:path");
const test = require("node:test");
const babel = require("@babel/core");

const serverSrc = path.join(__dirname, "../src/server");

const loadTs = (relPath, overrides = {}) => {
    const absPath = path.join(serverSrc, relPath);
    const transformed = babel.transformFileSync(absPath, {
        presets: [
            [require.resolve("@babel/preset-env"), { targets: { node: "20" }, modules: "commonjs" }],
            require.resolve("@babel/preset-typescript")
        ]
    });
    const mod = { exports: {} };
    const fn = new Function("module", "exports", "require", transformed.code);
    const customRequire = req => (Object.prototype.hasOwnProperty.call(overrides, req) ? overrides[req] : require(req));
    fn(mod, mod.exports, customRequire);
    return mod.exports;
};

const createHarness = () => {
    const calls = {
        admitAnyPendingMember: 0,
        admitParticipant: [],
        leaveCall: [],
        getRecords: 0,
        getHandles: 0,
        emitMessage: [],
        cleanupSession: [],
        sendApiMessage: [],
        playDtmf: []
    };

    const state = {
        facetimeCalling: false,
        admitAnyResult: { data: { admittedCount: 0 } },
        admitAnyError: null,
        notifications: [],
        playDtmfResult: { data: { played: false, fallback: "bridge" } }
    };

    class StubLoggable extends EventEmitter {
        get log() {
            return { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
        }
    }

    const { ScheduledService } = loadTs("lib/ScheduledService.ts");
    const TransactionType = { OTHER: "OTHER" };
    class FakeTransactionPromise {
        constructor(type) {
            this.type = type;
        }
    }

    const stubFacetimeApi = {
        admitAnyPendingMember: async () => {
            calls.admitAnyPendingMember += 1;
            if (state.admitAnyError) throw state.admitAnyError;
            return state.admitAnyResult;
        },
        admitParticipant: async (conversationUuid, handleUuid) => {
            calls.admitParticipant.push({ conversationUuid, handleUuid });
            return { data: { admittedParticipants: [handleUuid] } };
        },
        leaveCall: async callUuid => {
            calls.leaveCall.push(callUuid);
            return {};
        },
        playDtmf: async (callUuid, digit) => {
            calls.playDtmf.push({ callUuid, digit });
            return state.playDtmfResult;
        }
    };

    const stubServer = {
        repo: {
            getConfig: key => (key === "facetime_calling" ? state.facetimeCalling : null)
        },
        privateApi: { facetime: stubFacetimeApi },
        iMessageRepo: {
            getHandles: async () => {
                calls.getHandles += 1;
                return [[], 0];
            }
        },
        emitMessage: (type, data) => calls.emitMessage.push({ type, data })
    };

    const helperUtils = {
        waitMs: ms => new Promise(r => setTimeout(r, ms)),
        slugifyAddress: v => (v ? String(v).toLowerCase().trim() : v),
        isEmpty: v => v == null || v.length === 0
    };

    const managerMod = {};
    const sessionMod = loadTs("api/lib/facetime/FaceTimeSession.ts", {
        "@server": { Server: () => stubServer },
        "./FacetimeSessionManager": { FaceTimeSessionManager: () => managerMod.instance() },
        "@server/databases/notificationCenter/NotiicationCenterRepository": {
            NotificationCenterDB: () => ({
                getRecords: async () => {
                    calls.getRecords += 1;
                    return [state.notifications, state.notifications.length];
                }
            })
        },
        "@server/databases/imessage/helpers/dateUtil": { convertDateToCocoaTime: d => d.getTime() },
        "@server/helpers/utils": helperUtils,
        "../../../lib/ScheduledService": { ScheduledService },
        "../../../lib/logging/Loggable": { Loggable: StubLoggable }
    });

    const realManagerMod = loadTs("api/lib/facetime/FacetimeSessionManager.ts", {
        "./FaceTimeSession": sessionMod
    });
    managerMod.instance = realManagerMod.FaceTimeSessionManager;

    const { PrivateApiFaceTime } = loadTs("api/privateApi/apis/PrivateApiFaceTime.ts", {
        "@server/managers/transactionManager/transactionPromise": {
            TransactionPromise: FakeTransactionPromise,
            TransactionType
        },
        ".": {
            PrivateApiAction: class {
                async sendApiMessage(action, data, tx) {
                    calls.sendApiMessage.push({
                        action,
                        data,
                        hasTx: tx instanceof FakeTransactionPromise && tx.type === TransactionType.OTHER
                    });
                    return { data: { admittedCount: 1 } };
                }
            }
        }
    });

    const { PrivateApiFaceTimeStatusHandler } = loadTs(
        "api/privateApi/eventHandlers/PrivateApiFaceTimeStatusHandler.ts",
        {
            "@server": { Server: () => stubServer },
            "@server/events": { FT_CALL_STATUS_CHANGED: "ft-call-status-changed", INCOMING_FACETIME: "incoming-facetime" },
            "@server/types": {},
            "@server/helpers/utils": helperUtils,
            "@server/api/serializers/HandleSerializer": { HandleSerializer: { serialize: async ({ handle }) => handle } },
            "@server/api/lib/facetime/FacetimeSessionManager": { FaceTimeSessionManager: realManagerMod.FaceTimeSessionManager },
            "@server/api/lib/facetime/FaceTimeSession": sessionMod,
            "@server/api/lib/facetime/FaceTimeAudioBridge": {
                FaceTimeAudioBridge: { getInstance: () => ({ cleanupSession: id => calls.cleanupSession.push(id) }) }
            },
            "@server/lib/logging/Loggable": { Loggable: StubLoggable },
            ".": {}
        }
    );

    const { FaceTimeInterface } = loadTs("api/interfaces/facetimeInterface.ts", {
        "@server": { Server: () => stubServer },
        "../lib/facetime/FaceTimeSession": sessionMod,
        "../lib/facetime/FaceTimeAudioBridge": {
            FaceTimeAudioBridge: {
                getInstance: () => ({
                    cleanupSession: id => calls.cleanupSession.push(id),
                    sendDtmf: (id, digit) => {
                        if (!state.bridgeActive) return false;
                        calls.bridgeDtmf = calls.bridgeDtmf || [];
                        calls.bridgeDtmf.push({ id, digit });
                        return true;
                    }
                })
            }
        },
        "@server/env": { isMinMonterey: true },
        "@server/helpers/utils": { ...helperUtils, checkPrivateApiStatus: () => {} }
    });

    return {
        calls,
        state,
        FaceTimeSession: sessionMod.FaceTimeSession,
        FaceTimeSessionStatus: sessionMod.FaceTimeSessionStatus,
        FaceTimeSessionManager: realManagerMod.FaceTimeSessionManager,
        PrivateApiFaceTime,
        PrivateApiFaceTimeStatusHandler,
        FaceTimeInterface
    };
};

test("PrivateApiFaceTime.admitAnyPendingMember sends admit-any-pending-member", async () => {
    const { PrivateApiFaceTime, calls } = createHarness();
    const api = new PrivateApiFaceTime({});
    const res = await api.admitAnyPendingMember();

    assert.equal(calls.sendApiMessage.length, 1);
    assert.deepEqual(calls.sendApiMessage[0], { action: "admit-any-pending-member", data: {}, hasTx: true });
    assert.equal(res.data.admittedCount, 1);
});

test("admitSelfHandler prefers admitAnyPendingMember, falls back to NotificationCenterDB, and stops on DISCONNECTED", async () => {
    const h = createHarness();
    const session = new h.FaceTimeSession({ callUuid: "call-admit" });
    let stopped = false;
    session.selfAdmissionService = { stop: () => { stopped = true; } };

    // 1. admitAnyPendingMember succeeds -> skips NotificationCenterDB
    h.state.admitAnyResult = { data: { admittedCount: 1, admittedParticipants: ["h1"] } };
    assert.equal(await session.admitSelfHandler(new Date()), true);
    assert.equal(stopped, true);
    assert.equal(h.calls.getRecords, 0);
    assert.deepEqual(session.admittedParticipants, ["h1"]);

    // 2. admitAnyPendingMember returns 0 -> falls back to NotificationCenterDB
    stopped = false;
    h.state.admitAnyResult = { data: { admittedCount: 0 } };
    h.state.notifications = [
        { data: [{ req: { body: "wants to join", usda: { $objects: [0, 1, 2, 3, 4, 5, "user-2", 7, 8, "conv-9"] } } }] }
    ];
    assert.equal(await session.admitSelfHandler(new Date()), true);
    assert.equal(h.calls.getRecords, 1);
    assert.deepEqual(h.calls.admitParticipant, [{ conversationUuid: "conv-9", handleUuid: "user-2" }]);
    assert.equal(stopped, true);

    // 3. DISCONNECTED stops immediately without calling helper or DB
    stopped = false;
    session.invalidate();
    const beforeCalls = h.calls.admitAnyPendingMember;
    assert.equal(await session.admitSelfHandler(new Date()), false);
    assert.equal(stopped, true);
    assert.equal(h.calls.admitAnyPendingMember, beforeCalls);
});

test("admitAndLeave preserves active OUTGOING ring until ANSWERED, then leaves after handoff", async () => {
    const h = createHarness();
    const session = new h.FaceTimeSession({ callUuid: "call-out" });
    session.status = h.FaceTimeSessionStatus.OUTGOING;
    session.admitSelf = async () => {};

    let finished = false;
    const promise = session.admitAndLeave(500, 20).then(() => {
        finished = true;
    });

    await new Promise(r => setTimeout(r, 30));
    assert.equal(h.calls.leaveCall.length, 0, "must not leave while still ringing");
    assert.equal(finished, false);

    // Simulate status_id == 1 via status handler (even with facetime_calling=false default)
    const handler = new h.PrivateApiFaceTimeStatusHandler();
    await handler.handle({ data: { call_uuid: "call-out", status_id: 1, handle: null } }, {});

    assert.equal(session.status, h.FaceTimeSessionStatus.ANSWERED);
    assert.equal(h.calls.emitMessage.length, 0, "must not emit spurious incoming alert");

    await promise;
    assert.deepEqual(h.calls.leaveCall, ["call-out"]);
});

test("admitAndLeave aborts cleanly without leaveCall on DISCONNECTED", async () => {
    const h = createHarness();
    const session = new h.FaceTimeSession({ callUuid: "call-disc" });
    session.status = h.FaceTimeSessionStatus.OUTGOING;
    session.admitSelf = async () => {};

    const promise = session.admitAndLeave(500, 20);
    await new Promise(r => setTimeout(r, 20));
    session.invalidate();

    await promise;
    assert.equal(h.calls.leaveCall.length, 0);
});

test("PrivateApiFaceTimeStatusHandler null-guards handle.value and avoids spurious incoming alerts", async () => {
    const h = createHarness();
    h.state.facetimeCalling = true;
    const handler = new h.PrivateApiFaceTimeStatusHandler();

    const outgoing = new h.FaceTimeSession({ callUuid: "call-null-handle" });
    outgoing.status = h.FaceTimeSessionStatus.OUTGOING;

    // status_id == 1 with null handle transitions OUTGOING -> ANSWERED and emits ft-call-status-changed (multi-device dismiss)
    await handler.handle({ data: { call_uuid: "call-null-handle", status_id: 1, handle: null } }, {});
    assert.equal(outgoing.status, h.FaceTimeSessionStatus.ANSWERED);
    assert.equal(h.calls.emitMessage.length, 1);
    assert.equal(h.calls.emitMessage[0].type, "ft-call-status-changed");
    assert.equal(h.calls.emitMessage[0].data.uuid, "call-null-handle");
    assert.equal(h.calls.emitMessage[0].data.status_id, 1);
    assert.equal(h.calls.emitMessage[0].data.status, "answered");
    assert.equal(h.calls.getHandles, 0);

    // DISCONNECTED with null handle emits status change without slugifyAddress crash
    await handler.handle({ data: { call_uuid: "call-null-handle", call_status: 6, handle: null } }, {});
    assert.deepEqual(h.calls.cleanupSession, ["call-null-handle"]);
    assert.equal(h.calls.emitMessage.length, 2);
    assert.equal(h.calls.emitMessage[1].data.address, null);
    assert.equal(h.calls.emitMessage[1].data.handle, null);
    assert.equal(h.calls.getHandles, 0);
});

test("PrivateApiFaceTime.playDtmf and FaceTimeInterface.dtmf validate digits and fall back to bridge", async () => {
    const h = createHarness();
    const api = new h.PrivateApiFaceTime({});
    await api.playDtmf("call-dtmf", "#");
    assert.deepEqual(h.calls.sendApiMessage[0], {
        action: "play-dtmf",
        data: { callUUID: "call-dtmf", digit: "#" },
        hasTx: true
    });

    await assert.rejects(() => h.FaceTimeInterface.dtmf("call-dtmf", "Z"), /Invalid DTMF digit/);

    // Helper played: true -> no bridge fallback
    h.state.playDtmfResult = { data: { played: true } };
    h.state.bridgeActive = true;
    assert.deepEqual(await h.FaceTimeInterface.dtmf("call-dtmf", "a"), { played: true, via: "helper" });
    assert.equal(h.calls.bridgeDtmf, undefined);

    // Helper played: false -> bridge fallback
    h.state.playDtmfResult = { data: { played: false, fallback: "bridge" } };
    assert.deepEqual(await h.FaceTimeInterface.dtmf("call-dtmf", "*"), { played: true, via: "bridge" });
    assert.deepEqual(h.calls.bridgeDtmf, [{ id: "call-dtmf", digit: "*" }]);

    // Helper played: false + no active bridge -> played: false, via: "none"
    h.state.bridgeActive = false;
    assert.deepEqual(await h.FaceTimeInterface.dtmf("call-dtmf", "9"), { played: false, via: "none" });
});
