import type { DataSource } from "typeorm";
import { UNREAD_MESSAGE_PREDICATE } from "../snapshot/ChatStateSnapshot";

/**
 * Counts the incoming messages in a chat that are still awaiting a read,
 * using the same predicate as ChatStateSnapshot so live and snapshot read states agree.
 */
export function buildChatUnreadCountQuery(): string {
    return `
        SELECT
            COUNT(DISTINCT c.ROWID) AS chat_count,
            SUM(
                CASE
                    WHEN ${UNREAD_MESSAGE_PREDICATE}
                    THEN 1
                    ELSE 0
                END
            ) AS unread_count
        FROM chat c
        LEFT JOIN chat_message_join j ON j.chat_id = c.ROWID
        LEFT JOIN message m ON m.ROWID = j.message_id
        WHERE c.guid = ?
    `;
}

/**
 * Resolves whether a single chat currently has no unread incoming messages.
 *
 * A read advancing on one message does not mean the chat is read: the user may
 * have read the newest message while older ones remain unread, and emitting an
 * unconditional `read: true` clears the whole badge. Re-check the chat instead.
 */
export async function isChatFullyRead(db: DataSource, guid: string): Promise<boolean> {
    const rows = await db.query(buildChatUnreadCountQuery(), [guid]);
    const chatCount = Number(rows?.[0]?.chat_count ?? 0);
    if (chatCount <= 0) return false;
    const unread = Number(rows[0]?.unread_count ?? 0);
    return unread === 0;
}
