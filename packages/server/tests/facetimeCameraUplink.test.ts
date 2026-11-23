import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import ts from "typescript";
import { RTCPeerConnection, RtpHeader, RtpPacket, useH264, useOPUS } from "werift";

const require = createRequire(import.meta.url);

// Transpile .ts files on the fly so `node --test` runs directly.
require.extensions[".ts"] = function (module: any, filename: string) {
    const source = fs.readFileSync(filename, "utf8");
    const { outputText } = ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
            experimentalDecorators: true,
            emitDecoratorMetadata: true
        }
    });
    return module._compile(outputText, filename);
};

const srcRoot = path.resolve(import.meta.dirname, "../src");

function createMockProcess(bin: string) {
    const proc = new EventEmitter() as any;
    proc.bin = bin;
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.killCalls = [] as string[];
    proc.kill = (sig: string) => {
        proc.killed = true;
        proc.killCalls.push(sig);
        return true;
    };
    return proc;
}

function loadBridgeWithMocks(
    options: {
        existsSync?: (p: string) => boolean;
        spawn?: (bin: string) => any;
        findSession?: (id: string) => { status: number } | null;
    } = {}
) {
    const origLoad = (Module as any)._load;
    const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const bridgePath = path.join(srcRoot, "server/api/lib/facetime/FaceTimeAudioBridge.ts");
    delete require.cache[bridgePath];

    (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
        if (request === "child_process") {
            return { spawn: options.spawn ?? ((bin: string) => createMockProcess(bin)) };
        }
        if (request === "fs") {
            return {
                ...fs,
                existsSync: options.existsSync ?? (() => true)
            };
        }
        if (request === "@server") {
            return { Server: () => null };
        }
        if (request === "@server/env") {
            return new Proxy({}, { get: () => () => true });
        }
        if (request === "./FaceTimeCameraHook") {
            return { setCameraHookActiveFlag: () => {} };
        }
        if (request === "@server/fileSystem") {
            return { FileSystem: { resources: "/tmp/bb-resources" } };
        }
        if (request === "@server/lib/logging/Loggable") {
            return {
                Loggable: class {
                    log = noopLog;
                }
            };
        }
        if (request === "./FacetimeSessionManager" || request === "@server/api/lib/facetime/FacetimeSessionManager") {
            return {
                FaceTimeSessionManager: () => ({
                    findSession: options.findSession ?? (() => null)
                })
            };
        }
        return origLoad.apply(this, arguments);
    };

    try {
        return require(bridgePath);
    } finally {
        (Module as any)._load = origLoad;
    }
}

