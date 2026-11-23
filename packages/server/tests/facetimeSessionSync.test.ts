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
const emittedMessages: Array<{ type: string; data: any; priority?: string; useFcm?: boolean }> = [];
const loggedMessages: Array<{ message: string; type?: string }> = [];
const privateApiCalls: Array<{ method: string; args: any[] }> = [];
let mockRepoConfig: Record<string, any> = { facetime_calling: true };
let mockServerEnabled = true;
let mockConversationState: { data: { conversationCount: number; conversations: any[] } } = {
    data: { conversationCount: 0, conversations: [] }
};
let getHandlesOverride: ((args: { address: string }) => Promise<any>) | null = null;
let pullCallOverride: ((callUuid?: string | null, groupUuid?: string | null) => Promise<any>) | null = null;
let pushCallOverride: ((callUuid?: string | null) => Promise<any>) | null = null;

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
            removeLink: async (url?: string) => {
                privateApiCalls.push({ method: "removeLink", args: [url ?? null] });
                return { data: { removed: true, removed_count: 1, skipped_active_count: 0 } };
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
            },
            pullCall: async (callUuid?: string | null, groupUuid?: string | null) => {
                privateApiCalls.push({ method: "pullCall", args: [callUuid ?? null, groupUuid ?? null] });
                if (pullCallOverride) return pullCallOverride(callUuid, groupUuid);
                return { data: { call_uuid: callUuid ?? "pulled-uuid" } };
            },
            pushCall: async (callUuid?: string | null) => {
                privateApiCalls.push({ method: "pushCall", args: [callUuid ?? null] });
                if (pushCallOverride) return pushCallOverride(callUuid);
                return { data: { pushed: true } };
            }
        }
    },
    iMessageRepo: {
        getHandles: async (args: { address: string }) =>
            getHandlesOverride
                ? getHandlesOverride(args)
                : [[{ address: args.address, uncanonicalizedId: args.address, service: "FaceTime" }]]
    },
    emitMessage: async (type: string, data: any, priority?: string, useFcm?: boolean) => {
        emittedMessages.push({ type, data, priority, useFcm });
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
            slugifyAddress: (v: string) => v,
            isEmpty: (val: any) => val == null || (Array.isArray(val) && val.length === 0) || val === "",
            generateUuid: () => "tx-uuid-" + Math.random().toString(36).slice(2, 10)
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
    if (request === "@server/databases/callHistory") {
        return { CallHistoryRepository: class {} };
    }
    if (
        request === "@server/api/lib/facetime/FaceTimeAudioBridge" ||
        request.endsWith("/FaceTimeAudioBridge") ||
        request.endsWith("FaceTimeAudioBridge")
    ) {
        return {
            FaceTimeAudioBridge: {
                getInstance: () => {
                    const cleanupSession = (uuid: string) => {
                        privateApiCalls.push({ method: "bridgeCleanup", args: [uuid] });
                    };
                    return {
                        cleanupSession,
                        cleanupSessions: (ids: Iterable<string | null | undefined>) => {
                            const seen = new Set<string>();
                            for (const id of ids) {
                                if (!id || seen.has(id)) continue;
                                seen.add(id);
                                cleanupSession(id);
                            }
                        },
                        sendDtmf: () => false,
                        onCallAnswered: (uuid: string) => {
                            privateApiCalls.push({ method: "bridgeOnCallAnswered", args: [uuid] });
                            return true;
                        },
                        sessions: new Map()
                    };
                }
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
const { FaceTimeRouter } = require("../src/server/api/http/api/v1/routers/facetimeRouter.ts");
const { PrivateApiFaceTime } = require("../src/server/api/privateApi/apis/PrivateApiFaceTime.ts");
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
    pullCallOverride = null;
    pushCallOverride = null;
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

test("handleStandard adopts iPhone-hosted and handoff-eligible calls, handoff pulls and re-keys, and transferBack pushes", async () => {
    resetState();
    mockRepoConfig = { facetime_calling: false };
    const handler = new PrivateApiFaceTimeStatusHandler();

    // 1. Synthetic handoff-eligible FaceTime call on iPhone (keyed by conversation_group_uuid, facetime_calling off)
    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                is_handoff_eligible: true,
                conversation_group_uuid: "group-iphone-1",
                handle: { value: "+15557778888" },
                is_video: false
            }
        } as any,
        null as any
    );

    const eligibleSession = FaceTimeSessionManager().findSession("group-iphone-1");
    assert.ok(eligibleSession, "handleStandard should adopt handoff-eligible session when facetime_calling is off");
    assert.equal(eligibleSession.endpointOnMac, false);
    assert.equal(eligibleSession.fromIphone, true);
    assert.equal(eligibleSession.activeDeviceName, "iPhone");
    assert.equal(eligibleSession.serialize().endpoint_on_mac, false);
    assert.equal(eligibleSession.serialize().from_iphone, true);

    // 2. Pull -> re-key -> bridge mode
    pullCallOverride = async () => ({ data: { call_uuid: "pulled-mac-uuid-1" } });
    const handoffRes = await FaceTimeInterface.handoff("group-iphone-1", {
        deviceId: "android-pixel",
        deviceName: "Pixel 9",
        mode: "audio"
    });
    assert.equal(privateApiCalls.some(c => c.method === "pullCall" && c.args[1] === "group-iphone-1"), true);
    assert.equal(eligibleSession.callUuid, "pulled-mac-uuid-1");
    assert.equal(eligibleSession.endpointOnMac, true);
    assert.equal(eligibleSession.fromIphone, true);
    assert.equal(handoffRes.session.uuid, "pulled-mac-uuid-1");
    assert.equal(handoffRes.session.endpoint_on_mac, true);
    assert.equal(handoffRes.session.from_iphone, true);
    assert.equal(FaceTimeSessionManager().findSession("group-iphone-1"), eligibleSession);
    assert.equal(FaceTimeSessionManager().findSession("pulled-mac-uuid-1"), eligibleSession);
    assert.equal(privateApiCalls.some(c => c.method === "setMuted" && c.args[0] === "pulled-mac-uuid-1"), true);

    // 3. transferBack cleans up bridge and calls pushCall
    privateApiCalls.length = 0;
    const backRes = await FaceTimeInterface.transferBack("pulled-mac-uuid-1");
    const cleanupIdx = privateApiCalls.findIndex(
        c => c.method === "bridgeCleanup" && c.args[0] === "pulled-mac-uuid-1"
    );
    const pushIdx = privateApiCalls.findIndex(c => c.method === "pushCall" && c.args[0] === "pulled-mac-uuid-1");
    assert.ok(cleanupIdx >= 0, "transferBack should clean up bridge session");
    assert.ok(pushIdx > cleanupIdx, "transferBack should call pushCall after bridgeCleanup");
    assert.equal(backRes.session?.endpoint_on_mac, false);
    assert.equal(backRes.session?.active_device_name, "iPhone");
});

test("handleStandard adopts status-1 Continuity call with is_endpoint_on_current_device=false and propagates pull errors", async () => {
    resetState();
    mockRepoConfig = { facetime_calling: false };
    const handler = new PrivateApiFaceTimeStatusHandler();

    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "continuity-call-1",
                call_status: FaceTimeSessionStatus.ANSWERED,
                is_endpoint_on_current_device: false,
                is_telephony: true,
                handle: { value: "+15559990000" }
            }
        } as any,
        null as any
    );

    const session = FaceTimeSessionManager().findSession("continuity-call-1");
    assert.ok(session, "handleStandard should adopt status-1 call when is_endpoint_on_current_device is false");
    assert.equal(session.endpointOnMac, false);
    assert.equal(session.fromIphone, true);
    assert.equal(session.activeDeviceName, "iPhone");

    pullCallOverride = async () => {
        throw new Error("No eligible call on iPhone");
    };
    await assert.rejects(
        () =>
            FaceTimeInterface.handoff("continuity-call-1", {
                deviceId: "android-1",
                deviceName: "Pixel",
                mode: "audio"
            }),
        /No eligible call on iPhone/
    );
    assert.equal(session.endpointOnMac, false);
    assert.equal(session.activeDeviceName, "iPhone");
});

