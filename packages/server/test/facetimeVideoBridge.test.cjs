const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const babel = require("@babel/core");
const { RTCPeerConnection, useH264, useOPUS } = require("werift");

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
const bridgePath = path.join(srcRoot, "api/lib/facetime/FaceTimeAudioBridge.ts");

function createBridgeModule({ spawnImpl, existsSyncImpl } = {}) {
    const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    return loadTypeScriptModule(bridgePath, {
        child_process: {
            spawn: spawnImpl ?? (() => {
                const proc = new EventEmitter();
                proc.stdin = new PassThrough();
                proc.stdout = new PassThrough();
                proc.stderr = new PassThrough();
                proc.killed = false;
                proc.kill = () => {
                    proc.killed = true;
                    return true;
                };
                return proc;
            })
        },
        fs: {
            existsSync: existsSyncImpl ?? (p => String(p).endsWith("BlueBubblesVideoBridge"))
        },
        "@server": { Server: () => null },
        "@server/fileSystem": { FileSystem: { resources: "/tmp/bb-resources" } },
        "@server/lib/logging/Loggable": {
            Loggable: class {
                log = noopLog;
            }
        }
    });
}

test("splitAnnexBNalus splits 3-byte and 4-byte start codes", () => {
    const { splitAnnexBNalus } = createBridgeModule();
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f]);
    const pps = Buffer.from([0x68, 0xce, 0x38, 0x80]);
    const idr = Buffer.from([0x65, 0x88, 0x84, 0x21, 0x01]);

    const au = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x01]),
        sps,
        Buffer.from([0x00, 0x00, 0x01]),
        pps,
        Buffer.from([0x00, 0x00, 0x00, 0x01]),
        idr
    ]);

    const nalus = splitAnnexBNalus(au);
    assert.equal(nalus.length, 3);
    assert.deepEqual(nalus[0], sps);
    assert.deepEqual(nalus[1], pps);
    assert.deepEqual(nalus[2], idr);
    assert.deepEqual(splitAnnexBNalus(Buffer.alloc(0)), []);
});

test("packetizeH264Nalus handles single-NALU and FU-A fragmentation with marker bit on last packet", () => {
    const { packetizeH264Nalus } = createBridgeModule();

    // Small SPS + PPS + large IDR (>1200 bytes)
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f, 0xaa]);
    const pps = Buffer.from([0x68, 0xce, 0x38, 0x80]);
    const bigIdr = Buffer.alloc(2500, 0xab);
    bigIdr[0] = 0x65; // F=0, NRI=3 (0x60), Type=5 (IDR)

    const { packets, nextSeq } = packetizeH264Nalus([sps, pps, bigIdr], {
        payloadType: 102,
        ssrc: 0x12345678,
        timestamp: 90000,
        startSeq: 10
    });

    assert.equal(packets.length, 5); // 1 (SPS) + 1 (PPS) + 3 (FU-A of 2499 payload bytes @ 1198/pkt)
    assert.equal(nextSeq, 15);

    // Single NALUs
    assert.deepEqual(packets[0].payload, sps);
    assert.equal(packets[0].header.marker, false);
    assert.equal(packets[0].header.sequenceNumber, 11);
    assert.equal(packets[0].header.timestamp, 90000);
    assert.equal(packets[0].header.payloadType, 102);

    assert.deepEqual(packets[1].payload, pps);
    assert.equal(packets[1].header.marker, false);

    // FU-A fragments
    const fuFragments = packets.slice(2);
    for (const pkt of fuFragments) {
        assert.ok(pkt.payload.length <= 1200);
        assert.equal(pkt.header.timestamp, 90000);
        assert.equal(pkt.payload[0], (0x65 & 0xe0) | 28); // FU indicator
        assert.equal(pkt.payload[1] & 0x1f, 5); // NAL type 5
    }
    // Start bit only on first fragment, End bit only on last fragment, Marker only on last packet of AU
    assert.equal(Boolean(fuFragments[0].payload[1] & 0x80), true);
    assert.equal(Boolean(fuFragments[0].payload[1] & 0x40), false);
    assert.equal(fuFragments[0].header.marker, false);

    assert.equal(Boolean(fuFragments[1].payload[1] & 0x80), false);
    assert.equal(Boolean(fuFragments[1].payload[1] & 0x40), false);
    assert.equal(fuFragments[1].header.marker, false);

    assert.equal(Boolean(fuFragments[2].payload[1] & 0x80), false);
    assert.equal(Boolean(fuFragments[2].payload[1] & 0x40), true);
    assert.equal(fuFragments[2].header.marker, true);

    // Reassemble FU-A fragments and verify exact match with bigIdr
    const reassembled = Buffer.concat([
        Buffer.from([(fuFragments[0].payload[0] & 0xe0) | (fuFragments[0].payload[1] & 0x1f)]),
        ...fuFragments.map(p => p.payload.subarray(2))
    ]);
    assert.deepEqual(reassembled, bigIdr);
});

