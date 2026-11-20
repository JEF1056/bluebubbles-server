import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);

// Transpile .ts files on the fly (including TS enums) so `node --test` runs without extra flags.
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

// Mock @server and heavy Electron/DB dependencies before importing FaceTime modules.
const emittedMessages: Array<{ type: string; data: any; priority?: string }> = [];
const privateApiCalls: Array<{ method: string; args: any[] }> = [];
let mockRepoConfig: Record<string, any> = { facetime_calling: true };
let mockServerEnabled = true;

const mockServerInstance = {
    repo: {
        getConfig: (key: string) => mockRepoConfig[key]
    },
    privateApi: {
        helper: true,
        facetime: {
            startCall: async (addresses: string[], video: boolean, isTelephony: boolean) => {
                privateApiCalls.push({ method: "startCall", args: [addresses, video, isTelephony] });
                return { data: { call_uuid: "call-uuid-123", status: "outgoing" } };
            },
            generateLink: async (uuid: string | null) => {
                privateApiCalls.push({ method: "generateLink", args: [uuid] });
                return { data: { url: `https://facetime.apple.com/join#v=1&p=${uuid ?? "new"}` } };
            },
            answerCall: async (uuid: string) => {
                privateApiCalls.push({ method: "answerCall", args: [uuid] });
                return { data: {} };
            },
            leaveCall: async (uuid: string) => {
                privateApiCalls.push({ method: "leaveCall", args: [uuid] });
                return { data: {} };
            },
            endAndInvalidateCall: async (uuid: string, url?: string | null, groupUuid?: string | null) => {
                privateApiCalls.push({ method: "endAndInvalidateCall", args: [uuid, url ?? null, groupUuid ?? null] });
                return { data: { ended: true } };
            },
            declineCall: async (uuid: string) => {
                privateApiCalls.push({ method: "declineCall", args: [uuid] });
                return { data: {} };
            },
            setMuted: async (uuid: string, muted: boolean) => {
                privateApiCalls.push({ method: "setMuted", args: [uuid, muted] });
                return { data: {} };
            },
            admitAnyPendingMember: async () => {
                privateApiCalls.push({ method: "admitAnyPendingMember", args: [] });
                return { data: { admittedCount: 1, admittedParticipants: ["self"] } };
            }
        }
    },
    iMessageRepo: {
        getHandles: async ({ address }: { address: string }) => [
            [{ address, uncanonicalizedId: address, service: "FaceTime" }]
        ]
    },
    emitMessage: async (type: string, data: any, priority?: string) => {
        emittedMessages.push({ type, data, priority });
    }
};

const srcRoot = path.resolve(import.meta.dirname, "../src");
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (request === "@server") {
        return {
            Server: () => (mockServerEnabled ? mockServerInstance : null)
        };
    }
    if (request === "@server/env") {
        return { isMinMonterey: true };
    }
    if (request === "@server/helpers/utils") {
        return {
            checkPrivateApiStatus: () => {},
            waitMs: async () => {},
            slugifyAddress: (v: string) => v
        };
    }
    if (request === "@server/databases/notificationCenter/NotiicationCenterRepository") {
        return { NotificationCenterDB: () => ({ getRecords: async () => [[], 0] }) };
    }
    if (request === "@server/databases/imessage/helpers/dateUtil") {
        return { convertDateToCocoaTime: (d: Date) => d.getTime() };
    }
    if (request === "@server/api/serializers/HandleSerializer") {
        return { HandleSerializer: { serialize: async ({ handle }: any) => ({ address: handle.address }) } };
    }
    if (
        request === "@server/api/lib/facetime/FaceTimeAudioBridge" ||
        request.endsWith("/FaceTimeAudioBridge") ||
        request.endsWith("FaceTimeAudioBridge")
    ) {
        return {
            FaceTimeAudioBridge: {
                getInstance: () => ({
                    cleanupSession: (uuid: string) => {
                        privateApiCalls.push({ method: "bridgeCleanup", args: [uuid] });
                    },
                    sendDtmf: () => false,
                    sessions: new Map()
                })
            }
        };
    }
    if (request.endsWith("/lib/logging/Loggable") || request === "@server/lib/logging/Loggable") {
        const { EventEmitter } = require("events");
        class Loggable extends EventEmitter {
            log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
        }
        return { Loggable, getLogger: () => ({ info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }) };
    }
    if (request.startsWith("@server/")) {
        const resolved = path.join(srcRoot, "server", request.slice("@server/".length));
        return origLoad.call(this, resolved, parent, isMain);
    }
    return origLoad.call(this, request, parent, isMain);
};

