import type {
    FindMyAddress,
    FindMyDevice,
    FindMyDevicesRefreshResponse,
    FindMyFriendLocation,
    FindMyFriendsRefreshResponse,
    FindMyFriendStatus,
    FindMyLocation,
    FindMyStructuredAddress
} from "@server/api/lib/findmy/types";
import type {
    RefreshFindMyDevicesOptions,
    RefreshFindMyFriendsOptions
} from "@server/api/privateApi/apis/PrivateApiFindMy";

const FIND_MY_FRIEND_STATUSES = ["legacy", "live", "shallow"] as const;
const FIND_MY_DEVICES_HELPER_CONNECTION_TIMEOUT_MS = 10_000;
const FIND_MY_DEVICES_HELPER_CONNECTION_POLL_MS = 100;
const FIND_MY_LIVE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface StartFindMyLiveOptions {
    idleTimeoutMs?: number;
}

export interface FindMyLiveState {
    activeHandle: string | null;
    idleTimer: NodeJS.Timeout | null;
}

export interface FindMyForkHelperDeps {
    server: any;
    env: { isMinBigSur: boolean; isMinSonoma: boolean; isMinSequoia: boolean };
    execShellCommand: (command: string) => Promise<unknown>;
    waitMs: (ms: number) => Promise<unknown>;
    emitChangedDevices: (previousDevices: FindMyDevice[], nextDevices: FindMyDevice[]) => Promise<void>;
    refreshUsingFindMyApp: () => Promise<void>;
    resolveFindMyDevicesTarget: (env: { isMinSequoia: boolean }) => string | null;
    resolveFindMyFriendsTarget: (env: {
        isMinBigSur: boolean;
        isMinSonoma: boolean;
        isMinSequoia: boolean;
    }) => string | null;
}

const objectValue = (value: unknown): Record<string, unknown> | null =>
    value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const normalizeOptionalString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmedValue = value.trim().replace(/\s+/g, " ");
    return trimmedValue.length > 0 ? trimmedValue : null;
};

const normalizeOptionalNumber = (value: unknown): number | null => {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && value.trim().length === 0) return null;

    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
};

const normalizeOptionalInteger = (value: unknown): number | null => {
    const numericValue = normalizeOptionalNumber(value);
    return numericValue != null ? Math.round(numericValue) : null;
};

// Real fix timestamps are strictly positive epoch numbers; 0 or negative means unknown (never Date.now()).
const normalizeFindMyTimestamp = (value: unknown): number | null => {
    const parsed = normalizeOptionalInteger(value);
    return parsed != null && parsed > 0 ? parsed : null;
};

const normalizeOptionalBoolean = (value: unknown): boolean | undefined => {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
    return undefined;
};

const resolveFriendStatus = (rawStatus: unknown, locationType: number | null): FindMyFriendStatus | null => {
    if (FIND_MY_FRIEND_STATUSES.some(status => status === rawStatus)) return rawStatus as FindMyFriendStatus;
    if (locationType === 2) return "live";
    if (locationType === 1) return "shallow";
    if (locationType === 0) return "legacy";
    return null;
};

const isCountrySegment = (segment: string): boolean => {
    return /^(united states|usa|us|u\.s\.a\.|canada|united kingdom|uk|australia|mexico)$/i.test(segment.trim());
};

const parseStateZipSegment = (segment: string): { state: string | null; zip: string | null } => {
    const cleaned = segment.trim();
    const usMatch = cleaned.match(/^([A-Za-z]{2,})\s+(\d{5}(?:-\d{4})?)$/);
    if (usMatch) {
        return { state: usMatch[1], zip: usMatch[2] };
    }

    const intlMatch = cleaned.match(/^([A-Za-z]{2,})\s+([A-Z]\d[A-Z]\s?\d[A-Z]\d|[A-Z0-9]{3,10})$/i);
    if (intlMatch) {
        return { state: intlMatch[1], zip: intlMatch[2] };
    }

    const zipOnly = cleaned.match(/^(\d{5}(?:-\d{4})?)$/);
    if (zipOnly) {
        return { state: null, zip: zipOnly[1] };
    }

    return { state: cleaned.length > 0 ? cleaned : null, zip: null };
};

