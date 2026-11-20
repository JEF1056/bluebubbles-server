import type { FindMyAddress, FindMyDevice, FindMyLocation } from "@server/api/lib/findmy/types";
import type { TrackerGeocodedAddress } from "@server/api/lib/findmy/trackerCommon";
import type { ResolvedGeoCoordinates } from "./utagCrypto";

export interface SmartThingsBleD2D {
    advertisingId?: string;
    cipher?: string;
    encryptionKey?: string;
    privacyId?: string;
    [key: string]: unknown;
}

export interface SmartThingsTagDevice {
    deviceId: string;
    label?: string;
    name?: string;
    ocfDeviceType?: string;
    deviceManufacturerCode?: string;
    manufacturerName?: string;
    presentationId?: string;
    modelName?: string;
    icon?: string;
    batteryLevel?: string | number;
    bleD2D?: SmartThingsBleD2D;
    [key: string]: unknown;
}

export interface UTagBleSpec {
    deviceId: string;
    rawId: string;
    provider: "utag";
    serviceUuid: "fd5a";
    expiresAt: number;
    expectedPrivacyIdsHex: string[];
    supportsUwb: boolean;
    uwbPackage: "com.kieronquinn.app.utag";
    uwbAction: "com.kieronquinn.app.utag.MAP";
    uwbClass: "com.kieronquinn.app.utag.ui.activities.TagActivity";
    uwbExtraKey: "target_id";
    uwbFallbackPackage: "com.samsung.android.oneconnect";
}

export const mapSmartTagModelName = (rawModel?: string, fallbackName?: string): string => {
    const code = (rawModel ?? "").trim().toUpperCase();
    if (code === "EI-T5300") return "Galaxy SmartTag";
    if (code === "EI-T7300") return "Galaxy SmartTag+";
    if (code.startsWith("EI-T5600") || code.includes("SMARTTAG2")) return "Galaxy SmartTag2";
    return fallbackName?.trim() || rawModel?.trim() || "Galaxy SmartTag";
};

export const isUwbSupportedModel = (rawModel?: string): boolean => {
    const code = (rawModel ?? "").trim().toUpperCase();
    return code === "EI-T7300" || code.startsWith("EI-T5600") || code.includes("BLE-UWB") || code.includes("SMARTTAG2");
};

export const mapSmartTagBattery = (rawBattery?: string | number): number | undefined => {
    if (typeof rawBattery === "number" && Number.isFinite(rawBattery)) {
        return rawBattery > 1 ? Math.max(0, Math.min(1, rawBattery / 100)) : Math.max(0, Math.min(1, rawBattery));
    }
    if (typeof rawBattery !== "string") return undefined;
    const norm = rawBattery.trim().toUpperCase();
    if (norm === "CRITICAL" || norm === "VERY_LOW") return 0.1;
    if (norm === "LOW") return 0.25;
    if (norm === "MEDIUM" || norm === "NORMAL") return 0.6;
    if (norm === "FULL" || norm === "HIGH") return 1.0;
    const num = Number(norm);
    if (Number.isFinite(num)) {
        return num > 1 ? Math.max(0, Math.min(1, num / 100)) : Math.max(0, Math.min(1, num));
    }
    return undefined;
};

const ICON_EMOJI_MAP: Array<[RegExp, string]> = [
    [/key/i, "🔑"],
    [/wallet|purse/i, "👛"],
    [/briefcase/i, "💼"],
    [/bag|luggage|suitcase/i, "🧳"],
    [/backpack/i, "🎒"],
    [/bike|bicycle/i, "🚲"],
    [/car|auto|vehicle/i, "🚗"],
    [/dog|cat|pet|collar/i, "🐾"],
    [/umbrella/i, "☂️"],
    [/camera/i, "📷"],
    [/laptop|computer/i, "💻"],
    [/headphone|earbud/i, "🎧"]
];

export const mapSmartTagIconEmoji = (icon?: string): string => {
    if (!icon) return "🏷️";
    for (const [pattern, emoji] of ICON_EMOJI_MAP) {
        if (pattern.test(icon)) return emoji;
    }
    return "🏷️";
};