const { FaceTimeSession, FaceTimeSessionStatus } = require("../src/server/api/lib/facetime/FaceTimeSession.ts");
const { FaceTimeSessionManager } = require("../src/server/api/lib/facetime/FacetimeSessionManager.ts");
const { FaceTimeInterface } = require("../src/server/api/interfaces/facetimeInterface.ts");
const { PrivateApiFaceTimeStatusHandler } = require(
    "../src/server/api/privateApi/eventHandlers/PrivateApiFaceTimeStatusHandler.ts"
);

const resetState = () => {
    FaceTimeSessionManager().clearSessions();
    emittedMessages.length = 0;
    privateApiCalls.length = 0;
    mockRepoConfig = { facetime_calling: true };
    mockServerEnabled = true;
};

test("FaceTimeSession.serialize() returns full backwards-compatible payload and preserves uuid on invalidate()", () => {
    resetState();
    const session = new FaceTimeSession({
        callUuid: "call-1",
        status: FaceTimeSessionStatus.OUTGOING,
        addresses: ["+15551234567"],
        displayName: "Alice",
        chatGuid: "iMessage;-;+15551234567",
        isOutgoing: true,
        isVideo: true,
        initiatorDeviceId: "web-1",
        initiatorDeviceName: "Chrome"
    });
    session.url = "https://facetime.apple.com/join#1";

    const serialized = session.serialize();
    assert.equal(serialized.uuid, "call-1");
    assert.equal(serialized.session_uuid, session.uuid);
    assert.equal(serialized.status, "outgoing");
    assert.equal(serialized.status_id, 3);
    assert.equal(serialized.address, "+15551234567");
    assert.deepEqual(serialized.addresses, ["+15551234567"]);
    assert.equal(serialized.display_name, "Alice");
    assert.equal(serialized.chat_guid, "iMessage;-;+15551234567");
    assert.equal(serialized.link, "https://facetime.apple.com/join#1");
    assert.equal(serialized.is_outgoing, true);
    assert.equal(serialized.is_video, true);
    assert.equal(serialized.is_audio, false);
    assert.equal(serialized.is_telephony, false);
    assert.equal(serialized.is_link_only, false);
    assert.equal(serialized.is_muted, false);
    assert.equal(serialized.initiator_device_id, "web-1");
    assert.equal(serialized.initiator_device_name, "Chrome");
    assert.equal(serialized.active_device_id, "web-1");
    assert.equal(serialized.active_device_name, "Chrome");
    assert.equal(typeof serialized.started_at, "number");
    assert.equal(serialized.answered_at, null);
    assert.equal(typeof serialized.updated_at, "number");

    let disconnectedUuid: string | null = null;
    session.on("disconnected", () => {
        disconnectedUuid = session.callUuid;
    });
    session.invalidate("left");
    assert.equal(disconnectedUuid, "call-1");
    assert.equal(session.serialize().uuid, "call-1");
    assert.equal(session.serialize().status, "disconnected");
    assert.equal(session.serialize().ended_reason, "left");
});

test("FaceTimeInterface registers audio/telephony/link calls, supports handoff, mute sync, and idempotent leave/decline", async () => {
    resetState();

    // 1. Audio-only telephony call registered in manager
    const telephonyRes = await FaceTimeInterface.call({
        addresses: ["+15550001111"],
        video: false,
        isTelephony: true,
        deviceId: "android-1",
        deviceName: "Pixel 9",
        displayName: "Bob",
        chatGuid: "SMS;-;+15550001111"
    });
    assert.equal(telephonyRes.session.is_telephony, true);
    assert.equal(telephonyRes.session.is_audio, true);
    assert.equal(telephonyRes.session.is_video, false);
    assert.equal(FaceTimeInterface.listSessions().length, 1);

    // 2. Link-only session registered in manager
    const linkRes = await FaceTimeInterface.create({
        deviceId: "web-2",
        deviceName: "Firefox",
        displayName: "Group Call"
    });
    assert.ok(linkRes.link.includes("https://facetime.apple.com/join"));
    assert.equal(linkRes.session.is_link_only, true);
    assert.equal(FaceTimeInterface.listSessions().length, 2);

    // 3. Mute syncs is_muted and emits ft-call-status-changed
    const mutedSession = await FaceTimeInterface.setMuted("call-uuid-123", true);
    assert.equal(mutedSession?.is_muted, true);
    assert.ok(emittedMessages.some(m => m.type === "ft-call-status-changed" && m.data.is_muted === true));

    // 4. Handoff updates active_device, cleans audio bridge when moving to video, generates link
    const handoffRes = await FaceTimeInterface.handoff(linkRes.session.uuid, {
        deviceId: "android-2",
        deviceName: "Galaxy",
        mode: "video"
    });
    assert.equal(handoffRes.session.active_device_id, "android-2");
    assert.equal(handoffRes.session.active_device_name, "Galaxy");
    assert.ok(privateApiCalls.some(c => c.method === "bridgeCleanup"));

    // 5. Idempotent leave/decline always emits disconnected
    emittedMessages.length = 0;
    await FaceTimeInterface.leave("call-uuid-123");
    await FaceTimeInterface.leave("call-uuid-123");
    const disconnectedEvents = emittedMessages.filter(
        m => m.type === "ft-call-status-changed" && m.data.status === "disconnected"
    );
    assert.equal(disconnectedEvents.length, 2);
});

