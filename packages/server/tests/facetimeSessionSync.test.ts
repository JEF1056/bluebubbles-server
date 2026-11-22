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
const loggedMessages: Array<{ message: string; type?: string }> = [];
const privateApiCalls: Array<{ method: string; args: any[] }> = [];
let mockRepoConfig: Record<string, any> = { facetime_calling: true };
let mockServerEnabled = true;
let mockConversationState: { data: { conversationCount: number; conversations: any[] } } = {
    data: { conversationCount: 0, conversations: [] }
};
let getHandlesOverride: ((args: { address: string }) => Promise<any>) | null = null;

const mockServerInstance = {
    log: (message: string, type?: string) => {
        loggedMessages.push({ message, type });
    },
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
            },
            getConversationState: async () => {
                privateApiCalls.push({ method: "getConversationState", args: [] });
                return mockConversationState;
            }
        }
    },
    iMessageRepo: {
        getHandles: async (args: { address: string }) =>
            getHandlesOverride
                ? getHandlesOverride(args)
                : [[{ address: args.address, uncanonicalizedId: args.address, service: "FaceTime" }]]
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
    loggedMessages.length = 0;
    privateApiCalls.length = 0;
    mockRepoConfig = { facetime_calling: true };
    mockServerEnabled = true;
    mockConversationState = { data: { conversationCount: 0, conversations: [] } };
    getHandlesOverride = null;
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

test("handleStandard includes metadata in legacy incoming-facetime and emits ft-call-status-changed on answer/disconnect", async () => {
    resetState();
    mockRepoConfig.facetime_calling = false;
    const handler = new PrivateApiFaceTimeStatusHandler();

    // Untracked ANSWERED event should not emit ft-call-status-changed
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "untracked-call",
                call_status: FaceTimeSessionStatus.ANSWERED
            }
        } as any,
        null as any
    );
    assert.equal(emittedMessages.length, 0);

    // Incoming video FaceTime call
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "legacy-in-1",
                call_status: FaceTimeSessionStatus.INCOMING,
                is_outgoing: false,
                is_sending_video: true,
                is_sending_audio: false,
                is_telephony: false,
                handle: { value: "+15551112222" }
            }
        } as any,
        null as any
    );

    assert.equal(emittedMessages.length, 1);
    assert.equal(emittedMessages[0].type, "incoming-facetime");
    assert.equal(typeof emittedMessages[0].data, "string");
    const parsed = JSON.parse(emittedMessages[0].data);
    assert.equal(parsed.caller, "+15551112222");
    assert.equal(parsed.address, "+15551112222");
    assert.equal(parsed.uuid, "legacy-in-1");
    assert.equal(parsed.is_video, true);
    assert.equal(parsed.is_audio, false);
    assert.equal(parsed.is_telephony, false);
    assert.equal(typeof parsed.timestamp, "number");

    // Subsequent ANSWERED event emits ft-call-status-changed {uuid, status_id}
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "legacy-in-1",
                call_status: FaceTimeSessionStatus.ANSWERED
            }
        } as any,
        null as any
    );
    assert.equal(emittedMessages.length, 2);
    assert.equal(emittedMessages[1].type, "ft-call-status-changed");
    assert.deepEqual(emittedMessages[1].data, {
        uuid: "legacy-in-1",
        status_id: FaceTimeSessionStatus.ANSWERED
    });

    // Subsequent DISCONNECTED event emits ft-call-status-changed {uuid, status_id} and clears tracking
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "legacy-in-1",
                call_status: FaceTimeSessionStatus.DISCONNECTED
            }
        } as any,
        null as any
    );
    assert.equal(emittedMessages.length, 3);
    assert.equal(emittedMessages[2].type, "ft-call-status-changed");
    assert.deepEqual(emittedMessages[2].data, {
        uuid: "legacy-in-1",
        status_id: FaceTimeSessionStatus.DISCONNECTED
    });

    // Duplicate DISCONNECTED after cleanup is ignored
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "legacy-in-1",
                call_status: FaceTimeSessionStatus.DISCONNECTED
            }
        } as any,
        null as any
    );
    assert.equal(emittedMessages.length, 3);

    // Incoming telephony call sets is_telephony: true, is_video: false, is_audio: true
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "legacy-in-tel",
                call_status: FaceTimeSessionStatus.INCOMING,
                is_telephony: true,
                handle: { value: "+15553334444" }
            }
        } as any,
        null as any
    );
    assert.equal(emittedMessages.length, 4);
    const parsedTel = JSON.parse(emittedMessages[3].data);
    assert.equal(parsedTel.uuid, "legacy-in-tel");
    assert.equal(parsedTel.address, "+15553334444");
    assert.equal(parsedTel.is_telephony, true);
    assert.equal(parsedTel.is_video, false);
    assert.equal(parsedTel.is_audio, true);
});

