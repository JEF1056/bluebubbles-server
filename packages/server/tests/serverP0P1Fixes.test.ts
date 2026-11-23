import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

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

const emittedMessages: Array<{ type: string; data: any; priority?: string; useFcm?: boolean }> = [];
const repoConfigs: Record<string, any> = {
    group_typing_indicators: false
};
const chatParticipantsByGuid: Record<string, any[]> = {
    "any;+;group1": [{ address: "+15551111111" }],
    "any;+;group2": [{ address: "+15552222222" }]
};

const mockServerInstance = {
    log: () => {},
    repo: {
        getConfig: (key: string) => repoConfigs[key]
    },
    iMessageRepo: {
        getChats: async ({ chatGuid }: { chatGuid: string }) => {
            const participants = chatParticipantsByGuid[chatGuid] ?? [];
            return [[{ guid: chatGuid, participants }], participants.length];
        }
    },
    translationService: null,
    emitMessage: (type: string, data: any, priority?: string, useFcm?: boolean) => {
        emittedMessages.push({ type, data, priority, useFcm });
        return Promise.resolve();
    }
};

const srcRoot = path.resolve(import.meta.dirname, "../src");
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (request === "@server") {
        return { Server: () => mockServerInstance };
    }
    if (request === "@server/env") {
        return { isMinHighSierra: false, isMinMonterey: false, isMinVentura: false };
    }
    if (request === "@server/databases/server/entity") {
        return { ScheduledMessage: class {} };
    }
    if (request === "@server/api/interfaces/messageInterface") {
        return { MessageInterface: { sendMessageSync: async () => {} } };
    }
    if (request === "typeorm") {
        return {};
    }
    if (request === "@server/lib/logging/Loggable") {
        return {
            Loggable: class {
                log = {
                    info: () => {},
                    warn: () => {},
                    error: () => {},
                    debug: () => {}
                };
            }
        };
    }
    if (request === "./AttachmentSerializer") {
        return { AttachmentSerializer: { serializeList: async () => [] } };
    }
    if (request === "./HandleSerializer") {
        return {
            HandleSerializer: {
                serialize: async ({ handle }: any) => ({ address: handle.address }),
                serializeList: async ({ handles }: any) => handles.map((h: any) => ({ address: h.address }))
            }
        };
    }
    if (request === "./ChatSerializer") {
        return {
            ChatSerializer: {
                serializeList: async ({ chats }: any) =>
                    chats.map((c: any) => ({
                        guid: c.guid,
                        style: c.style,
                        participants: c.participants ?? [],
                        serviceName: c.serviceName ?? "iMessage"
                    }))
            },
            resolveEffectiveChatServiceName: (_g: string, cur: string) => cur
        };
    }
    if (request === "@server/helpers/utils") {
        return {
            isEmpty: (val: any) => val == null || (Array.isArray(val) && val.length === 0) || val === "",
            isNotEmpty: (val: any) => !(val == null || (Array.isArray(val) && val.length === 0) || val === ""),
            generateUuid: () => "tx-uuid-" + Math.random().toString(36).slice(2, 10)
        };
    }
    if (request === "@server/utils/TimeUtils") {
        return {
            safeTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms)
        };
    }
    if (request.startsWith("@server/")) {
        const mapped = path.join(srcRoot, "server", request.slice("@server/".length));
        if (fs.existsSync(mapped + ".ts")) {
            return origLoad.call(this, mapped + ".ts", parent, isMain);
        }
        if (fs.existsSync(path.join(mapped, "index.ts"))) {
            return origLoad.call(this, path.join(mapped, "index.ts"), parent, isMain);
        }
        return origLoad.call(this, mapped, parent, isMain);
    }
    return origLoad.call(this, request, parent, isMain);
};

const { MessageSerializer } = require("../src/server/api/serializers/MessageSerializer.ts");
const {
    ScheduledMessagesService,
    ScheduledMessageScheduleType,
    ScheduledMessageScheduleRecurringType
} = require("../src/server/services/scheduledMessagesService/index.ts");
const { PrivateApiTypingEventHandler } = require(
    "../src/server/api/privateApi/eventHandlers/PrivateApiTypingEventHandler.ts"
);
const { TransactionManager } = require("../src/server/managers/transactionManager/index.ts");
const { TransactionPromise, TransactionType } = require(
    "../src/server/managers/transactionManager/transactionPromise.ts"
);

const makeMessage = (guid: string, chats: any[]) => ({
    ROWID: 1,
    guid,
    universalText: () => "hello",
    attributedBody: null,
    handle: null,
    handleId: 0,
    otherHandle: 0,
    attachments: [],
    subject: null,
    error: 0,
    dateCreated: new Date(1_700_000_000_000),
    dateRead: null,
    dateDelivered: null,
    isRead: false,
    isDelivered: true,
    isFromMe: true,
    hasDdResults: false,
    isArchived: false,
    itemType: 0,
    groupTitle: null,
    groupActionType: 0,
    balloonBundleId: null,
    associatedMessageGuid: null,
    associatedMessageType: 0,
    associatedMessageEmoji: null,
    expressiveSendStyleId: null,
    threadOriginatorGuid: null,
    threadOriginatorPart: null,
    payloadData: null,
    service: "iMessage",
    chats
});

