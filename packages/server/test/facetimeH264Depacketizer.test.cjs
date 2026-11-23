const assert = require("node:assert/strict");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const babel = require("@babel/core");
const { RtpHeader, RtpPacket } = require("werift");

const loadTypeScriptModule = (modulePath, overrides = {}) => {
    const transformed = babel.transformFileSync(modulePath, {
        presets: [
            [require.resolve("@babel/preset-env"), { targets: { node: "20" }, modules: "commonjs" }],
            require.resolve("@babel/preset-typescript")
        ]
    });
    const loadedModule = { exports: {} };
    const loadModule = new Function("module", "exports", "require", "__dirname", "__filename", transformed.code);
    const customRequire = request => {
        if (overrides[request]) return overrides[request];
        if (request.startsWith("./") || request.startsWith("../")) {
            const tsCandidate = path.resolve(path.dirname(modulePath), `${request}.ts`);
            if (require("fs").existsSync(tsCandidate)) {
                return loadTypeScriptModule(tsCandidate, overrides);
            }
        }
        return require(request);
    };
    loadModule(loadedModule, loadedModule.exports, customRequire, path.dirname(modulePath), modulePath);
    return loadedModule.exports;
};

const bridgePath = path.join(__dirname, "../src/server/api/lib/facetime/FaceTimeAudioBridge.ts");

function loadBridgeModule() {
    const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    return loadTypeScriptModule(bridgePath, {
        "@server": { Server: () => null },
        "@server/env": {},
        "@server/fileSystem": { FileSystem: { resources: "/tmp/bb-resources" } },
        "@server/lib/logging/Loggable": {
            Loggable: class {
                log = noopLog;
            }
        },
        "./FaceTimeCameraHook": { setCameraHookActiveFlag: () => {} },
        "./FaceTimeAdaptiveController": { FaceTimeAdaptiveController: class {} }
    });
}

function makeRtp(seq, timestamp, payload, marker = true) {
    return new RtpPacket(
        new RtpHeader({
            payloadType: 96,
            sequenceNumber: seq & 0xffff,
            timestamp: timestamp >>> 0,
            ssrc: 0x12345678,
            marker
        }),
        payload
    );
}

test("empty payload (padding/probe) advances lastSeq without triggering onSeqGap", () => {
    const { H264RtpDepacketizer } = loadBridgeModule();
    const aus = [];
    let gaps = 0;
    const depacketizer = new H264RtpDepacketizer(
        (au, info) => aus.push({ au, isIdr: info.isIdr }),
        () => {
            gaps += 1;
        }
    );

    const pSlice = Buffer.from([0x41, 0x9a, 0x01]);
    depacketizer.pushPacket(makeRtp(100, 1000, Buffer.alloc(0), false));
    depacketizer.pushPacket(makeRtp(101, 2000, pSlice, true));
    depacketizer.pushPacket(makeRtp(102, 2000, Buffer.alloc(0), false));
    depacketizer.pushPacket(makeRtp(103, 3000, pSlice, true));

    assert.equal(gaps, 0);
    assert.equal(aus.length, 2);
});

test("out-of-order and duplicate packets are dropped without triggering onSeqGap or corrupting pending AU", () => {
    const { H264RtpDepacketizer } = loadBridgeModule();
    const aus = [];
    let gaps = 0;
    const depacketizer = new H264RtpDepacketizer(
        (au, info) => aus.push({ au, isIdr: info.isIdr }),
        () => {
            gaps += 1;
        }
    );

    const sps = Buffer.from([0x67, 0x42, 0x00, 0x1e]);
    const idr = Buffer.from([0x65, 0x88, 0x84]);
    const stale = Buffer.from([0x41, 0xde, 0xad]);

    depacketizer.pushPacket(makeRtp(65534, 1000, sps, false));
    // Duplicate of 65534 and older 65533 must be ignored
    depacketizer.pushPacket(makeRtp(65534, 1000, stale, true));
    depacketizer.pushPacket(makeRtp(65533, 900, stale, true));
    // Next in-order wraps around 65535 -> 0
    depacketizer.pushPacket(makeRtp(65535, 1000, idr, true));
    // Late packet from before wrap-around (65535) when expected is 0
    depacketizer.pushPacket(makeRtp(65535, 1000, stale, true));
    // In-order packet 0
    depacketizer.pushPacket(makeRtp(0, 2000, Buffer.from([0x41, 0x01]), true));

    assert.equal(gaps, 0);
    assert.equal(aus.length, 2);
    assert.equal(aus[0].isIdr, true);
    assert.deepEqual(
        aus[0].au,
        Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), sps, Buffer.from([0x00, 0x00, 0x00, 0x01]), idr])
    );
    assert.equal(aus[1].isIdr, false);
});