export const parseStructuredFindMyAddress = ({
    rawAddress,
    rawRecord,
    longAddress,
    shortAddress
}: {
    rawAddress?: Record<string, unknown> | null;
    rawRecord?: Record<string, unknown> | null;
    longAddress?: string | null;
    shortAddress?: string | null;
}): FindMyStructuredAddress | null => {
    const addr = rawAddress ?? {};
    const rec = rawRecord ?? {};

    let street =
        normalizeOptionalString(addr.street ?? addr.streetAddress ?? addr.fullThroroughfare ?? addr.streetName) ??
        normalizeOptionalString(rec.street ?? rec.street_address ?? rec.streetAddress);
    let city =
        normalizeOptionalString(addr.city ?? addr.locality ?? addr.subAdministrativeArea) ??
        normalizeOptionalString(rec.city ?? rec.locality);
    let state =
        normalizeOptionalString(addr.state ?? addr.stateCode ?? addr.administrativeArea) ??
        normalizeOptionalString(rec.state ?? rec.stateCode ?? rec.administrativeArea);
    let zip =
        normalizeOptionalString(addr.zip ?? addr.postalCode ?? addr.postal_code) ??
        normalizeOptionalString(rec.zip ?? rec.postalCode ?? rec.postal_code);
    let country =
        normalizeOptionalString(addr.country ?? addr.countryCode) ??
        normalizeOptionalString(rec.country ?? rec.countryCode);

    const parseSource = longAddress ?? shortAddress;
    if (parseSource) {
        let parts = parseSource
            .split(",")
            .map(part => part.trim())
            .filter(Boolean);

        const label = normalizeOptionalString(addr.label ?? rec.title);
        if (label && parts.length >= 4 && parts[0].toLowerCase() === label.toLowerCase()) {
            parts = parts.slice(1);
        }

        if (parts.length >= 2 && isCountrySegment(parts[parts.length - 1])) {
            country ??= parts.pop()!;
        }

        if (parts.length >= 2) {
            const parsedStateZip = parseStateZipSegment(parts[parts.length - 1]);
            if (parsedStateZip.state && (!state || (parsedStateZip.state.length === 2 && state.length > 2))) {
                state = parsedStateZip.state;
            }
            if (parsedStateZip.zip) {
                zip ??= parsedStateZip.zip;
            }

            if (parts.length >= 3) {
                city ??= parts[parts.length - 2];
                const streetCandidate = parts.slice(0, parts.length - 2).join(", ");
                if (streetCandidate) {
                    street ??= streetCandidate;
                }
            } else if (parts.length === 2) {
                city ??= parts[0];
            }
        }
    }

    if (!street && !city && !state && !zip && !country) {
        return null;
    }

    return { street, city, state, zip, country };
};

const normalizeCoordinatePair = (value: unknown): [number, number] | null => {
    if (!Array.isArray(value)) return null;
    const latitude = normalizeOptionalNumber(value[0]);
    const longitude = normalizeOptionalNumber(value[1]);
    if (latitude == null || longitude == null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return null;
    }
    return [latitude, longitude];
};

const normalizeLocationTitle = (value: unknown): string | null =>
    Array.isArray(value) ? value.map(normalizeOptionalString).find(c => c != null) ?? null : normalizeOptionalString(value);

const normalizeStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const normalized = value.map(normalizeOptionalString).filter((item): item is string => item != null);
    return normalized.length > 0 ? normalized : undefined;
};

const formatLongAddressFromStructured = (addr: Partial<FindMyStructuredAddress> | null): string | null => {
    if (!addr) return null;
    const stateZip = [addr.state, addr.zip].filter(Boolean).join(" ").trim();
    const parts = [addr.street, addr.city, stateZip || null, addr.country].filter(
        (part): part is string => typeof part === "string" && part.length > 0
    );
    return parts.length > 0 ? parts.join(", ") : null;
};

