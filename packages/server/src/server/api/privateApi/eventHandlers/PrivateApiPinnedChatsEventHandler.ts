import * as net from "net";
import { Server } from "@server";
import { PINNED_CHATS_UPDATED } from "@server/events";
import { PrivateApiEventHandler, EventData } from ".";

export class PrivateApiPinnedChatsEventHandler implements PrivateApiEventHandler {
    types: string[] = ["pinned-chats-updated"];

    async handle(data: EventData, _: net.Socket) {
        const { changed, pinnedChatGuids } = Server().pinnedChatsCache.setPinnedGuids(data?.pinnedChatGuids);
        if (changed) {
            Server().emitMessage(PINNED_CHATS_UPDATED, { pinnedChatGuids }, "normal", false);
        }
    }
}