test("H264RtpDepacketizer reassembles single NALUs, STAP-A, and FU-A into Annex-B access units", () => {
    const { H264RtpDepacketizer, packetizeH264Nalus } = loadBridgeWithMocks();

    const aus: Array<{ data: Buffer; isIdr: boolean }> = [];
    let gapCount = 0;
    const depacketizer = new H264RtpDepacketizer(
        (au: Buffer, info: { isIdr: boolean }) => aus.push({ data: au, isIdr: info.isIdr }),
        () => {
            gapCount += 1;
        }
    );

    // 1. STAP-A with SPS + PPS (timestamp 1000, marker=false)
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x1f, 0xda]);
    const pps = Buffer.from([0x68, 0xce, 0x38, 0x80]);
    const stapA = Buffer.allocUnsafe(1 + 2 + sps.length + 2 + pps.length);
    stapA[0] = 0x78; // NRI=3, Type=24 (STAP-A)
    stapA.writeUInt16BE(sps.length, 1);
    sps.copy(stapA, 3);
    stapA.writeUInt16BE(pps.length, 3 + sps.length);
    pps.copy(stapA, 5 + sps.length);

    depacketizer.pushPacket(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 1, timestamp: 1000, ssrc: 0x11223344, marker: false }),
            stapA
        )
    );
    assert.equal(aus.length, 0);

    // 2. Large IDR fragmented via FU-A (same timestamp 1000, marker=true on last fragment)
    const bigIdr = Buffer.alloc(2600, 0xab);
    bigIdr[0] = 0x65; // IDR
    const { packets } = packetizeH264Nalus([bigIdr], {
        payloadType: 96,
        ssrc: 0x11223344,
        timestamp: 1000,
        startSeq: 1
    });
    assert.ok(packets.length >= 3);
    for (const pkt of packets) {
        depacketizer.pushPacket(pkt);
    }

    assert.equal(gapCount, 0);
    assert.equal(aus.length, 1);
    assert.equal(aus[0].isIdr, true);

    const sc = Buffer.from([0x00, 0x00, 0x00, 0x01]);
    const expectedAu = Buffer.concat([sc, sps, sc, pps, sc, bigIdr]);
    assert.deepEqual(aus[0].data, expectedAu);

    // 3. Timestamp change flushes previous AU without marker bit
    const nonIdr = Buffer.from([0x41, 0x9a, 0x22, 0x11]);
    depacketizer.pushPacket(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 5, timestamp: 4000, ssrc: 0x11223344, marker: false }),
            nonIdr
        )
    );
    assert.equal(aus.length, 1);

    const nextNonIdr = Buffer.from([0x41, 0x9a, 0x33, 0x44]);
    depacketizer.pushPacket(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 6, timestamp: 7000, ssrc: 0x11223344, marker: true }),
            nextNonIdr
        )
    );
    assert.equal(aus.length, 3);
    assert.equal(aus[1].isIdr, false);
    assert.deepEqual(aus[1].data, Buffer.concat([sc, nonIdr]));
    assert.deepEqual(aus[2].data, Buffer.concat([sc, nextNonIdr]));
});

test("H264RtpDepacketizer flushes on timestamp change, detects sequence gaps, and gates on IDR", () => {
    const { H264RtpDepacketizer } = loadBridgeWithMocks();
    const aus: Array<{ data: Buffer; isIdr: boolean }> = [];
    let gapCount = 0;
    const depacketizer = new H264RtpDepacketizer(
        (au: Buffer, info: { isIdr: boolean }) => aus.push({ data: au, isIdr: info.isIdr }),
        () => {
            gapCount += 1;
        }
    );

    const sc = Buffer.from([0x00, 0x00, 0x00, 0x01]);
    const slice1 = Buffer.from([0x41, 0x01, 0x02]);
    const slice2 = Buffer.from([0x41, 0x03, 0x04]);
    const idr = Buffer.from([0x65, 0x88, 0x84]);

    depacketizer.pushPacket(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 10, timestamp: 1000, ssrc: 1, marker: false }),
            slice1
        )
    );
    // Sequence gap (10 -> 12): discards pending AU, suppresses non-IDR until IDR
    depacketizer.pushPacket(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 12, timestamp: 4000, ssrc: 1, marker: true }),
            slice2
        )
    );
    assert.equal(gapCount, 1);
    assert.equal(aus.length, 0);

    // IDR recovery clears needIdr and emits
    depacketizer.pushPacket(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 13, timestamp: 7000, ssrc: 1, marker: true }),
            idr
        )
    );
    assert.equal(aus.length, 1);
    assert.equal(aus[0].isIdr, true);
    assert.deepEqual(aus[0].data, Buffer.concat([sc, idr]));
});

