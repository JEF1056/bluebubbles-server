import { Server } from "@server";
import path from "path";
import fs from "fs";
import { FileSystem } from "@server/fileSystem";
import { NEW_FINDMY_DEVICE } from "@server/events";
import { isMinBigSur, isMinSequoia, isMinSonoma } from "@server/env";
import { waitMs } from "@server/helpers/utils";
import { quitFindMyFriends, startFindMyFriends, showFindMyFriends, hideFindMyFriends } from "../apple/scripts";
import { FindMyDevice, FindMyFriendLocation, FindMyItem } from "@server/api/lib/findmy/types";
import { utagService, UTagBleSpec } from "@server/api/lib/utag";
import { gfindService, GoogleFindBleSpec } from "@server/api/lib/gfind";
import {
    enrichFindMyDeviceIcon,
    findDeviceForIconLookup,
    ResolvedDeviceIcon,
    resolveFindMyDeviceIconBytes
} from "@server/api/lib/findmy/findMyIcons";
import {
    FindMyForkHelperDeps,
    FindMyLiveState,
    StartFindMyLiveOptions,
    getChangedFindMyDevices,
    normalizeFindMyFriendLocations,
    refreshFindMyDevicesThroughPrivateApi,
    refreshFindMyFriends,
    startFindMyLiveLocation,
    stopFindMyLiveLocation,
    transformFindMyItemToDevice
} from "@server/api/lib/findmy/utils";
import {
    resolveFindMyDevicesPrivateApiTarget,
    resolveFindMyFriendsPrivateApiTarget
} from "@server/api/lib/findmy/privateApiSupport";
import type {
    RefreshFindMyDevicesOptions,
    RefreshFindMyFriendsOptions
} from "@server/api/privateApi/apis/PrivateApiFindMy";

export type { StartFindMyLiveOptions };

export class FindMyInterface {
    private static lastPreSequoiaDevicesById = new Map<string, FindMyDevice>();
    private static liveState: FindMyLiveState = { activeHandle: null, idleTimer: null };

    private static getHelperDeps(): FindMyForkHelperDeps {
        return {
            server: Server(),
            env: { isMinBigSur, isMinSonoma, isMinSequoia },
            execShellCommand: FileSystem.execShellCommand,
            waitMs,
            emitChangedDevices: (prev, next) => this.emitChangedDevices(prev, next),
            refreshUsingFindMyApp: () => this.refreshUsingFindMyApp(),
            resolveFindMyDevicesTarget: resolveFindMyDevicesPrivateApiTarget,
            resolveFindMyFriendsTarget: resolveFindMyFriendsPrivateApiTarget
        };
    }

    private static async emitChangedDevices(
        previousDevices: FindMyDevice[],
        nextDevices: FindMyDevice[]
    ): Promise<void> {
        for (const device of getChangedFindMyDevices(previousDevices, nextDevices)) {
            await Server().emitMessage?.(NEW_FINDMY_DEVICE, enrichFindMyDeviceIcon(device), "normal", false, true);
        }
    }

    static async getFriends(): Promise<FindMyFriendLocation[]> {
        return normalizeFindMyFriendLocations(Server().findMyFriendsCache.getAll());
    }