test("outgoing conversation call_status=1 with 0 non-lightweight participants stays OUTGOING until callee joins", async () => {
    resetState();
    const handler = new PrivateApiFaceTimeStatusHandler();

    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "outgoing-gft-1",
                conversation_group_uuid: "group-gft-1",
                call_status: FaceTimeSessionStatus.ANSWERED,
                is_outgoing: true,
                is_conversation: true,
                is_video: true,
                is_telephony: false,
                active_non_lightweight_participants_count: 0,
                handle: { value: "+15551112222" }
            }
        } as any,
        null as any
    );

    const session = FaceTimeSessionManager().findSession("outgoing-gft-1");
    assert.ok(session, "session should be tracked");
    assert.equal(session.status, FaceTimeSessionStatus.OUTGOING);
    assert.equal(session.answeredAt, null);

    let answeredEmitted = false;
    session.once("answered", () => {
        answeredEmitted = true;
    });

    await handler.handle(
        {
            event: "ft-call-status-changed",
            data: {
                call_uuid: "outgoing-gft-1",
                conversation_group_uuid: "group-gft-1",
                call_status: FaceTimeSessionStatus.ANSWERED,
                is_outgoing: true,
                is_conversation: true,
                is_video: true,
                is_telephony: false,
                active_non_lightweight_participants_count: 1,
                handle: { value: "+15551112222" }
            }
        } as any,
        null as any
    );

    assert.equal(session.status, FaceTimeSessionStatus.ANSWERED);
    assert.ok(session.answeredAt instanceof Date);
    assert.equal(answeredEmitted, true);
});

test("waitForOutgoingAnswer polls getConversationState and promotes OUTGOING to ANSWERED when non-lightweight count > 0", async () => {
    resetState();
    const session = new FaceTimeSession({
        callUuid: "outgoing-poll-1",
        status: FaceTimeSessionStatus.OUTGOING,
        isOutgoing: true,
        isVideo: true,
        addToManager: true
    });
    session.conversationGroupUuid = "group-poll-1";

    let pollCount = 0;
    const origGetConversationState = mockServerInstance.privateApi.facetime.getConversationState;
    mockServerInstance.privateApi.facetime.getConversationState = async () => {
        pollCount += 1;
        return {
            data: {
                conversationCount: 1,
                conversations: [
                    {
                        groupUUID: "group-poll-1",
                        activeRemoteParticipantCount: pollCount >= 2 ? 1 : 0,
                        activeLightweightParticipantCount: 0,
                        activeNonLightweightParticipantCount: pollCount >= 2 ? 1 : 0,
                        pendingMemberCount: 0
                    }
                ]
            }
        };
    };

    try {
        const answered = await (session as any).waitForOutgoingAnswer(3500);
        assert.equal(answered, true);
        assert.equal(session.status, FaceTimeSessionStatus.ANSWERED);
        assert.ok(session.answeredAt instanceof Date);
    } finally {
        mockServerInstance.privateApi.facetime.getConversationState = origGetConversationState;
    }
});

