import crypto from "crypto";
import { FindMyAddress, FindMyDevice, FindMyLocation } from "../findmy/types";
import { reverseGeocode, TrackerCommonDeps, TrackerGeocodedAddress } from "../findmy/trackerCommon";
import {
    decryptCrowdsourcedLocationReport,
    decryptOwnLocationReport,
    deriveRingKey,
    GoogleFindSoundComponent,
    hkdfSha256,
    unwrapDeviceEik
} from "./gfindCrypto";
import {
    IdentifierInformationType,
    NovaDeviceType,
    ProtoDeviceMetadata,
    ProtoLocation,
    ProtoLocationReport,
    SpotDeviceType
} from "./gfindProto";

export interface GoogleFindBleSpec {
    deviceId: string;
    rawId: string;
    provider: "gfind";
    serviceUuid: "feaa";
    expiresAt: number;
    eidsHex: string[];
    ringKeyHex: string | null;
    ringComponents: GoogleFindSoundComponent[];
    supportsUwb: boolean;
    uwbPackage: "com.google.android.apps.adm";
}

export interface GoogleFindInternalRecord {
    canonicId: string;
    deviceId: string;
    novaDeviceType: NovaDeviceType;
    spotDeviceType: SpotDeviceType;
    isSpotAccessory: boolean;
    isEarbuds: boolean;
    rotationExponent: number;
    curve: "secp160r1" | "secp256r1";
    eik: Buffer | null;
    eikCandidates?: Buffer[];
    ringKey: Buffer | null;
    ownerKeyVersionMismatch: boolean;
    debugSummary?: string;
    device: FindMyDevice;
}

export interface MapDeviceOptions {
    ownerKey: Buffer | null;
    ownerKeyVersion: number | null;
    trackerDeps?: TrackerCommonDeps;
    reverseGeocodeFn?: (lat: number, lon: number) => Promise<TrackerGeocodedAddress | null>;
    fallbackRecord?: GoogleFindInternalRecord | null;
}

const SPOT_ACCESSORY_ROLE: Record<number, { name: string; emoji: string }> = {
    [SpotDeviceType.DEVICE_TYPE_HEADPHONES]: { name: "Headphones", emoji: "🎧" },
    [SpotDeviceType.DEVICE_TYPE_EARBUDS]: { name: "Earbuds", emoji: "🎧" },
    [SpotDeviceType.DEVICE_TYPE_KEYS]: { name: "Keys", emoji: "🔑" },
    [SpotDeviceType.DEVICE_TYPE_WATCH]: { name: "Watch", emoji: "⌚" },
    [SpotDeviceType.DEVICE_TYPE_WALLET]: { name: "Wallet", emoji: "👛" },
    [SpotDeviceType.DEVICE_TYPE_CAT]: { name: "Pet", emoji: "🐾" },
    [SpotDeviceType.DEVICE_TYPE_DOG]: { name: "Pet", emoji: "🐾" },
    [SpotDeviceType.DEVICE_TYPE_BAG]: { name: "Bag", emoji: "🎒" },
    [SpotDeviceType.DEVICE_TYPE_CAR]: { name: "Car", emoji: "🚗" },
    [SpotDeviceType.DEVICE_TYPE_BIKE]: { name: "Bike", emoji: "🚲" },
    [SpotDeviceType.DEVICE_TYPE_BEACON]: { name: "Tracker", emoji: "📍" },
    [SpotDeviceType.DEVICE_TYPE_UNKNOWN]: { name: "Tracker", emoji: "📍" }
};

function makeEmptyAddress(label: string | null = null): FindMyAddress {
    return {
        label,
        mapItemFullAddress: label,
        fullThroroughfare: null,
        streetAddress: null,
        streetName: null,
        locality: null,
        stateCode: null,
        administrativeArea: null,
        subAdministrativeArea: null,
        postalCode: null,
        country: null,
        countryCode: null,
        formattedAddressLines: label ? [label] : [],
        areaOfInterest: []
    };
}