export const normalizeFindMyFriendLocation = (untrustedLocation: unknown): FindMyFriendLocation | null => {
    const location = objectValue(untrustedLocation);
    if (location == null) return null;

    const handle = normalizeOptionalString(location.handle);
    if (handle == null) return null;

    const locationType = normalizeOptionalInteger(location.location_type);
    const status = resolveFriendStatus(location.status, locationType);
    const isLive = status === "live";
    const locatingInProgress = Boolean(
        normalizeOptionalBoolean(location.locating_in_progress ?? location.is_locating_in_progress)
    );

    const rawAddress = objectValue(location.address);
    const rawLongAddress =
        normalizeOptionalString(location.long_address) ??
        normalizeOptionalString(rawAddress?.mapItemFullAddress) ??
        (Array.isArray(rawAddress?.formattedAddressLines)
            ? normalizeStringArray(rawAddress.formattedAddressLines)?.join(", ") ?? null
            : null);
    const shortAddress = normalizeOptionalString(location.short_address);

    const structuredAddress = parseStructuredFindMyAddress({
        rawAddress,
        rawRecord: location,
        longAddress: rawLongAddress,
        shortAddress
    });

    const longAddress = rawLongAddress ?? formatLongAddressFromStructured(structuredAddress);

    return {
        handle,
        coordinates: normalizeCoordinatePair(location.coordinates),
        long_address: longAddress,
        short_address: shortAddress,
        subtitle: normalizeOptionalString(location.subtitle),
        title: normalizeLocationTitle(location.title),
        street: structuredAddress?.street ?? null,
        city: structuredAddress?.city ?? null,
        state: structuredAddress?.state ?? null,
        zip: structuredAddress?.zip ?? null,
        country: structuredAddress?.country ?? null,
        address: structuredAddress,
        last_updated: normalizeFindMyTimestamp(
            location.last_updated ?? location.timeStamp ?? location.timestamp
        ),
        is_live: isLive,
        locating_in_progress: locatingInProgress,
        is_locating_in_progress: locatingInProgress,
        status,
        location_type: locationType ?? undefined,
        horizontal_accuracy: normalizeOptionalNumber(location.horizontal_accuracy) ?? undefined,
        vertical_accuracy: normalizeOptionalNumber(location.vertical_accuracy) ?? undefined,
        speed: normalizeOptionalNumber(location.speed) ?? undefined,
        altitude: normalizeOptionalNumber(location.altitude) ?? undefined
    };
};

export const normalizeFindMyFriendLocations = (locations: unknown): FindMyFriendLocation[] => {
    if (!Array.isArray(locations)) return [];
    return locations
        .map(normalizeFindMyFriendLocation)
        .filter((location): location is FindMyFriendLocation => location != null);
};

const normalizeFindMyDeviceLocation = (rawLocation: unknown): FindMyLocation | undefined => {
    const location = objectValue(rawLocation);
    if (location == null) return undefined;

    const latitude = normalizeOptionalNumber(location.latitude);
    const longitude = normalizeOptionalNumber(location.longitude);
    if (latitude == null || longitude == null) return undefined;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;

    return {
        latitude,
        longitude,
        horizontalAccuracy: normalizeOptionalNumber(location.horizontalAccuracy) ?? undefined,
        verticalAccuracy: normalizeOptionalNumber(location.verticalAccuracy) ?? undefined,
        altitude: normalizeOptionalNumber(location.altitude) ?? undefined,
        timeStamp: normalizeFindMyTimestamp(location.timeStamp) ?? undefined,
        floorLevel: normalizeOptionalInteger(location.floorLevel) ?? undefined,
        isInaccurate: normalizeOptionalBoolean(location.isInaccurate),
        isOld: normalizeOptionalBoolean(location.isOld),
        locationFinished: normalizeOptionalBoolean(location.locationFinished),
        positionType: normalizeOptionalString(location.positionType) ?? undefined
    };
};

