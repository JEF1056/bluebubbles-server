import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import ts from "typescript";
import {
    RTCPeerConnection,
    RtcpReceiverInfo,
    RtcpRrPacket,
    useAbsSendTime,
    useFIR,
    useH264,
    useOPUS,
    usePLI,
    useREMB,
    useTWCC,
    useTransportWideCC
} from "werift";

const require = createRequire(import.meta.url);

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

function loadFaceTimeModules(options: { existsSync?: (p: string) => boolean; spawn?: (bin: string) => any } = {}) {
    const origLoad = (Module as any)._load;
    const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const bridgePath = path.join(srcRoot, "server/api/lib/facetime/FaceTimeAudioBridge.ts");
    const controllerPath = path.join(srcRoot, "server/api/lib/facetime/FaceTimeAdaptiveController.ts");
    delete require.cache[bridgePath];
    delete require.cache[controllerPath];

    (Module as any)._load = function (request: string) {
        if (request === "child_process") {
            return {
                spawn: options.spawn ?? ((bin: string) => createMockProcess(bin)),
                execFile: () => {}
            };
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
            return { isMinBigSur: () => true, isMinMonterey: () => true };
        }
        if (request === "@server/fileSystem") {
            return { FileSystem: { resources: "/tmp/bb-resources" } };
        }
        if (request === "@server/api/lib/facetime/FacetimeSessionManager") {
            return { FaceTimeSessionManager: class {} };
        }
        if (request === "@server/lib/logging/Loggable") {
            return {
                Loggable: class {
                    log = noopLog;
                },
                getLogger: () => noopLog
            };
        }
        return origLoad.apply(this, arguments);
    };

    try {
        return {
            ...require(bridgePath),
            ...require(controllerPath)
        };
    } finally {
        (Module as any)._load = origLoad;
    }
}

test("FaceTimeAdaptiveController starts at rung 4 (1080p) and adapts within rung with 500ms/10% hysteresis after 3s video warmup", () => {
    const { FaceTimeAdaptiveController } = loadFaceTimeModules();
    let now = 10_000;
    const adapts: any[] = [];
    const ctrl = new FaceTimeAdaptiveController({
        now: () => now,
        onAdapt: (cmd: any) => adapts.push(cmd)
    });

    assert.deepEqual(ctrl.getState(), {
        rung: 4,
        maxWidth: 1920,
        maxHeight: 1080,
        fps: 30,
        bitrate: 1_800_000,
        oscillationCount: 0,
        cooldownMs: 8_000
    });

    // RR/REMB ignored before video RTP flows >= 3s
    ctrl.updateBitrate(400_000);
    ctrl.updateRtcpFeedback({ fractionLost: 0.25, rttMs: 600 });
    assert.equal(adapts.length, 0);
    assert.equal(ctrl.getState().rung, 4);

    ctrl.markVideoRtpSent(now);
    now += 2_900;
    ctrl.updateBitrate(2_500_000);
    assert.equal(adapts.length, 0);

    now += 100; // 3.0s elapsed since first video RTP
    // <10% change ignored (deadband)
    ctrl.updateBitrate(1_900_000);
    assert.equal(adapts.length, 0);

    // >=10% change accepted
    ctrl.updateBitrate(2_500_000);
    assert.equal(adapts.length, 1);
    assert.deepEqual(adapts[0], { cmd: "adapt", maxWidth: 1920, maxHeight: 1080, fps: 30, bitrate: 2_500_000 });

    // Within 500ms interval is throttled
    now += 300;
    ctrl.updateBitrate(3_500_000);
    assert.equal(adapts.length, 1);

    // After >=500ms interval emits clamped within rung 4 max (4.5M)
    now += 300;
    ctrl.updateBitrate(5_200_000);
    assert.equal(adapts.length, 2);
    assert.equal(adapts[1].bitrate, 4_500_000);
});

