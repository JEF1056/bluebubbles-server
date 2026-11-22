const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const babel = require("@babel/core");
const EventEmitter = require("node:events");

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

const createPollerHarness = (repoOverride = {}) => {
    const constants = loadTypeScriptModule(path.join(srcRoot, "databases/imessage/pollers/constants.ts"));
    const { EventCache } = loadTypeScriptModule(path.join(srcRoot, "eventCache/index.ts"), {
        "@server/helpers/utils": {
            isEmpty: value => value === null || value === undefined || value.length === 0
        }
    });
    const pollerBase = loadTypeScriptModule(path.join(srcRoot, "databases/imessage/pollers/index.ts"), {
        "@server/eventCache": { EventCache },
        "@server/events": { CHAT_READ_STATUS_CHANGED: "chat-read-status-changed" },
        "@server/lib/logging/Loggable": { Loggable: class {} },
        "./constants": constants
    });

    const rejected = [];
    const resolved = [];
    const logs = [];
    let rejectResult = false;
    const serverStub = {
        log: (msg, level) => logs.push({ msg, level }),
        messageManager: {
            promises: [],
            resolve: entry => {
                resolved.push(entry);
                return Promise.resolve(true);
            },
            reject: (reason, entry) => {
                rejected.push({ reason, entry });
                return Promise.resolve(rejectResult);
            }
        }
    };

    const { MessagePoller } = loadTypeScriptModule(path.join(srcRoot, "databases/imessage/pollers/MessagePoller.ts"), {
        ".": pollerBase,
        "../entity/Message": { Message: class {} },
        "@server/helpers/utils": {
            isEmpty: value => value === null || value === undefined || value.length === 0
        },
        "@server": { Server: () => serverStub },
        "./constants": constants
    });

    const cache = new pollerBase.IMessageCache();
    const poller = new MessagePoller(repoOverride, cache);
    return {
        poller,
        logs,
        rejected,
        resolved,
        setRejectResult: val => {
            rejectResult = val;
        }
    };
};

const makePollerMsg = overrides => ({
    ROWID: 1,
    guid: "msg-1",
    text: "hello",
    isFromMe: true,
    isSent: true,
    isDelivered: false,
    error: 0,
    itemType: 0,
    groupActionType: 0,
    dateCreated: new Date(10_000),
    dateDelivered: null,
    dateRead: null,
    dateEdited: null,
    dateRetracted: null,
    hasUnsentParts: false,
    didNotifyRecipient: false,
    chats: [{ isGroup: false }],
    contentString: () => "hello",
    ...overrides
});

test("A1: getMessages omits query.take when limit is null and applies default 100 otherwise", async () => {
    const taken = [];
    const makeRepo = () => {
        const qb = {
            leftJoinAndSelect: () => qb,
            innerJoinAndSelect: () => qb,
            andWhere: () => qb,
            orderBy: () => qb,
            skip: () => qb,
            take: n => {
                taken.push(n);
                return qb;
            },
            getMany: async () => [],
            getManyAndCount: async () => [[], 0]
        };
        const { MessageRepository } = loadTypeScriptModule(path.join(srcRoot, "databases/imessage/index.ts"), {
            typeorm: {
                Brackets: class {},
                DataSource: class {},
                SelectQueryBuilder: class {}
            },
            "@server/databases/imessage/types": {},
            "@server/databases/imessage/helpers/dateUtil": { convertDateTo2001Time: d => d },
            "@server/databases/imessage/helpers/chatGuid": { getChatGuidCandidates: g => [g] },
            "@server/databases/imessage/entity/Chat": { Chat: class {} },
            "@server/databases/imessage/entity/Handle": { Handle: class {} },
            "@server/databases/imessage/entity/Message": { Message: class {} },
            "@server/databases/imessage/entity/Attachment": { Attachment: class {} },
            "@server/databases/imessage/helpers/whereClauseValidator": { buildQueryableColumns: () => ({}) },
            "@server/helpers/utils": { isNotEmpty: x => Boolean(x && x.length > 0) },
            "@server/env": { isMinHighSierra: true, isMinVentura: true },
            "@server/lib/logging/Loggable": { Loggable: class {} }
        });
        const repo = new MessageRepository();
        repo.db = { getRepository: () => ({ createQueryBuilder: () => qb }) };
        return repo;
    };

    const repo = makeRepo();
    await repo.getMessages({ withCount: false, withAttachments: false });
    await repo.getMessages({ limit: null, withCount: false, withAttachments: false });
    assert.deepEqual(taken, [100]);
});