test("Mac leaves after admit, survives duplicate TUCall DISCONNECTED events, and auto-hangs up once everyone leaves", async () => {
    resetState();
    const handler = new PrivateApiFaceTimeStatusHandler();
    const link = "https://facetime.apple.com/join#v=1&p=autoleave";
    const session = new FaceTimeSession({
        callUuid: "call-autoleave-1",
        status: FaceTimeSessionStatus.ANSWERED,
        url: link,
        isOutgoing: true,
        isVideo: true
    });
    session.conversationGroupUuid = "grp-autoleave-1";
    session.conversationMonitorIntervalMs = 15;

    // Room initially occupied by admitted web user + remote callee while Mac is not joined
    mockConversationState = {
        data: {
            conversationCount: 1,
            conversations: [
                {
                    uuid: "conv-autoleave-1",
                    groupUUID: "grp-autoleave-1",
                    link,
                    hasJoined: false,
                    activeRemoteParticipantCount: 2,
                    activeLightweightParticipantCount: 1,
                    activeNonLightweightParticipantCount: 1,
                    pendingMemberCount: 0
                }
            ]
        }
    };

    await session.admitAndLeave(500, 10, true);
    assert.ok(privateApiCalls.some(c => c.method === "setMuted" && c.args[0] === "call-autoleave-1" && c.args[1] === true));
    assert.ok(privateApiCalls.some(c => c.method === "leaveCall" && c.args[0] === "call-autoleave-1"));
    assert.equal(session.leftForHandoff, true);

    // Simulate duplicate TUCallCenterCallStatusChanged + VideoCallStatusChanged DISCONNECTED events for the Mac
    for (let i = 0; i < 2; i++) {
        await handler.handle(
            {
                event: "ft-call-status-changed",
                data: {
                    call_uuid: "call-autoleave-1",
                    call_status: FaceTimeSessionStatus.DISCONNECTED,
                    disconnected_reason: 1,
                    active_remote_participants_count: 0,
                    active_non_lightweight_participants_count: 0
                }
            } as any,
            null as any
        );
    }
    assert.equal(session.status, FaceTimeSessionStatus.ANSWERED, "duplicate Mac disconnect must not end active call");

    // Let monitor observe the occupied room
    await new Promise(r => setTimeout(r, 40));
    assert.equal(session.status, FaceTimeSessionStatus.ANSWERED);

    // Now everyone leaves -> conversation disappears from activeConversations
    mockConversationState = { data: { conversationCount: 0, conversations: [] } };
    await new Promise(r => setTimeout(r, 120));

    assert.equal(session.status, FaceTimeSessionStatus.DISCONNECTED);
    assert.equal(session.endedReason, "remote_ended");
    assert.ok(
        privateApiCalls.some(
            c =>
                c.method === "endAndInvalidateCall" &&
                c.args[0] === "call-autoleave-1" &&
                c.args[1] === link &&
                c.args[2] === "grp-autoleave-1"
        )
    );
});

test("conversation monitor stops safely without hanging up if unjoined conversation is never reported", async () => {
    resetState();
    const session = new FaceTimeSession({
        callUuid: "call-unreported-1",
        status: FaceTimeSessionStatus.ANSWERED,
        url: "https://facetime.apple.com/join#v=1&p=unreported",
        isOutgoing: true,
        isVideo: true
    });
    session.conversationGroupUuid = "grp-unreported-1";
    session.conversationMonitorIntervalMs = 10;
    session.hasParticipantCounts = true;
    session.activeRemoteParticipantsCount = 2;

    // macOS never returns the unjoined conversation in get-conversation-state
    mockConversationState = { data: { conversationCount: 0, conversations: [] } };
    session.startConversationMonitor(10);

    await new Promise(r => setTimeout(r, 120));
    assert.equal(session.status, FaceTimeSessionStatus.ANSWERED);
    assert.equal(session.conversationMonitorService, null, "monitor should stop after missing limit");
    assert.equal(
        privateApiCalls.some(c => c.method === "endAndInvalidateCall"),
        false,
        "must not kick/invalidate when unjoined conversation was never observed"
    );
});

