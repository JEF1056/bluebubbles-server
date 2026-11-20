// Minimal unknown-field-tolerant protobuf wire encoder/decoder for Google Find Hub (Nova, Spot, Checkin, FCM MCS).

import crypto from "crypto";

export type WireValue = bigint | Buffer;

export interface RawField {
    fieldNumber: number;
    wireType: number;
    value: WireValue;
}

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_FIXED32 = 5;

export function encodeVarint(value: number | bigint): Buffer {
    let v = typeof value === "bigint" ? BigInt.asUintN(64, value) : BigInt.asUintN(64, BigInt(Math.trunc(value)));
    const bytes: number[] = [];
    while (v >= BigInt(0x80)) {
        bytes.push(Number(v & BigInt(0x7f)) | 0x80);
        v >>= BigInt(7);
    }
    bytes.push(Number(v));
    return Buffer.from(bytes);
}

export function decodeVarint(buf: Buffer, offset: number): { value: bigint; nextOffset: number } {
    let result = BigInt(0);
    let shift = BigInt(0);
    let pos = offset;
    while (pos < buf.length) {
        const b = buf[pos++];
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) {
            return { value: result, nextOffset: pos };
        }
        shift += BigInt(7);
        if (shift > BigInt(63)) {
            throw new Error("Protobuf varint overflow");
        }
    }
    throw new Error("Truncated protobuf varint");
}

export function decodeRawFields(buf: Buffer): RawField[] {
    const fields: RawField[] = [];
    let offset = 0;
    while (offset < buf.length) {
        const tag = decodeVarint(buf, offset);
        offset = tag.nextOffset;
        const fieldNumber = Number(tag.value >> BigInt(3));
        const wireType = Number(tag.value & BigInt(0x7));
        if (fieldNumber <= 0) {
            throw new Error(`Invalid protobuf field number: ${fieldNumber}`);
        }

        if (wireType === WIRE_VARINT) {
            const val = decodeVarint(buf, offset);
            offset = val.nextOffset;
            fields.push({ fieldNumber, wireType, value: val.value });
        } else if (wireType === WIRE_FIXED64) {
            if (offset + 8 > buf.length) throw new Error("Truncated protobuf fixed64");
            fields.push({ fieldNumber, wireType, value: Buffer.from(buf.subarray(offset, offset + 8)) });
            offset += 8;
        } else if (wireType === WIRE_LENGTH_DELIMITED) {
            const len = decodeVarint(buf, offset);
            offset = len.nextOffset;
            const byteLen = Number(len.value);
            if (!Number.isSafeInteger(byteLen) || byteLen < 0 || offset + byteLen > buf.length) {
                throw new Error("Truncated protobuf length-delimited field");
            }
            fields.push({ fieldNumber, wireType, value: Buffer.from(buf.subarray(offset, offset + byteLen)) });
            offset += byteLen;
        } else if (wireType === WIRE_FIXED32) {
            if (offset + 4 > buf.length) throw new Error("Truncated protobuf fixed32");
            fields.push({ fieldNumber, wireType, value: Buffer.from(buf.subarray(offset, offset + 4)) });
            offset += 4;
        } else {
            throw new Error(`Unsupported protobuf wire type: ${wireType}`);
        }
    }
    return fields;
}

export function encodeRawFields(fields: RawField[]): Buffer {
    const chunks: Buffer[] = [];
    for (const f of fields) {
        const tag = (BigInt(f.fieldNumber) << BigInt(3)) | BigInt(f.wireType & 0x7);
        chunks.push(encodeVarint(tag));
        if (f.wireType === WIRE_VARINT) {
            chunks.push(encodeVarint(typeof f.value === "bigint" ? f.value : BigInt(0)));
        } else if (f.wireType === WIRE_FIXED64 || f.wireType === WIRE_FIXED32) {
            const b = Buffer.isBuffer(f.value) ? f.value : Buffer.alloc(f.wireType === WIRE_FIXED64 ? 8 : 4);
            chunks.push(b);
        } else if (f.wireType === WIRE_LENGTH_DELIMITED) {
            const b = Buffer.isBuffer(f.value) ? f.value : Buffer.alloc(0);
            chunks.push(encodeVarint(b.length), b);
        } else {
            throw new Error(`Unsupported protobuf wire type: ${f.wireType}`);
        }
    }
    return Buffer.concat(chunks);
}

const varintField = (fieldNumber: number, value: number | bigint): RawField => ({
    fieldNumber,
    wireType: WIRE_VARINT,
    value: typeof value === "bigint" ? BigInt.asUintN(64, value) : BigInt.asUintN(64, BigInt(Math.trunc(value)))
});

const bytesField = (fieldNumber: number, value: Buffer): RawField => ({
    fieldNumber,
    wireType: WIRE_LENGTH_DELIMITED,
    value
});

const stringField = (fieldNumber: number, value: string): RawField => ({
    fieldNumber,
    wireType: WIRE_LENGTH_DELIMITED,
    value: Buffer.from(value, "utf8")
});

const fixed32IntField = (fieldNumber: number, value: number): RawField => {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32LE(Math.trunc(value), 0);
    return { fieldNumber, wireType: WIRE_FIXED32, value: b };
};

const fixed32FloatField = (fieldNumber: number, value: number): RawField => {
    const b = Buffer.allocUnsafe(4);
    b.writeFloatLE(value, 0);
    return { fieldNumber, wireType: WIRE_FIXED32, value: b };
};

const fixed64UintField = (fieldNumber: number, value: bigint): RawField => {
    const b = Buffer.allocUnsafe(8);
    b.writeBigUInt64LE(BigInt.asUintN(64, value), 0);
    return { fieldNumber, wireType: WIRE_FIXED64, value: b };
};

const asInt32 = (v: WireValue): number => (typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : 0);
const asUint32 = (v: WireValue): number => (typeof v === "bigint" ? Number(BigInt.asUintN(32, v)) : 0);
const asBool = (v: WireValue): boolean => (typeof v === "bigint" ? v !== BigInt(0) : false);
const asBuffer = (v: WireValue): Buffer => (Buffer.isBuffer(v) ? v : Buffer.alloc(0));
const asString = (v: WireValue): string => asBuffer(v).toString("utf8");

function splitKnown(
    buf: Buffer,
    knownFieldNumbers: Set<number>
): { byField: Map<number, RawField[]>; unknownFields: RawField[] } {
    const raw = decodeRawFields(buf);
    const byField = new Map<number, RawField[]>();
    const unknownFields: RawField[] = [];
    for (const f of raw) {
        if (knownFieldNumbers.has(f.fieldNumber)) {
            const list = byField.get(f.fieldNumber);
            if (list) list.push(f);
            else byField.set(f.fieldNumber, [f]);
        } else {
            unknownFields.push(f);
        }
    }
    return { byField, unknownFields };
}

function appendUnknown(fields: RawField[], unknownFields?: RawField[]): Buffer {
    if (unknownFields && unknownFields.length > 0) {
        return encodeRawFields([...fields, ...unknownFields]);
    }
    return encodeRawFields(fields);
}

// ---- Enums ----

export enum NovaDeviceType {
    UNKNOWN_DEVICE_TYPE = 0,
    ANDROID_DEVICE = 1,
    SPOT_DEVICE = 2,
    TEST_DEVICE = 3,
    AUTO_DEVICE = 4,
    FASTPAIR_DEVICE = 5,
    SUPERVISED_ANDROID_DEVICE = 7
}

export enum IdentifierInformationType {
    IDENTIFIER_UNKNOWN = 0,
    IDENTIFIER_ANDROID = 1,
    IDENTIFIER_SPOT = 2
}