test("handler.handle auto-polls getConversationState for downgraded outgoing conversation without admitSelf", async () => {
    resetState();
    const handler = new PrivateApiFaceTimeStatusHandler();
    let pollCount = 0;
    const origGetConversationState = mockServerInstance.privateApi.facetime.getConversationState;
    mockServerInstance.privateApi.facetime.getConversationState = async () => {
        pollCount += 1;
        return {
            data: {
                conversationCount: 1,
                conversations: [
                    {
                        groupUUID: "group-autopolled-1",
                        activeRemoteParticipantCount: pollCount >= 2 ? 1 : 0,
                        activeLightweightParticipantCount: 0,
                        activeNonLightweightParticipantCount: pollCount >= 2 ? 1 : 0,
                        pendingMemberCount: 0
                    }
                ]
            }
        };
    };

    try {
        await handler.handle(
            {
                event: "ft-call-status-changed",
                data: {
                    call_uuid: "outgoing-autopolled-1",
                    conversation_group_uuid: "group-autopolled-1",
                    call_status: FaceTimeSessionStatus.ANSWERED,
                    is_outgoing: true,
                    is_conversation: true,
                    is_video: false,
                    is_telephony: false,
                    active_non_lightweight_participants_count: 0,
                    handle: { value: "+15553334444" }
                }
            } as any,
            null as any
        );

        const session = FaceTimeSessionManager().findSession("outgoing-autopolled-1");
        assert.ok(session, "session should be tracked");
        assert.equal(session.status, FaceTimeSessionStatus.OUTGOING);
        assert.equal(session.answeredAt, null);

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("timed out waiting for auto-poll promotion")), 3500);
            session.once("answered", () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        assert.equal(session.status, FaceTimeSessionStatus.ANSWERED);
        assert.ok(session.answeredAt instanceof Date);
        assert.ok(pollCount >= 2);
    } finally {
        mockServerInstance.privateApi.facetime.getConversationState = origGetConversationState;
    }
});

test("P0 #5: normal answered call without leftForHandoff/link invalidates on DISCONNECTED; addSession arms expiryTimer", async () => {
    resetState();
    const session = FaceTimeSession.fromEvent(
        {
            call_uuid: "call-p05-normal",
            call_status: FaceTimeSessionStatus.ANSWERED,
            active_remote_participants_count: 1,
            handle: { value: "+15551110000" }
        },
        false
    );
    const isNew = FaceTimeSessionManager().addSession(session);
    assert.equal(isNew, true);
    assert.ok((session as any).expiryTimer, "addSession should arm expiryTimer for new sessions");

    // Stale activeRemoteParticipantsCount=1 on `this` must NOT falsely trigger isHandoffLeave when session has null counts and no url/admittedParticipants
    session.update(
        FaceTimeSession.fromEvent({
            call_uuid: "call-p05-normal",
            call_status: FaceTimeSessionStatus.DISCONNECTED
        })
    );
    assert.equal(session.status, FaceTimeSessionStatus.DISCONNECTED);

    // Link-hosted call with admittedParticipants and active callee counts stays ANSWERED on local DISCONNECTED
    const linkSession = new FaceTimeSession({
        callUuid: "call-p05-link",
        url: "https://facetime.apple.com/join#v=1&p=test",
        status: FaceTimeSessionStatus.ANSWERED,
        addToManager: true
    });
    linkSession.admittedParticipants.push("guest-1");
    linkSession.update(
        FaceTimeSession.fromEvent({
            call_uuid: "call-p05-link",
            call_status: FaceTimeSessionStatus.DISCONNECTED,
            active_remote_participants_count: 1,
            active_non_lightweight_participants_count: 1
        })
    );
    assert.equal(linkSession.status, FaceTimeSessionStatus.ANSWERED);
    linkSession.invalidate();
});

test("P1 #9 & #12: FaceTime FCM priority gated to lifecycle transitions and endpointOnMac clears default iPhone device name", async () => {
    resetState();
    const session = new FaceTimeSession({
        callUuid: "call-p19-fcm",
        status: FaceTimeSessionStatus.INCOMING,
        endpointOnMac: false,
        addToManager: true
    });
    assert.equal(session.activeDeviceName, "iPhone");

    FaceTimeSessionManager().broadcastUpdate(session);
    assert.equal(emittedMessages.at(-1)?.priority, "high");
    assert.equal(emittedMessages.at(-1)?.useFcm, true);

    session.update(
        FaceTimeSession.fromEvent({
            call_uuid: "call-p19-fcm",
            call_status: FaceTimeSessionStatus.ANSWERED,
            is_endpoint_on_current_device: true
        })
    );
    assert.equal(session.activeDeviceName, null);
    FaceTimeSessionManager().broadcastUpdate(session);
    assert.equal(emittedMessages.at(-1)?.priority, "high");
    assert.equal(emittedMessages.at(-1)?.useFcm, true);
    assert.equal(emittedMessages.at(-1)?.data?.endpoint_on_mac, true);

    // Mute delta while ANSWERED must be socket-only (normal priority, useFcm=false)
    session.isMuted = true;
    FaceTimeSessionManager().broadcastUpdate(session);
    assert.equal(emittedMessages.at(-1)?.priority, "normal");
    assert.equal(emittedMessages.at(-1)?.useFcm, false);

    // Transition to DISCONNECTED uses high priority + FCM
    session.invalidate("remote_ended");
    FaceTimeSessionManager().broadcastUpdate(session);
    assert.equal(emittedMessages.at(-1)?.priority, "high");
    assert.equal(emittedMessages.at(-1)?.useFcm, true);
});