test("A1: MessagePoller uses 5000-row cap + warn on 7d reconcile and limit:null on fast poll", async () => {
    const calls = [];
    const bigBatch = Array.from({ length: 5000 }, (_, i) =>
        makePollerMsg({ ROWID: i + 1, guid: `m-${i}`, dateCreated: new Date(1000) })
    );
    const { poller, logs } = createPollerHarness({
        getMessages: async params => {
            calls.push(params);
            if (calls.length === 1) return [bigBatch, 0];
            return [[], 0];
        }
    });

    await poller.poll(new Date(5000));
    await poller.poll(new Date(5000));

    assert.equal(calls[0].limit, 5000);
    assert.ok(logs.some(l => l.level === "warn" && l.msg.includes("5000")));
    assert.equal(calls[1].limit, null);
});

test("A2 + A3: MessagePoller tracks only outgoing unsent rows and emits message-send-error once on failure", async () => {
    const incomingRow = makePollerMsg({
        ROWID: 10,
        guid: "in-10",
        isFromMe: false,
        isSent: false,
        error: 0,
        dateCreated: new Date(20_000)
    });
    let outgoingRow = makePollerMsg({
        ROWID: 11,
        guid: "out-11",
        isFromMe: true,
        isSent: false,
        error: 0,
        dateCreated: new Date(20_000)
    });

    let phase = 1;
    const { poller, rejected } = createPollerHarness({
        getMessages: async params => {
            if (params.where?.[0]?.statement?.includes("ROWID in")) {
                return [[outgoingRow], 0];
            }
            if (phase === 1) return [[incomingRow, outgoingRow], 0];
            return [[], 0];
        }
    });

    const r1 = await poller.poll(new Date(15_000));
    assert.deepEqual(poller.unsentIds, [11]);
    assert.equal(r1.filter(e => e.eventType === "message-send-error").length, 0);

    // Phase 2: outgoing row fails with error=4; reject returns false -> emits message-send-error once
    phase = 2;
    outgoingRow = { ...outgoingRow, error: 4 };
    const r2 = await poller.poll(new Date(25_000));
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].entry.ROWID, 11);
    assert.equal(r2.filter(e => e.eventType === "message-send-error").length, 1);
    assert.deepEqual(poller.unsentIds, []);

    // Phase 3: subsequent poll emits nothing and re-queries nothing
    const r3 = await poller.poll(new Date(30_000));
    assert.equal(r3.filter(e => e.eventType === "message-send-error").length, 0);
});

test("F1 + S2-19: FaceTimeAudioBridge skips spawn when orphaned mid-offer and cleans up after disconnected timeout", async () => {
    let spawnCount = 0;
    const emitted = [];
    const createdPcs = [];
    let deferredRemote;

    class FakeSubject {
        constructor() {
            this.listeners = [];
        }
        subscribe(fn) {
            this.listeners.push(fn);
        }
        emit(val) {
            for (const fn of this.listeners) fn(val);
        }
    }

    class FakePeerConnection {
        constructor() {
            this.onIceCandidate = new FakeSubject();
            this.connectionStateChange = new FakeSubject();
            this.closed = false;
            createdPcs.push(this);
        }
        addTransceiver() {
            return { receiver: { track: { onReceiveRtp: new FakeSubject() } } };
        }
        setRemoteDescription() {
            return new Promise(resolve => {
                deferredRemote = resolve;
            });
        }
        async createAnswer() {
            return { sdp: "v=0-answer", type: "answer" };
        }
        async setLocalDescription() {}
        async close() {
            this.closed = true;
        }
    }

    const { FaceTimeAudioBridge } = loadTypeScriptModule(
        path.join(srcRoot, "api/lib/facetime/FaceTimeAudioBridge.ts"),
        {
            child_process: {
                spawn: () => {
                    spawnCount += 1;
                    return {
                        killed: false,
                        kill: () => {},
                        stdout: new EventEmitter(),
                        stderr: new EventEmitter(),
                        stdin: new EventEmitter(),
                        on: () => {}
                    };
                }
            },
            fs: { existsSync: () => true },
            "socket.io": {},
            werift: {
                MediaStreamTrack: class {},
                RTCIceCandidate: class {},
                RTCPeerConnection: FakePeerConnection,
                RTCRtpCodecParameters: class {},
                RtpHeader: class {},
                RtpPacket: class {}
            },
            "@server": { Server: () => null },
            "@server/fileSystem": { FileSystem: { resources: "/tmp" } },
            "@server/lib/logging/Loggable": {
                Loggable: class {
                    log = { info: () => {}, warn: () => {}, debug: () => {} };
                }
            }
        }
    );

    const bridge = new FaceTimeAudioBridge();
    const socket = {
        id: "sock-1",
        emit: (evt, data) => emitted.push({ evt, data })
    };

    // F1: clean up while setRemoteDescription is pending -> should not emit answer or spawn audio bridge
    const offerPromise = bridge.handleOffer(socket, { callUuid: "call-f1", sdp: "v=0-offer" });
    bridge.cleanupSession("call-f1");
    deferredRemote();
    await offerPromise;

    assert.equal(spawnCount, 0);
    assert.equal(emitted.filter(e => e.evt === "ft-bridge-answer").length, 0);

    // S2-19: "disconnected" arms disconnect timer, cancelled by "connected", and cleans up when unrecovered
    bridge.disconnectTimeoutMs = 30;
    const offer2 = bridge.handleOffer(socket, { callUuid: "call-s219", sdp: "v=0-offer" });
    deferredRemote();
    await offer2;
    assert.equal(bridge.sessions.has("call-s219"), true);

    const pc2 = createdPcs[createdPcs.length - 1];
    pc2.connectionStateChange.emit("connected");
    pc2.connectionStateChange.emit("disconnected");
    // Recover before timeout
    pc2.connectionStateChange.emit("connected");
    await new Promise(r => setTimeout(r, 50));
    assert.equal(bridge.sessions.has("call-s219"), true);

    // Drop again and stay disconnected
    pc2.connectionStateChange.emit("disconnected");
    await new Promise(r => setTimeout(r, 60));
    assert.equal(bridge.sessions.has("call-s219"), false);
    assert.equal(pc2.closed, true);
});