test("FaceTimeAdaptiveController steps down 1 rung at a time on sustained low BWE, floors at rung 2 unless sustained 10s", () => {
    const { FaceTimeAdaptiveController } = loadFaceTimeModules();
    let now = 1_000;
    const adapts: any[] = [];
    const ctrl = new FaceTimeAdaptiveController({
        now: () => now,
        onAdapt: (cmd: any) => adapts.push(cmd)
    });
    ctrl.markVideoRtpSent(now);
    now += 3_000;

    // Brief 1.5s dip below 1.8M recovers -> no step-down
    ctrl.updateBitrate(1_400_000);
    now += 1_500;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 4);
    ctrl.updateBitrate(2_200_000);
    now += 1_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 4);

    // Sustained 2.0s below floor drops 4->3->2; below rung 2 requires 10.0s sustained
    const drops = [
        { bwe: 1_400_000, holdMs: 2_000, expectedRung: 3, w: 1280, h: 720, fps: 30 },
        { bwe: 800_000, holdMs: 2_000, expectedRung: 2, w: 960, h: 540, fps: 30 },
        { bwe: 400_000, holdMs: 10_000, expectedRung: 1, w: 640, h: 360, fps: 24 },
        { bwe: 200_000, holdMs: 10_000, expectedRung: 0, w: 426, h: 240, fps: 15 }
    ];
    for (const d of drops) {
        now += 500;
        ctrl.updateBitrate(d.bwe);
        now += d.holdMs - 100;
        ctrl.tick();
        assert.equal(ctrl.getState().rung, d.expectedRung + 1, `should not drop before ${d.holdMs}ms`);
        now += 100;
        ctrl.tick();
        const st = ctrl.getState();
        assert.equal(st.rung, d.expectedRung);
        assert.equal(st.maxWidth, d.w);
        assert.equal(st.maxHeight, d.h);
        assert.equal(st.fps, d.fps);
    }
    assert.ok(adapts.length >= 4);
});

test("FaceTimeAdaptiveController requires 2 consecutive high-loss RRs + STEP_DOWN_HOLD, steps 1 rung, and floors at rung 2 unless sustained", () => {
    const { FaceTimeAdaptiveController } = loadFaceTimeModules();
    let now = 1_000;
    const ctrl = new FaceTimeAdaptiveController({ now: () => now, onAdapt: () => {} });

    // Before video RTP flows >= 3s, RR is ignored
    ctrl.updateRtcpFeedback({ fractionLost: 0.25, rttMs: 500 });
    now += 3_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 4);

    // Start video RTP flow and wait 3s warmup
    ctrl.markVideoRtpSent(now);
    now += 3_000;

    // Single RR even with >10% loss does NOT step down
    ctrl.updateRtcpFeedback({ fractionLost: 0.2, rttMs: 50 });
    now += 3_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 4);

    // Healthy RR resets consecutive counter
    ctrl.updateRtcpFeedback({ fractionLost: 0.02, rttMs: 50 });
    assert.equal(ctrl.getState().rung, 4);

    // 2 consecutive RRs >5% starts STEP_DOWN_HOLD (2s) -> drops 4->3 only after 2s
    ctrl.updateRtcpFeedback({ fractionLost: 0.06, rttMs: 50 });
    assert.equal(ctrl.getState().rung, 4);
    now += 500;
    ctrl.updateRtcpFeedback({ fractionLost: 0.07, rttMs: 50 });
    assert.equal(ctrl.getState().rung, 4);
    now += 1_900;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 4);
    now += 100;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 3);

    // 2 consecutive RRs >10% + 2s hold drops 3->2 (1 rung at a time)
    now += 1_000;
    ctrl.updateRtcpFeedback({ fractionLost: 0.15, rttMs: 50 });
    now += 500;
    ctrl.updateRtcpFeedback({ fractionLost: 0.15, rttMs: 50 });
    now += 2_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 2);

    // At rung 2 floor, 2 consecutive RRs + 2s is NOT enough (requires 10s sustained)
    now += 1_000;
    ctrl.updateRtcpFeedback({ fractionLost: 0.15, rttMs: 50 });
    now += 500;
    ctrl.updateRtcpFeedback({ fractionLost: 0.15, rttMs: 50 });
    now += 5_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 2);

    // Sustained 10s at rung 2 drops 2->1
    now += 5_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 1);

    // reset() restores rung 4 and 3s warmup gate
    ctrl.reset();
    assert.equal(ctrl.getState().rung, 4);
    ctrl.updateRtcpFeedback({ fractionLost: 0.2, rttMs: 500 });
    now += 5_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 4);
});