test("PrivateApiFaceTimeStatusHandler emits OUTGOING, preserves session metadata, sets answered_at, and dedupes", async () => {
    resetState();
    const handler = new PrivateApiFaceTimeStatusHandler();

    // Pre-seed session with client metadata
    const existing = new FaceTimeSession({
        callUuid: "call-out-1",
        status: FaceTimeSessionStatus.OUTGOING,
        displayName: "Charlie",
        chatGuid: "iMessage;-;+15559998888",
        url: "https://facetime.apple.com/join#preserved",
        activeDeviceId: "web-9",
        activeDeviceName: "Safari",
        isMuted: true
    });
    FaceTimeSessionManager().broadcastUpdate(existing);
    const countBefore = emittedMessages.length;

    // Duplicate OUTGOING event from TUCall should be deduped (except if handle enriches it)
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-out-1",
                call_status: FaceTimeSessionStatus.OUTGOING,
                is_outgoing: true,
                handle: { value: "+15559998888" }
            }
        } as any,
        null as any
    );

    // Same OUTGOING event again with no changes -> deduped
    const countAfterFirst = emittedMessages.length;
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-out-1",
                call_status: FaceTimeSessionStatus.OUTGOING,
                is_outgoing: true,
                handle: { value: "+15559998888" }
            }
        } as any,
        null as any
    );
    assert.equal(emittedMessages.length, countAfterFirst);

    // ANSWERED event sets answered_at and preserves metadata
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-out-1",
                call_status: FaceTimeSessionStatus.ANSWERED,
                is_outgoing: true,
                handle: { value: "+15559998888" }
            }
        } as any,
        null as any
    );

    assert.ok(emittedMessages.length > countBefore);
    const last = emittedMessages[emittedMessages.length - 1].data;
    assert.equal(last.status, "answered");
    assert.equal(typeof last.answered_at, "number");
    assert.equal(last.display_name, "Charlie");
    assert.equal(last.chat_guid, "iMessage;-;+15559998888");
    assert.equal(last.link, "https://facetime.apple.com/join#preserved");
    assert.equal(last.active_device_id, "web-9");
    assert.equal(last.is_muted, true);
});

test("handleStandard broadcasts updates for tracked sessions and audio handoff unmutes Mac", async () => {
    resetState();
    mockRepoConfig.facetime_calling = false;
    const handler = new PrivateApiFaceTimeStatusHandler();

    const session = new FaceTimeSession({
        callUuid: "call-std-1",
        status: FaceTimeSessionStatus.OUTGOING,
        isOutgoing: true,
        isVideo: true
    });

    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-std-1",
                call_status: FaceTimeSessionStatus.ANSWERED,
                is_outgoing: true
            }
        } as any,
        null as any
    );
    assert.ok(emittedMessages.some(m => m.type === "ft-call-status-changed" && m.data.status === "answered"));

    privateApiCalls.length = 0;
    await FaceTimeInterface.handoff("call-std-1", {
        deviceId: "android-1",
        deviceName: "Pixel",
        mode: "audio"
    });
    assert.ok(
        privateApiCalls.some(c => c.method === "setMuted" && c.args[0] === "call-std-1" && c.args[1] === false)
    );
});