test("FaceTimeAudioBridge: parses optional TURN env vars and returns iceServers in ft-bridge-answer and ft-bridge-config", async () => {
    const emitted = [];
    const pcConfigs = [];

    class FakeSubject {
        subscribe() {}
    }

    class FakePeerConnection {
        constructor(config) {
            this.onIceCandidate = new FakeSubject();
            this.connectionStateChange = new FakeSubject();
            pcConfigs.push(config);
        }
        addTransceiver() {
            return { receiver: { track: { onReceiveRtp: new FakeSubject() } } };
        }
        async setRemoteDescription() {}
        async createAnswer() {
            return { sdp: "v=0-answer", type: "answer" };
        }
        async setLocalDescription() {}
        async close() {}
    }

    const { FaceTimeAudioBridge } = loadTypeScriptModule(
        path.join(srcRoot, "api/lib/facetime/FaceTimeAudioBridge.ts"),
        {
            child_process: { spawn: () => ({ killed: false, kill: () => {}, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter(), on: () => {} }) },
            fs: { existsSync: () => false },
            "socket.io": {},
            werift: {
                MediaStreamTrack: class {},
                RTCIceCandidate: class {},
                RTCPeerConnection: FakePeerConnection,
                RTCRtpCodecParameters: class {},
                RtpHeader: class {},
                RtpPacket: class {}
            },
            "@server": { Server: () => null },
            "@server/fileSystem": { FileSystem: { resources: "/tmp" } },
            "@server/lib/logging/Loggable": {
                Loggable: class {
                    log = { info: () => {}, warn: () => {}, debug: () => {} };
                }
            }
        }
    );

    const prevUrls = process.env.BB_FACETIME_TURN_URLS;
    const prevUser = process.env.BB_FACETIME_TURN_USERNAME;
    const prevCred = process.env.BB_FACETIME_TURN_CREDENTIAL;

    try {
        delete process.env.BB_FACETIME_TURN_URLS;
        delete process.env.BB_FACETIME_TURN_USERNAME;
        delete process.env.BB_FACETIME_TURN_CREDENTIAL;
        assert.deepEqual(FaceTimeAudioBridge.getIceServers(), [{ urls: "stun:stun.l.google.com:19302" }]);

        process.env.BB_FACETIME_TURN_URLS = "turn:turn.example.com:3478, turns:turn.example.com:5349 ";
        process.env.BB_FACETIME_TURN_USERNAME = "alice";
        process.env.BB_FACETIME_TURN_CREDENTIAL = "secret";

        const expectedIceServers = [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "turn:turn.example.com:3478", username: "alice", credential: "secret" },
            { urls: "turns:turn.example.com:5349", username: "alice", credential: "secret" }
        ];
        assert.deepEqual(FaceTimeAudioBridge.getIceServers(), expectedIceServers);

        const bridge = new FaceTimeAudioBridge();
        const socket = { id: "sock-turn", emit: (evt, data) => emitted.push({ evt, data }) };
        await bridge.handleOffer(socket, { callUuid: "call-turn", sdp: "v=0-offer" });
        bridge.cleanupSession("call-turn");

        assert.deepEqual(pcConfigs[0].iceServers, expectedIceServers);
        const answerEvt = emitted.find(e => e.evt === "ft-bridge-answer");
        assert.ok(answerEvt);
        assert.deepEqual(answerEvt.data.iceServers, expectedIceServers);

        const { registerForkSocketRoutes } = loadTypeScriptModule(
            path.join(srcRoot, "api/http/api/v1/socketForkRoutes.ts"),
            {
                "socket.io": {},
                "@server/api/lib/facetime/FaceTimeAudioBridge": { FaceTimeAudioBridge }
            }
        );
        const handlers = {};
        registerForkSocketRoutes({ on: (evt, fn) => { handlers[evt] = fn; } }, { debug: () => {} });
        let configAck = null;
        handlers["ft-bridge-config"]({}, res => {
            configAck = res;
        });
        assert.deepEqual(configAck, {
            iceServers: expectedIceServers,
            videoSupported: false,
            videoUplinkSupported: false
        });

        let configAckOneArg = null;
        handlers["ft-bridge-config"](res => {
            configAckOneArg = res;
        });
        assert.deepEqual(configAckOneArg, {
            iceServers: expectedIceServers,
            videoSupported: false,
            videoUplinkSupported: false
        });
    } finally {
        if (prevUrls === undefined) delete process.env.BB_FACETIME_TURN_URLS;
        else process.env.BB_FACETIME_TURN_URLS = prevUrls;
        if (prevUser === undefined) delete process.env.BB_FACETIME_TURN_USERNAME;
        else process.env.BB_FACETIME_TURN_USERNAME = prevUser;
        if (prevCred === undefined) delete process.env.BB_FACETIME_TURN_CREDENTIAL;
        else process.env.BB_FACETIME_TURN_CREDENTIAL = prevCred;
    }
});