test("FaceTimeAdaptiveController enforces 6s step-up hold, loss/RTT gates, and 8s->14s->20s oscillation backoff", () => {
    const { FaceTimeAdaptiveController } = loadFaceTimeModules();
    let now = 0;
    const idrs: number[] = [];
    const ctrl = new FaceTimeAdaptiveController({
        now: () => now,
        onAdapt: () => {},
        onIdr: () => idrs.push(now),
        warmupMs: 0
    });
    ctrl.markVideoRtpSent(now);

    // Drop 4->3 via 2 consecutive high-loss RRs + 2s STEP_DOWN_HOLD
    ctrl.updateRtcpFeedback({ fractionLost: 0.15, rttMs: 40 });
    now += 500;
    ctrl.updateRtcpFeedback({ fractionLost: 0.15, rttMs: 40 });
    now += 2_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 3);
    assert.equal(ctrl.getState().cooldownMs, 8_000);

    // High BWE (>= 3.0M) + high loss (2%) -> blocked from stepping up
    now += 1_000;
    ctrl.updateRtcpFeedback({ fractionLost: 0.02, rttMs: 40 });
    ctrl.updateBitrate(3_500_000);
    now += 9_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 3);

    // Loss clears (<1%) but RTT >= 200ms -> still blocked
    ctrl.updateRtcpFeedback({ fractionLost: 0.005, rttMs: 210 });
    now += 8_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 3);

    // Healthy RTT (<200ms) starts 6s hold -> promotes after 6s
    ctrl.updateRtcpFeedback({ fractionLost: 0, rttMs: 40 });
    now += 5_900;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 3);
    now += 100;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 4);

    // Drop again within 30s (oscillation #1) -> cooldown becomes 14s
    now += 1_000;
    ctrl.updateRtcpFeedback({ fractionLost: 0.15, rttMs: 40 });
    now += 500;
    ctrl.updateRtcpFeedback({ fractionLost: 0.15, rttMs: 40 });
    now += 2_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 3);
    assert.equal(ctrl.getState().cooldownMs, 14_000);

    now += 1_000;
    ctrl.updateRtcpFeedback({ fractionLost: 0, rttMs: 40 });
    ctrl.updateBitrate(3_500_000);
    now += 12_900; // 13.9s since drop (<14s cooldown, even though >6s good)
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 3);
    now += 100; // 14.0s elapsed
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 4);

    // Drop again within 30s (oscillation #2) -> cooldown becomes 20s
    now += 1_000;
    ctrl.updateRtcpFeedback({ fractionLost: 0.15, rttMs: 40 });
    now += 500;
    ctrl.updateRtcpFeedback({ fractionLost: 0.15, rttMs: 40 });
    now += 2_000;
    ctrl.tick();
    assert.equal(ctrl.getState().rung, 3);
    assert.equal(ctrl.getState().cooldownMs, 20_000);

    // IDR 300ms throttle check
    assert.equal(ctrl.requestIdr(), true);
    now += 150;
    assert.equal(ctrl.requestIdr(), false);
    now += 150;
    assert.equal(ctrl.requestIdr(), true);
    assert.equal(idrs.length, 2);
});