test("Mac leaving after handoff/admit keeps session ANSWERED across devices", async () => {
    resetState();
    mockRepoConfig.facetime_calling = true;
    const handler = new PrivateApiFaceTimeStatusHandler();

    const session = new FaceTimeSession({
        callUuid: "call-handoff-1",
        status: FaceTimeSessionStatus.ANSWERED,
        url: "https://facetime.apple.com/join#v=1&p=handoff",
        isOutgoing: true,
        isVideo: true
    });
    session.leftForHandoff = true;

    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-handoff-1",
                call_status: FaceTimeSessionStatus.DISCONNECTED,
                disconnected_reason: 1,
                active_remote_participants_count: 1,
                is_outgoing: true
            }
        } as any,
        null as any
    );

    assert.equal(session.status, FaceTimeSessionStatus.ANSWERED);
    assert.equal(FaceTimeSessionManager().listActiveSessions().length, 1);
});

test("Call failure maps ended_reason/ended_error and triggers endAndInvalidateCall", async () => {
    resetState();
    mockRepoConfig.facetime_calling = true;
    const handler = new PrivateApiFaceTimeStatusHandler();

    const session = new FaceTimeSession({
        callUuid: "call-fail-1",
        status: FaceTimeSessionStatus.OUTGOING,
        url: "https://facetime.apple.com/join#v=1&p=fail",
        conversationUuid: "conv-1",
        isOutgoing: true,
        isVideo: true
    });
    session.conversationGroupUuid = "grp-1";

    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-fail-1",
                call_status: FaceTimeSessionStatus.DISCONNECTED,
                disconnected_reason: 1,
                ended_error: "GKVoiceChatServiceErrorDomain Code=32016",
                is_outgoing: true
            }
        } as any,
        null as any
    );

    assert.equal(session.status, FaceTimeSessionStatus.DISCONNECTED);
    assert.equal(session.endedReason, "call_failed");
    assert.equal(session.endedError, "GKVoiceChatServiceErrorDomain Code=32016");
    assert.ok(
        privateApiCalls.some(
            c =>
                c.method === "endAndInvalidateCall" &&
                c.args[0] === "call-fail-1" &&
                c.args[1] === "https://facetime.apple.com/join#v=1&p=fail" &&
                c.args[2] === "grp-1"
        )
    );
});

test("FaceTimeInterface.end kicks everyone, invalidates link, and sets user_ended", async () => {
    resetState();
    const session = new FaceTimeSession({
        callUuid: "call-end-1",
        status: FaceTimeSessionStatus.ANSWERED,
        url: "https://facetime.apple.com/join#v=1&p=end1",
        isOutgoing: true,
        isVideo: true
    });
    session.conversationGroupUuid = "grp-end-1";

    await FaceTimeInterface.end("call-end-1");
    assert.equal(session.status, FaceTimeSessionStatus.DISCONNECTED);
    assert.equal(session.endedReason, "user_ended");
    assert.ok(
        privateApiCalls.some(
            c =>
                c.method === "endAndInvalidateCall" &&
                c.args[0] === "call-end-1" &&
                c.args[1] === "https://facetime.apple.com/join#v=1&p=end1" &&
                c.args[2] === "grp-end-1"
        )
    );
});

test("callee hanging up while admitted web participant remains ends session and kicks/invalidates link", async () => {
    resetState();
    const session = new FaceTimeSession({
        callUuid: "call-callee-drop",
        url: "https://facetime.apple.com/join#v=1&p=drop1",
        status: FaceTimeSessionStatus.ANSWERED,
        addresses: ["+16266165776"],
        isOutgoing: true,
        isVideo: true
    });
    session.conversationGroupUuid = "grp-drop-1";
    session.activeRemoteParticipantsCount = 2;
    session.activeNonLightweightParticipantsCount = 1;

    session.update(
        FaceTimeSession.fromEvent({
            call_uuid: "call-callee-drop",
            call_status: FaceTimeSessionStatus.DISCONNECTED,
            active_remote_participants_count: 1,
            active_non_lightweight_participants_count: 0,
            active_lightweight_participants_count: 1
        })
    );

    assert.equal(session.status, FaceTimeSessionStatus.DISCONNECTED);
    assert.equal(session.endedReason, "remote_ended");
    assert.ok(
        privateApiCalls.some(
            c =>
                c.method === "endAndInvalidateCall" &&
                c.args[0] === "call-callee-drop" &&
                c.args[1] === "https://facetime.apple.com/join#v=1&p=drop1" &&
                c.args[2] === "grp-drop-1"
        )
    );
});