test("S2-1: emitMessage sets FCM priority 'high' only when chat-read-status-changed has read:true", async () => {
    const fcmCalls = [];
    const noopProxy = new Proxy(function () {}, {
        get: (_t, prop) => (prop === "__esModule" ? false : noopProxy),
        construct: () => ({}),
        apply: () => noopProxy
    });
    const serverOverrides = {
        electron: { app: { getPath: () => "/tmp", getVersion: () => "1.0.0" }, nativeTheme: new EventEmitter() },
        "electron-log": { transports: { console: {}, file: {} } },
        "macos-version": () => "14.0.0",
        "node-mac-permissions": { getAuthStatus: () => "authorized" },
        "find-process": async () => [],
        path,
        fs: { existsSync: () => true },
        os: require("node:os"),
        process,
        events: { EventEmitter },
        "@server/services": { FCMService: { getApp: () => ({}) } },
        "./helpers/utils": {
            insertChatParticipants: () => {},
            isEmpty: () => false,
            isNotEmpty: v => Boolean(v && v.length),
            waitMs: async () => {}
        },
        "./events": { CHAT_READ_STATUS_CHANGED: "chat-read-status-changed" },
        "./lib/logging/Loggable": {
            getLogger: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} })
        }
    };
    const transformed = babel.transformFileSync(path.join(srcRoot, "index.ts"), {
        presets: [
            [require.resolve("@babel/preset-env"), { targets: { node: "20" }, modules: "commonjs" }],
            require.resolve("@babel/preset-typescript")
        ]
    });
    const serverMod = { exports: {} };
    new Function("module", "exports", "require", "__dirname", "__filename", transformed.code)(
        serverMod,
        serverMod.exports,
        req => serverOverrides[req] ?? noopProxy,
        srcRoot,
        path.join(srcRoot, "index.ts")
    );

    const instance = serverMod.exports.Server({}, null);
    instance.httpService = { socketServer: { emit: () => {} } };
    instance.repo = { devices: () => ({ find: async () => [{ identifier: "dev-1" }] }) };
    instance.fcm = {
        sendNotification: async (_ids, _payload, priority) => {
            fcmCalls.push(priority);
        }
    };
    instance.logger = { debug: () => {} };
    instance.webhookService = null;

    await instance.emitMessage("chat-read-status-changed", { chatGuid: "c1", read: true });
    await instance.emitMessage("chat-read-status-changed", { chatGuid: "c1", read: false });

    assert.deepEqual(fcmCalls, ["high", "normal"]);
});

