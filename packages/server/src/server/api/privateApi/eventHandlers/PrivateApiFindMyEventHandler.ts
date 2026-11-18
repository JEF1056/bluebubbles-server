import { Server } from "@server";
import * as net from "net";
import { PrivateApiEventHandler, EventData } from ".";
import { FindMyDevice, FindMyFriendLocation } from "@server/api/lib/findmy/types";
import {
    hasFindMyDeviceLocationChanged,
    normalizeFindMyDevices,
    normalizeFindMyFriendLocations
} from "@server/api/lib/findmy/utils";
import { NEW_FINDMY_DEVICE, NEW_FINDMY_LOCATION } from "@server/events";
import { isEmpty, titleCase, waitMs } from "@server/helpers/utils";
import { Loggable } from "@server/lib/logging/Loggable";
import { obfuscatedHandle } from "@server/utils/StringUtils";

export class PrivateApiFindMyEventHandler extends Loggable implements PrivateApiEventHandler {
    tag = "PrivateApiFindMyEventHandler";

    types: string[] = ["new-findmy-location", "new-findmy-device"];

    async handle(eventData: EventData, _socket: net.Socket) {
        try {
            if (eventData.event === "new-findmy-location") {
                await this.handleNewLocations(eventData.data);
            } else if (eventData.event === "new-findmy-device") {
                await this.handleNewDevices(eventData.data);
            }
        } catch (error: any) {
            this.log.debug(`Failed to handle event type ${eventData.event}. Error: ${error}`);
        }
    }

    async handleNewDevices(deviceUpdates: unknown) {
        if (isEmpty(deviceUpdates)) return;
        const rawDevices = Array.isArray(deviceUpdates) ? deviceUpdates : [deviceUpdates];
        const normalizedDevices = normalizeFindMyDevices(rawDevices);
        if (normalizedDevices.length === 0) return;

        const previousDevices = Server().findMyDevicesCache.getAll();
        const previousById = new Map<string, FindMyDevice>();
        for (const device of previousDevices) {
            const identifier = device.identifier ?? device.id;
            if (identifier) {
                previousById.set(identifier, device);
            }
        }

        const changedDevices = normalizedDevices.filter(device => {
            const identifier = device.identifier ?? device.id;
            const previousDevice = identifier ? previousById.get(identifier) : undefined;
            return hasFindMyDeviceLocationChanged(previousDevice, device);
        });

        Server().findMyDevicesCache.updateAll(normalizedDevices);

        for (const device of changedDevices) {
            await Server().emitMessage(NEW_FINDMY_DEVICE, device, "normal", false, true);
        }
    }

    async handleNewLocations(locationUpdates: FindMyFriendLocation[]) {
        if (isEmpty(locationUpdates)) return;
        const normalizedLocations = normalizeFindMyFriendLocations(locationUpdates);
        const updatedLocations = Server().findMyFriendsCache.updateAll(normalizedLocations);

        let emittedLocationCount = 0;
        for (const location of updatedLocations) {
            const handle = obfuscatedHandle(location.handle);
            const coordinates = location.coordinates;
            if (coordinates == null) {
                this.log.debug(
                    `Received FindMy ${titleCase(location.status)} Update Without a Location for Handle: ${handle}`
                );
            } else if (coordinates[0] === 0 && coordinates[1] === 0) {
                this.log.debug(
                    `Received FindMy ${titleCase(location.status)} (0, 0) Location Update for Handle: ${handle}`
                );
            } else {
                this.log.debug(`Received FindMy ${titleCase(location.status)} Location Update for Handle: ${handle}`);
            }

            await Server().emitMessage(NEW_FINDMY_LOCATION, location, "normal", false, true);
            emittedLocationCount += 1;

            if (emittedLocationCount < updatedLocations.length) {
                await waitMs(250);
            }
        }
    }
}
