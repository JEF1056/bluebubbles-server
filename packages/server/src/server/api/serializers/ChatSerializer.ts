import { isNotEmpty } from "@server/helpers/utils";
import { ChatResponse } from "@server/types";
import { DEFAULT_CHAT_CONFIG, DEFAULT_HANDLE_CONFIG, DEFAULT_MESSAGE_CONFIG } from "./constants";
import type { ChatSerializerMutliParams, ChatSerializerSingleParams } from "./types";
import { MessageSerializer } from "./MessageSerializer";
import { HandleSerializer } from "./HandleSerializer";
import { extractReadReceiptsOverride, isChatFilteredAsSpam } from "./chatSpam";
import { Server } from "@server";

// Unified `any;-;` chats can keep a stale `chat.service_name` (e.g. "SMS") in chat.db;
// prefer the latest message's service when known.
export const resolveEffectiveChatServiceName = (
    chatGuid: string | null | undefined,
    chatServiceName: string,
    lastMessageService?: string | null
): string => {
    if (chatGuid?.startsWith("any;-;") && isNotEmpty(lastMessageService)) {
        return lastMessageService;
    }
    return chatServiceName;
};

export class ChatSerializer {
    static async serialize({
        chat,
        config = DEFAULT_CHAT_CONFIG,
        messageConfig = DEFAULT_MESSAGE_CONFIG,
        handleConfig = DEFAULT_HANDLE_CONFIG,
        isForNotification = false
    }: ChatSerializerSingleParams): Promise<ChatResponse> {
        return (
            await ChatSerializer.serializeList({
                chats: [chat],
                config: { ...DEFAULT_CHAT_CONFIG, ...config },
                messageConfig: { ...DEFAULT_MESSAGE_CONFIG, ...messageConfig },
                handleConfig: { ...DEFAULT_HANDLE_CONFIG, ...handleConfig },
                isForNotification
            })
        )[0];
    }

    static async serializeList({
        chats,
        config = DEFAULT_CHAT_CONFIG,
        messageConfig = DEFAULT_MESSAGE_CONFIG,
        handleConfig = DEFAULT_HANDLE_CONFIG,
        isForNotification = false
    }: ChatSerializerMutliParams): Promise<ChatResponse[]> {
        return Promise.all(
            chats.map(
                async chat =>
                    await ChatSerializer.convert({
                        chat,
                        config: { ...DEFAULT_CHAT_CONFIG, ...config },
                        messageConfig: { ...DEFAULT_MESSAGE_CONFIG, ...messageConfig },
                        handleConfig: { ...DEFAULT_HANDLE_CONFIG, ...handleConfig },
                        isForNotification
                    })
            )
        );
    }

    private static async convert({
        chat,
        config = DEFAULT_CHAT_CONFIG,
        messageConfig = DEFAULT_MESSAGE_CONFIG,
        handleConfig = DEFAULT_HANDLE_CONFIG,
        isForNotification = false
    }: ChatSerializerSingleParams): Promise<ChatResponse> {
        let latestMsgService: string | null = null;
        if (isNotEmpty(chat.messages)) {
            let latest = chat.messages[0];
            for (let i = 1; i < chat.messages.length; i++) {
                const curTime = chat.messages[i]?.dateCreated?.getTime?.() ?? 0;
                const bestTime = latest?.dateCreated?.getTime?.() ?? 0;
                if (curTime > bestTime) latest = chat.messages[i];
            }
            latestMsgService = latest?.service ?? null;
        }

        let output: ChatResponse = {
            originalROWID: chat.ROWID,
            guid: chat.guid,
            style: chat.style,
            chatIdentifier: chat.chatIdentifier,
            serviceName: resolveEffectiveChatServiceName(chat.guid, chat.serviceName, latestMsgService),
            isArchived: chat.isArchived,
            displayName: chat.displayName,
            // Included in notifications too: the first message from a new spam
            // or iOS-filtered sender arrives by push, before any chat sync.
            isFiltered: Boolean(chat.isFiltered),
            isFilteredAsSpam: isChatFilteredAsSpam(chat.properties),
            autoSendReadReceipts: extractReadReceiptsOverride(chat.properties)
        };

        if (config.includeParticipants) {
            output.participants = await HandleSerializer.serializeList({
                handles: chat?.participants ?? [],
                config: {
                    ...handleConfig,
                    includeChats: false
                },
                messageConfig,
                chatConfig: config,
                isForNotification
            });
        }

        if (config.includeMessages) {
            output.messages = await MessageSerializer.serializeList({
                messages: chat?.messages ?? [],
                config: {
                    ...messageConfig,
                    includeChats: false
                },
                isForNotification
            });
        }

        if (!isForNotification) {
            const pinInfo = Server()?.pinnedChatsCache?.getPinInfo(chat.guid) ?? null;
            output = {
                ...output,
                ...{
                    ...(pinInfo ?? {}),
                    isFiltered: chat.isFiltered,
                    groupId: chat.groupId,
                    properties: chat.properties,
                    lastAddressedHandle: chat.lastAddressedHandle
                }
            };
        }

        return output;
    }
}