test("S2-2: IncomingReadEventDetector uses ChatStateSnapshot UNREAD_MESSAGE_PREDICATE", () => {
    const snapshot = loadTypeScriptModule(path.join(srcRoot, "databases/imessage/snapshot/ChatStateSnapshot.ts"));
    const detector = loadTypeScriptModule(path.join(srcRoot, "databases/imessage/pollers/IncomingReadEventDetector.ts"), {
        "../snapshot/ChatStateSnapshot": snapshot
    });

    const sql = detector.buildChatUnreadCountQuery().replace(/\s+/g, " ");
    const expectedPredicate = snapshot.UNREAD_MESSAGE_PREDICATE.replace(/\s+/g, " ");
    assert.ok(sql.includes(expectedPredicate), "per-chat unread query must share UNREAD_MESSAGE_PREDICATE");
    assert.doesNotMatch(sql, /\bAND m\.date_read = 0\b/i);
    assert.match(sql, /COALESCE\(c\.last_read_message_timestamp, 0\)/i);
});

test("S2-6: DylibPlugin resets failure count only after >=30s healthy uptime", async () => {
    let fakeNow = 100_000;
    const origNow = Date.now;
    Date.now = () => fakeNow;

    let runUptimesMs = [];
    let spawnCount = 0;

    try {
        const { DylibPlugin } = loadTypeScriptModule(
            path.join(srcRoot, "api/privateApi/modes/dylibPlugins/index.ts"),
            {
                fs: { existsSync: () => true },
                "@server/helpers/utils": { waitMs: async () => {} },
                "@server": {
                    Server: () => ({
                        privateApi: { on: () => {}, removeListener: () => {} }
                    })
                },
                "@server/fileSystem": { FileSystem: { killProcess: async () => {}, executeAppleScript: async () => {} } },
                "@server/api/apple/scripts": { hideApp: () => "" },
                "@server/lib/logging/Loggable": {
                    Loggable: class {
                        log = { debug: () => {}, warn: () => {}, error: () => {} };
                    }
                },
                "@server/lib/ProcessSpawner": {
                    ProcessSpawner: class {
                        async execute() {
                            const uptime = runUptimesMs[spawnCount] ?? 1_000;
                            spawnCount += 1;
                            fakeNow += uptime;
                        }
                    }
                }
            }
        );

        class TestPlugin extends DylibPlugin {
            get isEnabled() {
                return true;
            }
            get dylibPath() {
                return "/tmp/test.dylib";
            }
            get parentProcessPath() {
                return "/tmp/Messages";
            }
        }

        // Case 1: Rapid clean exits (< 30s) exhaust MAX_CONSECUTIVE_FAILURES (5) and stop looping
        runUptimesMs = [1_000, 1_000, 1_000, 1_000, 1_000];
        spawnCount = 0;
        const plugin1 = new TestPlugin("Test");
        plugin1.parentApp = "Messages";
        await plugin1.injectPlugin();
        assert.equal(spawnCount, 5);
        assert.equal(plugin1.consecutiveFailureCount, 5);

        // Case 2: 2 rapid exits (< 30s), then 1 healthy run (>= 30s) resets count to 0, then 5 rapid exits stop
        runUptimesMs = [1_000, 1_000, 35_000, 1_000, 1_000, 1_000, 1_000, 1_000];
        spawnCount = 0;
        const plugin2 = new TestPlugin("Test");
        plugin2.parentApp = "Messages";
        await plugin2.injectPlugin();
        assert.equal(spawnCount, 8);
    } finally {
        Date.now = origNow;
    }
});