test("cleanupSessions cleans up pre-handoff callUuid, aliases, uniqueProxyIdentifier, and conversationGroupUuid on handoff/end/disconnect", async () => {
    resetState();
    const session = new FaceTimeSession({
        callUuid: "call-old-1",
        uniqueProxyIdentifier: "proxy-1",
        status: FaceTimeSessionStatus.ANSWERED,
        endpointOnMac: false,
        addToManager: true
    });
    session.conversationGroupUuid = "group-1";
    session.registerIdentifier("alias-1");
    pullCallOverride = async () => ({ data: { call_uuid: "call-new-1" } });

    await FaceTimeInterface.handoff("call-old-1", { mode: "video" });
    const handoffCleanups = privateApiCalls.filter(c => c.method === "bridgeCleanup").map(c => c.args[0]);
    assert.equal(new Set(handoffCleanups).size, handoffCleanups.length);
    for (const id of ["call-old-1", "call-new-1", "alias-1", "proxy-1", "group-1"]) {
        assert.ok(handoffCleanups.includes(id), `handoff missing cleanup for ${id}`);
    }

    privateApiCalls.length = 0;
    await FaceTimeInterface.end("alias-1");
    const endCleanups = privateApiCalls.filter(c => c.method === "bridgeCleanup").map(c => c.args[0]);
    assert.equal(new Set(endCleanups).size, endCleanups.length);
    for (const id of ["call-new-1", "call-old-1", "alias-1", "proxy-1", "group-1"]) {
        assert.ok(endCleanups.includes(id), `end missing cleanup for ${id}`);
    }

    privateApiCalls.length = 0;
    const handler = new PrivateApiFaceTimeStatusHandler();
    await handler.handle({
        event: "ft-call-status-changed",
        data: {
            call_uuid: "call-event-1",
            unique_proxy_identifier: "proxy-1",
            conversation_group_uuid: "group-1",
            call_status: FaceTimeSessionStatus.DISCONNECTED
        }
    });
    const handlerCleanups = privateApiCalls.filter(c => c.method === "bridgeCleanup").map(c => c.args[0]);
    assert.equal(new Set(handlerCleanups).size, handlerCleanups.length);
    for (const id of ["call-new-1", "call-old-1", "alias-1", "proxy-1", "group-1", "call-event-1"]) {
        assert.ok(handlerCleanups.includes(id), `disconnect missing cleanup for ${id}`);
    }
});

test("Slice A: FaceTimeSession.fromEvent / update / serialize handles addresses and is_group, and manager broadcasts changes", async () => {
    resetState();
    const initial = FaceTimeSession.fromEvent(
        {
            call_uuid: "group-call-1",
            call_status: FaceTimeSessionStatus.ANSWERED,
            addresses: ["+15551110001"],
            remote_members_count: 1
        },
        true
    );
    assert.equal(initial.address, "+15551110001");
    assert.deepEqual(initial.addresses, ["+15551110001"]);
    assert.equal(initial.isGroup, false);
    assert.equal(initial.serialize().is_group, false);

    FaceTimeSessionManager().broadcastUpdate(initial);
    const firstEmitCount = emittedMessages.length;

    // Incoming update with longer addresses list and is_group=true should update and re-broadcast
    initial.update(
        FaceTimeSession.fromEvent({
            call_uuid: "group-call-1",
            call_status: FaceTimeSessionStatus.ANSWERED,
            addresses: ["+15551110001", "alice@example.com"],
            is_group: true
        })
    );
    assert.deepEqual(initial.addresses, ["+15551110001", "alice@example.com"]);
    assert.equal(initial.isGroup, true);
    assert.equal(initial.serialize().is_group, true);

    FaceTimeSessionManager().broadcastUpdate(initial);
    assert.equal(emittedMessages.length, firstEmitCount + 1);
    assert.deepEqual(emittedMessages.at(-1)?.data?.addresses, ["+15551110001", "alice@example.com"]);
    assert.equal(emittedMessages.at(-1)?.data?.is_group, true);

    // Shorter incoming addresses list must not overwrite longer list, and isGroup stays true via OR
    initial.update(
        FaceTimeSession.fromEvent({
            call_uuid: "group-call-1",
            call_status: FaceTimeSessionStatus.ANSWERED,
            addresses: ["+15551110001"],
            is_group: false
        })
    );
    assert.deepEqual(initial.addresses, ["+15551110001", "alice@example.com"]);
    assert.equal(initial.isGroup, true);

    // remote_members_count > 1 infers is_group when is_group is omitted
    const inferredGroup = FaceTimeSession.fromEvent({
        call_uuid: "group-call-2",
        call_status: FaceTimeSessionStatus.INCOMING,
        remote_members_count: 3
    });
    assert.equal(inferredGroup.isGroup, true);
});

