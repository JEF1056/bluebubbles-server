import { execFile } from "child_process";
import { promisify } from "util";
import { Next } from "koa";
import { RouterContext } from "koa-router";
import { Server } from "@server";
import { FaceTimeAudioBridge } from "@server/api/lib/facetime/FaceTimeAudioBridge";
import { BadRequest } from "../responses/errors";
import { NoData, Success } from "../responses/success";
import { CallMetadataOptions, FaceTimeInterface } from "@server/api/interfaces/facetimeInterface";
import { CallHistoryRepository } from "@server/databases/callHistory";

const execFileAsync = promisify(execFile);

const BRIDGE_PROBE_CACHE_TTL_MS = 30_000;

type BridgeProbeResult = {
    binaryFound: boolean;
    check: Record<string, any>;
    videoSupported: boolean;
    videoUplinkSupported: boolean;
};

let cachedBridgeProbe: { expiresAt: number; value: BridgeProbeResult } | null = null;
let bridgeProbeInFlight: Promise<BridgeProbeResult> | null = null;

async function getBridgeProbe(): Promise<BridgeProbeResult> {
    const now = Date.now();
    if (cachedBridgeProbe && now < cachedBridgeProbe.expiresAt) {
        return cachedBridgeProbe.value;
    }
    if (bridgeProbeInFlight) return bridgeProbeInFlight;

    bridgeProbeInFlight = (async () => {
        const bin = FaceTimeAudioBridge.resolveHelperBinary();
        let check: Record<string, any> = {
            ok: false,
            processTapSupported: false,
            blackHoleFound: false,
            targetProcessCount: 0
        };
        if (bin) {
            try {
                const { stdout } = await execFileAsync(bin, ["--check"], { timeout: 3000 });
                check = JSON.parse(stdout.trim());
            } catch (ex: any) {
                check.error = ex?.message ?? String(ex);
            }
        }
        const value: BridgeProbeResult = {
            binaryFound: Boolean(bin),
            check,
            videoSupported: FaceTimeAudioBridge.isVideoSupported(),
            videoUplinkSupported: FaceTimeAudioBridge.isVideoUplinkSupported()
        };
        if (value.binaryFound && value.check?.ok === true && !value.check?.error) {
            cachedBridgeProbe = { expiresAt: Date.now() + BRIDGE_PROBE_CACHE_TTL_MS, value };
        } else {
            cachedBridgeProbe = null;
        }
        return value;
    })().finally(() => {
        bridgeProbeInFlight = null;
    });

    return bridgeProbeInFlight;
}

const parseCallMode = (raw: unknown): "video" | "audio" | "video_bridge" | undefined =>
    raw === "video" || raw === "audio" || raw === "video_bridge" ? raw : undefined;

const extractMetadata = (body: Record<string, any> = {}): CallMetadataOptions => {
    const addresses = Array.isArray(body.addresses)
        ? body.addresses.map(String)
        : body.address
          ? [String(body.address)]
          : undefined;
    return {
        deviceId: body.deviceId ?? body.device_id ?? undefined,
        deviceName: body.deviceName ?? body.device_name ?? undefined,
        displayName: body.displayName ?? body.display_name ?? undefined,
        chatGuid: body.chatGuid ?? body.chat_guid ?? undefined,
        addresses
    };
};

export class FaceTimeRouter {
    static async listSessions(ctx: RouterContext, _: Next) {
        const sessions = FaceTimeInterface.listSessions();
        return new Success(ctx, { data: { sessions } }).send();
    }

    static async answer(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const audioOnly = ctx.request.query?.audioOnly === "true" || Boolean(body.audioOnly);
        const mode = parseCallMode(body.mode);
        const result = await FaceTimeInterface.answer(ctx.params.call_uuid, audioOnly, {
            ...extractMetadata(body),
            mode
        });
        return new Success(ctx, {
            data: {
                audioOnly: result.audioOnly,
                callUuid: result.callUuid,
                ...(result.link ? { link: result.link } : {}),
                session: result.session
            }
        }).send();
    }

    static async handoff(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const mode = parseCallMode(body.mode);
        const data = await FaceTimeInterface.handoff(ctx.params.call_uuid, {
            deviceId: body.deviceId ?? body.device_id,
            deviceName: body.deviceName ?? body.device_name,
            mode
        });
        return new Success(ctx, { data }).send();
    }

    static async transferBack(ctx: RouterContext, _: Next) {
        const data = await FaceTimeInterface.transferBack(ctx.params.call_uuid);
        return new Success(ctx, { data }).send();
    }

    static async leave(ctx: RouterContext, _: Next) {
        await FaceTimeInterface.leave(ctx.params.call_uuid);
        return new NoData(ctx, {}).send();
    }

