const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const typescript = require("typescript");
const { RTCPeerConnection, MediaStreamTrack } = require("werift");

const loadTypeScriptModule = (relativeSourcePath, moduleMocks = {}) => {
    const sourcePath = path.resolve(__dirname, relativeSourcePath);
    const sourceCode = fs.readFileSync(sourcePath, "utf8");
    const compiledCode = typescript.transpileModule(sourceCode, {
        compilerOptions: {
            module: typescript.ModuleKind.CommonJS,
            target: typescript.ScriptTarget.ES2020,
            esModuleInterop: true
        },
        fileName: sourcePath
    }).outputText;

    const loadedModule = { exports: {} };
    const executeModule = new Function("require", "module", "exports", "__dirname", "__filename", compiledCode);
    const moduleRequire = moduleName => {
        return Object.prototype.hasOwnProperty.call(moduleMocks, moduleName)
            ? moduleMocks[moduleName]
            : require(moduleName);
    };
    executeModule(moduleRequire, loadedModule, loadedModule.exports, path.dirname(sourcePath), sourcePath);
    return loadedModule.exports;
};

class MockLoggable {
    constructor() {
        this.log = {
            info: () => {},
            debug: () => {},
            warn: () => {},
            error: () => {}
        };
    }
}

async function run() {
    // 1. Verify Swift BlueBubblesAudioBridge binary compiles & runs --check
    const audioBridgeBin = path.resolve(__dirname, "../appResources/macos/tools/BlueBubblesAudioBridge");
    assert.ok(fs.existsSync(audioBridgeBin), `Missing compiled binary: ${audioBridgeBin}`);
    const checkOut = execFileSync(audioBridgeBin, ["--check"], { encoding: "utf8" });
    const checkJson = JSON.parse(checkOut.trim());
    assert.equal(checkJson.ok, true);
    assert.equal(checkJson.processTapSupported, true);
    assert.equal(typeof checkJson.blackHoleFound, "boolean");
    console.log("PASS: BlueBubblesAudioBridge --check", checkJson);

    // 2. Test FaceTimeAudioBridge WebRTC signaling + mute + hangup + orphan timeout
    const serverCalls = [];
    const mockServerFn = () => ({
        privateApi: {
            facetime: {
                startCall: async (addresses, video, isTelephony) => {
                    serverCalls.push({ action: "start-call", addresses, video, isTelephony });
                    return { data: { call_uuid: "test-call-uuid-1", status: "outgoing" } };
                },
                declineCall: async uuid => {
                    serverCalls.push({ action: "decline-call", uuid });
                    return { data: {} };
                },
                leaveCall: async uuid => {
                    serverCalls.push({ action: "leave-call", uuid });
                    return { data: {} };
                },
                setMuted: async (uuid, muted) => {
                    serverCalls.push({ action: "set-muted", uuid, muted });
                    return { data: {} };
                }
            }
        },
        emitMessage: () => {},
        iMessageRepo: { getHandles: async () => [[], 0] },
        repo: { getConfig: () => true }
    });

    const { FaceTimeAudioBridge } = loadTypeScriptModule("../src/server/api/lib/facetime/FaceTimeAudioBridge.ts", {
        "@server": { Server: mockServerFn },
        "@server/fileSystem": { FileSystem: { resources: path.resolve(__dirname, "../appResources") } },
        "@server/lib/logging/Loggable": { Loggable: MockLoggable }
    });

    const bridge = FaceTimeAudioBridge.getInstance();
    bridge.orphanTimeoutMs = 100;

    // Create a real client RTCPeerConnection to generate a valid SDP offer
    const clientPc = new RTCPeerConnection({});
    clientPc.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendrecv" });
    const offer = await clientPc.createOffer();
    await clientPc.setLocalDescription(offer);

    const emitted = [];
    const mockSocket = {
        id: "sock-1",
        emit: (event, data) => emitted.push({ event, data })
    };

    await bridge.handleOffer(mockSocket, {
        callUuid: "call-webrtc-1",
        sdp: offer.sdp,
        type: "offer"
    });

    const answerEvent = emitted.find(e => e.event === "ft-bridge-answer");
    assert.ok(answerEvent, "Expected ft-bridge-answer to be emitted");
    assert.equal(answerEvent.data.callUuid, "call-webrtc-1");
    assert.equal(answerEvent.data.type, "answer");
    assert.ok(answerEvent.data.sdp.includes("m=audio"), "Expected audio media line in SDP answer");
    assert.ok(bridge.sessions.has("call-webrtc-1"), "Session should be active after offer");

    // Mute test
    bridge.handleMute({ callUuid: "call-webrtc-1", muted: true });
    assert.equal(bridge.sessions.get("call-webrtc-1").muted, true);
    assert.ok(serverCalls.some(c => c.action === "set-muted" && c.uuid === "call-webrtc-1" && c.muted === true));

    // Hangup cleanup test
    bridge.handleHangup({ callUuid: "call-webrtc-1" });
    assert.equal(bridge.sessions.has("call-webrtc-1"), false, "Session should be cleaned up on hangup");

    // Orphan timeout cleanup test (30s in prod, 100ms in test)
    await bridge.handleOffer(mockSocket, {
        callUuid: "call-orphan-1",
        sdp: offer.sdp,
        type: "offer"
    });
    assert.ok(bridge.sessions.has("call-orphan-1"));
    await new Promise(r => setTimeout(r, 200));
    assert.equal(bridge.sessions.has("call-orphan-1"), false, "Orphaned session should auto-cleanup");

    await clientPc.close();

    // 2b. Verify spawnAudioProcess error & stdin EPIPE handling does not crash
    const origResolve = FaceTimeAudioBridge.resolveHelperBinary;
    FaceTimeAudioBridge.resolveHelperBinary = () => "/nonexistent/BlueBubblesAudioBridge";
    const fakeSession = {
        callUuid: "call-missing-bin",
        pc: { close: async () => {} },
        outboundTrack: new MediaStreamTrack({ kind: "audio" }),
        muted: false,
        rtpSeq: 0,
        rtpTimestamp: 0,
        ssrc: 1,
        stdoutBuffer: Buffer.alloc(0)
    };
    bridge.sessions.set("call-missing-bin", fakeSession);
    bridge.spawnAudioProcess(fakeSession);
    bridge.handleMute({ callUuid: "call-missing-bin", muted: true });
    bridge.writeUplinkOpusFrame(fakeSession, Buffer.from([0xf8, 0xff, 0xfe]));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(fakeSession.process, undefined, "Expected session.process to clear on spawn error");
    bridge.cleanupSession("call-missing-bin");
    FaceTimeAudioBridge.resolveHelperBinary = origResolve;

    console.log("PASS: FaceTimeAudioBridge signaling, mute, hangup, orphan cleanup, and process error safety");

    // 3. Test FaceTimeInterface.call (video vs audio) & decline & setMuted
    let admitAndLeaveCalled = false;
    class MockFaceTimeSession {
        constructor({ callUuid }) {
            this.callUuid = callUuid;
        }
        async generateLink() {
            return "https://facetime.apple.com/join#mock-link";
        }
        async admitAndLeave() {
            admitAndLeaveCalled = true;
        }
    }

    const { FaceTimeInterface } = loadTypeScriptModule("../src/server/api/interfaces/facetimeInterface.ts", {
        "@server": { Server: mockServerFn },
        "../lib/facetime/FaceTimeSession": { FaceTimeSession: MockFaceTimeSession },
        "../lib/facetime/FaceTimeAudioBridge": { FaceTimeAudioBridge },
        "@server/env": { isMinMonterey: true },
        "@server/helpers/utils": { checkPrivateApiStatus: () => {} }
    });

    const videoRes = await FaceTimeInterface.call({ addresses: ["+15551234567"], video: true });
    assert.equal(videoRes.link.url, "https://facetime.apple.com/join#mock-link");
    assert.equal(videoRes.call.call_uuid, "test-call-uuid-1");
    assert.equal(videoRes.call.is_video, true);
    assert.equal(admitAndLeaveCalled, true);

    const audioRes = await FaceTimeInterface.call({
        addresses: ["+15551234567"],
        video: false,
        isTelephony: true
    });
    assert.equal(audioRes.link, undefined, "Audio call should not generate FaceTime web link");
    assert.equal(audioRes.call.call_uuid, "test-call-uuid-1");
    assert.equal(audioRes.call.is_video, false);
    assert.equal(audioRes.call.is_telephony, true);

    await FaceTimeInterface.decline("test-call-uuid-1");
    assert.ok(serverCalls.some(c => c.action === "decline-call" && c.uuid === "test-call-uuid-1"));

    await FaceTimeInterface.setMuted("test-call-uuid-1", true);
    assert.ok(serverCalls.some(c => c.action === "set-muted" && c.uuid === "test-call-uuid-1" && c.muted === true));
    console.log("PASS: FaceTimeInterface.call (video & audio), decline, setMuted");

    // 4. Verify httpRoutes.ts registers v1 and v2 facetime/call + decline + set-muted
    const httpRoutesSrc = fs.readFileSync(
        path.resolve(__dirname, "../src/server/api/http/api/v1/httpRoutes.ts"),
        "utf8"
    );
    assert.ok(httpRoutesSrc.includes('"decline/:call_uuid"'), "Missing decline/:call_uuid route");
    assert.ok(httpRoutesSrc.includes('"set-muted/:call_uuid"'), "Missing set-muted/:call_uuid route");
    assert.ok(httpRoutesSrc.includes('["v2", "facetime", "call"]') || httpRoutesSrc.includes('"v2", "facetime", "call"'), "Missing /api/v2/facetime/call alias");

    // 5. Verify GeneralInterface exposes supportsFaceTimeCalls
    const generalSrc = fs.readFileSync(
        path.resolve(__dirname, "../src/server/api/interfaces/generalInterface.ts"),
        "utf8"
    );
    assert.ok(generalSrc.includes("supportsFaceTimeCalls"), "Missing supportsFaceTimeCalls in GeneralInterface");
    console.log("PASS: HttpRoutes (v1/v2) and GeneralInterface supportsFaceTimeCalls");
}

run().catch(err => {
    console.error("FAIL:", err);
    process.exit(1);
});