test("S2-7 + S2-13: FaceTimeSession guards answerWithServer waiter and admitSelf leaveCall timeout", async () => {
    let answerCallImpl = async () => {
        throw new Error("IPC failed");
    };
    let leaveCallImpl = async () => {
        throw new Error("leaveCall failed");
    };
    let scheduledCallback = null;
    const broadcasts = [];

    const { FaceTimeSession, FaceTimeSessionStatus } = loadTypeScriptModule(
        path.join(srcRoot, "api/lib/facetime/FaceTimeSession.ts"),
        {
            "@server": {
                Server: () => ({
                    privateApi: {
                        facetime: {
                            answerCall: () => answerCallImpl(),
                            leaveCall: () => leaveCallImpl()
                        }
                    }
                })
            },
            "./FacetimeSessionManager": {
                FaceTimeSessionManager: () => ({
                    findSession: () => null,
                    addSession: s => s,
                    broadcastUpdate: (s, force) => broadcasts.push({ s, force })
                })
            },
            "@server/databases/notificationCenter/NotiicationCenterRepository": { NotificationCenterDB: class {} },
            "@server/databases/imessage/helpers/dateUtil": { convertDateToCocoaTime: d => d },
            "@server/helpers/utils": { waitMs: async () => {} },
            "@server/types": {},
            uuid: { v4: () => "uuid-1" },
            "../../../lib/logging/Loggable": {
                Loggable: class extends EventEmitter {
                    log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
                }
            },
            "../../../lib/ScheduledService": {
                ScheduledService: class {
                    constructor(cb) {
                        scheduledCallback = cb;
                    }
                    stop() {}
                }
            }
        }
    );

    // S2-7a: answerCall throws -> rejects immediately with IPC error, no unhandled rejection
    let unhandled = 0;
    const onUnhandled = () => {
        unhandled += 1;
    };
    process.on("unhandledRejection", onUnhandled);

    const s1 = new FaceTimeSession({ callUuid: "ft-1", addToManager: false });
    await assert.rejects(() => s1.answerWithServer(), /IPC failed/);
    clearTimeout(s1.expiryTimer);

    // S2-7b: disconnected event short-circuits waitForAnswer immediately
    answerCallImpl = async () => {};
    const s2 = new FaceTimeSession({ callUuid: "ft-2", addToManager: false });
    const p2 = s2.answerWithServer();
    setImmediate(() => s2.invalidate("caller_hung_up"));
    await assert.rejects(() => p2, /disconnected/i);
    clearTimeout(s2.expiryTimer);

    // S2-13: admitSelf timeout path catches leaveCall() rejection and still rejects cleanly
    const OrigDate = global.Date;
    let fakeNow = 1_000_000;
    global.Date = class extends OrigDate {
        constructor(...args) {
            super(...(args.length ? args : [fakeNow]));
        }
        static now() {
            return fakeNow;
        }
    };
    const s3 = new FaceTimeSession({ callUuid: "ft-3", addToManager: false });
    s3.status = FaceTimeSessionStatus.INCOMING;
    s3.admitSelfHandler = async () => false;
    s3.leaveCall = () => leaveCallImpl();
    const admitPromise = s3.admitSelf(true);
    try {
        fakeNow = 1_200_000;
        await scheduledCallback();
        await assert.rejects(() => admitPromise, /Failed to admit self/);
        assert.equal(s3.status, FaceTimeSessionStatus.DISCONNECTED);
        assert.equal(broadcasts.length, 1);
    } finally {
        global.Date = OrigDate;
        clearTimeout(s3.expiryTimer);
        process.off("unhandledRejection", onUnhandled);
    }
    assert.equal(unhandled, 0);
});