test("FaceTime link cleanup removes unused links after disconnect and skips active or reused links", async () => {
    resetState();
    const mgr = FaceTimeSessionManager();
    const prevGrace = mgr.linkCleanupGraceMs;
    mgr.linkCleanupGraceMs = 30;

    try {
        // 1. Server-created link is recorded and cleaned up after session disconnects
        const s1 = new FaceTimeSession({
            callUuid: "call-link-1",
            status: FaceTimeSessionStatus.ANSWERED,
            addToManager: true
        });
        const link1 = await s1.generateLink();
        assert.ok(mgr.createdLinkUrls.has(link1), "generated link should be tracked in createdLinkUrls");

        s1.invalidate("user_ended");
        await new Promise(r => setTimeout(r, 60));
        assert.ok(
            privateApiCalls.some(c => c.method === "removeLink" && c.args[0] === link1),
            "unused link must be removed after disconnect grace delay"
        );
        assert.equal(mgr.createdLinkUrls.has(link1), false);

        // 2. Active session sharing the same link prevents deletion
        privateApiCalls.length = 0;
        const link2 = "https://facetime.apple.com/join#v=1&p=shared";
        mgr.recordCreatedLink(link2);
        const s2a = new FaceTimeSession({
            callUuid: "call-link-2a",
            status: FaceTimeSessionStatus.ANSWERED,
            url: link2,
            addToManager: true
        });
        const s2b = new FaceTimeSession({
            callUuid: "call-link-2b",
            status: FaceTimeSessionStatus.ANSWERED,
            url: link2,
            addToManager: true
        });
        s2a.invalidate("user_ended");
        await new Promise(r => setTimeout(r, 60));
        assert.equal(
            privateApiCalls.some(c => c.method === "removeLink" && c.args[0] === link2),
            false,
            "active link used by another session must NOT be deleted"
        );

        // Once the second session also disconnects, cleanup proceeds
        s2b.invalidate("remote_ended");
        await new Promise(r => setTimeout(r, 60));
        assert.ok(
            privateApiCalls.some(c => c.method === "removeLink" && c.args[0] === link2),
            "link should be removed once all active sessions using it disconnect"
        );

        // 3. Reusing a link cancels scheduled cleanup, and periodic sweep only removes old unused links
        privateApiCalls.length = 0;
        const link3 = "https://facetime.apple.com/join#v=1&p=reused";
        mgr.recordCreatedLink(link3);
        const s3 = new FaceTimeSession({
            callUuid: "call-link-3",
            status: FaceTimeSessionStatus.ANSWERED,
            url: link3,
            addToManager: true
        });
        s3.invalidate("user_ended");
        // Reuse immediately before grace delay fires
        new FaceTimeSession({
            callUuid: "call-link-3-reused",
            status: FaceTimeSessionStatus.ANSWERED,
            url: link3,
            addToManager: true
        });
        await new Promise(r => setTimeout(r, 60));
        assert.equal(
            privateApiCalls.some(c => c.method === "removeLink" && c.args[0] === link3),
            false,
            "reused link must cancel pending cleanup"
        );

        // Periodic sweep removes old unused link, leaves active link3 untouched
        const staleLink = "https://facetime.apple.com/join#v=1&p=stale";
        mgr.createdLinkUrls.set(staleLink, Date.now() - 10 * 60 * 1000);
        mgr.createdLinkUrls.set(link3, Date.now() - 10 * 60 * 1000);
        mgr.sweepUnusedLinks(5 * 60 * 1000);
        assert.ok(
            privateApiCalls.some(c => c.method === "removeLink" && c.args[0] === staleLink),
            "sweepUnusedLinks must remove stale unused link"
        );
        assert.equal(
            privateApiCalls.some(c => c.method === "removeLink" && c.args[0] === link3),
            false,
            "sweepUnusedLinks must NOT remove link still in active session"
        );

        // When no active sessions or tracked links remain, sweepUnusedLinks must NOT call removeLink() without a URL
        mgr.clearSessions();
        privateApiCalls.length = 0;
        mgr.sweepUnusedLinks(5 * 60 * 1000);
        assert.equal(
            privateApiCalls.length,
            0,
            "sweepUnusedLinks must NEVER call removeLink without an explicit tracked URL"
        );
    } finally {
        mgr.linkCleanupGraceMs = prevGrace;
        mgr.clearSessions();
    }
});

test("ensureOutgoingAnswerPolling auto-ends unanswered outgoing calls with no_answer and preserves link-only sessions", async () => {
    const mgr = FaceTimeSessionManager();
    mgr.clearSessions();
    privateApiCalls.length = 0;
    emittedMessages.length = 0;
    mockConversationState = { data: { conversationCount: 0, conversations: [] } };

    try {
        const session = new FaceTimeSession({
            callUuid: "call-no-answer-1",
            status: FaceTimeSessionStatus.OUTGOING,
            isOutgoing: true,
            isVideo: true,
            isAudio: false,
            isTelephony: false,
            isLinkOnly: false,
            address: "+15551230001",
            addToManager: true
        });

        const answered = await session.ensureOutgoingAnswerPolling(40);
        assert.equal(answered, false);
        assert.equal(session.status, FaceTimeSessionStatus.DISCONNECTED);
        assert.equal(session.endedReason, "no_answer");
        assert.ok(
            privateApiCalls.some(c => c.method === "leaveCall" && c.args[0] === "call-no-answer-1"),
            "timeout must leave the Mac call"
        );
        assert.ok(
            privateApiCalls.some(c => c.method === "endAndInvalidateCall" && c.args[0] === "call-no-answer-1"),
            "timeout must trigger endAndInvalidateCall"
        );
        assert.ok(
            emittedMessages.some(
                m =>
                    m.type === "ft-call-status-changed" &&
                    m.data?.uuid === "call-no-answer-1" &&
                    m.data?.status_id === FaceTimeSessionStatus.DISCONNECTED &&
                    m.data?.ended_reason === "no_answer"
            ),
            "timeout must broadcast DISCONNECTED with ended_reason='no_answer'"
        );

        // Link-only session (no recipients) must not be auto-ended by outgoing answer polling
        privateApiCalls.length = 0;
        const linkOnly = new FaceTimeSession({
            callUuid: "call-link-only-1",
            status: FaceTimeSessionStatus.OUTGOING,
            isOutgoing: true,
            isLinkOnly: true,
            url: "https://facetime.apple.com/join#v=1&p=linkonly",
            addToManager: true
        });
        const linkAnswered = await linkOnly.ensureOutgoingAnswerPolling(40);
        assert.equal(linkAnswered, false);
        assert.equal(linkOnly.status, FaceTimeSessionStatus.OUTGOING);
        assert.equal(linkOnly.endedReason, null);
        assert.equal(privateApiCalls.some(c => c.method === "leaveCall"), false);
    } finally {
        mgr.clearSessions();
    }
});