test("first-seen non-outgoing status 6 surfaces missed/silenced session and throttles DND alert to 1/hr", async () => {
    resetState();
    const handler = new PrivateApiFaceTimeStatusHandler();

    // Calling mode: silenced incoming call arrives directly as status 6 (never saw status 4)
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-silenced-1",
                call_status: FaceTimeSessionStatus.DISCONNECTED,
                is_outgoing: false,
                disconnected_reason: 21,
                filtered_out_reason: 6,
                is_incoming_silenced: true,
                handle: { value: "+15551112222" }
            }
        } as any,
        null as any
    );

    const broadcasts = emittedMessages.filter(m => m.type === "ft-call-status-changed");
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].data.status_id, FaceTimeSessionStatus.DISCONNECTED);
    assert.equal(broadcasts[0].data.ended_reason, "missed");
    assert.equal(broadcasts[0].data.silenced_reason, "dnd");
    assert.equal(loggedMessages.length, 1);
    assert.equal(loggedMessages[0].type, "warn");
    assert.match(loggedMessages[0].message, /mirroring or sharing the display/i);

    // Second silenced call within 1 hour emits session broadcast but throttles the server alert
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-silenced-2",
                call_status: FaceTimeSessionStatus.DISCONNECTED,
                is_outgoing: false,
                disconnected_reason: 21,
                filtered_out_reason: 6,
                is_incoming_silenced: true,
                handle: { value: "+15553334444" }
            }
        } as any,
        null as any
    );
    assert.equal(emittedMessages.filter(m => m.type === "ft-call-status-changed").length, 2);
    assert.equal(loggedMessages.length, 1, "alert should be throttled to once per hour");

    // Standard mode (facetime_calling=false): first-seen status 6 non-outgoing also surfaces missed session without DND
    mockRepoConfig.facetime_calling = false;
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-missed-std",
                call_status: FaceTimeSessionStatus.DISCONNECTED,
                is_outgoing: false,
                disconnected_reason: 1,
                filtered_out_reason: 0,
                is_incoming_silenced: true,
                handle: { value: "+15556667777" }
            }
        } as any,
        null as any
    );
    const stdBroadcast = emittedMessages.at(-1)!;
    assert.equal(stdBroadcast.type, "ft-call-status-changed");
    assert.equal(stdBroadcast.data.uuid, "call-missed-std");
    assert.equal(stdBroadcast.data.ended_reason, "missed");
    assert.equal(stdBroadcast.data.silenced_reason, null);
});

test("unanswered incoming disconnects as missed while answered incoming disconnects as remote_ended", async () => {
    resetState();
    const handler = new PrivateApiFaceTimeStatusHandler();

    // Incoming -> disconnect without answer -> missed
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-unanswered-in",
                call_status: FaceTimeSessionStatus.INCOMING,
                is_outgoing: false,
                handle: { value: "+15550001111" }
            }
        } as any,
        null as any
    );
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-unanswered-in",
                call_status: FaceTimeSessionStatus.DISCONNECTED,
                is_outgoing: false,
                disconnected_reason: 1
            }
        } as any,
        null as any
    );
    assert.equal(emittedMessages.at(-1)?.data.ended_reason, "missed");

    // Incoming -> answered -> disconnect -> remote_ended
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-answered-in",
                call_status: FaceTimeSessionStatus.INCOMING,
                is_outgoing: false,
                handle: { value: "+15550002222" }
            }
        } as any,
        null as any
    );
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-answered-in",
                call_status: FaceTimeSessionStatus.ANSWERED,
                is_outgoing: false
            }
        } as any,
        null as any
    );
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-answered-in",
                call_status: FaceTimeSessionStatus.DISCONNECTED,
                is_outgoing: false,
                disconnected_reason: 1
            }
        } as any,
        null as any
    );
    assert.equal(emittedMessages.at(-1)?.data.ended_reason, "remote_ended");
});

