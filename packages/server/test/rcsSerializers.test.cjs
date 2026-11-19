const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const babel = require("@babel/core");

const serverSrcRoot = path.resolve(__dirname, "../src/server");
const moduleCache = new Map();

function loadTs(absPath, stubs = {}) {
    if (moduleCache.has(absPath)) return moduleCache.get(absPath).exports;

    const source = fs.readFileSync(absPath, "utf8");
    const transformed = babel.transformSync(source, {
        filename: absPath,
        presets: [
            ["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }],
            "@babel/preset-typescript"
        ],
        plugins: [
            ["@babel/plugin-proposal-decorators", { legacy: true }],
            ["@babel/plugin-transform-class-properties", { loose: true }]
        ]
    });

    const mod = new Module(absPath);
    mod.filename = absPath;
    mod.paths = Module._nodeModulePaths(path.dirname(absPath));
    moduleCache.set(absPath, mod);

    const origRequire = mod.require.bind(mod);
    mod.require = req => {
        if (Object.prototype.hasOwnProperty.call(stubs, req)) {
            return stubs[req];
        }
        if (req.startsWith("@server/")) {
            const rel = req.slice("@server/".length);
            const candidates = [`${rel}.ts`, `${rel}/index.ts`, `${rel}.js`];
            for (const c of candidates) {
                const target = path.join(serverSrcRoot, c);
                if (fs.existsSync(target)) {
                    return target.endsWith(".ts") ? loadTs(target, stubs) : origRequire(target);
                }
            }
        }
        if (req.startsWith(".")) {
            const base = path.resolve(path.dirname(absPath), req);
            for (const ext of [".ts", "/index.ts", ".js"]) {
                const target = `${base}${ext}`;
                if (fs.existsSync(target)) {
                    return target.endsWith(".ts") ? loadTs(target, stubs) : origRequire(target);
                }
            }
        }
        return origRequire(req);
    };

    mod._compile(transformed.code, absPath);
    return mod.exports;
}

const isEmpty = val =>
    val == null ||
    (typeof val === "string" && val.trim() === "") ||
    (Array.isArray(val) && val.length === 0);
const isNotEmpty = val => !isEmpty(val);

let fakeRepo = {};
const stubs = {
    electron: {
        app: {
            getPath: () => "/tmp/bluebubbles-test",
            setPath: () => {}
        }
    },
    "@server": {
        Server: () => ({
            iMessageRepo: fakeRepo,
            pinnedChatsCache: { getPinInfo: () => null },
            log: () => {}
        })
    },
    "@server/env": {
        isMinHighSierra: true,
        isMinMonterey: true,
        isMinVentura: true
    },
    "@server/helpers/utils": { isEmpty, isNotEmpty }
};

const { ChatSerializer, resolveEffectiveChatServiceName } = loadTs(
    path.join(serverSrcRoot, "api/serializers/ChatSerializer.ts"),
    stubs
);
const { MessageSerializer } = loadTs(
    path.join(serverSrcRoot, "api/serializers/MessageSerializer.ts"),
    stubs
);
const { ChatInterface } = loadTs(
    path.join(serverSrcRoot, "api/interfaces/chatInterface.ts"),
    stubs
);

test("resolveEffectiveChatServiceName prefers lastMessage.service for unified any;-; chats", () => {
    assert.equal(resolveEffectiveChatServiceName("any;-;+14699229511", "SMS", "iMessage"), "iMessage");
    assert.equal(resolveEffectiveChatServiceName("any;-;+19293462110", "SMS", "RCS"), "RCS");
    assert.equal(resolveEffectiveChatServiceName("any;-;+19293462110", "SMS", null), "SMS");
    assert.equal(resolveEffectiveChatServiceName("iMessage;-;+14699229511", "iMessage", "SMS"), "iMessage");
    assert.equal(resolveEffectiveChatServiceName("SMS;-;+19293462110", "SMS", "RCS"), "SMS");
});

test("ChatSerializer.serialize resolves stale SMS serviceName from chat.messages when present", async () => {
    const serialized = await ChatSerializer.serialize({
        chat: {
            ROWID: 39,
            guid: "any;-;+19293462110",
            style: 45,
            chatIdentifier: "+19293462110",
            serviceName: "SMS",
            isArchived: false,
            displayName: "",
            isFiltered: false,
            properties: [],
            lastAddressedHandle: "+16692535118",
            messages: [
                {
                    ROWID: 20782,
                    guid: "rcs-msg-1",
                    universalText: () => "hi",
                    service: "RCS",
                    dateCreated: new Date(1792098155620)
                }
            ]
        },
        config: { includeMessages: false }
    });
    assert.equal(serialized.serviceName, "RCS");
});

test("ChatInterface.get updates stale SMS serviceName from cached lastMessage.service", async () => {
    const rawChat = {
        ROWID: 35,
        guid: "any;-;+14699229511",
        style: 45,
        chatIdentifier: "+14699229511",
        serviceName: "SMS",
        isArchived: false,
        displayName: "",
        isFiltered: false,
        properties: [],
        lastAddressedHandle: "+16692535118"
    };
    const lastMsg = {
        ROWID: 66992,
        guid: "imessage-last-1",
        universalText: () => "hey",
        service: "iMessage",
        dateCreated: new Date(1792098155620),
        attachments: []
    };
    fakeRepo.getChats = async ({ withLastMessage }) => {
        if (withLastMessage) {
            return [[{ ...rawChat, messages: [lastMsg] }], 1];
        }
        return [[{ ...rawChat, messages: [] }], 1];
    };

    const [results, total] = await ChatInterface.get({ withLastMessage: true });
    assert.equal(total, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].lastMessage.service, "iMessage");
    assert.equal(results[0].serviceName, "iMessage");
});

test("MessageSerializer preserves threadOriginatorPart on notifications and updates stale chat serviceName", async () => {
    const incomingRcsReply = {
        ROWID: 66008,
        guid: "58EDFD76-FBA4-4748-B08D-711635A0600C",
        universalText: () => "omg ! how did it go?",
        attributedBody: [
            { string: "omg ! how did it go?", runs: [{ range: [0, 20], attributes: { __kIMMessagePartAttributeName: 0 } }] }
        ],
        handle: { ROWID: 106, id: "+14084157073", service: "RCS", uncanonicalizedId: null, country: "US" },
        handleId: 106,
        otherHandle: 0,
        attachments: [],
        isDelivered: true,
        isFromMe: false,
        threadOriginatorGuid: "5E50001B-F703-4F16-A5BC-F5FE2587CE1E",
        threadOriginatorPart: "0:0:45",
        service: "RCS",
        partCount: 1,
        chats: [
            {
                ROWID: 88,
                guid: "any;-;+14084157073",
                style: 45,
                chatIdentifier: "+14084157073",
                serviceName: "SMS",
                isArchived: false,
                displayName: "",
                isFiltered: false,
                properties: [],
                lastAddressedHandle: "+16692535118"
            }
        ]
    };

    const notif = await MessageSerializer.serialize({
        message: incomingRcsReply,
        config: { includeChats: true },
        isForNotification: true
    });
    assert.equal(notif.threadOriginatorGuid, "5E50001B-F703-4F16-A5BC-F5FE2587CE1E");
    assert.equal(notif.threadOriginatorPart, "0:0:45");
    assert.equal(notif.service, "RCS");
    assert.equal(notif.isFromMe, false);
    assert.equal(notif.chats[0].serviceName, "RCS");
});