const normalizeFindMyDeviceAddress = (rawAddress: unknown): FindMyAddress | undefined => {
    const address = objectValue(rawAddress);
    if (address == null) return undefined;

    const formattedAddressLines = normalizeStringArray(address.formattedAddressLines);
    const label = normalizeOptionalString(address.label) ?? undefined;
    const countryCode = normalizeOptionalString(address.countryCode) ?? undefined;
    const administrativeArea = normalizeOptionalString(address.administrativeArea) ?? undefined;
    const subAdministrativeArea = normalizeOptionalString(address.subAdministrativeArea) ?? undefined;
    const locality = normalizeOptionalString(address.locality) ?? undefined;
    const streetAddress = normalizeOptionalString(address.streetAddress) ?? undefined;
    const streetName = normalizeOptionalString(address.streetName) ?? undefined;
    const fullThroroughfare = normalizeOptionalString(address.fullThroroughfare) ?? undefined;
    const stateCode = normalizeOptionalString(address.stateCode) ?? undefined;
    const postalCode = normalizeOptionalString(address.postalCode) ?? undefined;
    const country = normalizeOptionalString(address.country) ?? undefined;
    const mapItemFullAddress = normalizeOptionalString(address.mapItemFullAddress) ?? undefined;
    const areaOfInterest = normalizeStringArray(address.areaOfInterest);

    const longCandidate =
        mapItemFullAddress ?? (formattedAddressLines ? formattedAddressLines.join(", ") : null);
    const parsed = parseStructuredFindMyAddress({
        rawAddress: address,
        longAddress: longCandidate,
        shortAddress:
            locality && (stateCode ?? administrativeArea) ? `${locality}, ${stateCode ?? administrativeArea}` : label
    });

    const normalized: FindMyAddress = {
        label,
        countryCode,
        administrativeArea,
        subAdministrativeArea,
        locality,
        streetAddress: streetAddress ?? parsed?.street ?? undefined,
        streetName,
        fullThroroughfare,
        stateCode: stateCode ?? (parsed?.state && parsed.state.length <= 3 ? parsed.state : undefined),
        postalCode: postalCode ?? parsed?.zip ?? undefined,
        country: country ?? parsed?.country ?? undefined,
        areaOfInterest,
        mapItemFullAddress,
        formattedAddressLines: formattedAddressLines ?? [],
        street: parsed?.street ?? null,
        city: parsed?.city ?? locality ?? null,
        state: parsed?.state ?? stateCode ?? administrativeArea ?? null,
        zip: parsed?.zip ?? postalCode ?? null
    };

    const hasValue = Object.entries(normalized).some(([k, v]) => {
        if (k === "formattedAddressLines") return Array.isArray(v) && v.length > 0;
        return v !== undefined && v !== null;
    });

    return hasValue ? normalized : undefined;
};

export const normalizeFindMyDevice = (rawDevice: unknown): FindMyDevice | null => {
    const device = objectValue(rawDevice);
    if (device == null) return null;

    const identifier = normalizeOptionalString(device.identifier);
    if (identifier == null) return null;

    const batteryLevel = normalizeOptionalNumber(device.batteryLevel);
    const normalizedBatteryLevel =
        batteryLevel != null && batteryLevel >= 0 && batteryLevel <= 1 ? batteryLevel : undefined;
    const displayName = normalizeOptionalString(device.displayName) ?? undefined;
    const rawDeviceModel =
        normalizeOptionalString(device.rawDeviceModel) ?? normalizeOptionalString(device.model) ?? undefined;

    const address = normalizeFindMyDeviceAddress(device.address);
    const location = normalizeFindMyDeviceLocation(device.location);
    const crowdSourcedLocation = normalizeFindMyDeviceLocation(device.crowdSourcedLocation);

    const longAddress =
        normalizeOptionalString(device.long_address) ??
        address?.mapItemFullAddress ??
        (address?.formattedAddressLines && address.formattedAddressLines.length > 0
            ? address.formattedAddressLines.join(", ")
            : null) ??
        formatLongAddressFromStructured(address ?? null);
    const shortAddress =
        normalizeOptionalString(device.short_address) ??
        (address?.locality && (address.stateCode ?? address.administrativeArea)
            ? `${address.locality}, ${address.stateCode ?? address.administrativeArea}`
            : address?.label ?? null);

    const lastUpdated =
        location?.timeStamp ??
        crowdSourcedLocation?.timeStamp ??
        normalizeFindMyTimestamp(device.last_updated);

    const rawLoc = objectValue(device.location);
    const locatingInProgress = Boolean(
        normalizeOptionalBoolean(
            device.locating_in_progress ?? device.is_locating_in_progress ?? rawLoc?.isLocatingInProgress
        )
    );
    const isLive = device.status === "live" || location?.positionType === "live";

    return {
        id: identifier,
        identifier,
        name: normalizeOptionalString(device.name) ?? undefined,
        deviceDisplayName: displayName,
        modelDisplayName: displayName ?? rawDeviceModel,
        deviceModel: normalizeOptionalString(device.model) ?? rawDeviceModel,
        rawDeviceModel,
        systemVersion: normalizeOptionalString(device.systemVersion) ?? undefined,
        deviceClass: normalizeOptionalString(device.category) ?? undefined,
        batteryLevel: normalizedBatteryLevel,
        batteryStatus: normalizeOptionalString(device.batteryStatus) ?? undefined,
        deviceStatus:
            normalizeOptionalString(device.deviceStatus) ??
            normalizeOptionalString(device.deviceConnectedState) ??
            undefined,
        deviceDiscoveryId: normalizeOptionalString(device.discoveryIdentifier) ?? undefined,
        baUuid: normalizeOptionalString(device.baIdentifier) ?? undefined,
        address,
        location,
        crowdSourcedLocation,
        last_updated: lastUpdated,
        is_live: isLive,
        locating_in_progress: locatingInProgress,
        long_address: longAddress,
        short_address: shortAddress,
        street: address?.street ?? null,
        city: address?.city ?? null,
        state: address?.state ?? null,
        zip: address?.zip ?? null,
        country: address?.country ?? null
    };
};