    static async getDevices(): Promise<Array<FindMyDevice> | null> {
        let appleDevices: Array<FindMyDevice> | null = null;
        if (isMinSequoia) {
            appleDevices = Server().findMyDevicesCache.getAll();
        } else {
            try {
                const [devices, items] = await Promise.all([
                    FindMyInterface.readDataFile("Devices"),
                    FindMyInterface.readDataFile("Items")
                ]);

                if (devices != null || items != null) {
                    const itemsWithGroup = (items ?? []).filter(item => item.groupIdentifier);
                    if (itemsWithGroup.length > 0) {
                        try {
                            const itemGroups = await FindMyInterface.readItemGroups();
                            if (itemGroups) {
                                const groupMap = itemGroups.reduce((acc, group) => {
                                    acc[group.identifier] = group.name;
                                    return acc;
                                }, {} as Record<string, string>);

                                for (const item of items ?? []) {
                                    if (item.groupIdentifier && groupMap[item.groupIdentifier]) {
                                        item.groupName = groupMap[item.groupIdentifier];
                                    }
                                }
                            }
                        } catch (ex: any) {
                            Server().logger.debug("An error occurred while reading FindMy ItemGroups cache file.");
                            Server().logger.debug(String(ex));
                        }
                    }

                    const transformedItems = (items ?? []).map(transformFindMyItemToDevice);
                    appleDevices = [...(devices ?? []), ...transformedItems];
                }
            } catch (ex: any) {
                Server().logger.debug("An error occurred while reading FindMy Device cache files.");
                Server().logger.debug(String(ex));
            }
        }

        const enableUtag = Boolean(Server().repo?.getConfig("enable_utag"));
        const enableGfind = Boolean(Server().repo?.getConfig("enable_gfind"));
        let utagDevices = enableUtag ? utagService.getCachedDevices() : [];
        if (enableUtag && utagDevices.length === 0) {
            utagDevices = await utagService.refreshDevices().catch(() => []);
        }
        let gfindDevices = enableGfind ? gfindService.getCachedDevices() : [];
        if (enableGfind && gfindDevices.length === 0) {
            await gfindService.refreshDevices().catch(() => []);
            gfindDevices = gfindService.getCachedDevices();
        }

        if (appleDevices == null && !enableUtag && !enableGfind) {
            return null;
        }

        return [...(appleDevices ?? []), ...utagDevices, ...gfindDevices].map(enrichFindMyDeviceIcon);
    }

    static async getDeviceIcon(deviceId: string): Promise<ResolvedDeviceIcon | null> {
        const devices = await this.getDevices();
        if (!devices || devices.length === 0) return null;
        const device = findDeviceForIconLookup(devices, deviceId);
        if (!device) return null;
        return resolveFindMyDeviceIconBytes(device);
    }

    static async refreshDevices(options?: RefreshFindMyDevicesOptions): Promise<Array<FindMyDevice> | null> {
        const enableUtag = Boolean(Server().repo?.getConfig("enable_utag"));
        const enableGfind = Boolean(Server().repo?.getConfig("enable_gfind"));
        const targetId =
            typeof options?.deviceId === "string" && options.deviceId.trim().length > 0
                ? options.deviceId.trim()
                : undefined;
        const force = typeof options?.force === "boolean" ? options.force : undefined;
        const normalizedOptions: RefreshFindMyDevicesOptions | undefined =
            targetId !== undefined || force !== undefined
                ? {
                      ...(targetId !== undefined ? { deviceId: targetId } : {}),
                      ...(force !== undefined ? { force } : {})
                  }
                : undefined;

        if (targetId?.startsWith("utag:")) {
            if (enableUtag) {
                await utagService.refreshDevices(targetId, { force });
            }
            return this.getDevices();
        }

        if (targetId?.startsWith("gfind:")) {
            if (enableGfind) {
                await gfindService.refreshDevices(targetId, { force });
            }
            return this.getDevices();
        }

        const refreshApple = async (): Promise<void> => {
            if (isMinSequoia) {
                await refreshFindMyDevicesThroughPrivateApi(this.getHelperDeps(), normalizedOptions, this.liveState);
                return;
            }
            await this.refreshUsingFindMyApp();
            const devices = await this.getDevices();
            if (Array.isArray(devices)) {
                await this.emitChangedDevices(Array.from(this.lastPreSequoiaDevicesById.values()), devices);
                this.lastPreSequoiaDevicesById.clear();
                for (const device of devices) {
                    const identifier = device.identifier ?? device.id;
                    if (identifier) {
                        this.lastPreSequoiaDevicesById.set(identifier, device);
                    }
                }
            }
        };

        const tasks: Array<Promise<unknown>> = [refreshApple()];
        if (enableUtag && !targetId) {
            tasks.push(utagService.refreshDevices(targetId, { force }));
        }
        if (enableGfind && !targetId) {
            tasks.push(gfindService.refreshDevices(targetId, { force }));
        }

        const results = await Promise.allSettled(tasks);
        const anySucceeded = results.some(r => r.status === "fulfilled");
        if (!anySucceeded) {
            const firstRejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
            if (firstRejected) {
                throw firstRejected.reason;
            }
        }

        return this.getDevices();
    }