test("FaceTimeAudioBridge negotiates sendrecv, streams depacketized AUs to BlueBubblesCameraBridge, handles ft-bridge-camera & backpressure", async () => {
    const spawned: any[] = [];
    const { FaceTimeAudioBridge } = loadBridgeWithMocks({
        existsSync: p => p.endsWith("BlueBubblesVideoBridge") || p.endsWith("BlueBubblesCameraBridge"),
        spawn: bin => {
            const proc = createMockProcess(bin);
            spawned.push(proc);
            return proc;
        }
    });

    const bridge = new FaceTimeAudioBridge();
    const clientPc = new RTCPeerConnection({
        codecs: { audio: [useOPUS()], video: [useH264({ payloadType: 96 })] }
    });
    clientPc.addTransceiver("audio", { direction: "sendrecv" });
    clientPc.addTransceiver("video", { direction: "sendrecv" });
    const offer = await clientPc.createOffer();

    const emitted: Array<{ ev: string; data: any }> = [];
    await bridge.handleOffer(
        { id: "sock-uplink", emit: (ev: string, data: any) => emitted.push({ ev, data }) },
        { callUuid: "call-uplink-1", sdp: offer.sdp, type: "offer", video: true, uplinkVideo: true }
    );

    const answer = emitted.find(e => e.ev === "ft-bridge-answer");
    assert.ok(answer);
    assert.equal(answer.data.uplinkVideo, true);
    const videoSection = answer.data.sdp.split(/^m=/m).find((s: string) => s.startsWith("video ")) ?? "";
    assert.match(videoSection, /a=sendrecv/);

    const camProc = spawned.find(p => p.bin.endsWith("BlueBubblesCameraBridge"));
    assert.ok(camProc, "BlueBubblesCameraBridge should be spawned");

    const session = bridge.sessions.get("call-uplink-1");
    assert.ok(session?.videoTransceiver);

    const camWrites: Buffer[] = [];
    let nextWriteReturn = true;
    camProc.stdin.write = (chunk: Buffer) => {
        camWrites.push(Buffer.from(chunk));
        return nextWriteReturn;
    };

    const pliCalls: number[] = [];
    session.videoTransceiver.receiver.sendRtcpPLI = async (ssrc: number) => {
        pliCalls.push(ssrc);
    };

    // Simulate incoming IDR RTP packet
    const idrNalu = Buffer.from([0x65, 0x88, 0x84, 0x21]);
    session.videoTransceiver.receiver.track.onReceiveRtp.execute(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 1, timestamp: 9000, ssrc: 0xdeadbeef, marker: true }),
            idrNalu
        )
    );

    assert.equal(session.receivedFirstIdr, true);
    assert.equal(camWrites.length, 1);
    const expectedFrame = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), idrNalu]);
    assert.equal(camWrites[0].readUInt32BE(0), expectedFrame.length);
    assert.deepEqual(camWrites[0].subarray(4), expectedFrame);

    // Sequence gap triggers PLI (reset cooldown from initial startPliLoop) and gates non-IDR until IDR
    session.lastPliSentAt = 0;
    session.videoTransceiver.receiver.track.onReceiveRtp.execute(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 3, timestamp: 12000, ssrc: 0xdeadbeef, marker: true }),
            Buffer.from([0x41, 0x01, 0x02])
        )
    );
    assert.deepEqual(pliCalls, [0xdeadbeef]);
    assert.equal(camWrites.length, 1);
    session.videoTransceiver.receiver.track.onReceiveRtp.execute(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 4, timestamp: 15000, ssrc: 0xdeadbeef, marker: true }),
            Buffer.from([0x65, 0x88, 0x84, 0x22])
        )
    );
    assert.equal(camWrites.length, 2);

    // Backpressure: write returns false -> drop until drain, reset depacketizer (needIdr) + force PLI
    nextWriteReturn = false;
    session.videoTransceiver.receiver.track.onReceiveRtp.execute(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 5, timestamp: 18000, ssrc: 0xdeadbeef, marker: true }),
            Buffer.from([0x41, 0x03, 0x04])
        )
    );
    assert.equal(camWrites.length, 3);
    session.videoTransceiver.receiver.track.onReceiveRtp.execute(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 6, timestamp: 21000, ssrc: 0xdeadbeef, marker: true }),
            Buffer.from([0x41, 0x05, 0x06])
        )
    );
    assert.equal(camWrites.length, 3, "frame should be dropped while backpressured");
    assert.equal(pliCalls.length, 2, "backpressure drop should force PLI");

    nextWriteReturn = true;
    camProc.stdin.emit("drain");
    session.videoTransceiver.receiver.track.onReceiveRtp.execute(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 7, timestamp: 24000, ssrc: 0xdeadbeef, marker: true }),
            Buffer.from([0x41, 0x07, 0x08])
        )
    );
    assert.equal(camWrites.length, 3, "non-IDR suppressed after backpressure reset until IDR");
    session.videoTransceiver.receiver.track.onReceiveRtp.execute(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 8, timestamp: 27000, ssrc: 0xdeadbeef, marker: true }),
            Buffer.from([0x65, 0x88, 0x84, 0x23])
        )
    );
    assert.equal(camWrites.length, 4, "frames resume after drain on IDR");

    // Disable camera -> sends 4-byte zero clear frame and stops writing
    bridge.handleCamera({ callUuid: "call-uplink-1", enabled: false });
    assert.equal(camWrites.length, 5);
    assert.deepEqual(camWrites[4], Buffer.alloc(4, 0));

    session.videoTransceiver.receiver.track.onReceiveRtp.execute(
        new RtpPacket(
            new RtpHeader({ payloadType: 96, sequenceNumber: 7, timestamp: 24000, ssrc: 0xdeadbeef, marker: true }),
            Buffer.from([0x41, 0x09, 0x0a])
        )
    );
    assert.equal(camWrites.length, 5, "no frames written while camera disabled");

    // Cleanup kills cameraProcess
    bridge.cleanupSession("call-uplink-1");
    assert.deepEqual(camProc.killCalls, ["SIGTERM"]);
    await clientPc.close();
});

