const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const sourcePath = path.join(
    __dirname,
    "..",
    "src",
    "server",
    "api",
    "interfaces",
    "iCloudInterface.ts"
);

function loadICloudInterface({ fakeHome, fakePrivateApi = {} }) {
    const source = fs.readFileSync(sourcePath, "utf8");
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020
        }
    });

    const fakeServer = () => ({
        privateApi: {
            cloud: {
                getAccountInfo: async () => fakePrivateApi.accountInfo ?? null,
                getContactCard: async () => fakePrivateApi.contactCard ?? null,
                modifyActiveAlias: async () => undefined
            }
        }
    });

    class FakeDatabase {
        constructor(dbPath) {
            this.dbPath = dbPath;
        }
        prepare(sql) {
            return {
                all: () => {
                    if (sql.startsWith("PRAGMA table_info(ZABCDRECORD)")) {
                        return [
                            { name: "Z_PK" },
                            { name: "ZFIRSTNAME" },
                            { name: "ZLASTNAME" },
                            { name: "ZNICKNAME" },
                            { name: "ZORGANIZATION" },
                            { name: "ZIMAGEDATA" },
                            { name: "ZTHUMBNAILIMAGEDATA" }
                        ];
                    }
                    // Fail if a non-existent column like ZTHUMBNAILDATA or ZME is queried
                    if (sql.includes("ZTHUMBNAILDATA") || sql.includes("ZME")) {
                        throw new Error(`SqliteError: no such column in ${sql}`);
                    }
                    if (sql.includes("ZABCDEMAILADDRESS")) {
                        return [
                            {
                                ZFIRSTNAME: "Jess",
                                ZLASTNAME: "Fan",
                                ZNICKNAME: null,
                                ZORGANIZATION: null,
                                // 0x01 Apple AddressBook prefix + JPEG SOI header
                                ZIMAGEDATA: Buffer.from([0x01, 0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
                                ZTHUMBNAILIMAGEDATA: null,
                                match_val: "jessefan2002@gmail.com"
                            }
                        ];
                    }
                    return [];
                }
            };
        }
        close() {}
    }

    const mod = new Module(sourcePath, module);
    mod.filename = sourcePath;
    mod.paths = Module._nodeModulePaths(path.dirname(sourcePath));

    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === "@server") return { Server: fakeServer };
        if (request === "@server/env") return { isMinBigSur: () => true, isMinHighSierra: () => true };
        if (request === "@server/helpers/utils") {
            return {
                checkPrivateApiStatus: () => undefined,
                isNotEmpty: v => v !== null && v !== undefined && String(v).length > 0
            };
        }
        if (request === "./contactInterface") {
            return { ContactInterface: { queryContacts: async () => [] } };
        }
        if (request === "better-sqlite3") return FakeDatabase;
        if (request === "os") return { ...os, homedir: () => fakeHome };
        return origLoad.apply(this, arguments);
    };

    try {
        mod._compile(compiled.outputText, sourcePath);
    } finally {
        Module._load = origLoad;
    }

    return mod.exports.iCloudInterface;
}

test("getContactCard(null) resolves AddressBook iCloud Me card when ZTHUMBNAILDATA and ZME are absent", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bb-icloud-test-"));
    try {
        const sourceDir = path.join(tmpHome, "Library/Application Support/AddressBook/Sources/TEST-UUID");
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, "AddressBook-v22.abcddb"), "");

        const iCloudInterface = loadICloudInterface({
            fakeHome: tmpHome,
            fakePrivateApi: {
                accountInfo: {
                    data: {
                        account_name: "Jess Fan",
                        apple_id: "jessefan2002@gmail.com",
                        active_alias: "+16692535118",
                        aliases: [{ Alias: "+16692535118", IsUserVisible: true }],
                        vetted_aliases: [{ Alias: "+16692535118", IsUserVisible: true }]
                    }
                },
                contactCard: { data: { name: null, avatar_path: null } }
            }
        });
        iCloudInterface.invalidateAccountInfoCache();

        const card = await iCloudInterface.getContactCard(null);
        assert.equal(card.name, "Jess Fan");
        assert.equal(card.display_name, "Jess Fan");
        assert.equal(card.first_name, "Jess");
        assert.equal(card.last_name, "Fan");
        assert.equal(card.apple_id, "jessefan2002@gmail.com");
        assert.equal(card.active_alias, "+16692535118");
        assert.ok(card.avatar && card.avatar.length > 0, "avatar base64 should be populated");
        const decoded = Buffer.from(card.avatar, "base64");
        assert.deepEqual(decoded.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
    } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true });
    }
});