    static async ringDevice(
        deviceId: string,
        action: "start" | "stop",
        component?: "all" | "right" | "left" | "case"
    ): Promise<void> {
        if (deviceId.startsWith("utag:")) {
            if (!Server().repo?.getConfig("enable_utag")) {
                throw new Error("Samsung SmartThings Find integration is disabled");
            }
            await utagService.ringDevice(deviceId, action);
            return;
        }
        if (deviceId.startsWith("gfind:")) {
            if (!Server().repo?.getConfig("enable_gfind")) {
                throw new Error("Google Find Hub integration is disabled");
            }
            await gfindService.ringDevice(deviceId, action, component);
            return;
        }
        throw new Error(`Unsupported deviceId for ringing: ${deviceId}`);
    }

    static getBleSpec(deviceId: string): UTagBleSpec | GoogleFindBleSpec {
        if (deviceId.startsWith("utag:")) {
            if (!Server().repo?.getConfig("enable_utag")) {
                throw new Error("Samsung SmartThings Find integration is disabled");
            }
            return utagService.getBleSpec(deviceId);
        }
        if (deviceId.startsWith("gfind:")) {
            if (!Server().repo?.getConfig("enable_gfind")) {
                throw new Error("Google Find Hub integration is disabled");
            }
            return gfindService.getBleSpec(deviceId);
        }
        throw new Error(`Unsupported deviceId for BLE spec: ${deviceId}`);
    }

    static async refreshFriends(
        allowFindMyAppFallback = true,
        options?: RefreshFindMyFriendsOptions
    ): Promise<FindMyFriendLocation[]> {
        return refreshFindMyFriends(this.getHelperDeps(), allowFindMyAppFallback, options);
    }

    static async startLiveLocation(
        handle: string,
        options?: StartFindMyLiveOptions
    ): Promise<{ handle: string; live: boolean; locations: FindMyFriendLocation[] }> {
        return startFindMyLiveLocation(this.getHelperDeps(), this.liveState, handle, options);
    }

    static async stopLiveLocation(handle?: string): Promise<{ handle: string | null; stopped: boolean }> {
        return stopFindMyLiveLocation(this.getHelperDeps(), this.liveState, handle);
    }

    static async refreshUsingFindMyApp() {
        await FileSystem.requestFindMyAutomationPermissions();
        await FileSystem.executeAppleScript(quitFindMyFriends());
        await waitMs(3000);

        await FileSystem.executeAppleScript(startFindMyFriends());
        await waitMs(5000);

        await FileSystem.executeAppleScript(showFindMyFriends());
        await waitMs(15000);

        await FileSystem.executeAppleScript(hideFindMyFriends());
    }

    static async readItemGroups(): Promise<Array<any>> {
        const itemGroupsPath = path.join(FileSystem.findMyDir, "ItemGroups.data");
        if (!fs.existsSync(itemGroupsPath)) return [];

        return new Promise((resolve, reject) => {
            fs.readFile(itemGroupsPath, { encoding: "utf-8" }, (err, data) => {
                // Couldn't read the file
                if (err) return resolve(null);

                try {
                    const parsedData = JSON.parse(data.toString());
                    if (Array.isArray(parsedData)) {
                        return resolve(parsedData);
                    } else {
                        reject(new Error("Failed to read FindMy ItemGroups cache file! It is not an array!"));
                    }
                } catch {
                    reject(new Error("Failed to read FindMy ItemGroups cache file! It is not in the correct format!"));
                }
            });
        });
    }

    private static readDataFile<T extends "Devices" | "Items">(
        type: T
    ): Promise<Array<T extends "Devices" ? FindMyDevice : FindMyItem> | null> {
        const devicesPath = path.join(FileSystem.findMyDir, `${type}.data`);
        return new Promise((resolve, reject) => {
            fs.readFile(devicesPath, { encoding: "utf-8" }, (err, data) => {
                // Couldn't read the file
                if (err) return resolve(null);

                try {
                    const parsedData = JSON.parse(data.toString());
                    if (Array.isArray(parsedData)) {
                        return resolve(parsedData);
                    } else {
                        reject(new Error(`Failed to read FindMy ${type} cache file! It is not an array!`));
                    }
                } catch {
                    reject(new Error(`Failed to read FindMy ${type} cache file! It is not in the correct format!`));
                }
            });
        });
    }
}