test("FaceTimeAudioBridge falls back to sendonly downlink when BlueBubblesCameraBridge is missing", async () => {
    const spawned: any[] = [];
    const { FaceTimeAudioBridge } = loadBridgeWithMocks({
        existsSync: p => p.endsWith("BlueBubblesVideoBridge"),
        spawn: bin => {
            const proc = createMockProcess(bin);
            spawned.push(proc);
            return proc;
        }
    });

    const bridge = new FaceTimeAudioBridge();
    const clientPc = new RTCPeerConnection({
        codecs: { audio: [useOPUS()], video: [useH264({ payloadType: 96 })] }
    });
    clientPc.addTransceiver("audio", { direction: "sendrecv" });
    clientPc.addTransceiver("video", { direction: "sendrecv" });
    const offer = await clientPc.createOffer();

    const emitted: Array<{ ev: string; data: any }> = [];
    await bridge.handleOffer(
        { id: "sock-fallback", emit: (ev: string, data: any) => emitted.push({ ev, data }) },
        { callUuid: "call-fallback-1", sdp: offer.sdp, type: "offer", video: true, uplinkVideo: true }
    );

    const answer = emitted.find(e => e.ev === "ft-bridge-answer");
    assert.ok(answer);
    assert.equal(answer.data.uplinkVideo, false);
    const videoSection = answer.data.sdp.split(/^m=/m).find((s: string) => s.startsWith("video ")) ?? "";
    assert.match(videoSection, /a=sendonly/);
    assert.equal(spawned.some(p => p.bin.endsWith("BlueBubblesCameraBridge")), false);

    bridge.cleanupSession("call-fallback-1");
    await clientPc.close();
});

test("H264RtpDepacketizer supports 4MB 1080p IDR access units and drops >4MB AUs", () => {
    const { H264RtpDepacketizer, packetizeH264Nalus } = loadBridgeWithMocks();

    const aus: Array<{ data: Buffer; isIdr: boolean }> = [];
    const depacketizer = new H264RtpDepacketizer((au: Buffer, info: { isIdr: boolean }) =>
        aus.push({ data: au, isIdr: info.isIdr })
    );

    // 2.5 MB IDR (> legacy 2MB cap, <= 4MB cap) should succeed.
    const idr25Mb = Buffer.alloc(2_500_000, 0x7a);
    idr25Mb[0] = 0x65;
    const { packets, nextSeq } = packetizeH264Nalus([idr25Mb], {
        payloadType: 96,
        ssrc: 0x22334455,
        timestamp: 9000,
        startSeq: 0
    });
    for (const pkt of packets) {
        depacketizer.pushPacket(pkt);
    }
    assert.equal(aus.length, 1);
    assert.equal(aus[0].isIdr, true);
    assert.equal(aus[0].data.length, 4 + idr25Mb.length);

    // >4 MB IDR must be dropped safely.
    const idrTooBig = Buffer.alloc(4 * 1024 * 1024 + 128, 0x55);
    idrTooBig[0] = 0x65;
    const oversized = packetizeH264Nalus([idrTooBig], {
        payloadType: 96,
        ssrc: 0x22334455,
        timestamp: 12000,
        startSeq: nextSeq
    });
    for (const pkt of oversized.packets) {
        depacketizer.pushPacket(pkt);
    }
    assert.equal(aus.length, 1);
});

