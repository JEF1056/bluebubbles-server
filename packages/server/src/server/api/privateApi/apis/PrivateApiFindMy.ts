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

export const FIND_MY_DEVICES_REFRESH_TIMEOUT_MS = 12_000;

export interface RefreshFindMyDevicesOptions {
    deviceId?: string;
    force?: boolean;
}

const compactPayload = (fields: Record<string, unknown>): NodeJS.Dict<any> | null => {
    const payload: NodeJS.Dict<any> = {};
    for (const [k, v] of Object.entries(fields)) {
        if (typeof v === "string") {
            const trimmed = v.trim();
            if (trimmed.length > 0) payload[k] = trimmed;
        } else if (typeof v === "boolean") {
            payload[k] = v;
        }
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

    private requireTarget(target: string | null, kind: "Friends" | "Devices"): string {
        if (target == null) {
            throw new Error(`The Find My ${kind} private API is unavailable on this macOS version`);
        }
        return target;
    }

    async refreshFriends(options?: RefreshFindMyFriendsOptions): Promise<TransactionResult> {
        const target = this.requireTarget(this.friendsTargetProcessIdentifier, "Friends");
        const payload = compactPayload({
            handle: options?.handle,
            displayName: options?.displayName,
            force: options?.force,
            live: options?.live
        });
        return this.sendApiMessage("refresh-findmy-friends", payload, new TransactionPromise(TransactionType.FIND_MY), target);
    }

    async startLiveLocation(handle: string, displayName?: string): Promise<TransactionResult> {
        const target = this.requireTarget(this.friendsTargetProcessIdentifier, "Friends");
        const trimmedHandle = handle.trim();
        if (trimmedHandle.length === 0) {
            throw new Error("A friend handle is required to start Find My live location");
        }
        const payload = compactPayload({ handle: trimmedHandle, displayName });
        return this.sendApiMessage("start-findmy-live-location", payload, new TransactionPromise(TransactionType.FIND_MY), target);
    }

    async stopLiveLocation(handle?: string): Promise<TransactionResult> {
        const target = this.requireTarget(this.friendsTargetProcessIdentifier, "Friends");
        return this.sendApiMessage(
            "stop-findmy-live-location",
            compactPayload({ handle }),
            new TransactionPromise(TransactionType.FIND_MY),
            target
        );
    }

    async refreshDevices(options?: RefreshFindMyDevicesOptions): Promise<TransactionResult> {
        const target = this.requireTarget(this.devicesTargetProcessIdentifier, "Devices");
        const transaction = new TransactionPromise(TransactionType.FIND_MY);
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                this.sendApiMessage(
                    "refresh-findmy-devices",
                    compactPayload({ deviceId: options?.deviceId, force: options?.force }),
                    transaction,
                    target
                ),
                new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(() => {
                        const error = new Error(
                            `Find My Devices refresh timed out after ${FIND_MY_DEVICES_REFRESH_TIMEOUT_MS}ms`
                        );
                        if (!transaction.isResolved && typeof transaction.reject === "function") {
                            transaction.reject(error);
                        }
                        reject(error);
                    }, FIND_MY_DEVICES_REFRESH_TIMEOUT_MS);
                })
            ]);
        } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
    }
}