export const normalizeFindMyDevices = (devices: unknown): FindMyDevice[] => {
    if (!Array.isArray(devices)) return [];
    return devices.map(normalizeFindMyDevice).filter((device): device is FindMyDevice => device != null);
};

const hasLocationTupleChanged = (
    previousLocation: FindMyDevice["location"] | undefined,
    nextLocation: FindMyDevice["location"] | undefined
): boolean => {
    if (previousLocation == null && nextLocation == null) return false;
    if (previousLocation == null || nextLocation == null) return nextLocation != null;

    const prevTs = previousLocation.timeStamp;
    const nextTs = nextLocation.timeStamp;
    if (prevTs != null && nextTs != null && nextTs < prevTs) return false;

    return (
        prevTs !== nextTs ||
        previousLocation.latitude !== nextLocation.latitude ||
        previousLocation.longitude !== nextLocation.longitude ||
        previousLocation.horizontalAccuracy !== nextLocation.horizontalAccuracy ||
        previousLocation.locationFinished !== nextLocation.locationFinished ||
        previousLocation.isInaccurate !== nextLocation.isInaccurate ||
        previousLocation.isOld !== nextLocation.isOld ||
        previousLocation.positionType !== nextLocation.positionType
    );
};

export const hasFindMyDeviceLocationChanged = (
    previousDevice: FindMyDevice | undefined,
    nextDevice: FindMyDevice
): boolean => {
    if (previousDevice == null) {
        return nextDevice.location != null || nextDevice.crowdSourcedLocation != null;
    }

    return (
        hasLocationTupleChanged(previousDevice.location, nextDevice.location) ||
        hasLocationTupleChanged(previousDevice.crowdSourcedLocation, nextDevice.crowdSourcedLocation)
    );
};

export const getChangedFindMyDevices = (
    previousDevices: FindMyDevice[],
    nextDevices: FindMyDevice[]
): FindMyDevice[] => {
    const previousById = new Map<string, FindMyDevice>();
    for (const device of previousDevices) {
        const identifier = device.identifier ?? device.id;
        if (identifier) previousById.set(identifier, device);
    }

    return nextDevices.filter(device => {
        const identifier = device.identifier ?? device.id;
        return hasFindMyDeviceLocationChanged(identifier ? previousById.get(identifier) : undefined, device);
    });
};

const waitForPrivateApiClient = async (
    deps: FindMyForkHelperDeps,
    processIdentifier: string
): Promise<boolean> => {
    const maximumAttempts = Math.ceil(
        FIND_MY_DEVICES_HELPER_CONNECTION_TIMEOUT_MS / FIND_MY_DEVICES_HELPER_CONNECTION_POLL_MS
    );
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        if (deps.server.privateApi.hasClient(processIdentifier)) {
            return true;
        }
        await deps.waitMs(FIND_MY_DEVICES_HELPER_CONNECTION_POLL_MS);
    }
    return deps.server.privateApi.hasClient(processIdentifier);
};

