import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import test from "node:test";

import { CallHistoryRepository, mapCallRows } from "../src/server/databases/callHistory/index.ts";

const SEP = String.fromCharCode(31);

test("mapCallRows converts Core Data ZDATE, integer ZDURATION, read flag, and null name", () => {
    const zDate = 750000000.25;
    const expectedMs = Math.round((zDate + 978307200) * 1000);

    const [entry] = mapCallRows([
        {
            Z_PK: 1,
            ZUNIQUE_ID: "call-uuid-1",
            ZDATE: zDate,
            ZDURATION: 42.6,
            ZORIGINATED: 1,
            ZANSWERED: 1,
            ZCALLTYPE: 8,
            ZSERVICE_PROVIDER: "com.apple.FaceTime",
            ZADDRESS: "+15551234567",
            ZNAME: "",
            ZREAD: 1,
            participants: "+15551234567"
        }
    ]);

    assert.equal(entry.id, "call-uuid-1");
    assert.equal(entry.date, expectedMs);
    assert.equal(entry.duration, 43);
    assert.equal(entry.name, null);
    assert.equal(entry.read, true);
});

test("mapCallRows resolves direction for outgoing (even unanswered), incoming, and missed", () => {
    const rows = mapCallRows([
        {
            ZUNIQUE_ID: "out-unanswered",
            ZORIGINATED: 1,
            ZANSWERED: 0,
            ZCALLTYPE: 16,
            ZADDRESS: "a@example.com",
            ZREAD: 1
        },
        {
            ZUNIQUE_ID: "in-answered",
            ZORIGINATED: 0,
            ZANSWERED: 1,
            ZCALLTYPE: 16,
            ZADDRESS: "b@example.com",
            ZREAD: 1
        },
        {
            ZUNIQUE_ID: "in-missed",
            ZORIGINATED: 0,
            ZANSWERED: 0,
            ZCALLTYPE: 16,
            ZADDRESS: "c@example.com",
            ZREAD: 0
        }
    ]);

    assert.deepEqual(
        rows.map(r => r.direction),
        ["outgoing", "incoming", "missed"]
    );
    assert.equal(rows[2].read, false);
});

test("mapCallRows resolves service and isVideo across FaceTime video, FaceTime audio, and Telephony", () => {
    const rows = mapCallRows([
        { ZUNIQUE_ID: "ft-vid", ZCALLTYPE: 8, ZSERVICE_PROVIDER: "com.apple.FaceTime", ZADDRESS: "+15550001" },
        { ZUNIQUE_ID: "ft-aud", ZCALLTYPE: 16, ZSERVICE_PROVIDER: "com.apple.FaceTime", ZADDRESS: "+15550002" },
        { ZUNIQUE_ID: "tel-type", ZCALLTYPE: 1, ZSERVICE_PROVIDER: "com.apple.FaceTime", ZADDRESS: "+15550003" },
        { ZUNIQUE_ID: "tel-prov", ZCALLTYPE: 99, ZSERVICE_PROVIDER: "com.apple.Telephony", ZADDRESS: "+15550004" },
        { ZUNIQUE_ID: "unknown", ZCALLTYPE: 99, ZSERVICE_PROVIDER: "com.apple.FaceTime", ZADDRESS: "+15550005" }
    ]);

    assert.deepEqual(
        rows.map(r => ({ service: r.service, isVideo: r.isVideo })),
        [
            { service: "facetime_video", isVideo: true },
            { service: "facetime_audio", isVideo: false },
            { service: "phone", isVideo: false },
            { service: "phone", isVideo: false },
            { service: "facetime_audio", isVideo: false }
        ]
    );
});

test("mapCallRows splits char(31) participants, deduplicates, and falls back to [ZADDRESS]", () => {
    const rows = mapCallRows([
        {
            ZUNIQUE_ID: "group-call",
            ZCALLTYPE: 8,
            ZADDRESS: "+15551110000",
            ZNAME: "Team",
            participants: `+15551110000${SEP}alice@example.com${SEP}+15551110000${SEP} `
        },
        {
            ZUNIQUE_ID: "fallback-call",
            ZCALLTYPE: 16,
            ZADDRESS: "+15552220000",
            participants: null
        },
        {
            ZUNIQUE_ID: "empty-call",
            ZCALLTYPE: 16,
            ZADDRESS: "",
            participants: ""
        }
    ]);

    assert.deepEqual(rows[0].participants, ["+15551110000", "alice@example.com"]);
    assert.equal(rows[0].name, "Team");
    assert.deepEqual(rows[1].participants, ["+15552220000"]);
    assert.deepEqual(rows[2].participants, []);
});

test("CallHistoryRepository returns available:false and never throws when DB file is missing", () => {
    const missingPath = path.join(os.tmpdir(), `nonexistent-callhistory-${Date.now()}.storedata`);
    const repo = new CallHistoryRepository(missingPath);
    const result = repo.list({ limit: 25, offset: 0 });

    assert.equal(result.available, false);
    assert.deepEqual(result.data, []);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
});

test("CallHistoryRepository returns available:false on SQLITE_CANTOPEN / EPERM and clamps list params", () => {
    const permErr: any = new Error("unable to open database file");
    permErr.code = "SQLITE_CANTOPEN";
    const blockedRepo = new CallHistoryRepository({
        dbPath: "/fake/CallHistory.storedata",
        openDb: () => {
            throw permErr;
        }
    });
    const blocked = blockedRepo.list();
    assert.equal(blocked.available, false);
    assert.deepEqual(blocked.data, []);
    assert.match(blocked.reason ?? "", /Full Disk Access|Permission denied/i);

    let capturedSql = "";
    let capturedParams: any[] = [];
    let closed = false;
    const mockRepo = new CallHistoryRepository({
        dbPath: "/fake/CallHistory.storedata",
        openDb: () => ({
            prepare: (sql: string) => {
                capturedSql = sql;
                return {
                    all: (...params: any[]) => {
                        capturedParams = params;
                        return [
                            {
                                ZUNIQUE_ID: "m-1",
                                ZDATE: 0,
                                ZDURATION: 0,
                                ZORIGINATED: 0,
                                ZANSWERED: 0,
                                ZCALLTYPE: 16,
                                ZADDRESS: "+15553334444"
                            }
                        ];
                    }
                };
            },
            close: () => {
                closed = true;
            }
        })
    });

    const ok = mockRepo.list({ limit: 999, offset: -5, missedOnly: true });
    assert.equal(ok.available, true);
    assert.equal(ok.data.length, 1);
    assert.equal(ok.data[0].direction, "missed");
    assert.match(capturedSql, /WHERE r\.ZORIGINATED = 0 AND r\.ZANSWERED = 0/);
    assert.deepEqual(capturedParams, [200, 0]);
    assert.equal(closed, true);
});
