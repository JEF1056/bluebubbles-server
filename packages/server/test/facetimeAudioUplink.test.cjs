const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const babel = require("@babel/core");
const { MediaStreamTrack, RTCIceCandidate, RTCPeerConnection, RtpHeader, RtpPacket, useOPUS } = require("werift");

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
            existsSync: existsSyncImpl ?? (p => String(p).endsWith("BlueBubblesAudioBridge"))
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

test("handleOffer forwards offer-er Opus RTP packets to AudioBridge stdin", async () => {
    const audioStdinChunks = [];
    const { FaceTimeAudioBridge } = createBridgeModule({
        existsSyncImpl: p => String(p).endsWith("BlueBubblesAudioBridge"),
        spawnImpl: () => {
            const proc = new EventEmitter();
            proc.stdin = new PassThrough();
            proc.stdin.on("data", chunk => audioStdinChunks.push(chunk));
            proc.stdout = new PassThrough();
            proc.stderr = new PassThrough();
            proc.killed = false;
            proc.kill = () => {
                proc.killed = true;
                return true;
            };
            return proc;
        }
    });

    const bridge = new FaceTimeAudioBridge();
    const callUuid = "audio-uplink-test-call";
    const clientPc = new RTCPeerConnection({
        codecs: {
            audio: [useOPUS({ payloadType: 111 })]
        }
    });
    const clientTrack = new MediaStreamTrack({ kind: "audio" });
    clientPc.addTransceiver(clientTrack, { direction: "sendrecv" });

    let answerPayload;
    const socket = {
        id: "sock-audio-uplink",
        emit: (event, data) => {
            if (event === "ft-bridge-answer") {
                answerPayload = data;
            } else if (event === "ft-bridge-ice" && data?.candidate) {
                clientPc
                    .addIceCandidate(
                        new RTCIceCandidate({
                            candidate: data.candidate,
                            sdpMid: data.sdpMid ?? undefined,
                            sdpMLineIndex: data.sdpMLineIndex ?? undefined
                        })
                    )
                    .catch(() => {});
            }
        }
    };

    clientPc.onIceCandidate.subscribe(candidate => {
        if (!candidate) return;
        bridge
            .handleIce({
                callUuid,
                candidate: candidate.candidate,
                sdpMid: candidate.sdpMid ?? null,
                sdpMLineIndex: candidate.sdpMLineIndex ?? null
            })
            .catch(() => {});
    });

    const offer = await clientPc.createOffer();
    await clientPc.setLocalDescription(offer);

    await bridge.handleOffer(socket, {
        callUuid,
        sdp: offer.sdp,
        type: "offer",
        enableVideo: false
    });

    assert.ok(answerPayload?.sdp, "Expected ft-bridge-answer SDP");
    await clientPc.setRemoteDescription({ sdp: answerPayload.sdp, type: "answer" });

    // Wait for DTLS/ICE connection to become connected before sending RTP
    await new Promise((resolve, reject) => {
        if (clientPc.connectionState === "connected") return resolve();
        const timer = setTimeout(() => reject(new Error(`PeerConnection did not connect: ${clientPc.connectionState}`)), 5000);
        clientPc.connectionStateChange.subscribe(state => {
            if (state === "connected") {
                clearTimeout(timer);
                resolve();
            }
        });
    });

    const expectedPayloads = [
        Buffer.from([0xf8, 0xff, 0xfe, 0x01, 0x02]),
        Buffer.from([0xf8, 0xff, 0xfe, 0x03, 0x04]),
        Buffer.from([0xf8, 0xff, 0xfe, 0x05, 0x06])
    ];
    for (let i = 0; i < expectedPayloads.length; i++) {
        const pkt = new RtpPacket(
            new RtpHeader({
                payloadType: 111,
                sequenceNumber: 100 + i,
                timestamp: 960 * (i + 1),
                ssrc: 0x11223344
            }),
            expectedPayloads[i]
        );
        clientTrack.writeRtp(pkt);
    }

    // Parse framed packets (0x01 + uint32BE len + payload) from AudioBridge stdin
    const receivedFrames = [];
    const deadline = Date.now() + 3000;
    while (receivedFrames.length < expectedPayloads.length && Date.now() < deadline) {
        const buf = Buffer.concat(audioStdinChunks);
        receivedFrames.length = 0;
        let offset = 0;
        while (offset + 5 <= buf.length) {
            const type = buf[offset];
            const len = buf.readUInt32BE(offset + 1);
            if (offset + 5 + len > buf.length) break;
            if (type === 0x01) {
                receivedFrames.push(buf.subarray(offset + 5, offset + 5 + len));
            }
            offset += 5 + len;
        }
        if (receivedFrames.length < expectedPayloads.length) {
            await new Promise(r => setTimeout(r, 25));
        }
    }

    assert.equal(receivedFrames.length, expectedPayloads.length);
    for (let i = 0; i < expectedPayloads.length; i++) {
        assert.deepEqual(receivedFrames[i], expectedPayloads[i]);
    }

    bridge.cleanupSession(callUuid);
    await clientPc.close();
});