export enum SpotDeviceType {
    DEVICE_TYPE_UNKNOWN = 0,
    DEVICE_TYPE_BEACON = 1,
    DEVICE_TYPE_HEADPHONES = 2,
    DEVICE_TYPE_KEYS = 3,
    DEVICE_TYPE_WATCH = 4,
    DEVICE_TYPE_WALLET = 5,
    DEVICE_TYPE_BAG = 7,
    DEVICE_TYPE_LAPTOP = 8,
    DEVICE_TYPE_CAR = 9,
    DEVICE_TYPE_REMOTE_CONTROL = 10,
    DEVICE_TYPE_BADGE = 11,
    DEVICE_TYPE_BIKE = 12,
    DEVICE_TYPE_CAMERA = 13,
    DEVICE_TYPE_CAT = 14,
    DEVICE_TYPE_CHARGER = 15,
    DEVICE_TYPE_CLOTHING = 16,
    DEVICE_TYPE_DOG = 17,
    DEVICE_TYPE_NOTEBOOK = 18,
    DEVICE_TYPE_PASSPORT = 19,
    DEVICE_TYPE_PHONE = 20,
    DEVICE_TYPE_SPEAKER = 21,
    DEVICE_TYPE_TABLET = 22,
    DEVICE_TYPE_TOYS = 23,
    DEVICE_TYPE_UMBRELLA = 24,
    DEVICE_TYPE_STYLUS = 25,
    DEVICE_TYPE_EARBUDS = 26
}

export enum ExecuteActionLocationType {
    FMDN_DISABLED_DEFAULT = 0,
    FMDN_HIGH_TRAFFIC = 1,
    FMDN_ALL_LOCATIONS = 2,
    FMDN_CONTRIBUTOR_HIGH_TRAFFIC = 3,
    FMDN_CONTRIBUTOR_ALL_LOCATIONS = 4
}

export enum ExecuteActionDeviceComponent {
    DEVICE_COMPONENT_UNSPECIFIED = 0,
    DEVICE_COMPONENT_RIGHT = 1,
    DEVICE_COMPONENT_LEFT = 2,
    DEVICE_COMPONENT_CASE = 3
}

// ---- Interfaces ----

export interface ProtoLocation {
    latitude: number;
    longitude: number;
    altitude?: number;
    _unknownFields?: RawField[];
}

export interface ProtoEncryptedReport {
    publicKeyRandom?: Buffer;
    encryptedLocation?: Buffer;
    isOwnReport?: boolean;
    _unknownFields?: RawField[];
}

export interface ProtoGeoLocation {
    encryptedReport?: ProtoEncryptedReport;
    deviceTimeOffset?: number;
    accuracy?: number;
    unencryptedLocation?: ProtoLocation;
    _unknownFields?: RawField[];
}

export interface ProtoSemanticLocation {
    locationName?: string;
    _unknownFields?: RawField[];
}

export interface ProtoLocationReport {
    semanticLocation?: ProtoSemanticLocation;
    geoLocation?: ProtoGeoLocation;
    unencryptedLocation?: ProtoLocation;
    timestampSeconds?: number;
    timestampNanos?: number;
    status?: number;
    _unknownFields?: RawField[];
}

export interface ProtoEncryptedKeys {
    ownerKeyVersion?: number;
    encryptedIdentityKey?: Buffer;
    encryptedAccountKey?: Buffer;
    encryptedSha256AccountKey?: Buffer;
    _unknownFields?: RawField[];
}

export interface ProtoDeviceRegistration {
    spotDeviceType?: SpotDeviceType;
    encryptedKeys?: ProtoEncryptedKeys;
    rotatedEncryptedKeys?: ProtoEncryptedKeys[];
    trackableComponents?: number;
    manufacturer?: string;
    fastPairModelId?: string;
    rotationExponent?: number;
    ringKey?: Buffer;
    model?: string;
    componentImageUrls?: string[];
    _unknownFields?: RawField[];
}

export interface ProtoDeviceInformation {
    deviceRegistration?: ProtoDeviceRegistration;
    reports: ProtoLocationReport[];
    _unknownFields?: RawField[];
}

export interface ProtoPhoneInformation {
    canonicIds: string[];
    manufacturer?: string;
    modelNumber?: string;
    codename?: string;
    deviceInformation?: ProtoDeviceInformation;
    _unknownFields?: RawField[];
}

export interface ProtoImageInformation {
    imageUrl?: string;
    componentImages?: string[];
    _unknownFields?: RawField[];
}

export interface ProtoTrackerInformation {
    canonicIds: string[];
    _unknownFields?: RawField[];
}

export interface ProtoIdentifierInformation {
    type: IdentifierInformationType;
    phoneInformation?: ProtoPhoneInformation;
    trackerInformation?: ProtoTrackerInformation;
    _unknownFields?: RawField[];
}

export interface ProtoDeviceMetadata {
    identifierInformation?: ProtoIdentifierInformation;
    phoneInformation?: ProtoPhoneInformation;
    information?: ProtoDeviceInformation;
    userDefinedDeviceName?: string;
    imageInformation?: ProtoImageInformation;
    deviceCategory?: number;
    _unknownFields?: RawField[];
}

export interface ProtoDevicesList {
    deviceMetadata: ProtoDeviceMetadata[];
    _unknownFields?: RawField[];
}

export interface ProtoExecuteActionRequestMetadata {
    type: NovaDeviceType;
    requestUuid: string;
    fcmRegistrationId?: string;
    unknownFlag?: boolean;
    _unknownFields?: RawField[];
}

export interface ProtoDeviceUpdate {
    deviceMetadata?: ProtoDeviceMetadata;
    fcmMetadata?: ProtoExecuteActionRequestMetadata;
    _unknownFields?: RawField[];
}

// ---- Common CanonicIds ----

function decodeCanonicIds(buf: Buffer): string[] {
    const ids: string[] = [];
    for (const f of decodeRawFields(buf)) {
        if (f.fieldNumber === 1 && f.wireType === WIRE_LENGTH_DELIMITED) {
            for (const inner of decodeRawFields(asBuffer(f.value))) {
                if (inner.fieldNumber === 1 && inner.wireType === WIRE_LENGTH_DELIMITED) {
                    const id = asString(inner.value);
                    if (id) ids.push(id);
                }
            }
        }
    }
    return ids;
}

function encodeCanonicIds(ids: string[]): Buffer {
    const fields: RawField[] = [];
    for (const id of ids) {
        fields.push(bytesField(1, encodeRawFields([stringField(1, id)])));
    }
    return encodeRawFields(fields);
}

// ---- Location & Reports ----

