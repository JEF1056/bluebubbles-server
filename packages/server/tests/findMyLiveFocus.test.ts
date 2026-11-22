import assert from "node:assert/strict";
import test from "node:test";

import {
    refreshFindMyDevicesThroughPrivateApi,
    type FindMyForkHelperDeps,
    type FindMyLiveState
} from "../src/server/api/lib/findmy/findMyForkHelpers.ts";

const makeDeps = (overrides?: {
    hasClient?: boolean;
    refreshImpl?: () => Promise<any>;
}) => {
    const shellCommands: string[] = [];
    const liveRestarts: Array<{ handle: string; displayName?: string }> = [];
    const deviceRecord = {
        id: "dev-1",
        identifier: "dev-1",
        name: "MacBook",
        location: { latitude: 37.33, longitude: -122.03, timeStamp: 1700000000000 }
    };

    let cachedDevices: any[] = [];
    const deps: FindMyForkHelperDeps = {
        server: {
            repo: { getConfig: () => true },
            privateApi: {
                hasClient: () => overrides?.hasClient ?? true,
                findmy: {
                    refreshDevices:
                        overrides?.refreshImpl ??
                        (async () => ({
                            data: { devices: [deviceRecord], partial: false, skippedDevices: 0 }
                        })),
                    startLiveLocation: async (handle: string, displayName?: string) => {
                        liveRestarts.push({ handle, displayName });
                        return { data: { live: true, locations: [] } };
                    }
                }
            },
            findMyDevicesCache: {
                getAll: () => cachedDevices,
                updateAll: (items: any[]) => {
                    cachedDevices = items;
                    return items;
                },
                replaceAll: (items: any[]) => {
                    cachedDevices = items;
                    return items;
                }
            },
            logger: { debug: () => undefined, warn: () => undefined }
        },
        env: { isMinBigSur: true, isMinSonoma: true, isMinSequoia: true },
        execShellCommand: async (cmd: string) => {
            shellCommands.push(cmd);
        },
        waitMs: async () => undefined,
        emitChangedDevices: async () => undefined,
        refreshUsingFindMyApp: async () => undefined,
        resolveFindMyDevicesTarget: () => "com.apple.findmy",
        resolveFindMyFriendsTarget: () => "com.apple.findmy"
    };

    return { deps, shellCommands, liveRestarts, deviceRecord };
};

test("refreshFindMyDevicesThroughPrivateApi skips open findmy://devices when helper is already connected", async () => {
    const { deps, shellCommands, liveRestarts } = makeDeps({ hasClient: true });
    const liveState: FindMyLiveState = { activeHandle: "+15551234567", activeDisplayName: "Alice", idleTimer: null };

    const devices = await refreshFindMyDevicesThroughPrivateApi(deps, undefined, liveState);
    assert.equal(devices.length, 1);
    assert.deepEqual(shellCommands, []);
    assert.deepEqual(liveRestarts, []);
});

test("refreshFindMyDevicesThroughPrivateApi re-focuses active live person after cold-start open findmy://devices", async () => {
    let attempts = 0;
    const { deps, shellCommands, liveRestarts, deviceRecord } = makeDeps({
        hasClient: true,
        refreshImpl: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("devicesDataSource unavailable");
            return { data: { devices: [deviceRecord], partial: false, skippedDevices: 0 } };
        }
    });
    const liveState: FindMyLiveState = { activeHandle: "+15551234567", activeDisplayName: "Alice", idleTimer: null };

    const devices = await refreshFindMyDevicesThroughPrivateApi(deps, undefined, liveState);
    assert.equal(devices.length, 1);
    assert.deepEqual(shellCommands, ["/usr/bin/open -g findmy://devices"]);
    assert.deepEqual(liveRestarts, [{ handle: "+15551234567", displayName: "Alice" }]);
});
