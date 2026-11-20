import { isEmpty } from "@server/helpers/utils";
import { FindMyFriendLocation } from "./types";

const statusRank: Record<string, number> = {
    legacy: 1,
    shallow: 2,
    live: 3
};

const hasValidCoordinates = (coords: [number, number] | null | undefined): coords is [number, number] =>
    Array.isArray(coords) &&
    coords.length === 2 &&
    typeof coords[0] === "number" &&
    typeof coords[1] === "number" &&
    Number.isFinite(coords[0]) &&
    Number.isFinite(coords[1]) &&
    !(coords[0] === 0 && coords[1] === 0);

const mergeFallbackAddress = (
    merged: FindMyFriendLocation,
    existing: FindMyFriendLocation
): Partial<FindMyFriendLocation> => ({
    long_address: merged.long_address ?? existing.long_address,
    short_address: merged.short_address ?? existing.short_address,
    street: merged.street ?? existing.street,
    city: merged.city ?? existing.city,
    state: merged.state ?? existing.state,
    zip: merged.zip ?? existing.zip,
    country: merged.country ?? existing.country,
    address: merged.address ?? existing.address
});

export type FindMyFriendUpdateListener = (location: FindMyFriendLocation) => void;

export class FindMyFriendsCache {
    private cache: Map<string, FindMyFriendLocation> = new Map();
    private listeners: Set<FindMyFriendUpdateListener> = new Set();

    onUpdate(listener: FindMyFriendUpdateListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private notifyUpdate(location: FindMyFriendLocation) {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener(location);
            } catch {
                // Ignore listener failures so cache updates never fail
            }
        }
    }

    getAll(): FindMyFriendLocation[] {
        return Array.from(this.cache.values());
    }

    get(handle: string): FindMyFriendLocation | null {
        return this.cache.get(handle) ?? null;
    }

    updateAll(locations: FindMyFriendLocation[]): FindMyFriendLocation[] {
        const updatedLocations: FindMyFriendLocation[] = [];
        for (const loc of locations) {
            const updated = this.update(loc);
            if (updated) {
                updatedLocations.push(this.cache.get(loc.handle) ?? loc);
            }
        }
        return updatedLocations;
    }

    replaceAll(locations: FindMyFriendLocation[]): FindMyFriendLocation[] {
        const nextCache = new Map<string, FindMyFriendLocation>();
        const updatedLocations: FindMyFriendLocation[] = [];

        for (const loc of locations) {
            if (!loc || isEmpty(loc.handle)) continue;

            const existing = this.cache.get(loc.handle);
            const existingTimestamp = existing?.last_updated ?? 0;
            const nextTimestamp = loc.last_updated ?? 0;

            if (existing && existingTimestamp > nextTimestamp) {
                nextCache.set(loc.handle, existing);
                continue;
            }

            nextCache.set(loc.handle, loc);
            if (!existing || this.updateWouldChange(existing, loc)) {
                updatedLocations.push(loc);
            }
        }

        this.cache = nextCache;
        for (const loc of updatedLocations) {
            this.notifyUpdate(loc);
        }
        return updatedLocations;
    }

    private updateWouldChange(existing: FindMyFriendLocation, incoming: FindMyFriendLocation): boolean {
        return (
            existing.last_updated !== incoming.last_updated ||
            this.hasTelemetryOrStateChanged(existing, incoming)
        );
    }

    private hasTelemetryOrStateChanged(existing: FindMyFriendLocation, incoming: FindMyFriendLocation): boolean {
        const existingLat = existing.coordinates?.[0] ?? null;
        const existingLon = existing.coordinates?.[1] ?? null;
        const incomingLat = incoming.coordinates?.[0] ?? null;
        const incomingLon = incoming.coordinates?.[1] ?? null;
        return (
            existingLat !== incomingLat ||
            existingLon !== incomingLon ||
            existing.horizontal_accuracy !== incoming.horizontal_accuracy ||
            existing.vertical_accuracy !== incoming.vertical_accuracy ||
            existing.speed !== incoming.speed ||
            existing.altitude !== incoming.altitude ||
            Boolean(existing.locating_in_progress) !== Boolean(incoming.locating_in_progress) ||
            Boolean(existing.is_locating_in_progress) !== Boolean(incoming.is_locating_in_progress) ||
            Boolean(existing.is_live) !== Boolean(incoming.is_live) ||
            existing.location_type !== incoming.location_type ||
            existing.status !== incoming.status ||
            existing.long_address !== incoming.long_address ||
            existing.short_address !== incoming.short_address ||
            existing.title !== incoming.title ||
            existing.subtitle !== incoming.subtitle
        );
    }

    update(location: FindMyFriendLocation): boolean {
        if (!location || isEmpty(location.handle)) return false;

        const existing = this.cache.get(location.handle);
        const cachedTimestamp = existing?.last_updated ?? 0;
        const updatedTimestamp = location.last_updated ?? 0;

        if (existing) {
            // Never overwrite a newer fix with an older fix
            if (updatedTimestamp < cachedTimestamp) {
                return false;
            }

            // At the same timestamp, reject lower-tier status downgrades (e.g., shallow/legacy over live)
            if (updatedTimestamp === cachedTimestamp) {
                const cachedRank = statusRank[existing.status ?? ""] ?? 0;
                const updatedRank = statusRank[location.status ?? ""] ?? 0;
                if (updatedRank < cachedRank) {
                    return false;
                }
            }

            let merged = location;

            // Preserve cached coordinates, coordinate timestamp, and granular address when incoming has null/[0,0]
            if (!hasValidCoordinates(merged.coordinates) && hasValidCoordinates(existing.coordinates)) {
                merged = {
                    ...merged,
                    coordinates: existing.coordinates,
                    last_updated: existing.last_updated,
                    ...mergeFallbackAddress(merged, existing)
                };
            } else if (updatedTimestamp === cachedTimestamp && !merged.long_address && existing.long_address) {
                // Preserve already-resolved granular street address if a same-timestamp update lacks one
                merged = {
                    ...merged,
                    ...mergeFallbackAddress(merged, existing),
                    long_address: existing.long_address
                };
            }

            if (!this.updateWouldChange(existing, merged)) {
                return false;
            }

            this.cache.set(location.handle, merged);
            this.notifyUpdate(merged);
            return true;
        }

        this.cache.set(location.handle, location);
        this.notifyUpdate(location);
        return true;
    }
}