test("forward gap discards pending AU/FU, triggers onSeqGap, and suppresses non-IDR AUs until IDR", () => {
    const { H264RtpDepacketizer } = loadBridgeModule();
    const aus = [];
    let gaps = 0;
    const depacketizer = new H264RtpDepacketizer(
        (au, info) => aus.push({ au, isIdr: info.isIdr }),
        () => {
            gaps += 1;
        }
    );

    // Start an AU + partial FU-A at seq 10..11
    depacketizer.pushPacket(makeRtp(10, 1000, Buffer.from([0x41, 0x01]), false));
    depacketizer.pushPacket(makeRtp(11, 1000, Buffer.from([0x7c, 0x85, 0xaa, 0xbb]), false));

    // Forward gap: jump to seq 13 (non-IDR P-frame) -> discards pending AU+FU, sets needIdr=true, calls onSeqGap
    depacketizer.pushPacket(makeRtp(13, 2000, Buffer.from([0x41, 0x02]), true));
    // Another non-IDR P-frame while needIdr=true -> suppressed
    depacketizer.pushPacket(makeRtp(14, 3000, Buffer.from([0x41, 0x03]), true));

    assert.equal(gaps, 1);
    assert.equal(aus.length, 0);

    // IDR frame arrives -> clears needIdr and emits
    const idr = Buffer.from([0x65, 0x88, 0x99]);
    depacketizer.pushPacket(makeRtp(15, 4000, idr, true));
    // Subsequent P-frame -> emitted normally
    const pAfter = Buffer.from([0x41, 0x04]);
    depacketizer.pushPacket(makeRtp(16, 5000, pAfter, true));

    assert.equal(aus.length, 2);
    assert.equal(aus[0].isIdr, true);
    assert.deepEqual(aus[0].au, Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), idr]));
    assert.equal(aus[1].isIdr, false);
    assert.deepEqual(aus[1].au, Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), pAfter]));
});

test("backpressure drop resets depacketizer with needIdr=true and forces PLI", () => {
    const { FaceTimeAudioBridge, H264RtpDepacketizer } = loadBridgeModule();
    const bridge = new FaceTimeAudioBridge();
    const aus = [];
    const depacketizer = new H264RtpDepacketizer((au, info) => aus.push({ au, isIdr: info.isIdr }));

    const pliSsrcs = [];
    const stdin = new PassThrough();
    const session = {
        cameraEnabled: true,
        cameraBackpressured: true,
        cameraProcess: { stdin },
        depacketizer,
        uplinkVideoSsrc: 0xdeadbeef,
        lastPliSentAt: Date.now(),
        videoTransceiver: {
            receiver: {
                track: { ssrc: 0xdeadbeef },
                sendRtcpPLI: async ssrc => {
                    pliSsrcs.push(ssrc);
                }
            }
        }
    };

    bridge.writeUplinkVideoAccessUnit(session, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x01]));
    assert.deepEqual(pliSsrcs, [0xdeadbeef]);

    // Depacketizer must now gate non-IDR AUs until an IDR arrives
    depacketizer.pushPacket(makeRtp(1, 1000, Buffer.from([0x41, 0x02]), true));
    assert.equal(aus.length, 0);

    depacketizer.pushPacket(makeRtp(2, 2000, Buffer.from([0x65, 0x88]), true));
    assert.equal(aus.length, 1);
    assert.equal(aus[0].isIdr, true);
});