const isFriendsHelperReady = (deps: FindMyForkHelperDeps): boolean => {
    const privateApiTarget = deps.resolveFindMyFriendsTarget(deps.env);
    return (
        Boolean(deps.server.repo.getConfig("enable_private_api")) &&
        privateApiTarget != null &&
        deps.server.privateApi.hasClient(privateApiTarget)
    );
};

const resolveContactDisplayName = async (handle: string): Promise<string | undefined> => {
    try {
        const { ContactInterface } = require("@server/api/interfaces/contactInterface");
        const contacts = await ContactInterface.queryContacts([handle]);
        for (const contact of contacts) {
            const display =
                (typeof contact?.displayName === "string" && contact.displayName.trim()) ||
                [contact?.firstName, contact?.lastName]
                    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
                    .join(" ")
                    .trim();
            if (display.length > 0) return display;
        }
    } catch {
        // Best-effort lookup for FindMy People row selection.
    }
    return undefined;
};

const clearLiveIdleTimer = (liveState: FindMyLiveState): void => {
    if (liveState.idleTimer != null) {
        clearTimeout(liveState.idleTimer);
        liveState.idleTimer = null;
    }
};

export const refreshFindMyDevicesThroughPrivateApi = async (
    deps: FindMyForkHelperDeps,
    options?: RefreshFindMyDevicesOptions
): Promise<FindMyDevice[]> => {
    const privateApiEnabled = Boolean(deps.server.repo.getConfig("enable_private_api"));
    if (!privateApiEnabled) {
        throw new Error("Find My Devices on macOS 15 or later requires the Private API");
    }

    const openFindMyOnStartup = Boolean(deps.server.repo.getConfig("open_findmy_on_startup"));
    if (!openFindMyOnStartup) {
        throw new Error("Find My Devices requires Open FindMy App on Startup to be enabled");
    }

    const targetProcessIdentifier = deps.resolveFindMyDevicesTarget({ isMinSequoia: deps.env.isMinSequoia });
    if (targetProcessIdentifier == null) {
        throw new Error("The Find My Devices helper is unavailable on this macOS version");
    }

    // -g delivers the Find My URL without bringing Find My to the foreground.
    await deps.execShellCommand("/usr/bin/open -g findmy://devices");
    const helperAvailable = await waitForPrivateApiClient(deps, targetProcessIdentifier);
    if (!helperAvailable) {
        throw new Error("The Find My Devices helper did not connect before the refresh timeout");
    }

    const result = await deps.server.privateApi.findmy.refreshDevices(options);
    const refreshResponse = result?.data as FindMyDevicesRefreshResponse | undefined;
    if (!Array.isArray(refreshResponse?.devices)) {
        throw new Error("The Find My Devices helper returned an invalid response");
    }
    if (typeof refreshResponse.partial !== "boolean") {
        throw new Error("The Find My Devices helper returned an invalid completion state");
    }
    const skippedDeviceCount = refreshResponse.skippedDevices;
    if (typeof skippedDeviceCount !== "number" || !Number.isInteger(skippedDeviceCount) || skippedDeviceCount < 0) {
        throw new Error("The Find My Devices helper returned an invalid skipped-device count");
    }
    if (refreshResponse.partial !== skippedDeviceCount > 0) {
        throw new Error("The Find My Devices helper returned an inconsistent completion state");
    }

    const devices = normalizeFindMyDevices(refreshResponse.devices);
    if (devices.length !== refreshResponse.devices.length) {
        throw new Error("The Find My Devices helper returned invalid device records");
    }

    const deviceIdentifiers = devices.map(device => device.identifier);
    if (new Set(deviceIdentifiers).size !== deviceIdentifiers.length) {
        throw new Error("The Find My Devices helper returned duplicate device identifiers");
    }

    const previousDevices = deps.server.findMyDevicesCache.getAll();
    if (refreshResponse.partial) {
        deps.server.findMyDevicesCache.updateAll(devices);
        deps.server.logger.warn(
            `Find My Devices returned a partial response (${skippedDeviceCount} ` + "unidentifiable device(s))."
        );
    } else {
        deps.server.findMyDevicesCache.replaceAll(devices);
    }

    await deps.emitChangedDevices(previousDevices, devices);

    const devicesWithLocations = devices.filter(device => device.location != null).length;
    deps.server.logger.debug(
        `Refreshed ${devices.length} Find My device(s) through FMIPDataManager; ` +
            `${devicesWithLocations} included a location.`
    );
    return deps.server.findMyDevicesCache.getAll();
};

