import { Server } from "@server";
import path from "path";
import fs from "fs";
import { FileSystem } from "@server/fileSystem";
import { NEW_FINDMY_DEVICE } from "@server/events";
import { isMinBigSur, isMinSequoia, isMinSonoma } from "@server/env";
import { waitMs } from "@server/helpers/utils";
import { quitFindMyFriends, startFindMyFriends, showFindMyFriends, hideFindMyFriends } from "../apple/scripts";
import {
    FindMyDevice,
    FindMyDevicesRefreshResponse,
    FindMyFriendLocation,
    FindMyFriendsRefreshResponse,
    FindMyItem
} from "@server/api/lib/findmy/types";
import {
    getChangedFindMyDevices,
    normalizeFindMyDevices,
    normalizeFindMyFriendLocations,
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

const FIND_MY_DEVICES_HELPER_CONNECTION_TIMEOUT_MS = 10_000;
const FIND_MY_DEVICES_HELPER_CONNECTION_POLL_MS = 100;
const FIND_MY_LIVE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface StartFindMyLiveOptions {
    idleTimeoutMs?: number;
}

export class FindMyInterface {
    private static lastPreSequoiaDevicesById = new Map<string, FindMyDevice>();
    private static activeLiveFriendHandle: string | null = null;
    private static liveFriendIdleTimer: NodeJS.Timeout | null = null;

    private static async emitChangedDevices(
        previousDevices: FindMyDevice[],
        nextDevices: FindMyDevice[]
    ): Promise<void> {
        for (const device of getChangedFindMyDevices(previousDevices, nextDevices)) {
            await Server().emitMessage?.(NEW_FINDMY_DEVICE, device, "normal", false, true);
        }
    }

    static async getFriends(): Promise<FindMyFriendLocation[]> {
        return normalizeFindMyFriendLocations(Server().findMyFriendsCache.getAll());
    }

    static async getDevices(): Promise<Array<FindMyDevice> | null> {
        if (isMinSequoia) {
            return Server().findMyDevicesCache.getAll();
        }

        try {
            const [devices, items] = await Promise.all([
                FindMyInterface.readDataFile("Devices"),
                FindMyInterface.readDataFile("Items")
            ]);

            // Return null if neither of the files exist
            if (devices == null && items == null) return null;

            // Get any items with a group identifier
            const itemsWithGroup = items.filter(item => item.groupIdentifier);
            if (itemsWithGroup.length > 0) {
                try {
                    const itemGroups = await FindMyInterface.readItemGroups();
                    if (itemGroups) {
                        // Create a map of group IDs to group names
                        const groupMap = itemGroups.reduce((acc, group) => {
                            acc[group.identifier] = group.name;
                            return acc;
                        }, {} as Record<string, string>);

                        // Iterate over the items and add the group name
                        for (const item of items) {
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

            // Transform the items to match the same shape as devices
            const transformedItems = (items ?? []).map(transformFindMyItemToDevice);

            return [...(devices ?? []), ...transformedItems];
        } catch (ex: any) {
            Server().logger.debug("An error occurred while reading FindMy Device cache files.");
            Server().logger.debug(String(ex));
            return null;
        }
    }

    static async refreshDevices(options?: RefreshFindMyDevicesOptions): Promise<Array<FindMyDevice> | null> {
        if (isMinSequoia) {
            return this.refreshDevicesThroughPrivateApi(options);
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
        return devices;
    }

    private static async refreshDevicesThroughPrivateApi(
        options?: RefreshFindMyDevicesOptions
    ): Promise<FindMyDevice[]> {
        const privateApiEnabled = Boolean(Server().repo.getConfig("enable_private_api"));
        if (!privateApiEnabled) {
            throw new Error("Find My Devices on macOS 15 or later requires the Private API");
        }

        const openFindMyOnStartup = Boolean(Server().repo.getConfig("open_findmy_on_startup"));
        if (!openFindMyOnStartup) {
            throw new Error("Find My Devices requires Open FindMy App on Startup to be enabled");
        }

        const targetProcessIdentifier = resolveFindMyDevicesPrivateApiTarget({ isMinSequoia });
        if (targetProcessIdentifier == null) {
            throw new Error("The Find My Devices helper is unavailable on this macOS version");
        }

        await FileSystem.execShellCommand("/usr/bin/open findmy://devices");
        const helperAvailable = await this.waitForPrivateApiClient(targetProcessIdentifier);
        if (!helperAvailable) {
            throw new Error("The Find My Devices helper did not connect before the refresh timeout");
        }

        const hasDeviceOptions =
            (typeof options?.deviceId === "string" && options.deviceId.trim().length > 0) ||
            typeof options?.force === "boolean";
        const result = hasDeviceOptions
            ? await Server().privateApi.findmy.refreshDevices({
                  ...(options?.deviceId?.trim() ? { deviceId: options.deviceId.trim() } : {}),
                  ...(typeof options?.force === "boolean" ? { force: options.force } : {})
              })
            : await Server().privateApi.findmy.refreshDevices();
        const refreshResponse = result?.data as FindMyDevicesRefreshResponse | undefined;
        if (!Array.isArray(refreshResponse?.devices)) {
            throw new Error("The Find My Devices helper returned an invalid response");
        }
        if (typeof refreshResponse.partial !== "boolean") {
            throw new Error("The Find My Devices helper returned an invalid completion state");
        }
        const skippedDeviceCount = refreshResponse.skippedDevices;
        if (typeof skippedDeviceCount !== "number" || !Number.isInteger(skippedDeviceCount) || skippedDeviceCount < 0) {
            throw new Error("The Find My Devices helper returned an invalid skipped-device count");
        }
        if (refreshResponse.partial !== skippedDeviceCount > 0) {
            throw new Error("The Find My Devices helper returned an inconsistent completion state");
        }

        const devices = normalizeFindMyDevices(refreshResponse.devices);
        if (devices.length !== refreshResponse.devices.length) {
            throw new Error("The Find My Devices helper returned invalid device records");
        }

        const deviceIdentifiers = devices.map(device => device.identifier);
        if (new Set(deviceIdentifiers).size !== deviceIdentifiers.length) {
            throw new Error("The Find My Devices helper returned duplicate device identifiers");
        }

        const previousDevices = Server().findMyDevicesCache.getAll();
        if (refreshResponse.partial) {
            Server().findMyDevicesCache.updateAll(devices);
            Server().logger.warn(
                `Find My Devices returned a partial response (${skippedDeviceCount} ` + "unidentifiable device(s))."
            );
        } else {
            Server().findMyDevicesCache.replaceAll(devices);
        }

        await this.emitChangedDevices(previousDevices, devices);

        const devicesWithLocations = devices.filter(device => device.location != null).length;
        Server().logger.debug(
            `Refreshed ${devices.length} Find My device(s) through FMIPDataManager; ` +
                `${devicesWithLocations} included a location.`
        );
        return Server().findMyDevicesCache.getAll();
    }

    private static async waitForPrivateApiClient(processIdentifier: string): Promise<boolean> {
        const maximumAttempts = Math.ceil(
            FIND_MY_DEVICES_HELPER_CONNECTION_TIMEOUT_MS / FIND_MY_DEVICES_HELPER_CONNECTION_POLL_MS
        );
        for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
            if (Server().privateApi.hasClient(processIdentifier)) {
                return true;
            }
            await waitMs(FIND_MY_DEVICES_HELPER_CONNECTION_POLL_MS);
        }
        return Server().privateApi.hasClient(processIdentifier);
    }

    private static isFriendsHelperReady(): boolean {
        const privateApiTarget = resolveFindMyFriendsPrivateApiTarget({ isMinBigSur, isMinSonoma, isMinSequoia });
        return (
            Boolean(Server().repo.getConfig("enable_private_api")) &&
            privateApiTarget != null &&
            Server().privateApi.hasClient(privateApiTarget)
        );
    }

    static async refreshFriends(
        allowFindMyAppFallback = true,
        options?: RefreshFindMyFriendsOptions
    ): Promise<FindMyFriendLocation[]> {
        let receivedUsableHelperResponse = false;
        if (this.isFriendsHelperReady()) {
            try {
                const trimmedHandle = typeof options?.handle === "string" ? options.handle.trim() : "";
                const displayName =
                    trimmedHandle.length > 0 ? await this.resolveContactDisplayName(trimmedHandle) : undefined;
                const hasFriendOptions =
                    trimmedHandle.length > 0 ||
                    typeof options?.force === "boolean" ||
                    typeof options?.live === "boolean";
                const result = hasFriendOptions
                    ? await Server().privateApi.findmy.refreshFriends({
                          ...(trimmedHandle.length > 0 ? { handle: trimmedHandle } : {}),
                          ...(displayName ? { displayName } : {}),
                          ...(typeof options?.force === "boolean" ? { force: options.force } : {}),
                          ...(typeof options?.live === "boolean" ? { live: options.live } : {})
                      })
                    : await Server().privateApi.findmy.refreshFriends();
                const refreshResponse = result?.data as FindMyFriendsRefreshResponse | undefined;
                if (Array.isArray(refreshResponse?.locations)) {
                    const refreshedLocations = normalizeFindMyFriendLocations(refreshResponse.locations);
                    const responseContainsOnlyInvalidLocations =
                        refreshResponse.locations.length > 0 && refreshedLocations.length === 0;
                    const responseIsPartial = refreshResponse.partial === true;
                    receivedUsableHelperResponse =
                        !responseContainsOnlyInvalidLocations && (!responseIsPartial || refreshedLocations.length > 0);

                    if (!responseContainsOnlyInvalidLocations) {
                        if (responseIsPartial || trimmedHandle.length > 0) {
                            Server().findMyFriendsCache.updateAll(refreshedLocations);
                        } else {
                            Server().findMyFriendsCache.replaceAll(refreshedLocations);
                        }
                    } else {
                        Server().logger.warn("Find My Friends helper returned no identifiable locations.");
                    }

                    if (responseIsPartial) {
                        const timedOutFriendCount = Array.isArray(refreshResponse.timedOutHandles)
                            ? refreshResponse.timedOutHandles.length
                            : 0;
                        const skippedFriendCount = Number(refreshResponse.skippedFriends ?? 0);
                        Server().logger.warn(
                            `Find My Friends returned a partial response (${timedOutFriendCount} timed-out ` +
                                `handle(s), ${skippedFriendCount} skipped friend(s)).`
                        );
                    }
                }
            } catch (error: any) {
                Server().logger.warn(
                    `Unable to refresh Find My Friends through the helper: ${error?.message ?? String(error)}`
                );
            }
        }

        const shouldRefreshUsingFindMyApp = allowFindMyAppFallback && (!receivedUsableHelperResponse || !isMinSequoia);
        if (shouldRefreshUsingFindMyApp) {
            void this.refreshUsingFindMyApp().catch((error: any) => {
                Server().logger.warn(`Unable to refresh Find My through the app: ${error?.message ?? String(error)}`);
            });
        }

        return normalizeFindMyFriendLocations(Server().findMyFriendsCache.getAll());
    }

    private static async resolveContactDisplayName(handle: string): Promise<string | undefined> {
        try {
            const { ContactInterface } = require("./contactInterface");
            const contacts = await ContactInterface.queryContacts([handle]);
            for (const contact of contacts) {
                const display =
                    (typeof contact?.displayName === "string" && contact.displayName.trim()) ||
                    [contact?.firstName, contact?.lastName]
                        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
                        .join(" ")
                        .trim();
                if (display.length > 0) return display;
            }
        } catch {
            // Best-effort lookup for FindMy People row selection.
        }
        return undefined;
    }

    private static clearLiveIdleTimer(): void {
        if (this.liveFriendIdleTimer != null) {
            clearTimeout(this.liveFriendIdleTimer);
            this.liveFriendIdleTimer = null;
        }
    }

    static async startLiveLocation(
        handle: string,
        options?: StartFindMyLiveOptions
    ): Promise<{ handle: string; live: boolean; locations: FindMyFriendLocation[] }> {
        const trimmedHandle = handle.trim();
        if (trimmedHandle.length === 0) {
            throw new Error("A friend handle is required to start Find My live location");
        }

        if (!this.isFriendsHelperReady()) {
            throw new Error("Find My Friends Private API helper is not connected");
        }

        const displayName = await this.resolveContactDisplayName(trimmedHandle);
        const result = await Server().privateApi.findmy.startLiveLocation(trimmedHandle, displayName);
        const responseData = result?.data as FindMyFriendsRefreshResponse | undefined;
        let updatedLocations: FindMyFriendLocation[] = [];
        if (Array.isArray(responseData?.locations)) {
            const normalized = normalizeFindMyFriendLocations(responseData.locations);
            if (normalized.length > 0) {
                updatedLocations = Server().findMyFriendsCache.updateAll(normalized);
            }
        }

        if (updatedLocations.length === 0) {
            const cached = Server().findMyFriendsCache.getAll().filter(
                loc => loc.handle?.toLowerCase() === trimmedHandle.toLowerCase()
            );
            updatedLocations = normalizeFindMyFriendLocations(cached);
        }

        this.activeLiveFriendHandle = trimmedHandle;
        this.clearLiveIdleTimer();
        const idleTimeoutMs = options?.idleTimeoutMs ?? FIND_MY_LIVE_IDLE_TIMEOUT_MS;
        if (idleTimeoutMs > 0) {
            this.liveFriendIdleTimer = setTimeout(() => {
                void this.stopLiveLocation(trimmedHandle).catch((error: any) => {
                    Server().logger.debug(
                        `Auto-stop Find My live location failed: ${error?.message ?? String(error)}`
                    );
                });
            }, idleTimeoutMs);
            this.liveFriendIdleTimer.unref?.();
        }

        return {
            handle: trimmedHandle,
            live: true,
            locations: updatedLocations
        };
    }

    static async stopLiveLocation(handle?: string): Promise<{ handle: string | null; stopped: boolean }> {
        const trimmedHandle = typeof handle === "string" && handle.trim().length > 0 ? handle.trim() : undefined;
        const matchesActive =
            trimmedHandle == null ||
            this.activeLiveFriendHandle == null ||
            this.activeLiveFriendHandle.toLowerCase() === trimmedHandle.toLowerCase();
        const previousHandle = this.activeLiveFriendHandle;
        if (matchesActive) {
            this.clearLiveIdleTimer();
            this.activeLiveFriendHandle = null;
        }

        if (!this.isFriendsHelperReady()) {
            return {
                handle: trimmedHandle ?? previousHandle ?? null,
                stopped: false
            };
        }

        const result = await Server().privateApi.findmy.stopLiveLocation(trimmedHandle);
        const responseData = result?.data as { stopped?: unknown } | undefined;
        return {
            handle: trimmedHandle ?? previousHandle ?? null,
            stopped: typeof responseData?.stopped === "boolean" ? responseData.stopped : true
        };
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