test("P0 #1: MessageSerializer.serializeList increments inner loop k++ and guards on includeChats", async () => {
    const msgs = [
        makeMessage("m-1", [
            { guid: "any;+;group1", style: 43, participants: [] },
            { guid: "any;+;group2", style: 43, participants: [] }
        ]),
        makeMessage("m-2", [
            { guid: "any;+;group1", style: 43, participants: [] },
            { guid: "any;+;group2", style: 43, participants: [] }
        ])
    ];

    const resWithChats = await MessageSerializer.serializeList({
        messages: msgs,
        config: { includeChats: true, loadChatParticipants: true }
    });
    assert.equal(resWithChats.length, 2);
    assert.deepEqual(resWithChats[0].chats[0].participants, [{ address: "+15551111111" }]);
    assert.deepEqual(resWithChats[0].chats[1].participants, [{ address: "+15552222222" }]);
    assert.deepEqual(resWithChats[1].chats[0].participants, [{ address: "+15551111111" }]);
    assert.deepEqual(resWithChats[1].chats[1].participants, [{ address: "+15552222222" }]);

    // When includeChats is false, loadChatParticipants=true must not crash on missing messageResponses[i].chats
    const resWithoutChats = await MessageSerializer.serializeList({
        messages: msgs,
        config: { includeChats: false, loadChatParticipants: true }
    });
    assert.equal(resWithoutChats.length, 2);
    assert.equal(resWithoutChats[0].chats, undefined);
});

test("P0 #3: ScheduledMessagesService.getNextRecurringDate returns null on invalid/non-positive intervals", async () => {
    const svc = Object.create(ScheduledMessagesService.prototype) as any;
    svc.log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
    svc.removeTimer = () => {};

    const invalidCases = [
        { type: ScheduledMessageScheduleType.RECURRING, intervalType: ScheduledMessageScheduleRecurringType.HOURLY, interval: 0 },
        { type: ScheduledMessageScheduleType.RECURRING, intervalType: ScheduledMessageScheduleRecurringType.DAILY, interval: -2 },
        { type: ScheduledMessageScheduleType.RECURRING, intervalType: ScheduledMessageScheduleRecurringType.WEEKLY, interval: Number.NaN },
        { type: ScheduledMessageScheduleType.RECURRING, intervalType: "bogus", interval: 1 }
    ];

    for (const schedule of invalidCases) {
        const msg = {
            id: 42,
            scheduledFor: new Date(Date.now() - 60_000),
            schedule,
            toString: () => "msg-42"
        };
        assert.equal(svc.getNextRecurringDate(msg), null);
        const rescheduled = await svc.tryReschedule(msg, false, true);
        assert.equal(rescheduled, false);
    }

    const validMsg = {
        id: 43,
        scheduledFor: new Date(Date.now() - 30 * 60_000),
        schedule: {
            type: ScheduledMessageScheduleType.RECURRING,
            intervalType: ScheduledMessageScheduleRecurringType.HOURLY,
            interval: 1
        },
        toString: () => "msg-43"
    };
    const nextDate = svc.getNextRecurringDate(validMsg);
    assert.ok(nextDate instanceof Date && nextDate.getTime() > Date.now());
});

test("P1 #9: PrivateApiTypingEventHandler ignores uncached stopped-typing and deletes cache on stop", async () => {
    emittedMessages.length = 0;
    const handler = new PrivateApiTypingEventHandler();
    const guid = "iMessage;-;+15559998888";

    // Uncached stopped-typing must not emit or populate cache
    await handler.handle({ event: "stopped-typing", guid } as any, null as any);
    assert.equal(emittedMessages.length, 0);
    assert.equal(handler.cache[guid], undefined);

    // started-typing emits display: true and caches
    await handler.handle({ event: "started-typing", guid } as any, null as any);
    assert.equal(emittedMessages.length, 1);
    assert.deepEqual(emittedMessages[0].data, { display: true, guid });
    assert.equal(handler.cache[guid]?.lastValue, true);

    // stopped-typing after active typing emits display: false and deletes cache entry
    await handler.handle({ event: "stopped-typing", guid } as any, null as any);
    assert.equal(emittedMessages.length, 2);
    assert.deepEqual(emittedMessages[1].data, { display: false, guid });
    assert.equal(handler.cache[guid], undefined);

    // Repeated stopped-typing does not re-emit
    await handler.handle({ event: "stopped-typing", guid } as any, null as any);
    assert.equal(emittedMessages.length, 2);
});

test("P1 #11: TransactionPromise clears timeout and removes settled entry from TransactionManager", async () => {
    const manager = new TransactionManager();

    const tx1 = new TransactionPromise(TransactionType.MESSAGE);
    manager.add(tx1);
    assert.equal(manager.promises.length, 1);
    assert.ok((tx1 as any).timeout, "timeout should be armed");

    tx1.resolve("msg-guid-1");
    const res1 = await tx1.promise;
    assert.equal(res1.identifier, "msg-guid-1");
    assert.equal((tx1 as any).timeout, null);
    assert.equal(manager.promises.length, 0);

    const tx2 = new TransactionPromise(TransactionType.MESSAGE);
    manager.add(tx2);
    assert.equal(manager.promises.length, 1);

    tx2.reject(new Error("boom"));
    await assert.rejects(tx2.promise, /boom/);
    assert.equal((tx2 as any).timeout, null);
    assert.equal(manager.promises.length, 0);
});