test("handleCalling broadcasts before handle DB lookup and aligns isAudio/isVideo with handleStandard", async () => {
    resetState();
    const handler = new PrivateApiFaceTimeStatusHandler();

    let resolveHandles!: (rows: any) => void;
    getHandlesOverride = () =>
        new Promise(resolve => {
            resolveHandles = resolve;
        });

    const handlePromise = handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-fast-broadcast",
                call_status: FaceTimeSessionStatus.INCOMING,
                is_outgoing: false,
                is_video: true,
                is_sending_audio: true,
                handle: { value: "+15559990000" }
            }
        } as any,
        null as any
    );

    // Yield microtasks: broadcastUpdate must have already fired while getHandles is still pending
    await Promise.resolve();
    assert.equal(emittedMessages.length, 1, "session should broadcast before DB handle lookup completes");
    assert.equal(emittedMessages[0].data.is_video, true);
    assert.equal(emittedMessages[0].data.is_audio, false);

    resolveHandles([[{ address: "+15559990000", uncanonicalizedId: "+15559990000", service: "FaceTime" }]]);
    await handlePromise;
    assert.equal(emittedMessages.length, 1, "handle enrichment should not emit a duplicate broadcast");
    assert.equal(FaceTimeSessionManager().findSession("call-fast-broadcast")?.handle?.address, "+15559990000");

    // Standard mode incoming FaceTime audio call (is_video: false, is_sending_audio: false while ringing)
    mockRepoConfig.facetime_calling = false;
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-std-audio",
                call_status: FaceTimeSessionStatus.INCOMING,
                is_outgoing: false,
                is_video: false,
                is_sending_audio: false,
                handle: { value: "+15558887777" }
            }
        } as any,
        null as any
    );
    const legacyMsg = JSON.parse(emittedMessages.at(-1)!.data);
    const fromEventSession = FaceTimeSession.fromEvent({
        call_uuid: "call-std-audio",
        call_status: FaceTimeSessionStatus.INCOMING,
        is_video: false,
        is_sending_audio: false
    });
    assert.equal(legacyMsg.is_video, false);
    assert.equal(legacyMsg.is_audio, true);
    assert.equal(fromEventSession.isVideo, legacyMsg.is_video);
    assert.equal(fromEventSession.isAudio, legacyMsg.is_audio);
});

test("handoff resets leftForHandoff/handoffLeaveObserved and admitSelf cleans up on disconnect", async () => {
    resetState();
    const session = new FaceTimeSession({
        callUuid: "call-handoff-reset",
        status: FaceTimeSessionStatus.ANSWERED,
        url: "https://facetime.apple.com/join#v=1&p=reset1",
        isOutgoing: true,
        isVideo: true
    });
    session.leftForHandoff = true;
    session.handoffLeaveObserved = true;

    await FaceTimeInterface.handoff("call-handoff-reset", {
        deviceId: "android-1",
        deviceName: "Pixel",
        mode: "audio"
    });
    assert.equal(session.leftForHandoff, false);
    assert.equal(session.handoffLeaveObserved, false);

    // admitSelf should settle and clear selfAdmissionService immediately on disconnect
    const admitSession = new FaceTimeSession({
        callUuid: "call-admit-dc",
        status: FaceTimeSessionStatus.ANSWERED,
        isOutgoing: true,
        isVideo: true
    });
    const admitPromise = admitSession.admitSelf(false);
    admitSession.invalidate("user_ended");
    await admitPromise;
    assert.equal(admitSession.selfAdmissionService, null);
});

test("declining an incoming call preserves ended_reason='declined' on trailing DISCONNECTED without missed broadcast", async () => {
    resetState();
    const handler = new PrivateApiFaceTimeStatusHandler();

    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-decline-preserve",
                call_status: FaceTimeSessionStatus.INCOMING,
                is_outgoing: false,
                handle: { value: "+15554445555" }
            }
        } as any,
        null as any
    );

    await FaceTimeInterface.decline("call-decline-preserve");
    const afterDeclineCount = emittedMessages.length;
    assert.equal(emittedMessages.at(-1)?.data.ended_reason, "declined");

    // Trailing macOS helper DISCONNECTED event arrives with disconnected_reason: 1
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "call-decline-preserve",
                call_status: FaceTimeSessionStatus.DISCONNECTED,
                is_outgoing: false,
                disconnected_reason: 1
            }
        } as any,
        null as any
    );

    assert.equal(FaceTimeSessionManager().findSession("call-decline-preserve")?.endedReason, "declined");
    assert.equal(emittedMessages.length, afterDeclineCount, "must not emit a second missed broadcast after decline");
});
