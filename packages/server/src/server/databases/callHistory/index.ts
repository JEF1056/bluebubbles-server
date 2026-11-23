import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

const CORE_DATA_EPOCH_OFFSET_SECONDS = 978307200;
const PARTICIPANT_SEPARATOR = String.fromCharCode(31);

export const DEFAULT_CALL_HISTORY_DB_PATH = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "CallHistoryDB",
    "CallHistory.storedata"
);

export type CallDirection = "incoming" | "outgoing" | "missed";
export type CallService = "facetime_video" | "facetime_audio" | "phone";

export interface RawCallRecordRow {
    Z_PK?: number | string | null;
    ZUNIQUE_ID?: string | null;
    ZDATE?: number | null;
    ZDURATION?: number | null;
    ZORIGINATED?: number | null;
    ZANSWERED?: number | null;
    ZCALLTYPE?: number | null;
    ZSERVICE_PROVIDER?: string | null;
    ZADDRESS?: string | null;
    ZNAME?: string | null;
    ZREAD?: number | null;
    participants?: string | null;
}

export interface CallHistoryEntry {
    id: string;
    date: number;
    duration: number;
    direction: CallDirection;
    service: CallService;
    isVideo: boolean;
    address: string;
    name: string | null;
    participants: string[];
    read: boolean;
}

export interface CallHistoryListOptions {
    limit?: number;
    offset?: number;
    missedOnly?: boolean;
}

export interface CallHistoryListResult {
    data: CallHistoryEntry[];
    available: boolean;
    reason?: string;
}

type SqliteStatementLike = {
    all: (...params: any[]) => RawCallRecordRow[];
};

type SqliteDatabaseLike = {
    prepare: (sql: string) => SqliteStatementLike;
    close: () => void;
};

export interface CallHistoryRepositoryOptions {
    dbPath?: string;
    openDb?: (dbPath: string) => SqliteDatabaseLike;
}

function mapService(callTypeRaw: number | null | undefined, providerRaw: string | null | undefined): CallService {
    const callType = Number(callTypeRaw);
    if (callType === 8) return "facetime_video";
    if (callType === 16) return "facetime_audio";
    if (callType === 1 || providerRaw === "com.apple.Telephony") return "phone";
    return "facetime_audio";
}

function mapParticipants(rawParticipants: string | null | undefined, address: string): string[] {
    const split =
        typeof rawParticipants === "string" && rawParticipants.length > 0
            ? rawParticipants
                  .split(PARTICIPANT_SEPARATOR)
                  .map(p => p.trim())
                  .filter(Boolean)
            : [];
    const items = split.length > 0 ? split : address ? [address] : [];
    return Array.from(new Set(items));
}

export function mapCallRows(rows: RawCallRecordRow[]): CallHistoryEntry[] {
    return rows.map(row => {
        const zDate = Number(row.ZDATE);
        const date = Number.isFinite(zDate) ? Math.round((zDate + CORE_DATA_EPOCH_OFFSET_SECONDS) * 1000) : 0;

        const zDuration = Number(row.ZDURATION);
        const duration = Number.isFinite(zDuration) ? Math.max(0, Math.round(zDuration)) : 0;

        const direction: CallDirection =
            Number(row.ZORIGINATED) === 1 ? "outgoing" : Number(row.ZANSWERED) === 1 ? "incoming" : "missed";

        const service = mapService(row.ZCALLTYPE, row.ZSERVICE_PROVIDER);
        const address = String(row.ZADDRESS ?? "");
        const name = row.ZNAME != null && String(row.ZNAME).length > 0 ? String(row.ZNAME) : null;

        return {
            id: String(row.ZUNIQUE_ID ?? row.Z_PK ?? ""),
            date,
            duration,
            direction,
            service,
            isVideo: service === "facetime_video",
            address,
            name,
            participants: mapParticipants(row.participants, address),
            read: Boolean(row.ZREAD)
        };
    });
}

function defaultOpenDb(dbPath: string): SqliteDatabaseLike {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function formatOpenError(err: any): string {
    const code = err?.code;
    if (code === "SQLITE_CANTOPEN" || code === "EPERM" || code === "EACCES") {
        return "Permission denied reading macOS Call History database (grant Full Disk Access to BlueBubbles Server).";
    }
    if (code === "ENOENT") {
        return "macOS Call History database not found.";
    }
    return err?.message ?? String(err);
}

export class CallHistoryRepository {
    private readonly dbPath: string;
    private readonly openDb: (dbPath: string) => SqliteDatabaseLike;

    constructor(dbPathOrOpts?: string | CallHistoryRepositoryOptions) {
        if (typeof dbPathOrOpts === "string") {
            this.dbPath = dbPathOrOpts;
            this.openDb = defaultOpenDb;
        } else {
            this.dbPath = dbPathOrOpts?.dbPath ?? DEFAULT_CALL_HISTORY_DB_PATH;
            this.openDb = dbPathOrOpts?.openDb ?? defaultOpenDb;
        }
    }

    list(opts: CallHistoryListOptions = {}): CallHistoryListResult {
        const rawLimit = Number(opts.limit ?? 50);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 50;

        const rawOffset = Number(opts.offset ?? 0);
        const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;

        const missedOnly = Boolean(opts.missedOnly);

        if (!this.openDb || (this.openDb === defaultOpenDb && !fs.existsSync(this.dbPath))) {
            return {
                data: [],
                available: false,
                reason: "macOS Call History database not found."
            };
        }

        let db: SqliteDatabaseLike | null = null;
        try {
            db = this.openDb(this.dbPath);
            const whereClause = missedOnly ? "WHERE r.ZORIGINATED = 0 AND r.ZANSWERED = 0" : "";
            const sql = `
                SELECT
                    r.Z_PK,
                    r.ZUNIQUE_ID,
                    r.ZDATE,
                    r.ZDURATION,
                    r.ZORIGINATED,
                    r.ZANSWERED,
                    r.ZCALLTYPE,
                    r.ZSERVICE_PROVIDER,
                    r.ZADDRESS,
                    r.ZNAME,
                    r.ZREAD,
                    group_concat(h.ZVALUE, char(31)) AS participants
                FROM ZCALLRECORD r
                LEFT JOIN Z_2REMOTEPARTICIPANTHANDLES p ON p.Z_2REMOTEPARTICIPANTCALLS = r.Z_PK
                LEFT JOIN ZHANDLE h ON h.Z_PK = p.Z_4REMOTEPARTICIPANTHANDLES
                ${whereClause}
                GROUP BY r.Z_PK
                ORDER BY r.ZDATE DESC
                LIMIT ? OFFSET ?
            `;
            const rows = db.prepare(sql).all(limit, offset);
            return {
                data: mapCallRows(rows),
                available: true
            };
        } catch (err: any) {
            return {
                data: [],
                available: false,
                reason: formatOpenError(err)
            };
        } finally {
            try {
                db?.close();
            } catch {
                // Ignore close errors on failed/read-only handles
            }
        }
    }
}
