import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
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

const origResolveFilename = (Module as any)._resolveFilename;
const serverRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/server");
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
    if (request === "@server") {
        return origResolveFilename.call(this, path.join(serverRoot, "index.ts"), parent, isMain, options);
    }
    if (request.startsWith("@server/")) {
        return origResolveFilename.call(
            this,
            path.join(serverRoot, request.slice("@server/".length)),
            parent,
            isMain,
            options
        );
    }
    return origResolveFilename.call(this, request, parent, isMain, options);
};

const { UTagService } = require("../src/server/api/lib/utag/utagService.ts");

function makeStorageDeps(baseDir: string) {
    return {
        baseDir,
        safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (s: string) => Buffer.from(s, "utf8"),
            decryptString: (b: Buffer) => b.toString("utf8")
        }
    };
}

function seedConnectedService(baseDir: string, client: any) {
    const service = new UTagService({
        storageDeps: makeStorageDeps(baseDir),
        client,
        emitDevice: async () => undefined,
        cooldownMs: 60_000,
        searchPollIntervalMs: 10,
        searchPollCapMs: 80,
        untargetedSettleMs: 15
    });
    (service as any).savePersisted({
        deviceId: "bb-device-1",
        tokens: {
            iotToken: "iot-token",
            userId: "user-1"
        }
    });
    return service;
}

test("utag targeted refresh polls getTagGeolocation until lastUpdateTime > baseline and disables searching in finally", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utag-test-"));
    try {
        const searchCalls: Array<{ deviceId: string; searching: boolean }> = [];
        let geoCalls = 0;

        const client = {
            setTokens: () => undefined,
            getTokens: () => ({ iotToken: "iot-token", userId: "user-1" }),
            getSmartTagDevices: async () => [{ deviceId: "tag-1", name: "Keys" }],
            getFmeInstalledAppId: async () => "installed-app-1",
            setSearchingStatus: async (_appId: string, deviceId: string, searching: boolean) => {
                searchCalls.push({ deviceId, searching });
            },
            getTagGeolocation: async () => {
                geoCalls += 1;
                // Initial seed call returns 1000; first two targeted polls return stale 1000; 3rd returns 2000
                const lastUpdateTime = geoCalls >= 4 ? 2000 : 1000;
                return {
                    geo: {
                        latitude: 37.33,
                        longitude: -122.03,
                        horizontalAccuracy: 15,
                        lastUpdateTime
                    }
                };
            }
        };

        const service = seedConnectedService(tmpDir, client);
        // Seed baseline at 1000
        await service.refreshDevices();
        searchCalls.length = 0;
        geoCalls = 1;

        const devices = await service.refreshDevices("utag:tag-1", { force: true });
        assert.equal(geoCalls, 4);
        assert.equal(devices[0]?.last_updated, 2000);
        assert.deepEqual(searchCalls, [
            { deviceId: "tag-1", searching: true },
            { deviceId: "tag-1", searching: false }
        ]);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("utag targeted refresh always disables searching in finally even when getTagGeolocation throws", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utag-test-"));
    try {
        const searchCalls: Array<{ deviceId: string; searching: boolean }> = [];
        const client = {
            setTokens: () => undefined,
            getTokens: () => ({ iotToken: "iot-token", userId: "user-1" }),
            getSmartTagDevices: async () => [{ deviceId: "tag-1", name: "Keys" }],
            getFmeInstalledAppId: async () => "installed-app-1",
            setSearchingStatus: async (_appId: string, deviceId: string, searching: boolean) => {
                searchCalls.push({ deviceId, searching });
            },
            getTagGeolocation: async () => {
                throw new Error("FME network error");
            }
        };

        const service = seedConnectedService(tmpDir, client);
        await service.refreshDevices("utag:tag-1", { force: true });

        assert.equal(searchCalls[0]?.searching, true);
        assert.equal(searchCalls[searchCalls.length - 1]?.searching, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("utag untargeted force:true enables searching, settles, polls once per tag, and disables in finally", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utag-test-"));
    try {
        const events: string[] = [];
        const client = {
            setTokens: () => undefined,
            getTokens: () => ({ iotToken: "iot-token", userId: "user-1" }),
            getSmartTagDevices: async () => [
                { deviceId: "tag-1", name: "Keys" },
                { deviceId: "tag-2", name: "Wallet" }
            ],
            getFmeInstalledAppId: async () => "installed-app-1",
            setSearchingStatus: async (_appId: string, deviceId: string, searching: boolean) => {
                events.push(`search:${deviceId}:${searching}`);
            },
            getTagGeolocation: async (_appId: string, deviceId: string) => {
                events.push(`geo:${deviceId}`);
                return {
                    geo: {
                        latitude: 37.33,
                        longitude: -122.03,
                        horizontalAccuracy: 20,
                        lastUpdateTime: 3000
                    }
                };
            }
        };

        const service = seedConnectedService(tmpDir, client);
        await service.refreshDevices(undefined, { force: true });

        assert.deepEqual(events, [
            "search:tag-1:true",
            "search:tag-2:true",
            "geo:tag-1",
            "geo:tag-2",
            "search:tag-1:false",
            "search:tag-2:false"
        ]);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