test("FaceTimeAudioBridge forwards voiceIsolation opcode 0x04 to audioProc.stdin", async () => {
    const spawned: any[] = [];
    const { FaceTimeAudioBridge } = loadBridgeWithMocks({
        existsSync: p => p.endsWith("BlueBubblesAudioBridge"),
        spawn: bin => {
            const proc = createMockProcess(bin);
            spawned.push(proc);
            return proc;
        }
    });

    const bridge = new FaceTimeAudioBridge();
    const clientPc = new RTCPeerConnection({ codecs: { audio: [useOPUS()] } });
    clientPc.addTransceiver("audio", { direction: "sendrecv" });
    const offer = await clientPc.createOffer();

    await bridge.handleOffer(
        { id: "sock-voice-iso", emit: () => {} },
        { callUuid: "call-vi-1", sdp: offer.sdp, type: "offer", voiceIsolation: false }
    );

    const audioProc = spawned.find(p => p.bin.endsWith("BlueBubblesAudioBridge"));
    assert.ok(audioProc);
    const writes: Buffer[] = [];
    const origWrite = audioProc.stdin.write.bind(audioProc.stdin);
    audioProc.stdin.write = (chunk: Buffer) => {
        writes.push(Buffer.from(chunk));
        return origWrite(chunk);
    };

    assert.equal(bridge.setVoiceIsolation("call-vi-1", true), true);
    bridge.handleAudioConfig({ callUuid: "call-vi-1", voiceIsolation: false });

    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], Buffer.from([0x04, 0x00, 0x00, 0x00, 0x01, 0x01]));
    assert.deepEqual(writes[1], Buffer.from([0x04, 0x00, 0x00, 0x00, 0x01, 0x00]));

    bridge.cleanupSession("call-vi-1");
    await clientPc.close();
});

test("socketForkRoutes handles ft-bridge-camera and exposes videoUplinkSupported in config and bridgeStatus", async () => {
    const { FaceTimeAudioBridge } = loadBridgeWithMocks({
        existsSync: p => p.endsWith("BlueBubblesVideoBridge") || p.endsWith("BlueBubblesCameraBridge")
    });
    const fakeInstance = new FaceTimeAudioBridge();
    const cameraCalls: any[] = [];
    fakeInstance.handleCamera = (payload: any) => {
        cameraCalls.push(payload);
    };

    const origLoad = (Module as any)._load;
    (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
        if (request === "@server/api/lib/facetime/FaceTimeAudioBridge") {
            return {
                FaceTimeAudioBridge: Object.assign(FaceTimeAudioBridge, {
                    getInstance: () => fakeInstance
                })
            };
        }
        if (request === "@server") {
            return { Server: () => ({ repo: { getConfig: () => true }, privateApi: { helper: {} } }) };
        }
        if (request === "@server/api/interfaces/facetimeInterface") {
            return { FaceTimeInterface: {} };
        }
        if (request === "@server/databases/callHistory") {
            return { CallHistoryRepository: class {} };
        }
        if (request === "./FacetimeSessionManager" || request === "@server/api/lib/facetime/FacetimeSessionManager") {
            return {
                FaceTimeSessionManager: () => ({
                    findSession: options.findSession ?? (() => null)
                })
            };
        }
        return origLoad.apply(this, arguments);
    };

    try {
        const routesPath = path.join(srcRoot, "server/api/http/api/v1/socketForkRoutes.ts");
        const routerPath = path.join(srcRoot, "server/api/http/api/v1/routers/facetimeRouter.ts");
        delete require.cache[routesPath];
        delete require.cache[routerPath];

        const { registerForkSocketRoutes } = require(routesPath);
        const handlers: Record<string, Function> = {};
        registerForkSocketRoutes(
            { on: (ev: string, fn: Function) => { handlers[ev] = fn; } },
            { debug: () => {} }
        );

        let configAck: any = null;
        handlers["ft-bridge-config"]((payload: any) => { configAck = payload; });
        assert.equal(configAck.videoSupported, true);
        assert.equal(configAck.videoUplinkSupported, true);

        handlers["ft-bridge-camera"]({ callUuid: "call-1", enabled: false });
        assert.deepEqual(cameraCalls, [{ callUuid: "call-1", enabled: false }]);

        const { FaceTimeRouter } = require(routerPath);
        let statusBody: any = null;
        const ctx: any = { status: 200, body: null };
        await FaceTimeRouter.bridgeStatus(ctx, async () => {});
        statusBody = ctx.body;
        assert.equal(statusBody.data.videoSupported, true);
        assert.equal(statusBody.data.videoUplinkSupported, true);
    } finally {
        (Module as any)._load = origLoad;
    }
});

