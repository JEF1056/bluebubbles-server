import { Next } from "koa";
import { RouterContext } from "koa-router";
import { Success } from "../responses/success";
import { BadRequest, ServerError } from "../responses/errors";
import { FindMyInterface } from "@server/api/interfaces/findMyInterface";
import { FindMyFriendLocation } from "@server/api/lib/findmy/types";
import { NEW_FINDMY_LOCATION } from "@server/events";
import { Server } from "@server";

const optStr = (val: unknown): string | undefined =>
    typeof val === "string" && val.trim().length > 0 ? val.trim() : undefined;

export class FindMyRouter {
    static async emitFriendLocationUpdates(friendLocations: FindMyFriendLocation[]) {
        if (!Array.isArray(friendLocations)) return;
        for (const friendLocation of friendLocations) {
            await Server().emitMessage(NEW_FINDMY_LOCATION, friendLocation, "normal", false, true);
        }

        Server().logger.debug(
            `Emitted ${friendLocations.length} FindMy friend location update(s) to socket clients after refresh.`
        );
    }

    static async refreshDevices(ctx: RouterContext, _: Next) {
        try {
            const body = (ctx.request?.body ?? {}) as { deviceId?: unknown; force?: unknown };
            const deviceId = optStr(body.deviceId ?? ctx.query?.deviceId);
            const force =
                typeof body.force === "boolean"
                    ? body.force
                    : ctx.query?.force === "true"
                      ? true
                      : undefined;
            const locations = await FindMyInterface.refreshDevices(
                deviceId !== undefined || force !== undefined ? { deviceId, force } : undefined
            );
            return new Success(ctx, {
                message: "Successfully refreshed Find My device locations!",
                data: locations
            }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to refresh Find My device locations!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async refreshFriends(ctx: RouterContext, _: Next) {
        try {
            const body = (ctx.request?.body ?? {}) as { handle?: unknown; force?: unknown; live?: unknown };
            const handle = optStr(body.handle);
            const force = typeof body.force === "boolean" ? body.force : undefined;
            const live = typeof body.live === "boolean" ? body.live : undefined;
            const options =
                handle !== undefined || force !== undefined || live !== undefined
                    ? { handle, force, live }
                    : undefined;
            const friendLocations = await FindMyInterface.refreshFriends(true, options);
            const locationsToEmit =
                handle !== undefined
                    ? friendLocations.filter(loc => loc.handle?.toLowerCase() === handle.toLowerCase())
                    : friendLocations;
            await FindMyRouter.emitFriendLocationUpdates(locationsToEmit);
            return new Success(ctx, {
                message: "Successfully refreshed Find My friends locations!",
                data: friendLocations
            }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to refresh Find My friends locations!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async devices(ctx: RouterContext, _: Next) {
        try {
            const data = await FindMyInterface.getDevices();
            return new Success(ctx, { message: "Successfully fetched Find My device locations!", data }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to fetch Find My device locations!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async friends(ctx: RouterContext, _: Next) {
        try {
            const friendLocations = await FindMyInterface.getFriends();
            return new Success(ctx, {
                message: "Successfully fetched Find My friends locations!",
                data: friendLocations
            }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to fetch Find My friends locations!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async startLiveFriend(ctx: RouterContext, _: Next) {
        const body = (ctx.request?.body ?? {}) as { handle?: unknown };
        const handle = typeof body.handle === "string" ? body.handle.trim() : "";
        if (handle.length === 0) {
            throw new BadRequest({ error: "A friend handle is required to start Find My live location!" });
        }

        try {
            const result = await FindMyInterface.startLiveLocation(handle);
            if (result.locations.length > 0) {
                await FindMyRouter.emitFriendLocationUpdates(result.locations);
            }
            return new Success(ctx, {
                message: "Successfully started Find My live location!",
                data: result
            }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to start Find My live location!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async stopLiveFriend(ctx: RouterContext, _: Next) {
        try {
            const body = (ctx.request?.body ?? {}) as { handle?: unknown };
            const result = await FindMyInterface.stopLiveLocation(optStr(body.handle));
            return new Success(ctx, {
                message: "Successfully stopped Find My live location!",
                data: result
            }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to stop Find My live location!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async ringDevice(ctx: RouterContext, _: Next) {
        const body = (ctx.request?.body ?? {}) as {
            deviceId?: unknown;
            action?: unknown;
            component?: unknown;
        };
        const deviceId = optStr(body.deviceId);
        if (!deviceId) {
            throw new BadRequest({
                error: "A valid utag: or gfind: deviceId is required to ring a tracker."
            });
        }
        if (!deviceId.startsWith("utag:") && !deviceId.startsWith("gfind:")) {
            throw new BadRequest({
                error: "Apple Find My devices and AirTags cannot be rung remotely via the server; use the Find My app on the Mac."
            });
        }

        const action = optStr(body.action);
        if (action !== "start" && action !== "stop") {
            throw new BadRequest({
                error: "Action must be 'start' or 'stop'."
            });
        }

        const component = optStr(body.component);
        if (component && component !== "all" && component !== "right" && component !== "left" && component !== "case") {
            throw new BadRequest({
                error: "Component must be one of 'all', 'right', 'left', or 'case'."
            });
        }

        try {
            await FindMyInterface.ringDevice(
                deviceId,
                action,
                component as "all" | "right" | "left" | "case" | undefined
            );
            return new Success(ctx, {
                message: `Successfully sent ${action} ring command!`,
                data: { deviceId, action, component: component ?? null }
            }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to ring tracker device!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async bleSpec(ctx: RouterContext, _: Next) {
        const deviceId = optStr(ctx.query?.deviceId);
        if (!deviceId || (!deviceId.startsWith("utag:") && !deviceId.startsWith("gfind:"))) {
            throw new BadRequest({
                error: "A valid utag: or gfind: deviceId query parameter is required."
            });
        }

        try {
            const spec = FindMyInterface.getBleSpec(deviceId);
            return new Success(ctx, {
                message: "Successfully fetched tracker BLE spec!",
                data: spec
            }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to fetch tracker BLE spec!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async deviceIcon(ctx: RouterContext, _: Next) {
        const id = optStr(ctx.query?.id ?? ctx.query?.deviceId);
        if (!id) {
            throw new BadRequest({
                error: "A valid id query parameter is required."
            });
        }

        const icon = await FindMyInterface.getDeviceIcon(id);
        if (!icon) {
            ctx.status = 404;
            ctx.body = { status: 404, message: "Find My device icon not found" };
            return;
        }

        ctx.status = 200;
        ctx.set("Content-Type", icon.contentType);
        ctx.set("Cache-Control", "private, max-age=86400");
        ctx.body = icon.bytes;
    }
}
