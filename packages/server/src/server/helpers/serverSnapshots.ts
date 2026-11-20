import {
    loadChatStateSnapshot,
    type ChatStateSnapshotResult
} from "@server/databases/imessage/snapshot/ChatStateSnapshot";
import {
    loadRecoverableMessageSnapshot,
    type RecoverableMessageSnapshotResult
} from "@server/databases/imessage/snapshot/RecoverableMessageSnapshot";

export type { ChatStateSnapshotResult, RecoverableMessageSnapshotResult };

type SnapshotLogger = {
    info: (message: string) => void;
};

export async function getChatStateSnapshot(
    db: Parameters<typeof loadChatStateSnapshot>[0] | undefined,
    logger: SnapshotLogger
): Promise<ChatStateSnapshotResult> {
    if (!db) {
        throw new Error("iMessage repository is not initialized");
    }

    const snapshot = await loadChatStateSnapshot(db);
    const unread = snapshot.chats.filter(chat => !chat.read).length;
    logger.info(
        `Served chat state snapshot: ${snapshot.chats.length} chats ` +
            `(${snapshot.chats.length - unread} read, ${unread} unread)`
    );

    return snapshot;
}

export async function getRecoverableMessageSnapshot(
    db: Parameters<typeof loadRecoverableMessageSnapshot>[0] | undefined,
    logger: SnapshotLogger
): Promise<RecoverableMessageSnapshotResult> {
    if (!db) {
        throw new Error("iMessage repository is not initialized");
    }

    const snapshot = await loadRecoverableMessageSnapshot(db);
    const total = snapshot.chats.reduce((sum, chat) => sum + chat.deletedMessageGuids.length, 0);
    logger.info(
        `Served recoverable message snapshot: ${total} deleted messages across ${snapshot.chats.length} chats`
    );

    return snapshot;
}