test("handleOffer negotiates H.264 sendonly video, streams length-prefixed Annex-B frames, and cleans up videoProcess", async () => {
    const spawned = [];
    const { FaceTimeAudioBridge } = createBridgeModule({
        existsSyncImpl: p => String(p).endsWith("BlueBubblesVideoBridge"),
        spawnImpl: bin => {
            const proc = new EventEmitter();
            proc.bin = bin;
            proc.stdin = new PassThrough();
            proc.stdout = new PassThrough();
            proc.stderr = new PassThrough();
            proc.killed = false;
            proc.killCalls = [];
            proc.kill = sig => {
                proc.killed = true;
                proc.killCalls.push(sig);
                return true;
            };
            spawned.push(proc);
            return proc;
        }
    });

    const bridge = new FaceTimeAudioBridge();
    const clientPc = new RTCPeerConnection({
        codecs: { audio: [useOPUS()], video: [useH264({ payloadType: 102 })] }
    });
    clientPc.addTransceiver("audio", { direction: "sendrecv" });
    clientPc.addTransceiver("video", { direction: "recvonly" });
    const offer = await clientPc.createOffer();

    const emitted = [];
    const mockSocket = { id: "sock-1", emit: (ev, data) => emitted.push({ ev, data }) };

    await bridge.handleOffer(mockSocket, {
        callUuid: "call-video-1",
        sdp: offer.sdp,
        type: "offer",
        video: true
    });

    const answerMsg = emitted.find(e => e.ev === "ft-bridge-answer");
    assert.ok(answerMsg, "ft-bridge-answer should be emitted");
    assert.match(answerMsg.data.sdp, /^m=video\b/m);
    assert.match(answerMsg.data.sdp, /H264\/90000/);
    assert.match(answerMsg.data.sdp, /a=sendonly/);

    assert.equal(spawned.length, 1);
    assert.ok(spawned[0].bin.endsWith("BlueBubblesVideoBridge"));

    const session = bridge.sessions.get("call-video-1");
    assert.ok(session?.outboundVideoTrack);
    assert.equal(session.videoPayloadType, 102);

    const writtenRtp = [];
    session.outboundVideoTrack.writeRtp = pkt => writtenRtp.push(pkt);

    // Emit a 4-byte BE length-prefixed Annex-B access unit in two chunks to test buffering
    const au = Buffer.from([
        0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xe0, 0x1f,
        0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21
    ]);
    const framed = Buffer.allocUnsafe(4 + au.length);
    framed.writeUInt32BE(au.length, 0);
    au.copy(framed, 4);

    spawned[0].stdout.write(framed.subarray(0, 6));
    spawned[0].stdout.write(framed.subarray(6));
    await new Promise(r => setImmediate(r));

    assert.equal(writtenRtp.length, 2);
    assert.equal(writtenRtp[0].header.payloadType, 102);
    assert.equal(writtenRtp[0].header.marker, false);
    assert.equal(writtenRtp[1].header.marker, true);
    assert.equal(writtenRtp[0].header.timestamp, writtenRtp[1].header.timestamp);

    // Unexpected video process exit keeps audio session alive
    spawned[0].emit("exit", 1);
    assert.equal(bridge.sessions.has("call-video-1"), true);
    assert.equal(session.videoProcess, undefined);

    // Cleanup kills any active videoProcess and closes pc
    const fakeProc = new EventEmitter();
    fakeProc.killed = false;
    fakeProc.killCalls = [];
    fakeProc.kill = sig => {
        fakeProc.killed = true;
        fakeProc.killCalls.push(sig);
        return true;
    };
    session.videoProcess = fakeProc;

    bridge.cleanupSession("call-video-1");
    assert.deepEqual(fakeProc.killCalls, ["SIGTERM"]);
    assert.equal(bridge.sessions.has("call-video-1"), false);
    await clientPc.close();
});