function geocodedToFindMyAddress(geo: TrackerGeocodedAddress, labelOverride?: string): FindMyAddress {
    const label = labelOverride || geo.label || geo.mapItemFullAddress;
    return {
        label,
        mapItemFullAddress: geo.mapItemFullAddress || label,
        fullThroroughfare: geo.streetAddress,
        streetAddress: geo.streetAddress,
        streetName: geo.streetAddress,
        locality: geo.locality,
        stateCode: geo.stateCode,
        administrativeArea: geo.stateCode,
        subAdministrativeArea: null,
        postalCode: null,
        country: geo.country,
        countryCode: null,
        formattedAddressLines: label ? [label] : [],
        areaOfInterest: []
    };
}

function reportTimestampMs(r: ProtoLocationReport): number {
    const sec = r.timestampSeconds ?? 0;
    const nanos = r.timestampNanos ?? 0;
    return sec * 1000 + Math.floor(nanos / 1_000_000);
}

function sortReportsNewestFirst(reports: ProtoLocationReport[]): ProtoLocationReport[] {
    if (!reports || reports.length === 0) return [];
    return [...reports].sort((a, b) => reportTimestampMs(b) - reportTimestampMs(a));
}

export async function mapProtoDeviceToFindMy(
    meta: ProtoDeviceMetadata,
    opts: MapDeviceOptions
): Promise<GoogleFindInternalRecord | null> {
    const idInfo = meta.identifierInformation;
    const trackerIds = idInfo?.trackerInformation?.canonicIds ?? [];
    const phoneIds = idInfo?.phoneInformation?.canonicIds ?? [];
    const canonicId = trackerIds[0] ?? phoneIds[0];
    if (!canonicId) return null;

    const prev = opts.fallbackRecord ?? null;
    const phoneInfo = meta.phoneInformation ?? idInfo?.phoneInformation;
    const info = meta.information ?? phoneInfo?.deviceInformation;
    const reg = info?.deviceRegistration;
    const spotType = reg?.spotDeviceType ?? prev?.spotDeviceType ?? SpotDeviceType.DEVICE_TYPE_UNKNOWN;
    const isSpotIdentifier = idInfo?.type === IdentifierInformationType.IDENTIFIER_SPOT || trackerIds.length > 0;
    const isAndroidDeviceType =
        !isSpotIdentifier ||
        spotType === SpotDeviceType.DEVICE_TYPE_PHONE ||
        spotType === SpotDeviceType.DEVICE_TYPE_TABLET ||
        spotType === SpotDeviceType.DEVICE_TYPE_LAPTOP;

    const novaDeviceType = isSpotIdentifier
        ? NovaDeviceType.SPOT_DEVICE
        : prev?.novaDeviceType ?? NovaDeviceType.ANDROID_DEVICE;
    const manufacturer = phoneInfo?.manufacturer ?? reg?.manufacturer ?? null;
    const model = phoneInfo?.modelNumber ?? reg?.model ?? null;
    const displayName =
        meta.userDefinedDeviceName?.trim() ||
        [manufacturer, model].filter(Boolean).join(" ") ||
        prev?.device.name ||
        canonicId;
    const combinedNames = `${displayName} ${model ?? ""}`;

    const isSpotAccessory = prev ? prev.isSpotAccessory : !isAndroidDeviceType;
    const isEarbuds =
        isSpotAccessory &&
        (spotType === SpotDeviceType.DEVICE_TYPE_EARBUDS ||
            meta.deviceCategory === 11 ||
            /\b(buds|earbud|earbuds|wf-1000|wf1000)\b/i.test(combinedNames));
    const isHeadphones =
        isSpotAccessory &&
        !isEarbuds &&
        (spotType === SpotDeviceType.DEVICE_TYPE_HEADPHONES ||
            meta.deviceCategory === 8 ||
            /\b(headphone|headphones|headset|wh-1000|wh1000)\b/i.test(combinedNames));

    const isWatch =
        spotType === SpotDeviceType.DEVICE_TYPE_WATCH ||
            meta.deviceCategory === 4 ||
            (/\bwatch\b/i.test(combinedNames) && !isSpotAccessory);
    const isTablet = spotType === SpotDeviceType.DEVICE_TYPE_TABLET || /\b(tablet|tab|pad)\b/i.test(combinedNames);
    const isLaptop = spotType === SpotDeviceType.DEVICE_TYPE_LAPTOP || /\b(chromebook|laptop)\b/i.test(combinedNames);

    let deviceModel: string;
    let modelDisplayName: string;
    let deviceClass: string;
    let iconCategory: string;
    let role: { name: string; emoji: string; identifier: number };

    if (isSpotAccessory) {
        const mappedRole = SPOT_ACCESSORY_ROLE[spotType] ?? (isEarbuds ? { name: "Earbuds", emoji: "🎧" } : isHeadphones ? { name: "Headphones", emoji: "🎧" } : { name: "Tracker", emoji: "📍" });
        deviceModel = reg?.fastPairModelId || model || prev?.device.deviceModel || "Google Find Tag";
        modelDisplayName = [manufacturer, model].filter(Boolean).join(" ") || prev?.device.modelDisplayName || "Find Hub Tag";
        deviceClass = "Accessory";
        iconCategory = isEarbuds ? "earbuds" : isHeadphones ? "headphones" : isWatch ? "watch" : "tracker";
        role = { name: mappedRole.name, emoji: mappedRole.emoji, identifier: spotType };
    } else if (isWatch) {
        deviceModel = model || "AndroidWatch";
        modelDisplayName = [manufacturer, model].filter(Boolean).join(" ") || "Android Watch";
        deviceClass = "Watch";
        iconCategory = "watch";
        role = { name: "Watch", emoji: "⌚", identifier: SpotDeviceType.DEVICE_TYPE_WATCH };
    } else if (isTablet) {
        deviceModel = "AndroidTablet";
        modelDisplayName = [manufacturer, model].filter(Boolean).join(" ") || "Android Tablet";
        deviceClass = "Tablet";
        iconCategory = "tablet";
        role = { name: "Tablet", emoji: "📱", identifier: 11 };
    } else if (isLaptop) {
        deviceModel = "Chromebook";
        modelDisplayName = [manufacturer, model].filter(Boolean).join(" ") || "Chromebook";
        deviceClass = "Laptop";
        iconCategory = "laptop";
        role = { name: "Laptop", emoji: "💻", identifier: 8 };
    } else {
        deviceModel = "AndroidPhone";
        modelDisplayName = [manufacturer, model].filter(Boolean).join(" ") || "Android Phone";
        deviceClass = "Phone";
        iconCategory = "phone";
        role = { name: "Phone", emoji: "📱", identifier: 12 };
    }

    const rotationExponent =
        reg?.rotationExponent && reg.rotationExponent > 0 ? reg.rotationExponent : prev?.rotationExponent ?? 10;
    const eikCandidates: Buffer[] = [];
    const pushEikCandidate = (buf: Buffer | null | undefined) => {
        if (!buf || buf.length === 0) return;
        if (!eikCandidates.some(existing => existing.equals(buf))) {
            eikCandidates.push(buf);
        }
    };

    let primaryEik: Buffer | null = null;
    let ownerKeyVersionMismatch = false;

    if (opts.ownerKey && reg?.encryptedKeys?.encryptedIdentityKey) {
        try {
            const unwrapped = unwrapDeviceEik({
                ownerKey: opts.ownerKey,
                encryptedIdentityKey: reg.encryptedKeys.encryptedIdentityKey,
                fastPairModelId: reg.fastPairModelId,
                canonicId,
                deviceOwnerKeyVersion: reg.encryptedKeys.ownerKeyVersion,
                expectedOwnerKeyVersion: opts.ownerKeyVersion
            });
            primaryEik = unwrapped.eik;
            ownerKeyVersionMismatch = unwrapped.ownerKeyVersionMismatch;
        } catch {
            primaryEik = null;
        }
    }

    // Try rotated EIKs first (f29): encrypted under ownerKey, primaryEik, or derived/HKDF variants.
    const wrappingKeys: Buffer[] = [];
    const seenWrapHex = new Set<string>();
    const addWrappingKey = (buf: Buffer | null | undefined) => {
        if (!buf || (buf.length !== 32 && buf.length !== 16)) return;
        const hex = buf.toString("hex");
        if (seenWrapHex.has(hex)) return;
        seenWrapHex.add(hex);
        wrappingKeys.push(buf);
    };
    for (const baseKey of [opts.ownerKey, primaryEik, prev?.eik]) {
        if (!baseKey) continue;
        addWrappingKey(baseKey);
        addWrappingKey(crypto.createHash("sha256").update(baseKey).digest());
        for (const suffix of [0x00, 0x01, 0x02, 0x03, 0x04, 0x05]) {
            addWrappingKey(
                crypto
                    .createHash("sha256")
                    .update(Buffer.concat([baseKey, Buffer.from([suffix])]))
                    .digest()
            );
        }
        for (const info of ["", "key_rotation", "EIK_ROTATION", "SPOT_KEY_ROTATION", "rotated_identity_key"]) {
            addWrappingKey(hkdfSha256(baseKey, Buffer.alloc(0), Buffer.from(info, "utf8"), 32));
        }
    }
    const rotExtraAads: Buffer[] = [
        ...(reg?.encryptedKeys?.encryptedIdentityKey ? [reg.encryptedKeys.encryptedIdentityKey] : []),
        ...(primaryEik ? [primaryEik] : []),
        Buffer.from("key_rotation", "utf8"),
        Buffer.from("rotated_user_secrets", "utf8")
    ];
    const rotatedList = [...(reg?.rotatedEncryptedKeys ?? [])].reverse();
    for (const rot of rotatedList) {
        if (!rot.encryptedIdentityKey) continue;
        for (const wrapKey of wrappingKeys) {
            try {
                const unwrapped = unwrapDeviceEik({
                    ownerKey: wrapKey,
                    encryptedIdentityKey: rot.encryptedIdentityKey,
                    fastPairModelId: reg?.fastPairModelId,
                    canonicId,
                    deviceOwnerKeyVersion: rot.ownerKeyVersion,
                    expectedOwnerKeyVersion: wrapKey === opts.ownerKey ? opts.ownerKeyVersion : undefined,
                    extraAads: rotExtraAads
                });
                if (unwrapped.eik) {
                    pushEikCandidate(unwrapped.eik);
                    break;
                }
            } catch {
                // Try next wrapping key candidate.
            }
        }
    }

    pushEikCandidate(primaryEik);
    pushEikCandidate(prev?.eik);
    for (const prevCand of prev?.eikCandidates ?? []) {
        pushEikCandidate(prevCand);
    }

    let eik: Buffer | null = eikCandidates[0] ?? null;
    if (eik) {
        ownerKeyVersionMismatch = false;
    } else if (prev?.ownerKeyVersionMismatch) {
        ownerKeyVersionMismatch = true;
    }

    const ringKey = eik
        ? deriveRingKey(eik, reg?.ringKey)
        : reg?.ringKey && reg.ringKey.length >= 8
          ? reg.ringKey.subarray(0, 8)
          : prev?.ringKey ?? null;

    const isMultiComponent =
        isEarbuds || (reg?.componentImageUrls?.length ?? 0) > 1 || (reg?.trackableComponents ?? 0) > 1;
    const crowdsourcedKeys: Array<{ key: Buffer; ownerEik: Buffer }> = eikCandidates.map(cand => ({
        key: cand,
        ownerEik: cand
    }));
    if (isMultiComponent) {
        for (const cand of eikCandidates) {
            for (const compId of [0, 1, 2, 3, 254, 255]) {
                const kc = crypto
                    .createHash("sha256")
                    .update(Buffer.concat([cand, Buffer.from([0x04, compId])]))
                    .digest();
                crowdsourcedKeys.push({ key: kc, ownerEik: cand });
            }
        }
    }

    const sortedReports = sortReportsNewestFirst(info?.reports ?? []);
    let latestReport: ProtoLocationReport | null = sortedReports[0] ?? null;
    let tsMs = latestReport ? reportTimestampMs(latestReport) : 0;
    let semanticName = latestReport?.semanticLocation?.locationName?.trim() || null;

    let decodedLoc: ProtoLocation | null = null;
    let accuracy = 0;
    let lastDecryptErr: string | null = null;

    for (const report of sortedReports) {
        const geo = report.geoLocation;
        let candidate: ProtoLocation | null = null;
        if (geo?.unencryptedLocation) {
            candidate = geo.unencryptedLocation;
        } else if (report.unencryptedLocation) {
            candidate = report.unencryptedLocation;
        } else if (geo?.encryptedReport?.encryptedLocation && eikCandidates.length > 0) {
            const pubRand = geo.encryptedReport.publicKeyRandom;
            if (pubRand && pubRand.length > 0) {
                const offsetSec = reg?.fastPairModelId?.trim() === "003200" ? 0 : (geo.deviceTimeOffset ?? 0);
                for (const entry of crowdsourcedKeys) {
                    try {
                        candidate = decryptCrowdsourcedLocationReport({
                            eik: entry.key,
                            encryptedLocation: geo.encryptedReport.encryptedLocation,
                            publicKeyRandom: pubRand,
                            deviceTimeOffset: offsetSec,
                            rotationExponent
                        });
                        eik = entry.ownerEik;
                        break;
                    } catch (err: any) {
                        lastDecryptErr = String(err?.message ?? err);
                    }
                }
            } else {
                for (const cand of eikCandidates) {
                    try {
                        candidate = decryptOwnLocationReport(cand, geo.encryptedReport.encryptedLocation, canonicId);
                        eik = cand;
                        break;
                    } catch (err: any) {
                        lastDecryptErr = String(err?.message ?? err);
                    }
                }
            }
        }
        if (candidate) {
            decodedLoc = candidate;
            latestReport = report;
            tsMs = reportTimestampMs(report);
            accuracy = geo?.accuracy ?? 0;
            semanticName = report.semanticLocation?.locationName?.trim() || semanticName;
            break;
        }
    }

    let location: FindMyLocation | null = null;
    let address: FindMyAddress | null = null;

    if (decodedLoc) {
        location = {
            positionType: latestReport?.geoLocation?.encryptedReport ? "crowdsourced" : "gps",
            latitude: decodedLoc.latitude,
            longitude: decodedLoc.longitude,
            floorLevel: 0,
            horizontalAccuracy: accuracy,
            verticalAccuracy: 0,
            isInaccurate: accuracy > 150,
            isOld: tsMs > 0 ? Date.now() - tsMs > 30 * 60 * 1000 : false,
            locationFinished: true,
            timeStamp: tsMs || Date.now(),
            altitude: decodedLoc.altitude ?? 0
        };

        const geoFn = opts.reverseGeocodeFn ?? ((lat, lon) => reverseGeocode(lat, lon, opts.trackerDeps));
        const geocoded = await geoFn(decodedLoc.latitude, decodedLoc.longitude).catch(() => null);
        if (geocoded) {
            address = geocodedToFindMyAddress(geocoded, semanticName ?? undefined);
        } else if (semanticName) {
            address = makeEmptyAddress(semanticName);
        }
    } else if (semanticName) {
        address = makeEmptyAddress(semanticName);
    } else if (latestReport?.geoLocation?.encryptedReport?.encryptedLocation && !eik) {
        const statusLabel = ownerKeyVersionMismatch
            ? "E2EE Key Rotation Required"
            : opts.ownerKey
              ? "Encrypted Location"
              : "E2EE Locked";
        address = makeEmptyAddress(statusLabel);
    }

    const iconUrl =
        meta.imageInformation?.imageUrl?.trim() ||
        meta.imageInformation?.componentImages?.find(u => u?.trim())?.trim() ||
        reg?.componentImageUrls?.find(u => u?.trim())?.trim() ||
        prev?.device.iconUrl ||
        null;

    const deviceId = `gfind:${canonicId}`;
    const device: FindMyDevice = {
        id: deviceId,
        identifier: canonicId,
        name: displayName,
        isConsideredAccessory: isSpotAccessory,
        deviceModel,
        modelDisplayName,
        deviceDisplayName: modelDisplayName,
        rawDeviceModel: reg?.fastPairModelId ?? model ?? prev?.device.rawDeviceModel ?? null,
        deviceClass,
        iconUrl,
        iconCategory,
        role,
        location,
        crowdSourcedLocation: isSpotAccessory ? location : null,
        address,
        batteryStatus: "Unknown",
        batteryLevel: 0,
        lowPowerMode: false,
        lostModeCapable: true,
        lostModeEnabled: false,
        lostModeMetadata: null,
        snd: true,
        locFoundEnabled: false,
        deviceDiscoveryId: reg?.fastPairModelId ?? null,
        deviceStatus: ownerKeyVersionMismatch ? "key_mismatch" : !eik && isSpotAccessory ? "locked" : "online",
        last_updated: tsMs || Date.now(),
        short_address: address?.label ?? null,
        long_address: address?.mapItemFullAddress ?? address?.label ?? null,
        street: address?.streetAddress ?? null,
        city: address?.locality ?? null,
        state: address?.stateCode ?? null,
        zip: address?.postalCode ?? null,
        country: address?.country ?? null,
        features: {
            SND: true,
            TRACKER_PROVIDER: "gfind",
            CAN_RING: true,
            CAN_FIND_NEARBY: isSpotAccessory && Boolean(eik),
            HAS_BLE_RING: isSpotAccessory && Boolean(ringKey),
            SUPPORTS_UWB: isSpotAccessory,
            RING_COMPONENTS: isEarbuds ? ["left", "right", "case"] : []
        } as unknown as Record<string, boolean>
    };

    const curve: "secp160r1" | "secp256r1" =
        latestReport?.geoLocation?.encryptedReport?.publicKeyRandom?.length === 32 ? "secp256r1" : "secp160r1";

    const statuses = sortedReports.map(r => r.status ?? -1).join(",");
    let diagSuffix = "";
    if (lastDecryptErr) {
        const rep = sortedReports[0]?.geoLocation?.encryptedReport;
        const rotLens = (reg?.rotatedEncryptedKeys ?? [])
            .map(r => `${r.ownerKeyVersion ?? "-"}:${r.encryptedIdentityKey?.length ?? 0}`)
            .join(",");
        diagSuffix = ` ownLen=${rep?.encryptedLocation?.length ?? 0} isOwn=${rep?.isOwnReport ?? "-"} pubLen=${rep?.publicKeyRandom?.length ?? 0} f19v=${reg?.encryptedKeys?.ownerKeyVersion ?? "-"} rot=[${rotLens}]`;
    }
    const debugSummary = `reports=${sortedReports.length} eiks=${eikCandidates.length} statuses=[${statuses}] err=${lastDecryptErr ?? "none"} hasLoc=${Boolean(decodedLoc)}${diagSuffix}`;

    return {
        canonicId,
        deviceId,
        novaDeviceType,
        spotDeviceType: spotType,
        isSpotAccessory,
        isEarbuds,
        rotationExponent,
        curve,
        eik,
        eikCandidates,
        ringKey,
        ownerKeyVersionMismatch,
        debugSummary,
        device
    };
}
