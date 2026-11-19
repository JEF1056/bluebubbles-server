import {
    TransactionPromise,
    TransactionResult,
    TransactionType
} from "@server/managers/transactionManager/transactionPromise";
import { PrivateApiAction } from ".";
import { isMinBigSur, isMinSequoia, isMinSonoma } from "@server/env";
import {
    resolveFindMyDevicesPrivateApiTarget,
    resolveFindMyFriendsPrivateApiTarget
} from "@server/api/lib/findmy/privateApiSupport";

export interface RefreshFindMyFriendsOptions {
    handle?: string;
    displayName?: string;
    force?: boolean;
    live?: boolean;
}

export interface RefreshFindMyDevicesOptions {
    deviceId?: string;
    force?: boolean;
}

const buildRefreshFriendsPayload = (options?: RefreshFindMyFriendsOptions): NodeJS.Dict<any> | null => {
    const payload: NodeJS.Dict<any> = {};
    const handle = typeof options?.handle === "string" ? options.handle.trim() : "";
    if (handle.length > 0) {
        payload.handle = handle;
    }
    const displayName = typeof options?.displayName === "string" ? options.displayName.trim() : "";
    if (displayName.length > 0) {
        payload.displayName = displayName;
    }
    if (typeof options?.force === "boolean") {
        payload.force = options.force;
    }
    if (typeof options?.live === "boolean") {
        payload.live = options.live;
    }
    return Object.keys(payload).length > 0 ? payload : null;
};

const buildRefreshDevicesPayload = (options?: RefreshFindMyDevicesOptions): NodeJS.Dict<any> | null => {
    const payload: NodeJS.Dict<any> = {};
    const deviceId = typeof options?.deviceId === "string" ? options.deviceId.trim() : "";
    if (deviceId.length > 0) {
        payload.deviceId = deviceId;
    }
    if (typeof options?.force === "boolean") {
        payload.force = options.force;
    }
    return Object.keys(payload).length > 0 ? payload : null;
};

export class PrivateApiFindMy extends PrivateApiAction {
    tag = "PrivateApiFindMy";

    readonly friendsTargetProcessIdentifier = resolveFindMyFriendsPrivateApiTarget({
        isMinBigSur,
        isMinSonoma,
        isMinSequoia
    });

    readonly devicesTargetProcessIdentifier = resolveFindMyDevicesPrivateApiTarget({ isMinSequoia });

    async refreshFriends(options?: RefreshFindMyFriendsOptions): Promise<TransactionResult> {
        if (this.friendsTargetProcessIdentifier == null) {
            throw new Error("The Find My Friends private API is unavailable on this macOS version");
        }

        const action = "refresh-findmy-friends";
        const request = new TransactionPromise(TransactionType.FIND_MY);
        return this.sendApiMessage(
            action,
            buildRefreshFriendsPayload(options),
            request,
            this.friendsTargetProcessIdentifier
        );
    }

    async startLiveLocation(handle: string, displayName?: string): Promise<TransactionResult> {
        if (this.friendsTargetProcessIdentifier == null) {
            throw new Error("The Find My Friends private API is unavailable on this macOS version");
        }

        const trimmedHandle = handle.trim();
        if (trimmedHandle.length === 0) {
            throw new Error("A friend handle is required to start Find My live location");
        }

        const trimmedDisplayName = typeof displayName === "string" ? displayName.trim() : "";
        const payload: NodeJS.Dict<any> = { handle: trimmedHandle };
        if (trimmedDisplayName.length > 0) {
            payload.displayName = trimmedDisplayName;
        }

        const request = new TransactionPromise(TransactionType.FIND_MY);
        return this.sendApiMessage(
            "start-findmy-live-location",
            payload,
            request,
            this.friendsTargetProcessIdentifier
        );
    }

    async stopLiveLocation(handle?: string): Promise<TransactionResult> {
        if (this.friendsTargetProcessIdentifier == null) {
            throw new Error("The Find My Friends private API is unavailable on this macOS version");
        }

        const trimmedHandle = typeof handle === "string" ? handle.trim() : "";
        const payload = trimmedHandle.length > 0 ? { handle: trimmedHandle } : null;
        const request = new TransactionPromise(TransactionType.FIND_MY);
        return this.sendApiMessage(
            "stop-findmy-live-location",
            payload,
            request,
            this.friendsTargetProcessIdentifier
        );
    }

    async refreshDevices(options?: RefreshFindMyDevicesOptions): Promise<TransactionResult> {
        if (this.devicesTargetProcessIdentifier == null) {
            throw new Error("The Find My Devices private API is unavailable on this macOS version");
        }

        const action = "refresh-findmy-devices";
        const request = new TransactionPromise(TransactionType.FIND_MY);
        return this.sendApiMessage(
            action,
            buildRefreshDevicesPayload(options),
            request,
            this.devicesTargetProcessIdentifier
        );
    }
}