test("FaceTimeAudioBridge defers BlueBubblesVideoBridge spawn while OUTGOING and spawns on onCallAnswered", async () => {
    const spawned: any[] = [];
    let currentFtStatus = 3; // FaceTimeSessionStatus.OUTGOING
    const { FaceTimeAudioBridge } = loadBridgeWithMocks({
        existsSync: p => p.endsWith("BlueBubblesAudioBridge") || p.endsWith("BlueBubblesVideoBridge"),
        spawn: (bin: string) => {
            const proc = createMockProcess(bin);
            spawned.push(proc);
            return proc;
        },
        findSession: () => ({ status: currentFtStatus })
    });

    const bridge = FaceTimeAudioBridge.getInstance();
    bridge.cleanupAllSessions();

    const clientPc = new RTCPeerConnection({
        codecs: {
            audio: [useOPUS()],
            video: [useH264({ payloadType: 96, parameters: "profile-level-id=42e01f;packetization-mode=1" })]
        }
    });
    clientPc.addTransceiver("audio", { direction: "sendrecv" });
    clientPc.addTransceiver("video", { direction: "recvonly" });

    try {
        const offer = await clientPc.createOffer();
        await clientPc.setLocalDescription(offer);

        await bridge.handleOffer(
            { id: "sock-defer", emit: () => {} } as any,
            { callUuid: "call-defer-1", sdp: offer.sdp, type: "offer", video: true }
        );

        assert.equal(
            spawned.some(p => p.bin.endsWith("BlueBubblesVideoBridge")),
            false,
            "BlueBubblesVideoBridge must NOT spawn while session is OUTGOING"
        );
        assert.equal(
            spawned.some(p => p.bin.endsWith("BlueBubblesAudioBridge")),
            true,
            "BlueBubblesAudioBridge still spawns for early audio"
        );

        // Now mark answered and notify bridge
        currentFtStatus = 1; // ANSWERED
        const started = bridge.onCallAnswered("call-defer-1");
        assert.equal(started, true);
        assert.equal(
            spawned.filter(p => p.bin.endsWith("BlueBubblesVideoBridge")).length,
            1,
            "BlueBubblesVideoBridge must spawn once onCallAnswered is called"
        );

        // Idempotent: second onCallAnswered does not spawn a duplicate
        assert.equal(bridge.onCallAnswered("call-defer-1"), false);
        assert.equal(spawned.filter(p => p.bin.endsWith("BlueBubblesVideoBridge")).length, 1);

        // Cleaned-up session does not spawn on late onCallAnswered
        bridge.cleanupSession("call-defer-1");
        assert.equal(bridge.onCallAnswered("call-defer-1"), false);
    } finally {
        bridge.cleanupAllSessions();
        await clientPc.close().catch(() => {});
    }
});