export const mapSmartTagToFindMyDevice = (
    device: SmartThingsTagDevice,
    options?: {
        coords?: ResolvedGeoCoordinates | null;
        geocoded?: TrackerGeocodedAddress | null;
        needsPin?: boolean;
        batteryLevel?: number | string;
    }
): FindMyDevice => {
    const rawId = device.deviceId;
    const id = `utag:${rawId}`;
    const rawModel = device.modelName ?? device.presentationId ?? "EI-T5300";
    const modelDisplayName = mapSmartTagModelName(rawModel, device.modelName);
    const supportsUwb = isUwbSupportedModel(rawModel);
    const emoji = mapSmartTagIconEmoji(device.icon);
    const name = device.label?.trim() || device.name?.trim() || modelDisplayName;
    const batteryLevel = mapSmartTagBattery(options?.batteryLevel ?? device.batteryLevel);

    const accuracy = options?.coords?.horizontalAccuracy ?? 50;
    const timestamp = options?.coords?.lastUpdateTime ?? Date.now();
    const location: FindMyLocation | undefined = options?.coords
        ? {
              latitude: options.coords.latitude,
              longitude: options.coords.longitude,
              horizontalAccuracy: accuracy,
              verticalAccuracy: 0,
              floorLevel: 0,
              altitude: 0,
              timeStamp: timestamp,
              positionType: "crowdsourced",
              isInaccurate: accuracy > 150,
              isOld: options.coords.lastUpdateTime ? Date.now() - options.coords.lastUpdateTime > 30 * 60 * 1000 : false,
              locationFinished: true
          }
        : undefined;

    let address: FindMyAddress | undefined;
    if (options?.geocoded) {
        address = {
            label: options.geocoded.label,
            mapItemFullAddress: options.geocoded.mapItemFullAddress,
            streetAddress: options.geocoded.streetAddress,
            locality: options.geocoded.locality,
            stateCode: options.geocoded.stateCode,
            country: options.geocoded.country
        };
    } else if (options?.needsPin) {
        address = {
            label: "Encrypted — enter Samsung E2EE PIN in Server Settings"
        };
    }

    const batteryStatus =
        batteryLevel === undefined ? "Unknown" : batteryLevel <= 0.25 ? "Low" : batteryLevel >= 0.8 ? "Full" : "Normal";
    const iconUrl = typeof device.iconUrl === "string" && device.iconUrl.trim().length > 0 ? device.iconUrl.trim() : undefined;

    return {
        id,
        identifier: id,
        name,
        modelDisplayName,
        deviceModel: rawModel,
        rawDeviceModel: rawModel,
        deviceClass: "SmartTag",
        iconCategory: "tracker",
        ...(iconUrl ? { iconUrl } : {}),
        isConsideredAccessory: true,
        locationEnabled: true,
        locationCapable: true,
        lostModeCapable: false,
        lostModeEnabled: false,
        batteryLevel,
        batteryStatus,
        deviceStatus: options?.needsPin ? "locked" : "online",
        last_updated: options?.coords?.lastUpdateTime ?? null,
        location,
        crowdSourcedLocation: location ?? null,
        address,
        short_address: address?.label ?? null,
        long_address: address?.mapItemFullAddress ?? address?.label ?? null,
        street: address?.streetAddress ?? null,
        city: address?.locality ?? null,
        state: address?.stateCode ?? null,
        country: address?.country ?? null,
        role: {
            name: device.icon ?? "SmartTag",
            emoji,
            identifier: 0
        },
        deviceDisplayName: emoji,
        features: {
            SND: true,
            TRACKER_PROVIDER: "utag",
            CAN_RING: true,
            CAN_FIND_NEARBY: true,
            HAS_BLE_RING: true,
            SUPPORTS_UWB: supportsUwb,
            UTAG_REMOTE_RING: (device.bleD2D as any)?.metadata?.remoteRing?.enabled === true
        } as unknown as Record<string, boolean>
    };
};

export const buildUTagBleSpec = (
    device: SmartThingsTagDevice,
    expectedPrivacyIdsHex: string[] = [],
    ttlMs = 15 * 60 * 1000
): UTagBleSpec => {
    const rawId = device.deviceId;
    const rawModel = device.modelName ?? device.presentationId ?? "EI-T5300";
    return {
        deviceId: `utag:${rawId}`,
        rawId,
        provider: "utag",
        serviceUuid: "fd5a",
        expiresAt: Date.now() + ttlMs,
        expectedPrivacyIdsHex,
        supportsUwb: isUwbSupportedModel(rawModel),
        uwbPackage: "com.kieronquinn.app.utag",
        uwbAction: "com.kieronquinn.app.utag.MAP",
        uwbClass: "com.kieronquinn.app.utag.ui.activities.TagActivity",
        uwbExtraKey: "target_id",
        uwbFallbackPackage: "com.samsung.android.oneconnect"
    };
};
