import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import ts from "typescript";
import { RTCPeerConnection, useH264, useOPUS } from "werift";

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

    (Module as any)._load = function (request: string) {
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
        if (request === "./FacetimeSessionManager" && options.findSession) {
            return {
                FaceTimeSessionManager: () => ({
                    findSession: options.findSession
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

test("FaceTimeAudioBridge.onCallAnswered matches session UUIDs case-insensitively", async () => {
    const spawned: any[] = [];
    const { FaceTimeAudioBridge } = loadBridgeWithMocks({
        existsSync: p => p.endsWith("BlueBubblesAudioBridge") || p.endsWith("BlueBubblesVideoBridge"),
        spawn: (bin: string) => {
            const proc = createMockProcess(bin);
            spawned.push(proc);
            return proc;
        },
        findSession: () => ({ status: 3 }) // OUTGOING -> defer video spawn
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
        await bridge.handleOffer(
            { id: "sock-case", emit: () => {} } as any,
            { callUuid: "Call-Case-ABC-123", sdp: offer.sdp, type: "offer", video: true }
        );

        assert.equal(spawned.some(p => p.bin.endsWith("BlueBubblesVideoBridge")), false);

        // Lowercase callUuid must still locate session and spawn BlueBubblesVideoBridge once
        assert.equal(bridge.onCallAnswered("call-case-abc-123"), true);
        assert.equal(spawned.filter(p => p.bin.endsWith("BlueBubblesVideoBridge")).length, 1);

        // Uppercase follow-up is idempotent and does not spawn a duplicate
        assert.equal(bridge.onCallAnswered("CALL-CASE-ABC-123"), false);
        assert.equal(spawned.filter(p => p.bin.endsWith("BlueBubblesVideoBridge")).length, 1);
    } finally {
        bridge.cleanupAllSessions();
        await clientPc.close().catch(() => {});
    }
});

test("FaceTimeAudioBridge respawns exited audio/video/camera helpers with 1s/2s/4s backoff (max 3) and clears timers on cleanup", async () => {
    const spawned: any[] = [];
    const { FaceTimeAudioBridge } = loadBridgeWithMocks({
        existsSync: p =>
            p.endsWith("BlueBubblesAudioBridge") ||
            p.endsWith("BlueBubblesVideoBridge") ||
            p.endsWith("BlueBubblesCameraBridge"),
        spawn: (bin: string) => {
            const proc = createMockProcess(bin);
            spawned.push(proc);
            return proc;
        },
        findSession: () => ({ status: 1 }) // ANSWERED -> spawn all three immediately
    });

    const bridge = new FaceTimeAudioBridge();
    assert.equal(bridge.respawnBaseDelayMs, 1000);
    assert.equal(bridge.maxRespawnRetries, 3);

    const clientPc = new RTCPeerConnection({
        codecs: {
            audio: [useOPUS()],
            video: [useH264({ payloadType: 96, parameters: "profile-level-id=42e01f;packetization-mode=1" })]
        }
    });
    clientPc.addTransceiver("audio", { direction: "sendrecv" });
    clientPc.addTransceiver("video", { direction: "sendrecv" });

    // Intercept setTimeout/clearTimeout only for the 1000/2000/4000ms helper respawn timers.
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    const scheduled: Array<{ delay: number; cb: () => void; cleared: boolean; id: any }> = [];

    (globalThis as any).setTimeout = ((fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        if (delay === 1000 || delay === 2000 || delay === 4000) {
            const entry = {
                delay,
                cb: () => fn(...args),
                cleared: false,
                id: { unref: () => {} }
            };
            scheduled.push(entry);
            return entry.id;
        }
        return origSetTimeout(fn, delay, ...args);
    }) as typeof setTimeout;

    (globalThis as any).clearTimeout = ((id: any) => {
        const entry = scheduled.find(e => e.id === id);
        if (entry) {
            entry.cleared = true;
            return;
        }
        return origClearTimeout(id);
    }) as typeof clearTimeout;

    try {
        const offer = await clientPc.createOffer();
        await bridge.handleOffer(
            { id: "sock-respawn", emit: () => {} } as any,
            { callUuid: "call-respawn-1", sdp: offer.sdp, type: "offer", video: true, uplinkVideo: true }
        );

        const session = bridge.sessions.get("call-respawn-1");
        assert.ok(session);

        // While pc.connectionState is NOT "connected", unexpected exit does NOT respawn
        let mockConnState = "connecting";
        Object.defineProperty(session.pc, "connectionState", {
            get: () => mockConnState,
            configurable: true
        });
        const initialAudio = spawned.filter(p => p.bin.endsWith("BlueBubblesAudioBridge")).at(-1);
        initialAudio.emit("exit", 1);
        assert.equal(scheduled.length, 0, "must not respawn when pc.connectionState !== 'connected'");

        // Re-spawn manually via a fresh session for full connected lifecycle test
        bridge.cleanupAllSessions();
        spawned.length = 0;
        scheduled.length = 0;

        const offer2 = await clientPc.createOffer();
        await bridge.handleOffer(
            { id: "sock-respawn-2", emit: () => {} } as any,
            { callUuid: "call-respawn-2", sdp: offer2.sdp, type: "offer", video: true, uplinkVideo: true }
        );
        const s2 = bridge.sessions.get("call-respawn-2");
        assert.ok(s2);
        mockConnState = "connected";
        Object.defineProperty(s2.pc, "connectionState", {
            get: () => mockConnState,
            configurable: true
        });

        // Verify audio, video, and camera helpers each respawn up to 3 times with 1s, 2s, 4s backoff
        for (const binSuffix of ["BlueBubblesAudioBridge", "BlueBubblesVideoBridge", "BlueBubblesCameraBridge"]) {
            scheduled.length = 0;
            for (let attempt = 0; attempt < 3; attempt++) {
                const currentProc = spawned.filter(p => p.bin.endsWith(binSuffix)).at(-1);
                assert.ok(currentProc);
                currentProc.emit("exit", 1);
                assert.equal(scheduled.length, attempt + 1);
                assert.equal(scheduled[attempt].delay, 1000 * 2 ** attempt);
                scheduled[attempt].cb();
            }
            assert.equal(
                spawned.filter(p => p.bin.endsWith(binSuffix)).length,
                4,
                `${binSuffix} should have 1 initial + 3 respawns`
            );

            // 4th unexpected exit exceeds max 3 retries and does not schedule another respawn
            const fourthProc = spawned.filter(p => p.bin.endsWith(binSuffix)).at(-1);
            fourthProc.emit("exit", 1);
            assert.equal(scheduled.length, 3, `${binSuffix} must stop respawning after 3 retries`);
        }

        // Cleanup clears pending respawn timer and prevents respawn on process exit
        bridge.cleanupAllSessions();
        spawned.length = 0;
        scheduled.length = 0;

        const offer3 = await clientPc.createOffer();
        await bridge.handleOffer(
            { id: "sock-respawn-3", emit: () => {} } as any,
            { callUuid: "call-respawn-3", sdp: offer3.sdp, type: "offer", video: true, uplinkVideo: true }
        );
        const s3 = bridge.sessions.get("call-respawn-3");
        assert.ok(s3);
        Object.defineProperty(s3.pc, "connectionState", {
            get: () => "connected",
            configurable: true
        });
        const videoProc3 = spawned.find(p => p.bin.endsWith("BlueBubblesVideoBridge"));
        videoProc3.emit("exit", 1);
        assert.equal(scheduled.length, 1);
        assert.equal(scheduled[0].cleared, false);

        const audioCountBeforeCleanup = spawned.filter(p => p.bin.endsWith("BlueBubblesAudioBridge")).length;
        const audioProc3 = spawned.find(p => p.bin.endsWith("BlueBubblesAudioBridge"));
        bridge.cleanupSession("call-respawn-3");
        assert.equal(scheduled[0].cleared, true, "cleanupSession must clear pending respawn timers");
        audioProc3.emit("exit", 0);
        assert.equal(scheduled.length, 1, "cleanupSession must suppress respawn on killed process exit");
        assert.equal(spawned.filter(p => p.bin.endsWith("BlueBubblesAudioBridge")).length, audioCountBeforeCleanup);
    } finally {
        globalThis.setTimeout = origSetTimeout;
        globalThis.clearTimeout = origClearTimeout;
        bridge.cleanupAllSessions();
        await clientPc.close().catch(() => {});
    }
});
