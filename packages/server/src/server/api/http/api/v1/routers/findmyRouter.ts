import { Next } from "koa";
import { RouterContext } from "koa-router";
import { Success } from "../responses/success";
import { BadRequest, ServerError } from "../responses/errors";
import { FindMyInterface } from "@server/api/interfaces/findMyInterface";
import { FindMyFriendLocation } from "@server/api/lib/findmy/types";
import { NEW_FINDMY_LOCATION } from "@server/events";
import { Server } from "@server";

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
            const deviceId =
                typeof body.deviceId === "string" && body.deviceId.trim().length > 0
                    ? body.deviceId.trim()
                    : undefined;
            const force = typeof body.force === "boolean" ? body.force : undefined;
            const options = deviceId !== undefined || force !== undefined ? { deviceId, force } : undefined;
            const locations = await FindMyInterface.refreshDevices(options);
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
            const handle =
                typeof body.handle === "string" && body.handle.trim().length > 0 ? body.handle.trim() : undefined;
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
            const handle =
                typeof body.handle === "string" && body.handle.trim().length > 0 ? body.handle.trim() : undefined;
            const result = await FindMyInterface.stopLiveLocation(handle);
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
}