test("FaceTimeInterface.call starts outgoing answer polling for non-telephony audio-only calls", async () => {
    const mgr = FaceTimeSessionManager();
    mgr.clearSessions();
    privateApiCalls.length = 0;
    mockConversationState = { data: { conversationCount: 0, conversations: [] } };

    let pollingTimeoutMs: number | undefined;
    const origPolling = FaceTimeSession.prototype.ensureOutgoingAnswerPolling;
    FaceTimeSession.prototype.ensureOutgoingAnswerPolling = function (ringTimeoutMs = 60000) {
        pollingTimeoutMs = ringTimeoutMs;
        return Promise.resolve(false);
    };

    try {
        const res = await FaceTimeInterface.call({
            addresses: ["+15551230002"],
            video: false,
            isTelephony: false
        });
        assert.equal(res.session.status_id, FaceTimeSessionStatus.OUTGOING);
        assert.equal(pollingTimeoutMs, 60000, "audio-only outgoing call must start 60s answer polling");
    } finally {
        FaceTimeSession.prototype.ensureOutgoingAnswerPolling = origPolling;
        mgr.clearSessions();
    }
});

test("FaceTimeSession notifies FaceTimeAudioBridge.onCallAnswered on OUTGOING -> ANSWERED and guards no-answer timeout race", async () => {
    const mgr = FaceTimeSessionManager();
    mgr.clearSessions();
    privateApiCalls.length = 0;

    try {
        const s1 = new FaceTimeSession({
            callUuid: "call-race-answer-1",
            status: FaceTimeSessionStatus.OUTGOING,
            isOutgoing: true,
            isVideo: true,
            addToManager: true
        });
        const pollPromise = s1.ensureOutgoingAnswerPolling(60);
        // Late answer before timeout fires
        s1.setStatus(FaceTimeSessionStatus.ANSWERED);
        s1.emit("answered", true);
        const answered = await pollPromise;
        assert.equal(answered, true);
        assert.ok(
            privateApiCalls.some(c => c.method === "bridgeOnCallAnswered" && c.args[0] === "call-race-answer-1"),
            "OUTGOING -> ANSWERED must notify FaceTimeAudioBridge.onCallAnswered"
        );
        // Wait past timeout window to ensure no late no_answer invalidation occurs
        await new Promise(r => setTimeout(r, 80));
        assert.equal(s1.status, FaceTimeSessionStatus.ANSWERED);
        assert.equal(s1.endedReason, null);
        assert.equal(privateApiCalls.some(c => c.method === "leaveCall"), false);

        // Non-OUTGOING transitions (CONNECTING, UNKNOWN, INCOMING -> ANSWERED) also notify bridge once
        for (const [idx, initialStatus] of [
            FaceTimeSessionStatus.CONNECTING,
            FaceTimeSessionStatus.UNKNOWN,
            FaceTimeSessionStatus.INCOMING
        ].entries()) {
            privateApiCalls.length = 0;
            const id = `call-any-answer-${idx}`;
            const s = new FaceTimeSession({
                callUuid: id,
                status: initialStatus,
                isVideo: true,
                addToManager: true
            });
            s.setStatus(FaceTimeSessionStatus.ANSWERED);
            assert.equal(
                privateApiCalls.filter(c => c.method === "bridgeOnCallAnswered" && c.args[0] === id).length,
                1,
                `transition from ${initialStatus} -> ANSWERED must notify FaceTimeAudioBridge.onCallAnswered`
            );
            // Re-setting ANSWERED -> ANSWERED does not refire
            s.setStatus(FaceTimeSessionStatus.ANSWERED);
            assert.equal(
                privateApiCalls.filter(c => c.method === "bridgeOnCallAnswered" && c.args[0] === id).length,
                1
            );
        }
    } finally {
        mgr.clearSessions();
    }
});