export function decodeLocation(buf: Buffer): ProtoLocation {
    const { byField, unknownFields } = splitKnown(buf, new Set([1, 2, 3]));
    let latitude = 0;
    let longitude = 0;
    let altitude: number | undefined;

    const f1 = byField.get(1)?.[0];
    if (f1 && f1.wireType === WIRE_FIXED32) {
        latitude = asBuffer(f1.value).readInt32LE(0) / 1e7;
    }
    const f2 = byField.get(2)?.[0];
    if (f2 && f2.wireType === WIRE_FIXED32) {
        longitude = asBuffer(f2.value).readInt32LE(0) / 1e7;
    }
    const f3 = byField.get(3)?.[0];
    if (f3 && f3.wireType === WIRE_VARINT) {
        altitude = asInt32(f3.value);
    }

    return {
        latitude,
        longitude,
        altitude,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

export function encodeLocation(loc: ProtoLocation): Buffer {
    const fields: RawField[] = [
        fixed32IntField(1, Math.round(loc.latitude * 1e7)),
        fixed32IntField(2, Math.round(loc.longitude * 1e7))
    ];
    if (loc.altitude !== undefined) {
        fields.push(varintField(3, loc.altitude));
    }
    return appendUnknown(fields, loc._unknownFields);
}

function decodeEncryptedReport(buf: Buffer): ProtoEncryptedReport {
    const { byField, unknownFields } = splitKnown(buf, new Set([1, 2, 3]));
    const f1 = byField.get(1)?.[0];
    const f2 = byField.get(2)?.[0];
    const f3 = byField.get(3)?.[0];
    return {
        publicKeyRandom: f1 && f1.wireType === WIRE_LENGTH_DELIMITED ? asBuffer(f1.value) : undefined,
        encryptedLocation: f2 && f2.wireType === WIRE_LENGTH_DELIMITED ? asBuffer(f2.value) : undefined,
        isOwnReport: f3 && f3.wireType === WIRE_VARINT ? asBool(f3.value) : undefined,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

function encodeEncryptedReport(rep: ProtoEncryptedReport): Buffer {
    const fields: RawField[] = [];
    if (rep.publicKeyRandom) fields.push(bytesField(1, rep.publicKeyRandom));
    if (rep.encryptedLocation) fields.push(bytesField(2, rep.encryptedLocation));
    if (rep.isOwnReport !== undefined) fields.push(varintField(3, rep.isOwnReport ? 1 : 0));
    return appendUnknown(fields, rep._unknownFields);
}

function looksLikeProtoLocation(buf: Buffer): boolean {
    try {
        const fields = decodeRawFields(buf);
        const hasLat = fields.some(f => f.fieldNumber === 1 && f.wireType === WIRE_FIXED32);
        const hasLon = fields.some(f => f.fieldNumber === 2 && f.wireType === WIRE_FIXED32);
        return hasLat && hasLon;
    } catch {
        return false;
    }
}

function decodeGeoLocation(buf: Buffer): ProtoGeoLocation {
    const { byField, unknownFields } = splitKnown(buf, new Set([1, 2, 3, 4]));
    const f1 = byField.get(1)?.[0];
    const f2 = byField.get(2)?.[0];
    const f3 = byField.get(3)?.[0];
    const f4 = byField.get(4)?.[0];

    let accuracy: number | undefined;
    if (f3) {
        if (f3.wireType === WIRE_FIXED32) {
            accuracy = asBuffer(f3.value).readFloatLE(0);
        } else if (f3.wireType === WIRE_VARINT) {
            accuracy = asInt32(f3.value);
        }
    }

    let unencryptedLocation: ProtoLocation | undefined;
    if (f4 && f4.wireType === WIRE_LENGTH_DELIMITED && looksLikeProtoLocation(asBuffer(f4.value))) {
        unencryptedLocation = decodeLocation(asBuffer(f4.value));
    } else {
        for (const uf of unknownFields) {
            if (uf.wireType === WIRE_LENGTH_DELIMITED && looksLikeProtoLocation(asBuffer(uf.value))) {
                unencryptedLocation = decodeLocation(asBuffer(uf.value));
                break;
            }
        }
    }

    return {
        encryptedReport: f1 && f1.wireType === WIRE_LENGTH_DELIMITED ? decodeEncryptedReport(asBuffer(f1.value)) : undefined,
        deviceTimeOffset: f2 && f2.wireType === WIRE_VARINT ? asUint32(f2.value) : undefined,
        accuracy,
        unencryptedLocation,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

function encodeGeoLocation(geo: ProtoGeoLocation): Buffer {
    const fields: RawField[] = [];
    if (geo.encryptedReport) fields.push(bytesField(1, encodeEncryptedReport(geo.encryptedReport)));
    if (geo.deviceTimeOffset !== undefined) fields.push(varintField(2, geo.deviceTimeOffset));
    if (geo.accuracy !== undefined) fields.push(fixed32FloatField(3, geo.accuracy));
    if (geo.unencryptedLocation) fields.push(bytesField(4, encodeLocation(geo.unencryptedLocation)));
    return appendUnknown(fields, geo._unknownFields);
}

function decodeSemanticLocation(buf: Buffer): ProtoSemanticLocation {
    const { byField, unknownFields } = splitKnown(buf, new Set([1]));
    const f1 = byField.get(1)?.[0];
    return {
        locationName: f1 && f1.wireType === WIRE_LENGTH_DELIMITED ? asString(f1.value) : undefined,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

function decodeTimeField(buf: Buffer): { seconds?: number; nanos?: number } {
    let seconds: number | undefined;
    let nanos: number | undefined;
    for (const tf of decodeRawFields(buf)) {
        if (tf.fieldNumber === 1 && tf.wireType === WIRE_VARINT) {
            seconds = Number(BigInt.asIntN(64, tf.value as bigint));
        } else if (tf.fieldNumber === 2 && tf.wireType === WIRE_VARINT) {
            nanos = asInt32(tf.value);
        }
    }
    return { seconds, nanos };
}

function encodeTimeField(seconds?: number, nanos?: number): Buffer {
    const tf: RawField[] = [];
    if (seconds !== undefined) tf.push(varintField(1, seconds));
    if (nanos !== undefined) tf.push(varintField(2, nanos));
    return encodeRawFields(tf);
}

export function decodeLocationReport(buf: Buffer): ProtoLocationReport {
    const { byField, unknownFields } = splitKnown(buf, new Set([5, 7, 8, 10, 11]));
    const f5 = byField.get(5)?.[0];
    const f7 = byField.get(7)?.[0];
    const f8 = byField.get(8)?.[0];
    const f10 = byField.get(10)?.[0];
    const f11 = byField.get(11)?.[0];

    let timestampSeconds: number | undefined;
    let timestampNanos: number | undefined;
    if (f7 && f7.wireType === WIRE_LENGTH_DELIMITED) {
        const parsedTime = decodeTimeField(asBuffer(f7.value));
        timestampSeconds = parsedTime.seconds;
        timestampNanos = parsedTime.nanos;
    }

    let unencryptedLocation: ProtoLocation | undefined;
    if (!f10) {
        for (const uf of unknownFields) {
            if (uf.wireType === WIRE_LENGTH_DELIMITED && looksLikeProtoLocation(asBuffer(uf.value))) {
                unencryptedLocation = decodeLocation(asBuffer(uf.value));
                break;
            }
        }
    }

    const statusField = f11 ?? f8;
    return {
        semanticLocation: f5 && f5.wireType === WIRE_LENGTH_DELIMITED ? decodeSemanticLocation(asBuffer(f5.value)) : undefined,
        geoLocation: f10 && f10.wireType === WIRE_LENGTH_DELIMITED ? decodeGeoLocation(asBuffer(f10.value)) : undefined,
        unencryptedLocation,
        timestampSeconds,
        timestampNanos,
        status: statusField && statusField.wireType === WIRE_VARINT ? asUint32(statusField.value) : undefined,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

export function encodeLocationReport(report: ProtoLocationReport): Buffer {
    const fields: RawField[] = [];
    if (report.semanticLocation) {
        const sf: RawField[] = [];
        if (report.semanticLocation.locationName !== undefined) {
            sf.push(stringField(1, report.semanticLocation.locationName));
        }
        fields.push(bytesField(5, appendUnknown(sf, report.semanticLocation._unknownFields)));
    }
    if (report.geoLocation) fields.push(bytesField(10, encodeGeoLocation(report.geoLocation)));
    if (report.status !== undefined) fields.push(varintField(11, report.status));
    return appendUnknown(fields, report._unknownFields);
}

// ---- DeviceRegistration & Metadata ----

function decodeEncryptedKeys(buf: Buffer): ProtoEncryptedKeys {
    const { byField, unknownFields } = splitKnown(buf, new Set([1, 3, 4, 11]));
    const f1 = byField.get(1)?.[0];
    const f3 = byField.get(3)?.[0];
    const f4 = byField.get(4)?.[0];
    const f11 = byField.get(11)?.[0];

    return {
        encryptedIdentityKey: f1 && f1.wireType === WIRE_LENGTH_DELIMITED ? asBuffer(f1.value) : undefined,
        ownerKeyVersion: f3 && f3.wireType === WIRE_VARINT ? asInt32(f3.value) : undefined,
        encryptedAccountKey: f4 && f4.wireType === WIRE_LENGTH_DELIMITED ? asBuffer(f4.value) : undefined,
        encryptedSha256AccountKey: f11 && f11.wireType === WIRE_LENGTH_DELIMITED ? asBuffer(f11.value) : undefined,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

function encodeEncryptedKeys(ek: ProtoEncryptedKeys): Buffer {
    const fields: RawField[] = [];
    if (ek.encryptedIdentityKey) fields.push(bytesField(1, ek.encryptedIdentityKey));
    if (ek.ownerKeyVersion !== undefined) fields.push(varintField(3, ek.ownerKeyVersion));
    if (ek.encryptedAccountKey) fields.push(bytesField(4, ek.encryptedAccountKey));
    if (ek.encryptedSha256AccountKey) fields.push(bytesField(11, ek.encryptedSha256AccountKey));
    return appendUnknown(fields, ek._unknownFields);
}

function decodeKeyRotationEncryptedKeys(buf: Buffer): ProtoEncryptedKeys[] {
    const out: ProtoEncryptedKeys[] = [];
    for (const rf of decodeRawFields(buf)) {
        if (rf.wireType !== WIRE_LENGTH_DELIMITED) continue;
        const innerBuf = asBuffer(rf.value);
        if (rf.fieldNumber === 1) {
            // Either EncryptedUserSecrets directly (live Pixel 8 Pro f29.f1.f1=60B) or RotatedUserSecrets { encryptedUserSecrets = 1 }
            const direct = decodeEncryptedKeys(innerBuf);
            if (direct.encryptedIdentityKey && (direct.encryptedIdentityKey.length === 48 || direct.encryptedIdentityKey.length === 60)) {
                out.push(direct);
            } else {
                const nested = decodeRawFields(innerBuf).find(
                    nf => nf.fieldNumber === 1 && nf.wireType === WIRE_LENGTH_DELIMITED
                );
                if (nested) {
                    const parsed = decodeEncryptedKeys(asBuffer(nested.value));
                    if (parsed.encryptedIdentityKey?.length) out.push(parsed);
                }
            }
        } else if (rf.fieldNumber === 2) {
            const parsed = decodeEncryptedKeys(innerBuf);
            if (parsed.encryptedIdentityKey?.length) out.push(parsed);
        }
    }
    return out;
}

function decodeDeviceRegistration(buf: Buffer): ProtoDeviceRegistration {
    const { byField, unknownFields } = splitKnown(buf, new Set([2, 3, 11, 19, 20, 21, 24, 25, 29, 34]));

    let spotDeviceType: SpotDeviceType | undefined;
    const componentImageUrls: string[] = [];
    const typeContainer = byField.get(2)?.[0] ?? byField.get(3)?.[0];
    if (typeContainer) {
        if (typeContainer.wireType === WIRE_VARINT) {
            spotDeviceType = asInt32(typeContainer.value) as SpotDeviceType;
        } else if (typeContainer.wireType === WIRE_LENGTH_DELIMITED) {
            const sub = decodeRawFields(asBuffer(typeContainer.value));
            const dt = sub.find(x => (x.fieldNumber === 2 || x.fieldNumber === 1) && x.wireType === WIRE_VARINT);
            if (dt) spotDeviceType = asInt32(dt.value) as SpotDeviceType;
            for (const comp of sub.filter(x => x.fieldNumber === 15 && x.wireType === WIRE_LENGTH_DELIMITED)) {
                for (const cf of decodeRawFields(asBuffer(comp.value))) {
                    if (cf.fieldNumber === 2 && cf.wireType === WIRE_LENGTH_DELIMITED) {
                        const urlField = decodeRawFields(asBuffer(cf.value)).find(
                            u => u.fieldNumber === 1 && u.wireType === WIRE_LENGTH_DELIMITED
                        );
                        if (urlField) {
                            const url = asString(urlField.value).trim();
                            if (url) componentImageUrls.push(url);
                        }
                    }
                }
            }
        }
    }

    let trackableComponents: number | undefined;
    const f11 = byField.get(11)?.[0];
    if (f11 && f11.wireType === WIRE_LENGTH_DELIMITED) {
        const tc = decodeRawFields(asBuffer(f11.value)).find(
            x => x.fieldNumber === 6 && x.wireType === WIRE_VARINT
        );
        if (tc) trackableComponents = asUint32(tc.value);
    }

    const rotatedEncryptedKeys: ProtoEncryptedKeys[] = [];
    for (const f29 of byField.get(29) ?? []) {
        if (f29.wireType === WIRE_LENGTH_DELIMITED) {
            rotatedEncryptedKeys.push(...decodeKeyRotationEncryptedKeys(asBuffer(f29.value)));
        }
    }

    const f19 = byField.get(19)?.[0];
    const f20 = byField.get(20)?.[0];
    const f21 = byField.get(21)?.[0];
    const f24 = byField.get(24)?.[0];
    const f25 = byField.get(25)?.[0];
    const f34 = byField.get(34)?.[0];

    return {
        spotDeviceType,
        encryptedKeys: f19 && f19.wireType === WIRE_LENGTH_DELIMITED ? decodeEncryptedKeys(asBuffer(f19.value)) : undefined,
        rotatedEncryptedKeys: rotatedEncryptedKeys.length > 0 ? rotatedEncryptedKeys : undefined,
        trackableComponents,
        manufacturer: f20 && f20.wireType === WIRE_LENGTH_DELIMITED ? asString(f20.value) : undefined,
        fastPairModelId: f21 && f21.wireType === WIRE_LENGTH_DELIMITED ? asString(f21.value) : undefined,
        rotationExponent: f24 && f24.wireType === WIRE_VARINT ? asUint32(f24.value) : undefined,
        ringKey: f25 && f25.wireType === WIRE_LENGTH_DELIMITED ? asBuffer(f25.value) : undefined,
        model: f34 && f34.wireType === WIRE_LENGTH_DELIMITED ? asString(f34.value) : undefined,
        componentImageUrls: componentImageUrls.length > 0 ? componentImageUrls : undefined,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

function encodeDeviceRegistration(reg: ProtoDeviceRegistration): Buffer {
    const fields: RawField[] = [];
    if (reg.spotDeviceType !== undefined) {
        fields.push(bytesField(2, encodeRawFields([varintField(2, reg.spotDeviceType)])));
    }
    if (reg.trackableComponents !== undefined) {
        fields.push(bytesField(11, encodeRawFields([varintField(6, reg.trackableComponents)])));
    }
    if (reg.encryptedKeys) fields.push(bytesField(19, encodeEncryptedKeys(reg.encryptedKeys)));
    if (reg.manufacturer !== undefined) fields.push(stringField(20, reg.manufacturer));
    if (reg.fastPairModelId !== undefined) fields.push(stringField(21, reg.fastPairModelId));
    if (reg.rotationExponent !== undefined) fields.push(varintField(24, reg.rotationExponent));
    if (reg.ringKey !== undefined) fields.push(bytesField(25, reg.ringKey));
    if (reg.rotatedEncryptedKeys?.length) {
        const rotFields = reg.rotatedEncryptedKeys.map(k => bytesField(1, encodeEncryptedKeys(k)));
        fields.push(bytesField(29, encodeRawFields(rotFields)));
    }
    if (reg.model !== undefined) fields.push(stringField(34, reg.model));
    return appendUnknown(fields, reg._unknownFields);
}

function decodeLocationInformation(buf: Buffer): ProtoLocationReport[] {
    const reports: ProtoLocationReport[] = [];
    for (const f of decodeRawFields(buf)) {
        if (f.fieldNumber !== 3 || f.wireType !== WIRE_LENGTH_DELIMITED) continue;
        const wrapperFields = decodeRawFields(asBuffer(f.value));
        const nested = wrapperFields.find(rf => rf.fieldNumber === 4 && rf.wireType === WIRE_LENGTH_DELIMITED);
        if (nested) {
            const rlFields = decodeRawFields(asBuffer(nested.value));
            let recentReport: ProtoLocationReport | undefined;
            let recentTime: { seconds?: number; nanos?: number } | undefined;
            const networkReports: ProtoLocationReport[] = [];
            const networkTimes: Array<{ seconds?: number; nanos?: number }> = [];

            for (const rf of rlFields) {
                if (rf.wireType !== WIRE_LENGTH_DELIMITED) continue;
                if (rf.fieldNumber === 1) {
                    recentReport = decodeLocationReport(asBuffer(rf.value));
                } else if (rf.fieldNumber === 2) {
                    recentTime = decodeTimeField(asBuffer(rf.value));
                } else if (rf.fieldNumber === 5) {
                    networkReports.push(decodeLocationReport(asBuffer(rf.value)));
                } else if (rf.fieldNumber === 6) {
                    networkTimes.push(decodeTimeField(asBuffer(rf.value)));
                }
            }
            if (recentReport) {
                if (recentTime) {
                    recentReport.timestampSeconds ??= recentTime.seconds;
                    recentReport.timestampNanos ??= recentTime.nanos;
                }
                reports.push(recentReport);
            }
            for (let i = 0; i < networkReports.length; i++) {
                const netReport = networkReports[i];
                const netTime = networkTimes[i];
                if (netTime) {
                    netReport.timestampSeconds ??= netTime.seconds;
                    netReport.timestampNanos ??= netTime.nanos;
                }
                reports.push(netReport);
            }
            continue;
        }
        // Fallback for flat wrappers
        for (const rf of wrapperFields) {
            if ((rf.fieldNumber === 1 || rf.fieldNumber === 2) && rf.wireType === WIRE_LENGTH_DELIMITED) {
                reports.push(decodeLocationReport(asBuffer(rf.value)));
            }
        }
    }
    return reports;
}

function decodeDeviceInformation(buf: Buffer): ProtoDeviceInformation {
    const { byField, unknownFields } = splitKnown(buf, new Set([1, 2]));
    const f1 = byField.get(1)?.[0];
    const f2 = byField.get(2)?.[0];
    return {
        deviceRegistration: f1 && f1.wireType === WIRE_LENGTH_DELIMITED ? decodeDeviceRegistration(asBuffer(f1.value)) : undefined,
        reports: f2 && f2.wireType === WIRE_LENGTH_DELIMITED ? decodeLocationInformation(asBuffer(f2.value)) : [],
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

function encodeDeviceInformation(info: ProtoDeviceInformation): Buffer {
    const fields: RawField[] = [];
    if (info.deviceRegistration) {
        fields.push(bytesField(1, encodeDeviceRegistration(info.deviceRegistration)));
    }
    if (info.reports.length > 0) {
        const rlFields: RawField[] = [];
        const [first, ...rest] = info.reports;
        rlFields.push(bytesField(1, encodeLocationReport(first)));
        if (first.timestampSeconds !== undefined || first.timestampNanos !== undefined) {
            rlFields.push(bytesField(2, encodeTimeField(first.timestampSeconds, first.timestampNanos)));
        }
        for (const r of rest) {
            rlFields.push(bytesField(5, encodeLocationReport(r)));
            if (r.timestampSeconds !== undefined || r.timestampNanos !== undefined) {
                rlFields.push(bytesField(6, encodeTimeField(r.timestampSeconds, r.timestampNanos)));
            }
        }
        const wrapper = encodeRawFields([bytesField(4, encodeRawFields(rlFields))]);
        fields.push(bytesField(2, encodeRawFields([bytesField(3, wrapper)])));
    }
    return appendUnknown(fields, info._unknownFields);
}

function decodePhoneInformation(buf: Buffer): ProtoPhoneInformation {
    const { byField, unknownFields } = splitKnown(buf, new Set([2, 3, 4, 5, 6, 7, 8, 9, 18, 19, 26]));
    const f2 = byField.get(2)?.[0];
    const f26 = byField.get(26)?.[0];

    const pickString = (fieldNums: number[]): string | undefined => {
        for (const n of fieldNums) {
            const entry = byField.get(n)?.[0];
            if (entry && entry.wireType === WIRE_LENGTH_DELIMITED) {
                const s = asString(entry.value).trim();
                if (s) return s;
            }
        }
        return undefined;
    };

    return {
        canonicIds: f2 && f2.wireType === WIRE_LENGTH_DELIMITED ? decodeCanonicIds(asBuffer(f2.value)) : [],
        manufacturer: pickString([4, 6, 8, 18]),
        modelNumber: pickString([3, 7, 9, 19]),
        codename: pickString([5]),
        deviceInformation: f26 && f26.wireType === WIRE_LENGTH_DELIMITED ? decodeDeviceInformation(asBuffer(f26.value)) : undefined,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

function encodePhoneInformation(pi: ProtoPhoneInformation): Buffer {
    const fields: RawField[] = [];
    if (pi.canonicIds.length > 0) fields.push(bytesField(2, encodeCanonicIds(pi.canonicIds)));
    if (pi.manufacturer !== undefined) fields.push(stringField(6, pi.manufacturer));
    if (pi.modelNumber !== undefined) fields.push(stringField(7, pi.modelNumber));
    if (pi.codename !== undefined) fields.push(stringField(5, pi.codename));
    if (pi.deviceInformation) fields.push(bytesField(26, encodeDeviceInformation(pi.deviceInformation)));
    return appendUnknown(fields, pi._unknownFields);
}

function decodeTrackerInformation(buf: Buffer): ProtoTrackerInformation {
    const { byField, unknownFields } = splitKnown(buf, new Set([1, 2]));
    const f2 = byField.get(2)?.[0];
    const f1 = byField.get(1)?.[0];
    let canonicIds: string[] = [];
    if (f2 && f2.wireType === WIRE_LENGTH_DELIMITED) {
        canonicIds = decodeCanonicIds(asBuffer(f2.value));
    }
    if (canonicIds.length === 0 && f1 && f1.wireType === WIRE_LENGTH_DELIMITED) {
        canonicIds = decodeCanonicIds(asBuffer(f1.value));
    }
    return {
        canonicIds,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

function decodeIdentifierInformation(buf: Buffer): ProtoIdentifierInformation {
    const { byField, unknownFields } = splitKnown(buf, new Set([1, 2, 3, 4]));
    const f1 = byField.get(1)?.[0];
    const f2 = byField.get(2)?.[0];
    const f3 = byField.get(3)?.[0];
    const f4 = byField.get(4)?.[0];
    const trackerInformation =
        f3 && f3.wireType === WIRE_LENGTH_DELIMITED
            ? { canonicIds: decodeCanonicIds(asBuffer(f3.value)) }
            : f4 && f4.wireType === WIRE_LENGTH_DELIMITED
              ? decodeTrackerInformation(asBuffer(f4.value))
              : undefined;
    return {
        type: f2 && f2.wireType === WIRE_VARINT ? (asInt32(f2.value) as IdentifierInformationType) : IdentifierInformationType.IDENTIFIER_UNKNOWN,
        phoneInformation: f1 && f1.wireType === WIRE_LENGTH_DELIMITED ? decodePhoneInformation(asBuffer(f1.value)) : undefined,
        trackerInformation,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

function encodeIdentifierInformation(idInfo: ProtoIdentifierInformation): Buffer {
    const fields: RawField[] = [];
    if (idInfo.phoneInformation) fields.push(bytesField(1, encodePhoneInformation(idInfo.phoneInformation)));
    fields.push(varintField(2, idInfo.type));
    if (idInfo.trackerInformation && idInfo.trackerInformation.canonicIds.length > 0) {
        fields.push(bytesField(3, encodeCanonicIds(idInfo.trackerInformation.canonicIds)));
    }
    return appendUnknown(fields, idInfo._unknownFields);
}

function decodeImageInformation(buf: Buffer): ProtoImageInformation {
    const { byField, unknownFields } = splitKnown(buf, new Set([1, 3]));
    const f1 = byField.get(1)?.[0];
    const componentImages: string[] = [];
    for (const f3 of byField.get(3) ?? []) {
        if (f3.wireType === WIRE_LENGTH_DELIMITED) {
            const sub = decodeRawFields(asBuffer(f3.value));
            const u = sub.find(x => x.fieldNumber === 3 && x.wireType === WIRE_LENGTH_DELIMITED);
            if (u) {
                const s = asString(u.value).trim();
                if (s) componentImages.push(s);
            }
        }
    }
    return {
        imageUrl: f1 && f1.wireType === WIRE_LENGTH_DELIMITED ? asString(f1.value).trim() || undefined : undefined,
        componentImages: componentImages.length > 0 ? componentImages : undefined,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

function encodeImageInformation(img: ProtoImageInformation): Buffer {
    const fields: RawField[] = [];
    if (img.imageUrl !== undefined) fields.push(stringField(1, img.imageUrl));
    for (const u of img.componentImages ?? []) {
        fields.push(bytesField(3, encodeRawFields([stringField(3, u)])));
    }
    return appendUnknown(fields, img._unknownFields);
}

export function decodeDeviceMetadata(buf: Buffer): ProtoDeviceMetadata {
    const { byField, unknownFields } = splitKnown(buf, new Set([1, 3, 4, 5, 6, 8]));
    const f1 = byField.get(1)?.[0];
    const f3 = byField.get(3)?.[0];
    const f4 = byField.get(4)?.[0];
    const f5 = byField.get(5)?.[0];
    const f6 = byField.get(6)?.[0];
    const f8 = byField.get(8)?.[0];
    return {
        identifierInformation:
            f1 && f1.wireType === WIRE_LENGTH_DELIMITED ? decodeIdentifierInformation(asBuffer(f1.value)) : undefined,
        phoneInformation: f3 && f3.wireType === WIRE_LENGTH_DELIMITED ? decodePhoneInformation(asBuffer(f3.value)) : undefined,
        information: f4 && f4.wireType === WIRE_LENGTH_DELIMITED ? decodeDeviceInformation(asBuffer(f4.value)) : undefined,
        userDefinedDeviceName: f5 && f5.wireType === WIRE_LENGTH_DELIMITED ? asString(f5.value) : undefined,
        imageInformation: f6 && f6.wireType === WIRE_LENGTH_DELIMITED ? decodeImageInformation(asBuffer(f6.value)) : undefined,
        deviceCategory: f8 && f8.wireType === WIRE_VARINT ? asInt32(f8.value) : undefined,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

export function encodeDeviceMetadata(meta: ProtoDeviceMetadata): Buffer {
    const fields: RawField[] = [];
    if (meta.identifierInformation) fields.push(bytesField(1, encodeIdentifierInformation(meta.identifierInformation)));
    if (meta.phoneInformation) fields.push(bytesField(3, encodePhoneInformation(meta.phoneInformation)));
    if (meta.information) fields.push(bytesField(4, encodeDeviceInformation(meta.information)));
    if (meta.userDefinedDeviceName !== undefined) fields.push(stringField(5, meta.userDefinedDeviceName));
    if (meta.imageInformation) fields.push(bytesField(6, encodeImageInformation(meta.imageInformation)));
    if (meta.deviceCategory !== undefined) fields.push(varintField(8, meta.deviceCategory));
    return appendUnknown(fields, meta._unknownFields);
}

// ---- Nova Requests & Responses ----

export function encodeDevicesListRequest(params: {
    type: NovaDeviceType;
    devicesListRequestUuid: string;
}): Buffer {
    return encodeRawFields([
        bytesField(1, encodeRawFields([varintField(1, params.type), stringField(3, params.devicesListRequestUuid)]))
    ]);
}

export function decodeDevicesList(buf: Buffer): ProtoDevicesList {
    const { byField, unknownFields } = splitKnown(buf, new Set([2]));
    const list = byField.get(2) ?? [];
    const deviceMetadata: ProtoDeviceMetadata[] = [];
    for (const f of list) {
        if (f.wireType === WIRE_LENGTH_DELIMITED) {
            deviceMetadata.push(decodeDeviceMetadata(asBuffer(f.value)));
        }
    }
    return {
        deviceMetadata,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

export function encodeDevicesList(list: ProtoDevicesList): Buffer {
    const fields: RawField[] = [];
    for (const meta of list.deviceMetadata) {
        fields.push(bytesField(2, encodeDeviceMetadata(meta)));
    }
    return appendUnknown(fields, list._unknownFields);
}

export type ExecuteActionPayload =
    | {
          kind: "locateTracker";
          contributors?: ExecuteActionLocationType[];
          lastHighPrecisionLocation?: boolean;
      }
    | {
          kind: "startSound";
          component?: ExecuteActionDeviceComponent;
      }
    | {
          kind: "stopSound";
          component?: ExecuteActionDeviceComponent;
      };

function randomUuidV4(): string {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function encodeExecuteActionRequest(params: {
    deviceType: NovaDeviceType;
    canonicId: string;
    requestUuid: string;
    fmdClientUuid?: string;
    fcmRegistrationId?: string;
    action: ExecuteActionPayload;
}): Buffer {
    // Upstream Nova nbe_execute_action expects SPOT_DEVICE (2) on scope and requestMetadata even for Android phones/watches.
    const executeDeviceType =
        params.deviceType === NovaDeviceType.ANDROID_DEVICE ? NovaDeviceType.SPOT_DEVICE : params.deviceType;
    const canonicIdMsg = encodeRawFields([stringField(1, params.canonicId)]);
    const scope = encodeRawFields([
        varintField(2, executeDeviceType),
        bytesField(3, encodeRawFields([bytesField(1, canonicIdMsg)]))
    ]);

    const actionFields: RawField[] = [];
    if (params.action.kind === "locateTracker") {
        const lf: RawField[] = [];
        if (params.action.lastHighPrecisionLocation ?? true) {
            lf.push(bytesField(2, encodeTimeField(0)));
        }
        const contributors = params.action.contributors ?? [ExecuteActionLocationType.FMDN_ALL_LOCATIONS];
        for (const c of contributors) lf.push(varintField(3, c));
        actionFields.push(bytesField(30, encodeRawFields(lf)));
    } else if (params.action.kind === "startSound") {
        const sf: RawField[] = [];
        if (
            params.action.component !== undefined &&
            params.action.component !== ExecuteActionDeviceComponent.DEVICE_COMPONENT_UNSPECIFIED
        ) {
            sf.push(varintField(1, params.action.component));
        }
        actionFields.push(bytesField(31, encodeRawFields(sf)));
    } else if (params.action.kind === "stopSound") {
        const sf: RawField[] = [];
        if (
            params.action.component !== undefined &&
            params.action.component !== ExecuteActionDeviceComponent.DEVICE_COMPONENT_UNSPECIFIED
        ) {
            sf.push(varintField(1, params.action.component));
        }
        actionFields.push(bytesField(32, encodeRawFields(sf)));
    }

    const metaFields: RawField[] = [
        varintField(1, executeDeviceType),
        stringField(2, params.requestUuid),
        stringField(3, params.fmdClientUuid ?? randomUuidV4())
    ];
    if (params.fcmRegistrationId) {
        metaFields.push(bytesField(4, encodeRawFields([stringField(1, params.fcmRegistrationId)])));
    }
    metaFields.push(varintField(6, 1));

    return encodeRawFields([
        bytesField(1, scope),
        bytesField(2, encodeRawFields(actionFields)),
        bytesField(3, encodeRawFields(metaFields))
    ]);
}

function decodeRequestMetadata(buf: Buffer): ProtoExecuteActionRequestMetadata | undefined {
    try {
        const fields = decodeRawFields(buf);
        const f1 = fields.find(f => f.fieldNumber === 1 && f.wireType === WIRE_VARINT);
        const f2 = fields.find(f => f.fieldNumber === 2 && f.wireType === WIRE_LENGTH_DELIMITED);
        const f3 = fields.find(f => f.fieldNumber === 3 && f.wireType === WIRE_LENGTH_DELIMITED);
        const f4 = fields.find(f => f.fieldNumber === 4 && f.wireType === WIRE_LENGTH_DELIMITED);
        const f6 = fields.find(f => f.fieldNumber === 6 && f.wireType === WIRE_VARINT);
        if (!f1 && !f2 && !f4 && !f6) return undefined;
        let fcmRegistrationId: string | undefined;
        if (f4) {
            const gcmFields = decodeRawFields(asBuffer(f4.value));
            const gcmId = gcmFields.find(g => g.fieldNumber === 1 && g.wireType === WIRE_LENGTH_DELIMITED);
            if (gcmId) fcmRegistrationId = asString(gcmId.value);
        } else if (f3) {
            // Fallback for older tests passing raw fcmRegistrationId on field 3
            fcmRegistrationId = asString(f3.value);
        }
        return {
            type: f1 ? (asInt32(f1.value) as NovaDeviceType) : NovaDeviceType.UNKNOWN_DEVICE_TYPE,
            requestUuid: f2 ? asString(f2.value) : "",
            fcmRegistrationId,
            unknownFlag: f6 ? asBool(f6.value) : undefined
        };
    } catch {
        return undefined;
    }
}

export function decodeDeviceUpdate(buf: Buffer): ProtoDeviceUpdate {
    const raw = decodeRawFields(buf);
    let deviceMetadata: ProtoDeviceMetadata | undefined;
    let fcmMetadata: ProtoExecuteActionRequestMetadata | undefined;
    const unknownFields: RawField[] = [];

    for (const f of raw) {
        if (f.wireType !== WIRE_LENGTH_DELIMITED) {
            unknownFields.push(f);
            continue;
        }
        const sub = asBuffer(f.value);
        if (f.fieldNumber === 1 && !fcmMetadata) {
            const parsedMeta = decodeRequestMetadata(sub);
            if (parsedMeta) {
                fcmMetadata = parsedMeta;
                continue;
            }
        }
        if (f.fieldNumber === 2 && (!fcmMetadata || !fcmMetadata.requestUuid)) {
            const parsedMeta = decodeRequestMetadata(sub);
            if (parsedMeta && parsedMeta.requestUuid) {
                fcmMetadata = parsedMeta;
                continue;
            }
        }
        if (f.fieldNumber === 3 && !deviceMetadata) {
            deviceMetadata = decodeDeviceMetadata(sub);
            continue;
        }
        unknownFields.push(f);
    }

    if (!deviceMetadata) {
        const f2Idx = unknownFields.findIndex(f => f.fieldNumber === 2 && f.wireType === WIRE_LENGTH_DELIMITED);
        if (f2Idx >= 0) {
            deviceMetadata = decodeDeviceMetadata(asBuffer(unknownFields[f2Idx].value));
            unknownFields.splice(f2Idx, 1);
        }
    }

    return {
        deviceMetadata,
        fcmMetadata,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

export function encodeDeviceUpdate(update: ProtoDeviceUpdate): Buffer {
    const fields: RawField[] = [];
    if (update.fcmMetadata) {
        const mf: RawField[] = [
            varintField(1, update.fcmMetadata.type),
            stringField(2, update.fcmMetadata.requestUuid)
        ];
        if (update.fcmMetadata.fcmRegistrationId) {
            mf.push(bytesField(4, encodeRawFields([stringField(1, update.fcmMetadata.fcmRegistrationId)])));
        }
        if (update.fcmMetadata.unknownFlag !== undefined) mf.push(varintField(6, update.fcmMetadata.unknownFlag ? 1 : 0));
        fields.push(bytesField(1, encodeRawFields(mf)));
    }
    if (update.deviceMetadata) fields.push(bytesField(3, encodeDeviceMetadata(update.deviceMetadata)));
    return appendUnknown(fields, update._unknownFields);
}

// ---- Spot gRPC & Vault Unlock ----

export function encodeGetEidInfoForE2eeDevicesRequest(params?: {
    ownerKeyVersion?: number;
    hasOwnerKeyVersion?: boolean;
}): Buffer {
    const ownerKeyVersion = params?.ownerKeyVersion ?? -1;
    const hasOwnerKeyVersion = params?.hasOwnerKeyVersion ?? true;
    return encodeRawFields([
        varintField(1, ownerKeyVersion),
        varintField(2, hasOwnerKeyVersion ? 1 : 0)
    ]);
}

export interface EncryptedOwnerKeyEntry {
    encryptedOwnerKey: Buffer;
    ownerKeyVersion: number;
    securityDomain: string;
}

export interface GetEidInfoResponse {
    ownerKeys: EncryptedOwnerKeyEntry[];
    _unknownFields?: RawField[];
}

export function decodeGetEidInfoForE2eeDevicesResponse(buf: Buffer): GetEidInfoResponse {
    const { byField, unknownFields } = splitKnown(buf, new Set([4]));
    const ownerKeys: EncryptedOwnerKeyEntry[] = [];
    for (const f of byField.get(4) ?? []) {
        if (f.wireType !== WIRE_LENGTH_DELIMITED) continue;
        const inner = decodeRawFields(asBuffer(f.value));
        const f1 = inner.find(x => x.fieldNumber === 1 && x.wireType === WIRE_LENGTH_DELIMITED);
        const f2 = inner.find(x => x.fieldNumber === 2 && x.wireType === WIRE_VARINT);
        const f3 = inner.find(x => x.fieldNumber === 3 && x.wireType === WIRE_LENGTH_DELIMITED);
        if (f1) {
            ownerKeys.push({
                encryptedOwnerKey: asBuffer(f1.value),
                ownerKeyVersion: f2 ? asUint32(f2.value) : 0,
                securityDomain: f3 ? asString(f3.value) : ""
            });
        }
    }
    return {
        ownerKeys,
        _unknownFields: unknownFields.length > 0 ? unknownFields : undefined
    };
}

export function encodeGetEidInfoForE2eeDevicesResponse(res: GetEidInfoResponse): Buffer {
    const fields: RawField[] = [];
    for (const entry of res.ownerKeys) {
        fields.push(
            bytesField(
                4,
                encodeRawFields([
                    bytesField(1, entry.encryptedOwnerKey),
                    varintField(2, entry.ownerKeyVersion),
                    stringField(3, entry.securityDomain)
                ])
            )
        );
    }
    return appendUnknown(fields, res._unknownFields);
}

export function encodeEncryptionUnlockRequestExtras(
    securityDomain = "finder_hw",
    sessionId = randomUuidV4()
): Buffer {
    return encodeRawFields([
        varintField(1, 1), // operation = 1
        bytesField(2, encodeRawFields([stringField(1, securityDomain), varintField(2, 0)])),
        stringField(6, sessionId)
    ]);
}

// ---- Android Checkin ----

export interface AndroidCheckinCredentials {
    androidId: bigint;
    securityToken: bigint;
}

export function encodeAndroidCheckinRequest(existing?: Partial<AndroidCheckinCredentials>): Buffer {
    const chromeBuild = encodeRawFields([
        varintField(1, 3), // PLATFORM_LINUX
        stringField(2, "120.0.6099.109"),
        varintField(3, 1) // CHANNEL_STABLE
    ]);
    const checkinProto = encodeRawFields([
        varintField(2, 0),
        varintField(9, 0),
        varintField(12, 3), // DEVICE_CHROME_BROWSER
        bytesField(13, chromeBuild)
    ]);
    const fields: RawField[] = [
        varintField(2, existing?.androidId ?? BigInt(0)),
        stringField(3, ""),
        bytesField(4, checkinProto),
        stringField(6, "en-US"),
        varintField(7, BigInt(0)),
        stringField(12, "America/Los_Angeles"),
        fixed64UintField(13, existing?.securityToken ?? BigInt(0)),
        varintField(14, 3),
        stringField(15, "71Q6Rn2DDZl1zPDVaaeEHItd+Yg="),
        varintField(20, 0),
        varintField(22, 0)
    ];
    return encodeRawFields(fields);
}

export function decodeAndroidCheckinResponse(buf: Buffer): AndroidCheckinCredentials {
    const raw = decodeRawFields(buf);
    const f7 = raw.find(f => f.fieldNumber === 7 && f.wireType === WIRE_FIXED64);
    const f8 = raw.find(f => f.fieldNumber === 8 && f.wireType === WIRE_FIXED64);
    if (!f7 || !f8) {
        throw new Error("AndroidCheckinResponse missing androidId or securityToken");
    }
    return {
        androidId: asBuffer(f7.value).readBigUInt64LE(0),
        securityToken: asBuffer(f8.value).readBigUInt64LE(0)
    };
}

// ---- FCM MCS Wire Frames ----

export const MCS_VERSION = 41;
export const MCS_TAG_HEARTBEAT_PING = 0;
export const MCS_TAG_HEARTBEAT_ACK = 1;
export const MCS_TAG_LOGIN_REQUEST = 2;
export const MCS_TAG_LOGIN_RESPONSE = 3;
export const MCS_TAG_CLOSE = 4;
export const MCS_TAG_IQ_STANZA = 7;
export const MCS_TAG_DATA_MESSAGE_STANZA = 8;
export const MCS_TAG_STREAM_ERROR_STANZA = 12;

export function encodeMcsFrame(tag: number, payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from([tag & 0xff]), encodeVarint(payload.length), payload]);
}

export function encodeMcsHeartbeatPing(streamId?: number, lastStreamIdReceived?: number): Buffer {
    const fields: RawField[] = [];
    if (streamId !== undefined) fields.push(varintField(1, streamId));
    if (lastStreamIdReceived !== undefined) fields.push(varintField(2, lastStreamIdReceived));
    return encodeMcsFrame(MCS_TAG_HEARTBEAT_PING, encodeRawFields(fields));
}

export function encodeMcsHeartbeatAck(streamId?: number, lastStreamIdReceived?: number): Buffer {
    const fields: RawField[] = [];
    if (streamId !== undefined) fields.push(varintField(1, streamId));
    if (lastStreamIdReceived !== undefined) fields.push(varintField(2, lastStreamIdReceived));
    return encodeMcsFrame(MCS_TAG_HEARTBEAT_ACK, encodeRawFields(fields));
}

export function encodeMcsSelectiveAck(persistentIds: string[]): Buffer {
    const selectiveAck = encodeRawFields(persistentIds.map(id => stringField(1, id)));
    const ext = encodeRawFields([varintField(1, 12), bytesField(2, selectiveAck)]);
    const iq = encodeRawFields([
        varintField(2, 1), // IqType.SET
        stringField(3, ""),
        bytesField(7, ext)
    ]);
    return encodeMcsFrame(MCS_TAG_IQ_STANZA, iq);
}

export function encodeMcsLoginRequest(params: {
    androidId: bigint;
    securityToken: bigint;
    receivedPersistentIds?: string[];
}): Buffer {
    const androidIdStr = params.androidId.toString();
    const securityTokenStr = params.securityToken.toString();
    const fields: RawField[] = [
        stringField(1, "chrome-120.0.6099.109"),
        stringField(2, "mcs.android.com"),
        stringField(3, androidIdStr),
        stringField(4, androidIdStr),
        stringField(5, securityTokenStr),
        stringField(6, `android-${params.androidId.toString(16)}`),
        bytesField(8, encodeRawFields([stringField(1, "new_vc"), stringField(2, "1")]))
    ];
    for (const pid of params.receivedPersistentIds ?? []) {
        fields.push(stringField(10, pid));
    }
    fields.push(varintField(12, 0), varintField(14, 1), varintField(16, 2), varintField(17, 1));
    return encodeMcsFrame(MCS_TAG_LOGIN_REQUEST, encodeRawFields(fields));
}

export interface McsDataMessageStanza {
    id?: string;
    from?: string;
    to?: string;
    category?: string;
    token?: string;
    appData: Record<string, string>;
    persistentId?: string;
    streamId?: number;
    lastStreamIdReceived?: number;
    sent?: number;
    rawData?: Buffer;
}

export function decodeMcsDataMessageStanza(buf: Buffer): McsDataMessageStanza {
    const raw = decodeRawFields(buf);
    const appData: Record<string, string> = {};
    const stanza: McsDataMessageStanza = { appData };

    for (const f of raw) {
        if (f.fieldNumber === 2 && f.wireType === WIRE_LENGTH_DELIMITED) stanza.id = asString(f.value);
        else if (f.fieldNumber === 3 && f.wireType === WIRE_LENGTH_DELIMITED) stanza.from = asString(f.value);
        else if (f.fieldNumber === 4 && f.wireType === WIRE_LENGTH_DELIMITED) stanza.to = asString(f.value);
        else if (f.fieldNumber === 5 && f.wireType === WIRE_LENGTH_DELIMITED) stanza.category = asString(f.value);
        else if (f.fieldNumber === 6 && f.wireType === WIRE_LENGTH_DELIMITED) stanza.token = asString(f.value);
        else if (f.fieldNumber === 7 && f.wireType === WIRE_LENGTH_DELIMITED) {
            const kv = decodeRawFields(asBuffer(f.value));
            const k = kv.find(x => x.fieldNumber === 1 && x.wireType === WIRE_LENGTH_DELIMITED);
            const v = kv.find(x => x.fieldNumber === 2 && x.wireType === WIRE_LENGTH_DELIMITED);
            if (k && v) {
                appData[asString(k.value)] = asString(v.value);
            }
        } else if (f.fieldNumber === 9 && f.wireType === WIRE_LENGTH_DELIMITED) stanza.persistentId = asString(f.value);
        else if (f.fieldNumber === 10 && f.wireType === WIRE_VARINT) stanza.streamId = asInt32(f.value);
        else if (f.fieldNumber === 11 && f.wireType === WIRE_VARINT) stanza.lastStreamIdReceived = asInt32(f.value);
        else if (f.fieldNumber === 16 && f.wireType === WIRE_VARINT) stanza.sent = Number(BigInt.asIntN(64, f.value as bigint));
        else if (f.fieldNumber === 21 && f.wireType === WIRE_LENGTH_DELIMITED) stanza.rawData = asBuffer(f.value);
    }

    return stanza;
}

export function encodeMcsDataMessageStanza(stanza: McsDataMessageStanza): Buffer {
    const fields: RawField[] = [];
    if (stanza.id !== undefined) fields.push(stringField(2, stanza.id));
    if (stanza.from !== undefined) fields.push(stringField(3, stanza.from));
    if (stanza.to !== undefined) fields.push(stringField(4, stanza.to));
    if (stanza.category !== undefined) fields.push(stringField(5, stanza.category));
    if (stanza.token !== undefined) fields.push(stringField(6, stanza.token));
    for (const [k, v] of Object.entries(stanza.appData)) {
        fields.push(bytesField(7, encodeRawFields([stringField(1, k), stringField(2, v)])));
    }
    if (stanza.persistentId !== undefined) fields.push(stringField(9, stanza.persistentId));
    if (stanza.streamId !== undefined) fields.push(varintField(10, stanza.streamId));
    if (stanza.lastStreamIdReceived !== undefined) fields.push(varintField(11, stanza.lastStreamIdReceived));
    if (stanza.sent !== undefined) fields.push(varintField(16, stanza.sent));
    if (stanza.rawData !== undefined) fields.push(bytesField(21, stanza.rawData));
    return encodeMcsFrame(MCS_TAG_DATA_MESSAGE_STANZA, encodeRawFields(fields));
}

export interface McsLoginResponse {
    id?: string;
    jid?: string;
    errorCode?: number;
    errorMessage?: string;
}

export function decodeMcsLoginResponse(buf: Buffer): McsLoginResponse {
    const raw = decodeRawFields(buf);
    const out: McsLoginResponse = {};
    for (const f of raw) {
        if (f.fieldNumber === 1 && f.wireType === WIRE_LENGTH_DELIMITED) out.id = asString(f.value);
        else if (f.fieldNumber === 2 && f.wireType === WIRE_LENGTH_DELIMITED) out.jid = asString(f.value);
        else if (f.fieldNumber === 3 && f.wireType === WIRE_LENGTH_DELIMITED) {
            const ef = decodeRawFields(asBuffer(f.value));
            const code = ef.find(x => x.fieldNumber === 1 && x.wireType === WIRE_VARINT);
            const msg = ef.find(x => x.fieldNumber === 2 && x.wireType === WIRE_LENGTH_DELIMITED);
            if (code) out.errorCode = asInt32(code.value);
            if (msg) out.errorMessage = asString(msg.value);
        }
    }
    return out;
}

export interface McsParsedFrame {
    tag: number;
    payload: Buffer;
}

export class McsFrameReader {
    private buffer = Buffer.alloc(0);
    private expectedVersion = true;

    constructor(expectVersionByte = true) {
        this.expectedVersion = expectVersionByte;
    }

    push(chunk: Buffer): McsParsedFrame[] {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        const frames: McsParsedFrame[] = [];

        if (this.expectedVersion) {
            if (this.buffer.length < 1) return frames;
            this.expectedVersion = false;
            this.buffer = this.buffer.subarray(1);
        }

        while (this.buffer.length >= 2) {
            const tag = this.buffer[0];
            let pos = 1;
            let len = 0;
            let shift = 0;
            let haveLen = false;
            while (pos < this.buffer.length) {
                const b = this.buffer[pos++];
                len |= (b & 0x7f) << shift;
                if ((b & 0x80) === 0) {
                    haveLen = true;
                    break;
                }
                shift += 7;
                if (shift > 28) throw new Error("MCS frame length overflow");
            }
            if (!haveLen || pos + len > this.buffer.length) break;

            const payload = Buffer.from(this.buffer.subarray(pos, pos + len));
            this.buffer = this.buffer.subarray(pos + len);
            frames.push({ tag, payload });
        }

        return frames;
    }
}