test("Wave1 #2: PrivateApiService destroys socket on non-JSON line", async () => {
    const { JsonLineBuffer } = loadTypeScriptModule(
        path.join(srcRoot, "api/privateApi/JsonLineBuffer.ts")
    );
    const noopClass = class {};
    const { PrivateApiService } = loadTypeScriptModule(
        path.join(srcRoot, "api/privateApi/PrivateApiService.ts"),
        {
            "async-sema": { Sema: class { acquire() {} release() {} } },
            "@server/helpers/utils": { clamp: v => v, isEmpty: v => !v, isNotEmpty: v => !!v },
            "@server/managers/transactionManager/transactionPromise": { TransactionPromise: noopClass, TransactionResult: {} },
            "@server/managers/transactionManager": { TransactionManager: noopClass },
            "./Constants": { MAX_PORT: 46000, MIN_PORT: 45000 },
            "./eventHandlers": {},
            "./eventHandlers/PrivateApiTypingEventHandler": { PrivateApiTypingEventHandler: noopClass },
            "./apis/PrivateApiMessage": { PrivateApiMessage: noopClass },
            "./apis/PrivateApiChat": { PrivateApiChat: noopClass },
            "./apis/PrivateApiHandle": { PrivateApiHandle: noopClass },
            "./apis/PrivateApiAttachment": { PrivateApiAttachment: noopClass },
            "./modes": {},
            "./modes/ProcessDylibMode": { ProcessDylibMode: noopClass },
            "./eventHandlers/PrivateApiPingEventHandler": { PrivateApiPingEventHandler: noopClass },
            "./apis/PrivateApiFindMy": { PrivateApiFindMy: noopClass },
            "./eventHandlers/PrivateApiAddressEventHandler": { PrivateApiAddressEventHandler: noopClass },
            "./eventHandlers/PrivateApiFaceTimeStatusHandler": { PrivateApiFaceTimeStatusHandler: noopClass },
            "./apis/PrivateApiCloud": { PrivateApiCloud: noopClass },
            "./apis/PrivateApiFaceTime": { PrivateApiFaceTime: noopClass },
            "@server/api/lib/facetime/FaceTimeCameraHook": { ensureCameraHookInstalled: () => {} },
            "./eventHandlers/PrivateApiFindMyEventHandler": { PrivateApiFindMyEventHandler: noopClass },
            "./eventHandlers/PrivateApiPinnedChatsEventHandler": { PrivateApiPinnedChatsEventHandler: noopClass },
            "../types": {},
            uuid: { v4: () => "id-1" },
            "../../lib/logging/Loggable": {
                Loggable: class extends EventEmitter {
                    log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
                }
            },
            "./JsonLineBuffer": { JsonLineBuffer },
            "./PrivateApiClientSelector": { selectPrivateApiClients: () => [] }
        }
    );

    const svc = new PrivateApiService();
    svc.eventHandlers = [];

    const validSocket = {
        destroyed: false,
        destroy() {
            this.destroyed = true;
        }
    };
    await svc.onEvent(JSON.stringify({ event: "ping" }), validSocket);
    assert.equal(validSocket.destroyed, false);

    const badSocket = {
        destroyed: false,
        destroy() {
            this.destroyed = true;
        }
    };
    await svc.onEvent("{not-valid-json", badSocket);
    assert.equal(badSocket.destroyed, true);

    const handledEvents = [];
    svc.eventHandlers = [{
        types: ["ping"],
        async handle(message) {
            handledEvents.push(message);
        }
    }];
    const smuggleSocket = new EventEmitter();
    smuggleSocket.destroyed = false;
    smuggleSocket.destroy = () => {
        smuggleSocket.destroyed = true;
    };
    svc.setupListeners(smuggleSocket);
    smuggleSocket.emit(
        "data",
        Buffer.from('POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n{"event":"ping"}\n')
    );
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(smuggleSocket.destroyed, true);
    assert.equal(handledEvents.length, 0);
});