export const refreshFindMyFriends = async (
    deps: FindMyForkHelperDeps,
    allowFindMyAppFallback = true,
    options?: RefreshFindMyFriendsOptions
): Promise<FindMyFriendLocation[]> => {
    let receivedUsableHelperResponse = false;
    const trimmedHandle = typeof options?.handle === "string" ? options.handle.trim() : "";
    const normalizedTarget = trimmedHandle.toLowerCase();

    const cacheWithListeners = deps.server.findMyFriendsCache as unknown as {
        onUpdate?: (listener: (loc: FindMyFriendLocation) => void) => () => void;
    };
    let sawFinishedTargetUpdate = false;
    let onTargetSettled: (() => void) | null = null;

    const unsubscribe =
        normalizedTarget.length > 0 && typeof cacheWithListeners?.onUpdate === "function"
            ? cacheWithListeners.onUpdate(loc => {
                  const handleKey = loc.handle?.toLowerCase();
                  if (handleKey === normalizedTarget && !loc.locating_in_progress) {
                      sawFinishedTargetUpdate = true;
                      onTargetSettled?.();
                  }
              })
            : null;

    try {
        if (isFriendsHelperReady(deps)) {
            try {
                const displayName =
                    trimmedHandle.length > 0 ? await resolveContactDisplayName(trimmedHandle) : undefined;
                const result = await deps.server.privateApi.findmy.refreshFriends({
                    ...(options ?? {}),
                    ...(displayName ? { displayName } : {})
                });
                const refreshResponse = result?.data as FindMyFriendsRefreshResponse | undefined;
                if (Array.isArray(refreshResponse?.locations)) {
                    const refreshedLocations = normalizeFindMyFriendLocations(refreshResponse.locations);
                    const responseContainsOnlyInvalidLocations =
                        refreshResponse.locations.length > 0 && refreshedLocations.length === 0;
                    const responseIsPartial = refreshResponse.partial === true;
                    receivedUsableHelperResponse =
                        !responseContainsOnlyInvalidLocations &&
                        (!responseIsPartial || refreshedLocations.length > 0);

                    if (!responseContainsOnlyInvalidLocations) {
                        if (responseIsPartial || trimmedHandle.length > 0) {
                            deps.server.findMyFriendsCache.updateAll(refreshedLocations);
                        } else {
                            deps.server.findMyFriendsCache.replaceAll(refreshedLocations);
                        }
                    } else {
                        deps.server.logger.warn("Find My Friends helper returned no identifiable locations.");
                    }

                    if (responseIsPartial) {
                        const timedOutFriendCount = Array.isArray(refreshResponse.timedOutHandles)
                            ? refreshResponse.timedOutHandles.length
                            : 0;
                        const skippedFriendCount = Number(refreshResponse.skippedFriends ?? 0);
                        deps.server.logger.warn(
                            `Find My Friends returned a partial response (${timedOutFriendCount} timed-out ` +
                                `handle(s), ${skippedFriendCount} skipped friend(s)).`
                        );
                    }
                }
            } catch (error: any) {
                deps.server.logger.warn(
                    `Unable to refresh Find My Friends through the helper: ${error?.message ?? String(error)}`
                );
            }
        }

        // Only wait post-helper when a targeted handle is actively locating; untargeted/cached calls return immediately
        // and rely on NEW_FINDMY_LOCATION socket pushes for async fixes.
        if (receivedUsableHelperResponse && unsubscribe != null && normalizedTarget.length > 0 && !sawFinishedTargetUpdate) {
            const targetEntry = deps.server.findMyFriendsCache
                .getAll()
                .find((loc: FindMyFriendLocation) => loc.handle?.toLowerCase() === normalizedTarget);
            if (targetEntry?.locating_in_progress === true) {
                await new Promise<void>(resolve => {
                    const timer = setTimeout(() => {
                        onTargetSettled = null;
                        resolve();
                    }, 3500);
                    onTargetSettled = () => {
                        clearTimeout(timer);
                        onTargetSettled = null;
                        resolve();
                    };
                });
            }
        }
    } finally {
        unsubscribe?.();
    }

    const shouldRefreshUsingFindMyApp = allowFindMyAppFallback && (!receivedUsableHelperResponse || !deps.env.isMinSequoia);
    if (shouldRefreshUsingFindMyApp) {
        void deps.refreshUsingFindMyApp().catch((error: any) => {
            deps.server.logger.warn(`Unable to refresh Find My through the app: ${error?.message ?? String(error)}`);
        });
    }

    return normalizeFindMyFriendLocations(deps.server.findMyFriendsCache.getAll());
};