test("Direct FaceTime calls/answers/handoffs avoid link generation even with mode='video' on call(), while create() generates links", async () => {
    resetState();
    const mgr = FaceTimeSessionManager();
    let admitAndLeaveCalls = 0;
    let admitSelfCalls = 0;
    let pollingTimeoutMs: number | undefined;
    const origAdmitAndLeave = FaceTimeSession.prototype.admitAndLeave;
    const origAdmitSelf = FaceTimeSession.prototype.admitSelf;
    const origPolling = FaceTimeSession.prototype.ensureOutgoingAnswerPolling;
    const origAnswerCall = mockServerInstance.privateApi.facetime.answerCall;

    FaceTimeSession.prototype.admitAndLeave = async function () {
        admitAndLeaveCalls += 1;
    };
    FaceTimeSession.prototype.admitSelf = async function () {
        admitSelfCalls += 1;
    };
    FaceTimeSession.prototype.ensureOutgoingAnswerPolling = function (ringTimeoutMs = 60000) {
        pollingTimeoutMs = ringTimeoutMs;
        return Promise.resolve(false);
    };
    mockServerInstance.privateApi.facetime.answerCall = async (uuid: string) => {
        const res = await origAnswerCall(uuid);
        const s = mgr.findSession(uuid);
        if (s) {
            s.conversationHasJoined = true;
            s.setStatus(FaceTimeSessionStatus.ANSWERED);
            s.emit("answered", true);
            s.emit("updated");
        }
        return res;
    };

    try {
        // 1. Direct 1:1 & group video calls (default & mode: "video_bridge") never generate links or admitAndLeave
        const direct1v1 = await FaceTimeInterface.call({
            addresses: ["+15551234001"],
            video: true
        });
        assert.equal("link" in direct1v1, false);
        assert.equal(direct1v1.session.link, null);
        assert.equal(direct1v1.session.is_video, true);
        assert.equal(pollingTimeoutMs, 60000);
        assert.equal(privateApiCalls.some(c => c.method === "generateLink"), false);
        assert.equal(admitAndLeaveCalls, 0);

        mgr.clearSessions();
        privateApiCalls.length = 0;
        const directGroupBridge = await FaceTimeInterface.call({
            addresses: ["+15551234002", "+15551234003"],
            video: true,
            mode: "video_bridge"
        });
        assert.equal("link" in directGroupBridge, false);
        assert.equal(directGroupBridge.session.is_group, true);
        assert.equal(directGroupBridge.session.is_video, true);
        assert.equal(privateApiCalls.some(c => c.method === "generateLink"), false);
        assert.equal(admitAndLeaveCalls, 0);

        // 2. Even with mode: "video", direct call() with addresses must NEVER generate a link or admitAndLeave
        mgr.clearSessions();
        privateApiCalls.length = 0;
        pollingTimeoutMs = undefined;
        const modeVideoDirectCall = await FaceTimeInterface.call({
            addresses: ["+15551234004"],
            video: true,
            mode: "video"
        });
        assert.equal("link" in modeVideoDirectCall, false);
        assert.equal(modeVideoDirectCall.session.link, null);
        assert.equal(pollingTimeoutMs, 60000);
        assert.equal(privateApiCalls.some(c => c.method === "generateLink"), false);
        assert.equal(admitAndLeaveCalls, 0);

        // 3. Explicit create() keeps is_link_only: true and generates link + calls admitAndLeave
        mgr.clearSessions();
        privateApiCalls.length = 0;
        admitAndLeaveCalls = 0;
        const created = await FaceTimeInterface.create({ displayName: "Room" });
        assert.ok(created.link.includes("https://facetime.apple.com/join"));
        assert.equal(created.session.is_link_only, true);
        assert.equal(privateApiCalls.some(c => c.method === "generateLink"), true);
        assert.equal(admitAndLeaveCalls, 1);

        // 4. Direct answer() (default & video_bridge & audio) calls answerCall directly without link/admit/mute
        mgr.clearSessions();
        privateApiCalls.length = 0;
        admitAndLeaveCalls = 0;
        new FaceTimeSession({
            callUuid: "in-direct-vid",
            status: FaceTimeSessionStatus.INCOMING,
            isVideo: true,
            isAudio: false
        });
        const ansVideo = await FaceTimeInterface.answer("in-direct-vid", false);
        assert.equal(ansVideo.link, null);
        assert.equal(ansVideo.audioOnly, false);
        assert.equal(ansVideo.session.status_id, FaceTimeSessionStatus.ANSWERED);
        assert.equal(ansVideo.session.is_video, true);
        assert.equal(ansVideo.session.is_audio, false);
        assert.equal(privateApiCalls.some(c => c.method === "answerCall" && c.args[0] === "in-direct-vid"), true);
        assert.equal(privateApiCalls.some(c => c.method === "generateLink"), false);
        assert.equal(privateApiCalls.some(c => c.method === "setMuted"), false);
        assert.equal(admitAndLeaveCalls, 0);

        privateApiCalls.length = 0;
        new FaceTimeSession({
            callUuid: "in-direct-aud",
            status: FaceTimeSessionStatus.INCOMING,
            isVideo: false,
            isAudio: true
        });
        const ansPreservedAudio = await FaceTimeInterface.answer("in-direct-aud", false);
        assert.equal(ansPreservedAudio.link, null);
        assert.equal(ansPreservedAudio.session.is_audio, true);
        assert.equal(ansPreservedAudio.session.is_video, false);

        const ansModeAudio = await FaceTimeInterface.answer("in-direct-vid", false, { mode: "audio" });
        assert.equal(ansModeAudio.audioOnly, true);
        assert.equal(ansModeAudio.link, null);
        assert.equal(ansModeAudio.session.is_audio, true);
        assert.equal(ansModeAudio.session.is_video, false);

        // 5. Explicit mode: "video" on answer() generates link and mutes Mac
        privateApiCalls.length = 0;
        admitAndLeaveCalls = 0;
        new FaceTimeSession({
            callUuid: "in-link-vid",
            status: FaceTimeSessionStatus.INCOMING,
            isVideo: true
        });
        const ansLink = await FaceTimeInterface.answer("in-link-vid", false, { mode: "video" });
        assert.ok(ansLink.link?.includes("https://facetime.apple.com/join"));
        assert.equal(privateApiCalls.some(c => c.method === "generateLink"), true);
        assert.equal(privateApiCalls.some(c => c.method === "setMuted" && c.args[0] === "in-link-vid" && c.args[1] === true), true);
        assert.equal(admitAndLeaveCalls, 1);

        // 6. Default handoff() uses video_bridge for video calls (no generateLink / admitSelf) and audio for audio calls
        privateApiCalls.length = 0;
        admitSelfCalls = 0;
        new FaceTimeSession({
            callUuid: "handoff-vid-default",
            status: FaceTimeSessionStatus.ANSWERED,
            isVideo: true,
            isAudio: false
        });
        const handoffDefaultVid = await FaceTimeInterface.handoff("handoff-vid-default", {
            deviceId: "web-1",
            deviceName: "Chrome"
        });
        assert.equal(handoffDefaultVid.link, null);
        assert.equal(handoffDefaultVid.session.is_video, true);
        assert.equal(privateApiCalls.some(c => c.method === "generateLink"), false);
        assert.equal(admitSelfCalls, 0);

        const handoffExplicitLink = await FaceTimeInterface.handoff("handoff-vid-default", {
            deviceId: "web-2",
            mode: "video"
        });
        assert.ok(handoffExplicitLink.link?.includes("https://facetime.apple.com/join"));
        assert.equal(privateApiCalls.some(c => c.method === "generateLink"), true);
        assert.equal(admitSelfCalls, 1);

        // 7. FaceTimeRouter forwards mode and omits null link in answer()
        mgr.clearSessions();
        privateApiCalls.length = 0;
        const routerCallCtx: any = {
            request: { body: { addresses: ["+15551234005"], video: true, mode: "video_bridge" } },
            status: 200,
            body: null
        };
        await FaceTimeRouter.call(routerCallCtx, async () => {});
        assert.equal("link" in routerCallCtx.body.data, false);
        assert.equal(privateApiCalls.some(c => c.method === "generateLink"), false);

        const routerAnswerDirectCtx: any = {
            params: { call_uuid: "router-direct-ans" },
            request: { body: { mode: "video_bridge" }, query: {} },
            status: 200,
            body: null
        };
        await FaceTimeRouter.answer(routerAnswerDirectCtx, async () => {});
        assert.equal("link" in routerAnswerDirectCtx.body.data, false);
        assert.equal(routerAnswerDirectCtx.body.data.audioOnly, false);
        assert.equal(routerAnswerDirectCtx.body.data.callUuid, "router-direct-ans");
        assert.equal(routerAnswerDirectCtx.body.data.session.status, "answered");

        const routerAnswerLinkCtx: any = {
            params: { call_uuid: "router-link-ans" },
            request: { body: { mode: "video" }, query: {} },
            status: 200,
            body: null
        };
        await FaceTimeRouter.answer(routerAnswerLinkCtx, async () => {});
        assert.ok(routerAnswerLinkCtx.body.data.link.includes("https://facetime.apple.com/join"));
    } finally {
        FaceTimeSession.prototype.admitAndLeave = origAdmitAndLeave;
        FaceTimeSession.prototype.admitSelf = origAdmitSelf;
        FaceTimeSession.prototype.ensureOutgoingAnswerPolling = origPolling;
        mockServerInstance.privateApi.facetime.answerCall = origAnswerCall;
        mgr.clearSessions();
    }
});