test("Wave1 #4: FileSystem.saveFCMClient and saveFCMServer return early when usingCustomFcm", () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-fcm-test-"));
    try {
        const { FileSystem } = loadTypeScriptModule(path.join(srcRoot, "fileSystem/index.ts"), {
            "electron-log": { transports: { file: {} } },
            electron: { app: { getPath: () => tmpDir, setPath: () => {} } },
            "read-chunk": { sync: () => Buffer.alloc(0) },
            "@server": {
                Server: () => ({
                    log: () => {},
                    args: {
                        "fcm-client": path.join(tmpDir, "custom-client.json"),
                        "fcm-server": path.join(tmpDir, "custom-server.json")
                    }
                })
            },
            "@server/helpers/utils": {
                concatUint8Arrays: a => a,
                parseMetadataString: () => ({}),
                isNotEmpty: v => Boolean(v && v.length > 0),
                isEmpty: v => !v || v.length === 0,
                safeTrim: s => (s ?? "").trim()
            },
            "@server/env": { isMinMonterey: true },
            "@server/databases/imessage/entity/Attachment": { Attachment: class {} },
            "../api/apple/scripts": { startMessages: () => "" },
            "./fileSystemForkHelpers": {
                convertToPng: async () => {},
                hasAlpha: async () => false,
                requestFindMyAutomationPermissions: async () => {}
            },
            "./types": { MetadataKeyMap: {} },
            uuid: { v4: () => "uuid-fcm" }
        });

        FileSystem.fcmDir = tmpDir;
        FileSystem.saveFCMClient({ project_id: "x" });
        FileSystem.saveFCMServer({ type: "service_account" });
        assert.deepEqual(fs.readdirSync(tmpDir), []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("Wave1 #5: socketRoutes checks null chunk before deflateSync and emits check-for-server-update", async () => {
    const handlers = new Map();
    const emitted = [];
    const mockSocket = {
        use: () => {},
        on: (event, fn) => handlers.set(event, fn),
        emit: (event, data) => emitted.push({ event, data })
    };

    const { SocketRoutes } = loadTypeScriptModule(path.join(srcRoot, "api/http/api/v1/socketRoutes.ts"), {
        fs: { existsSync: () => true },
        electron: { app: { getVersion: () => "1.0.0" } },
        "macos-version": () => "14.0",
        "@server": {
            Server: () => ({
                repo: { getConfig: () => false },
                iMessageRepo: {
                    getAttachment: async () => ({
                        filePath: "/tmp/fake-attachment.bin",
                        transferName: "fake.bin"
                    })
                }
            })
        },
        "@server/fileSystem": {
            FileSystem: {
                getRealPath: p => p,
                readFileChunk: () => null
            }
        },
        "@server/helpers/utils": {
            isEmpty: v => !v || v.length === 0,
            isNotEmpty: v => Boolean(v && v.length > 0),
            isValidAddress: () => true,
            onlyAlphaNumeric: s => s,
            safeTrim: s => (s ?? "").trim()
        },
        "@server/types": {},
        "@server/api/http/api/v1/responses/types": { ErrorTypes: {}, ResponseFormat: {}, ResponseJson: {} },
        "@server/databases/imessage/entity/Handle": { Handle: class {} },
        "@server/databases/imessage/types": {},
        "@server/databases/imessage/helpers/whereClauseValidator": {
            validateWhereClauses: () => {},
            WhereClauseError: class extends Error {}
        },
        "@server/api/apple/actions": { ActionHandler: {} },
        "@server/services/queueService": { QueueItem: {} },
        "@server/api/interfaces/generalInterface": {
            GeneralInterface: { checkForUpdate: async () => ({ available: false }) }
        },
        "@server/api/interfaces/messageInterface": { MessageInterface: {} },
        "@server/databases/imessage/helpers/utils": { convertAudio: async () => {} },
        "./responses": {
            createSuccessResponse: (data, message) => ({ status: 200, message, data }),
            createServerErrorResponse: (err, error, msg) => ({ status: 500, message: msg, error: { message: err } }),
            createBadRequestResponse: msg => ({ status: 400, message: msg }),
            createNoDataResponse: () => ({ status: 200, message: "No data", data: null })
        },
        "@server/api/serializers/MessageSerializer": { MessageSerializer: {} },
        "@server/events": { CHAT_READ_STATUS_CHANGED: "chat-read-status-changed" },
        "@server/api/serializers/ChatSerializer": { ChatSerializer: {} },
        "@server/api/serializers/HandleSerializer": { HandleSerializer: {} },
        "@server/api/serializers/AttachmentSerializer": { AttachmentSerializer: {} },
        "@server/api/interfaces/macosInterface": { MacOsInterface: {} },
        "@server/api/lib/facetime/FaceTimeAudioBridge": { FaceTimeAudioBridge: {} },
        "@server/lib/logging/Loggable": {
            getLogger: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} })
        },
        "@server/databases/server/constants": { ProxyServices: {} },
        "@server/api/lib/gfind": { gfindService: { onClientConnected: () => {} } },
        "./socketForkRoutes": { registerForkSocketRoutes: () => {} }
    });

    SocketRoutes.createRoutes(mockSocket);

    let chunkRes = null;
    await handlers.get("get-attachment-chunk")(
        { identifier: "att-1", start: 0, chunkSize: 100, compress: true },
        res => {
            chunkRes = res;
        }
    );
    assert.equal(chunkRes?.status, 200);
    assert.equal(chunkRes?.data, null);

    await handlers.get("check-for-server-update")({});
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, "check-for-server-update");
    assert.equal(emitted[0].data.status, 200);
});

test("Wave1 #7: MessagePoller handles empty chats and fixes dateDelivered/dateRead precedence", async () => {
    const { poller, resolved } = createPollerHarness({
        getMessages: async () => [
            [
                makePollerMsg({
                    ROWID: 101,
                    guid: "empty-chats-delivered",
                    isFromMe: true,
                    isDelivered: true,
                    chats: [],
                    dateCreated: new Date(1000),
                    dateDelivered: new Date(10_500),
                    dateRead: new Date(10_600)
                }),
                makePollerMsg({
                    ROWID: 102,
                    guid: "incoming-delivered-ignored",
                    isFromMe: false,
                    isDelivered: true,
                    chats: [{ isGroup: false }],
                    dateCreated: new Date(1000),
                    dateDelivered: new Date(10_500)
                })
            ],
            0
        ]
    });

    const results = await poller.poll(new Date(10_000));
    assert.equal(results.length, 1);
    assert.equal(results[0].data.guid, "empty-chats-delivered");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].guid, "empty-chats-delivered");
});
