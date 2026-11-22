import assert from "node:assert/strict";
import test from "node:test";

import {
    FCM_DEFAULT_TTL_MS,
    FCM_RING_TTL_MS,
    getFcmAndroidTtlMs
} from "../src/server/services/fcmService/FcmPayload.ts";
import { ScheduledService } from "../src/server/lib/ScheduledService.ts";

test("getFcmAndroidTtlMs uses 30s TTL for incoming-facetime", () => {
    assert.equal(
        getFcmAndroidTtlMs({ type: "incoming-facetime", data: JSON.stringify({ call_uuid: "u-1" }) }),
        FCM_RING_TTL_MS
    );
    assert.equal(FCM_RING_TTL_MS, 30_000);
});

test("getFcmAndroidTtlMs uses 30s TTL for ft-call-status-changed status_id 4", () => {
    assert.equal(
        getFcmAndroidTtlMs({ type: "ft-call-status-changed", data: JSON.stringify({ uuid: "u-1", status_id: 4 }) }),
        FCM_RING_TTL_MS
    );
});

test("getFcmAndroidTtlMs keeps 24h TTL for missed-call status_id 6, other statuses, and other events", () => {
    assert.equal(
        getFcmAndroidTtlMs({ type: "ft-call-status-changed", data: JSON.stringify({ uuid: "u-1", status_id: 6 }) }),
        FCM_DEFAULT_TTL_MS
    );
    assert.equal(
        getFcmAndroidTtlMs({ type: "ft-call-status-changed", data: JSON.stringify({ uuid: "u-1", status_id: 1 }) }),
        FCM_DEFAULT_TTL_MS
    );
    assert.equal(
        getFcmAndroidTtlMs({ type: "ft-call-status-changed", data: "not-json" }),
        FCM_DEFAULT_TTL_MS
    );
    assert.equal(
        getFcmAndroidTtlMs({ type: "new-message", data: JSON.stringify({ guid: "m-1" }) }),
        FCM_DEFAULT_TTL_MS
    );
    assert.equal(FCM_DEFAULT_TTL_MS, 24 * 60 * 60 * 1000);
});

test("ScheduledService skips overlapping ticks while an async action is in flight", async () => {
    let calls = 0;
    let releaseFirst: (() => void) | null = null;

    const svc = new ScheduledService(async () => {
        calls += 1;
        if (calls === 1) {
            await new Promise<void>(resolve => {
                releaseFirst = resolve;
            });
        }
    }, 15);

    try {
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(calls, 1, "expected second and third ticks to be skipped while first is in flight");

        releaseFirst?.();
        await new Promise(resolve => setTimeout(resolve, 45));
        assert.ok(calls >= 2, `expected ticks to resume after in-flight action resolved, got ${calls}`);
    } finally {
        svc.stop();
    }
});