test("handleOffer degrades gracefully to audio-only when BlueBubblesVideoBridge binary is missing", async () => {
    const spawned = [];
    const { FaceTimeAudioBridge } = createBridgeModule({
        existsSyncImpl: () => false,
        spawnImpl: bin => {
            spawned.push(bin);
            return new EventEmitter();
        }
    });

    const bridge = new FaceTimeAudioBridge();
    const clientPc = new RTCPeerConnection({
        codecs: { audio: [useOPUS()], video: [useH264()] }
    });
    clientPc.addTransceiver("audio", { direction: "sendrecv" });
    clientPc.addTransceiver("video", { direction: "recvonly" });
    const offer = await clientPc.createOffer();

    const emitted = [];
    await bridge.handleOffer(
        { id: "sock-2", emit: (ev, data) => emitted.push({ ev, data }) },
        { callUuid: "call-audio-fallback", sdp: offer.sdp, type: "offer", video: true }
    );

    const answerMsg = emitted.find(e => e.ev === "ft-bridge-answer");
    assert.ok(answerMsg);
    // RFC 3264: rejected video m-line has port 0 and a=inactive (no sendonly track)
    assert.match(answerMsg.data.sdp, /^m=video 0\b/m);
    assert.match(answerMsg.data.sdp, /a=inactive/);
    assert.doesNotMatch(answerMsg.data.sdp, /a=sendonly/);
    assert.equal(bridge.sessions.get("call-audio-fallback")?.outboundVideoTrack, undefined);
    assert.equal(spawned.length, 0);

    bridge.cleanupSession("call-audio-fallback");
    await clientPc.close();
});

test("ft-bridge-config and bridgeStatus expose videoSupported", async () => {
    const { FaceTimeAudioBridge } = createBridgeModule({
        existsSyncImpl: p => String(p).endsWith("BlueBubblesVideoBridge")
    });
    const fakeInstance = new FaceTimeAudioBridge();

    const { registerForkSocketRoutes } = loadTypeScriptModule(
        path.join(srcRoot, "api/http/api/v1/socketForkRoutes.ts"),
        {
            "@server/api/lib/facetime/FaceTimeAudioBridge": { FaceTimeAudioBridge }
        }
    );

    const handlers = {};
    registerForkSocketRoutes(
        { on: (ev, fn) => { handlers[ev] = fn; } },
        { debug: () => {} }
    );

    let configAck = null;
    handlers["ft-bridge-config"](payload => { configAck = payload; });
    assert.equal(configAck.videoSupported, true);
    assert.ok(Array.isArray(configAck.iceServers));

    let sentStatus = null;
    const { FaceTimeRouter } = loadTypeScriptModule(
        path.join(srcRoot, "api/http/api/v1/routers/facetimeRouter.ts"),
        {
            "@server": { Server: () => ({ repo: { getConfig: () => true }, privateApi: { helper: {} } }) },
            "@server/api/lib/facetime/FaceTimeAudioBridge": {
                FaceTimeAudioBridge: Object.assign(FaceTimeAudioBridge, {
                    getInstance: () => fakeInstance
                })
            },
            "../responses/errors": { BadRequest: Error },
            "../responses/success": {
                NoData: class {},
                Success: class {
                    constructor(_ctx, body) { this.body = body; }
                    send() { sentStatus = this.body; }
                }
            },
            "@server/api/interfaces/facetimeInterface": { FaceTimeInterface: {} }
        }
    );

    await FaceTimeRouter.bridgeStatus({}, () => {});
    assert.equal(sentStatus.data.videoSupported, true);
    assert.equal(sentStatus.data.binaryFound, false);
});