    static async end(ctx: RouterContext, _: Next) {
        await FaceTimeInterface.end(ctx.params.call_uuid);
        return new NoData(ctx, {}).send();
    }

    static async newSession(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const rawVideo = body.isVideo ?? body.is_video ?? body.video;
        const isVideo =
            rawVideo === false || rawVideo === "false" ? false : rawVideo !== undefined ? Boolean(rawVideo) : true;
        const data = await FaceTimeInterface.create({ ...extractMetadata(body), isVideo });
        return new Success(ctx, { data }).send();
    }

    static async call(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const meta = extractMetadata(body);
        const addresses = meta.addresses ?? [];
        const video = body.video !== undefined ? Boolean(body.video) : true;
        const isTelephony = Boolean(body.isTelephony ?? body.is_telephony ?? false);
        const mode = parseCallMode(body.mode);
        const data = await FaceTimeInterface.call({ ...meta, addresses, video, isTelephony, mode });
        return new Success(ctx, { data }).send();
    }

    static async decline(ctx: RouterContext, _: Next) {
        await FaceTimeInterface.decline(ctx.params.call_uuid);
        return new NoData(ctx, {}).send();
    }

    static async setMuted(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        await FaceTimeInterface.setMuted(ctx.params.call_uuid, Boolean(body.muted));
        return new NoData(ctx, {}).send();
    }

    static async dtmf(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const callUuid = String(body.callUuid ?? body.call_uuid ?? "").trim();
        const digit = String(body.digit ?? "").trim().toUpperCase();
        if (!callUuid) throw new BadRequest({ message: "callUuid is required" });
        if (!/^[0-9*#ABCD]$/.test(digit)) {
            throw new BadRequest({ message: "Invalid DTMF digit: must be one of 0-9, *, #, A-D" });
        }
        const data = await FaceTimeInterface.dtmf(callUuid, digit);
        return new Success(ctx, { data }).send();
    }

    static async bridgeStatus(ctx: RouterContext, _: Next) {
        const probe = await getBridgeProbe();
        return new Success(ctx, {
            data: {
                ...probe.check,
                binaryFound: probe.binaryFound,
                videoSupported: probe.videoSupported,
                videoUplinkSupported: probe.videoUplinkSupported,
                facetime_calling: Boolean(Server().repo.getConfig("facetime_calling")),
                helper_connected: Boolean(Server().privateApi?.helper),
                activeSessions: FaceTimeAudioBridge.getInstance().sessions.size,
                iceServers: FaceTimeAudioBridge.getIceServers()
            }
        }).send();
    }

    static async history(ctx: RouterContext, _: Next) {
        const query = ctx.request.query ?? {};
        const pick = (val: string | string[] | undefined): string | undefined =>
            (Array.isArray(val) ? val[0] : val)?.trim();

        let limit = 50;
        const rawLimit = pick(query.limit);
        if (rawLimit !== undefined && rawLimit !== "") {
            if (!/^-?\d+$/.test(rawLimit)) {
                throw new BadRequest({ message: "limit must be an integer" });
            }
            limit = Math.max(1, Math.min(200, Number(rawLimit)));
        }

        let offset = 0;
        const rawOffset = pick(query.offset);
        if (rawOffset !== undefined && rawOffset !== "") {
            if (!/^-?\d+$/.test(rawOffset)) {
                throw new BadRequest({ message: "offset must be an integer" });
            }
            offset = Math.max(0, Number(rawOffset));
        }

        let missedOnly = false;
        const rawMissedOnly = pick(query.missedOnly);
        if (rawMissedOnly !== undefined && rawMissedOnly !== "") {
            const normalized = rawMissedOnly.toLowerCase();
            if (normalized === "true" || normalized === "1") {
                missedOnly = true;
            } else if (normalized === "false" || normalized === "0") {
                missedOnly = false;
            } else {
                throw new BadRequest({ message: "missedOnly must be a boolean" });
            }
        }

        const repo = new CallHistoryRepository();
        const result = repo.list({ limit, offset, missedOnly });
        const metadata: Record<string, any> = {
            limit,
            offset,
            count: result.data.length,
            available: result.available
        };
        if (result.reason !== undefined) {
            metadata.reason = result.reason;
        }

        return new Success(ctx, { data: result.data, metadata }).send();
    }

    static async cleanupLinks(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body ?? {}) as Record<string, any>;
        const url = typeof body.url === "string" ? body.url.trim() : "";
        if (!url) {
            throw new BadRequest({ message: "url is required" });
        }
        const result = await Server().privateApi.facetime.removeLink(url);
        return new Success(ctx, { data: result?.data ?? {} }).send();
    }
}