export const startFindMyLiveLocation = async (
    deps: FindMyForkHelperDeps,
    liveState: FindMyLiveState,
    handle: string,
    options?: StartFindMyLiveOptions
): Promise<{ handle: string; live: boolean; locations: FindMyFriendLocation[] }> => {
    const trimmedHandle = handle.trim();
    if (trimmedHandle.length === 0) {
        throw new Error("A friend handle is required to start Find My live location");
    }

    if (!isFriendsHelperReady(deps)) {
        throw new Error("Find My Friends Private API helper is not connected");
    }

    const displayName = await resolveContactDisplayName(trimmedHandle);
    const result = await deps.server.privateApi.findmy.startLiveLocation(trimmedHandle, displayName);
    const responseData = result?.data as FindMyFriendsRefreshResponse | undefined;
    let updatedLocations: FindMyFriendLocation[] = [];
    if (Array.isArray(responseData?.locations)) {
        const normalized = normalizeFindMyFriendLocations(responseData.locations);
        if (normalized.length > 0) {
            updatedLocations = deps.server.findMyFriendsCache.updateAll(normalized);
        }
    }

    if (updatedLocations.length === 0) {
        const cached = deps.server.findMyFriendsCache
            .getAll()
            .filter((loc: FindMyFriendLocation) => loc.handle?.toLowerCase() === trimmedHandle.toLowerCase());
        updatedLocations = normalizeFindMyFriendLocations(cached);
    }

    liveState.activeHandle = trimmedHandle;
    clearLiveIdleTimer(liveState);
    const idleTimeoutMs = options?.idleTimeoutMs ?? FIND_MY_LIVE_IDLE_TIMEOUT_MS;
    if (idleTimeoutMs > 0) {
        liveState.idleTimer = setTimeout(() => {
            void stopFindMyLiveLocation(deps, liveState, trimmedHandle).catch((error: any) => {
                deps.server.logger.debug(
                    `Auto-stop Find My live location failed: ${error?.message ?? String(error)}`
                );
            });
        }, idleTimeoutMs);
        liveState.idleTimer.unref?.();
    }

    return {
        handle: trimmedHandle,
        live: true,
        locations: updatedLocations
    };
};

export const stopFindMyLiveLocation = async (
    deps: FindMyForkHelperDeps,
    liveState: FindMyLiveState,
    handle?: string
): Promise<{ handle: string | null; stopped: boolean }> => {
    const trimmedHandle = typeof handle === "string" && handle.trim().length > 0 ? handle.trim() : undefined;
    const matchesActive =
        trimmedHandle == null ||
        liveState.activeHandle == null ||
        liveState.activeHandle.toLowerCase() === trimmedHandle.toLowerCase();
    const previousHandle = liveState.activeHandle;
    if (matchesActive) {
        clearLiveIdleTimer(liveState);
        liveState.activeHandle = null;
    }

    if (!isFriendsHelperReady(deps)) {
        return {
            handle: trimmedHandle ?? previousHandle ?? null,
            stopped: false
        };
    }

    const result = await deps.server.privateApi.findmy.stopLiveLocation(trimmedHandle);
    const responseData = result?.data as { stopped?: unknown } | undefined;
    return {
        handle: trimmedHandle ?? previousHandle ?? null,
        stopped: typeof responseData?.stopped === "boolean" ? responseData.stopped : true
    };
};