test("FaceTimeSession.fromEvent keeps 1:1 outgoing TUDialRequest ANSWERED without conversation UUIDs", () => {
    const oneToOne = FaceTimeSession.fromEvent({
        call_uuid: "direct-1v1-1",
        call_status: FaceTimeSessionStatus.ANSWERED,
        is_outgoing: true,
        is_conversation: true,
        is_telephony: false,
        active_non_lightweight_participants_count: 0
    });
    assert.equal(oneToOne.status, FaceTimeSessionStatus.ANSWERED);

    const groupWithGroupUuid = FaceTimeSession.fromEvent({
        call_uuid: "gft-1",
        conversation_group_uuid: "grp-1",
        call_status: FaceTimeSessionStatus.ANSWERED,
        is_outgoing: true,
        is_conversation: true,
        is_telephony: false,
        active_non_lightweight_participants_count: 0
    });
    assert.equal(groupWithGroupUuid.status, FaceTimeSessionStatus.OUTGOING);
});

test("cleanupLinks and PrivateApiFaceTime.removeLink reject missing or blank url", async () => {
    resetState();

    for (const badBody of [undefined, {}, { url: "" }, { url: "   " }, { url: null }, { url: 123 }]) {
        const ctx: any = {
            request: { body: badBody },
            status: 200,
            body: null
        };
        await assert.rejects(
            () => FaceTimeRouter.cleanupLinks(ctx, async () => {}),
            (err: any) => err?.name === "BadRequest" && err?.status === 400
        );
    }
    assert.equal(privateApiCalls.length, 0, "rejected cleanupLinks requests must never invoke removeLink");

    const okCtx: any = {
        request: { body: { url: "  https://facetime.apple.com/join#v=1&p=clean123  " } },
        status: 200,
        body: null
    };
    await FaceTimeRouter.cleanupLinks(okCtx, async () => {});
    assert.equal(privateApiCalls.length, 1);
    assert.deepEqual(privateApiCalls[0], {
        method: "removeLink",
        args: ["https://facetime.apple.com/join#v=1&p=clean123"]
    });

    const sentApiMessages: Array<{ action: string; data: Record<string, any> }> = [];
    const ftApi = new PrivateApiFaceTime({
        hasClient: () => true,
        server: {},
        writeData: async (action: string, data: Record<string, any>, transaction?: any) => {
            sentApiMessages.push({ action, data });
            transaction?.resolve?.("ok", { removed: true });
            return { data: { removed: true } } as any;
        }
    } as any);

    for (const badUrl of [undefined, "", "   ", null as any]) {
        await assert.rejects(
            () => ftApi.removeLink(badUrl),
            /url is required/
        );
    }
    assert.equal(sentApiMessages.length, 0, "PrivateApiFaceTime.removeLink must not send IPC without a url");

    await ftApi.removeLink("  https://facetime.apple.com/join#v=1&p=clean456  ");
    assert.deepEqual(sentApiMessages, [
        {
            action: "remove-facetime-link",
            data: { url: "https://facetime.apple.com/join#v=1&p=clean456" }
        }
    ]);
});