test("FaceTimeAudioBridge negotiates H.264 Level 4.0+, TWCC/AbsSendTime, GCC, Opus FEC/DTX, and drives video stdin adapt/idr", async () => {
    const spawned: any[] = [];
    const { FaceTimeAudioBridge } = loadFaceTimeModules({
        existsSync: p => p.endsWith("BlueBubblesVideoBridge") || p.endsWith("BlueBubblesAudioBridge"),
        spawn: bin => {
            const proc = createMockProcess(bin);
            spawned.push(proc);
            return proc;
        }
    });

    const bridge = new FaceTimeAudioBridge();
    const clientPc = new RTCPeerConnection({
        codecs: {
            audio: [useOPUS()],
            video: [
                // Intentionally place Level 3.1 BEFORE Level 4.2 High to verify server reorders Level 4.0+ first.
                useH264({
                    payloadType: 96,
                    parameters: "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1",
                    rtcpFeedback: [{ type: "nack" }, usePLI(), useFIR(), useREMB(), useTWCC()]
                }),
                useH264({
                    payloadType: 97,
                    parameters: "profile-level-id=64002a;packetization-mode=1;level-asymmetry-allowed=1",
                    rtcpFeedback: [{ type: "nack" }, usePLI(), useFIR(), useREMB(), useTWCC()]
                })
            ]
        },
        headerExtensions: {
            video: [useTransportWideCC(), useAbsSendTime()]
        }
    });
    clientPc.addTransceiver("audio", { direction: "sendrecv" });
    clientPc.addTransceiver("video", { direction: "recvonly" });
    const offer = await clientPc.createOffer();

    const emitted: Array<{ ev: string; data: any }> = [];
    try {
        await bridge.handleOffer(
            { id: "sock-1080p", emit: (ev: string, data: any) => emitted.push({ ev, data }) },
            { callUuid: "call-1080p-1", sdp: offer.sdp, type: "offer", video: true }
        );

        const answer = emitted.find(e => e.ev === "ft-bridge-answer");
        assert.ok(answer);
        const sdp = answer.data.sdp as string;

        // Opus FEC/DTX/bitrate parameters present in answer
        assert.match(sdp, /useinbandfec=1/);
        assert.match(sdp, /usedtx=1/);
        assert.match(sdp, /maxaveragebitrate=64000/);

        // Video answer prefers Level 4.2 (64002a) first in m=video before 42e01f
        const videoSection = sdp.split(/^m=/m).find(s => s.startsWith("video ")) ?? "";
        const mLineMatch = /^video \d+ UDP\/TLS\/RTP\/SAVPF ([^\r\n]+)/.exec(videoSection);
        assert.ok(mLineMatch, "m=video line should exist");
        const ptOrder = mLineMatch[1].trim().split(/\s+/).map(Number);
        const pt64002aMatch = /a=fmtp:(\d+) [^\r\n]*profile-level-id=64002a/.exec(videoSection);
        const pt42e01fMatch = /a=fmtp:(\d+) [^\r\n]*profile-level-id=42e01f/.exec(videoSection);
        assert.ok(pt64002aMatch && pt42e01fMatch);
        assert.ok(
            ptOrder.indexOf(Number(pt64002aMatch[1])) < ptOrder.indexOf(Number(pt42e01fMatch[1])),
            `Expected 64002a PT before 42e01f PT in m=video (${ptOrder.join(",")})`
        );
        assert.match(videoSection, /a=rtcp-fb:\d+ ccm fir/);
        assert.match(videoSection, /a=rtcp-fb:\d+ transport-cc/);
        assert.match(videoSection, /transport-wide-cc/);
        assert.match(videoSection, /abs-send-time/);

        const videoProc = spawned.find(p => p.bin.endsWith("BlueBubblesVideoBridge"));
        assert.ok(videoProc);

        const stdinLines: string[] = [];
        videoProc.stdin.write = (chunk: Buffer | string) => {
            stdinLines.push(chunk.toString());
            return true;
        };

        const session = bridge.sessions.get("call-1080p-1");
        assert.ok(session?.videoTransceiver);
        assert.ok(session.adaptiveController);

        // Sender FIR / PLI triggers IDR command on videoProc.stdin
        session.videoTransceiver.sender.onKeyFrameRequest.execute("fir");
        assert.equal(stdinLines.length, 1);
        assert.deepEqual(JSON.parse(stdinLines[0]), { cmd: "idr" });

        // Early RTCP RR before video RTP flows >= 3s is ignored (does not step down)
        const rr = new RtcpRrPacket({
            ssrc: 0x99887766,
            reports: [
                new RtcpReceiverInfo({
                    ssrc: session.videoTransceiver.sender.ssrc,
                    fractionLost: Math.round(0.15 * 256),
                    packetsLost: 15,
                    highestSequence: 100,
                    jitter: 10,
                    lsr: 0,
                    dlsr: 0
                })
            ]
        });
        session.videoTransceiver.sender.onRtcp.execute(rr);
        assert.equal(stdinLines.length, 1);

        // After video RTP flows >= 3s, 2 consecutive high-loss RRs + STEP_DOWN_HOLD steps down to 720p rung 3
        const t0 = Date.now();
        session.adaptiveController.markVideoRtpSent(t0);
        session.adaptiveController.updateRtcpFeedback({ fractionLost: 0.15 }, t0 + 3_000);
        session.adaptiveController.updateRtcpFeedback({ fractionLost: 0.15 }, t0 + 3_500);
        session.adaptiveController.tick(t0 + 5_500);
        assert.equal(stdinLines.length, 2);
        const adaptCmd = JSON.parse(stdinLines[1]);
        assert.equal(adaptCmd.cmd, "adapt");
        assert.equal(adaptCmd.maxWidth, 1280);
        assert.equal(adaptCmd.maxHeight, 720);

        // Dynamic 90kHz timestamp delta on downlink video frames
        const sentTimestamps: number[] = [];
        session.outboundVideoTrack.writeRtp = (pkt: any) => {
            sentTimestamps.push(pkt.header.timestamp);
        };
        const au = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21]);
        const frame1 = Buffer.allocUnsafe(4 + au.length);
        frame1.writeUInt32BE(au.length, 0);
        au.copy(frame1, 4);
        videoProc.stdout.emit("data", frame1);
        await new Promise(r => setTimeout(r, 45));
        videoProc.stdout.emit("data", frame1);

        assert.equal(sentTimestamps.length, 2);
        const delta = (sentTimestamps[1] - sentTimestamps[0]) >>> 0;
        assert.ok(delta >= 3200 && delta <= 18_000, `expected real-time 90kHz delta (~4050 for 45ms), got ${delta}`);
    } finally {
        bridge.cleanupSession("call-1080p-1");
        await clientPc.close();
    }
});
