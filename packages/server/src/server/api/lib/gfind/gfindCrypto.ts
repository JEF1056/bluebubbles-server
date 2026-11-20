// Pure Node crypto + BigInt implementation of Google Find Hub (FMDN & SECUREBOX v2) cryptography.
import crypto from "crypto";
import {
    ExecuteActionDeviceComponent,
    ProtoLocation,
    decodeLocation
} from "./gfindProto";

// ---- RFC 5869 HKDF-SHA256 ----

export function hkdfSha256(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
    const actualSalt = salt.length > 0 ? salt : Buffer.alloc(32, 0);
    const prk = crypto.createHmac("sha256", actualSalt).update(ikm).digest();
    const blocks: Buffer[] = [];
    let prev = Buffer.alloc(0);
    let counter = 1;
    let total = 0;
    while (total < length) {
        prev = crypto
            .createHmac("sha256", prk)
            .update(Buffer.concat([prev, info, Buffer.from([counter++])]))
            .digest();
        blocks.push(prev);
        total += prev.length;
    }
    return Buffer.concat(blocks).subarray(0, length);
}

// ---- SECUREBOX v2 owner_key unwrap ----

const SECUREBOX_VERSION = Buffer.from([0x02, 0x00]);
const SECUREBOX_SALT = Buffer.from("SECUREBOX\x02\x00", "latin1");
const SECUREBOX_INFO = Buffer.from("SHARED HKDF-SHA-256 AES-128-GCM", "ascii");

export function extractFinderHwDomainKey(vaultKeysInput: unknown): Buffer {
    let parsed: any = vaultKeysInput;
    if (typeof vaultKeysInput === "string") {
        parsed = JSON.parse(vaultKeysInput);
    }
    if (parsed && typeof parsed === "object" && "vaultKeys" in parsed && parsed.vaultKeys != null) {
        parsed = typeof parsed.vaultKeys === "string" ? JSON.parse(parsed.vaultKeys) : parsed.vaultKeys;
    }

    let entry: any = null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const domainVal = parsed.finder_hw ?? parsed.finderHw;
        if (Array.isArray(domainVal) && domainVal.length > 0) {
            entry =
                typeof domainVal[0] === "number"
                    ? domainVal
                    : [...domainVal].sort((a, b) => Number(b?.epoch ?? 0) - Number(a?.epoch ?? 0))[0];
        } else if (domainVal && typeof domainVal === "object") {
            entry = domainVal;
        }
    } else if (Array.isArray(parsed)) {
        const matches = parsed.filter(item => item?.securityDomain === "finder_hw" || item?.domain === "finder_hw");
        if (matches.length > 0) {
            entry = [...matches].sort((a, b) => Number(b?.epoch ?? 0) - Number(a?.epoch ?? 0))[0];
        }
    }

    const rawKey = entry?.key ?? entry?.keyMaterial ?? entry;
    if (typeof rawKey === "string") {
        const buf = Buffer.from(rawKey, "base64");
        if (buf.length > 0) return buf;
    }
    if (Array.isArray(rawKey) || rawKey instanceof Uint8Array || Buffer.isBuffer(rawKey)) {
        const buf = Buffer.from(rawKey);
        if (buf.length > 0) return buf;
    }
    if (rawKey && typeof rawKey === "object") {
        const numericKeys = Object.keys(rawKey)
            .filter(k => /^\d+$/.test(k))
            .sort((a, b) => Number(a) - Number(b));
        if (numericKeys.length > 0) {
            return Buffer.from(numericKeys.map(k => Number((rawKey as Record<string, unknown>)[k]) & 0xff));
        }
    }
    throw new Error("Vault keys missing finder_hw domain key");
}

export function decryptOwnerKey(sharedKey: Buffer, encryptedOwnerKey: Buffer): Buffer {
    if (encryptedOwnerKey.length < 12 + 16) {
        throw new Error("Encrypted owner_key too short");
    }
    const nonce = encryptedOwnerKey.subarray(0, 12);
    const body = encryptedOwnerKey.subarray(12);
    const ciphertext = body.subarray(0, body.length - 16);
    const tag = body.subarray(body.length - 16);

    const decipher = crypto.createDecipheriv("aes-256-gcm", sharedKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptOwnerKey(sharedKey: Buffer, ownerKey: Buffer, nonce?: Buffer): Buffer {
    const iv = nonce ?? crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", sharedKey, iv);
    const ct = Buffer.concat([cipher.update(ownerKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ct, tag]);
}

export function decryptSecureBoxV2(domainKey: Buffer, encryptedOwnerKey: Buffer, header: Buffer = Buffer.alloc(0)): Buffer {
    if (encryptedOwnerKey.length < 2 + 12 + 16) {
        throw new Error("SECUREBOX v2 ciphertext too short");
    }
    if (!encryptedOwnerKey.subarray(0, 2).equals(SECUREBOX_VERSION)) {
        throw new Error("Unsupported SECUREBOX version (expected v2)");
    }

    const nonce = encryptedOwnerKey.subarray(2, 14);
    const body = encryptedOwnerKey.subarray(14);
    const ciphertext = body.subarray(0, body.length - 16);
    const tag = body.subarray(body.length - 16);

    const aesKey = hkdfSha256(domainKey, SECUREBOX_SALT, SECUREBOX_INFO, 16);
    const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, nonce);
    if (header.length > 0) {
        decipher.setAAD(header);
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptSecureBoxV2(domainKey: Buffer, plaintext: Buffer, nonce?: Buffer, header: Buffer = Buffer.alloc(0)): Buffer {
    const iv = nonce ?? crypto.randomBytes(12);
    const aesKey = hkdfSha256(domainKey, SECUREBOX_SALT, SECUREBOX_INFO, 16);
    const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, iv);
    if (header.length > 0) {
        cipher.setAAD(header);
    }
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([SECUREBOX_VERSION, iv, ct, tag]);
}

// ---- Per-device EIK unwrap & key derivation ----

export interface UnwrapEikResult {
    eik: Buffer | null;
    ownerKeyVersionMismatch: boolean;
}

export function unwrapDeviceEik(params: {
    ownerKey: Buffer;
    encryptedIdentityKey: Buffer;
    fastPairModelId?: string | null;
    canonicId?: string | null;
    deviceOwnerKeyVersion?: number;
    expectedOwnerKeyVersion?: number | null;
    extraAads?: Buffer[];
}): UnwrapEikResult {
    if (
        params.expectedOwnerKeyVersion != null &&
        params.deviceOwnerKeyVersion != null &&
        params.deviceOwnerKeyVersion !== params.expectedOwnerKeyVersion
    ) {
        return { eik: null, ownerKeyVersionMismatch: true };
    }

    const rawBytes =
        params.fastPairModelId?.trim() === "003200"
            ? Buffer.from(params.encryptedIdentityKey.map(b => b ^ 0xff))
            : params.encryptedIdentityKey;

    if (rawBytes.length === 48) {
        const iv = rawBytes.subarray(0, 16);
        const ciphertext = rawBytes.subarray(16, 48);
        const decipher = crypto.createDecipheriv("aes-256-cbc", params.ownerKey, iv);
        decipher.setAutoPadding(false);
        const eik = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return { eik, ownerKeyVersionMismatch: false };
    }

    if (rawBytes.length === 60) {
        const nonce = rawBytes.subarray(0, 12);
        const ciphertext = rawBytes.subarray(12, 44);
        const tag = rawBytes.subarray(44, 60);
        const aadCandidates: Array<Buffer | undefined> = [undefined];
        if (params.canonicId?.trim()) {
            const rawId = params.canonicId.trim();
            const strippedId = rawId.replace(/^\$+/, "");
            for (const candidate of [rawId, rawId.toLowerCase(), strippedId, strippedId.toLowerCase()]) {
                if (candidate) aadCandidates.push(Buffer.from(candidate, "utf8"));
            }
        }
        for (const extra of params.extraAads ?? []) {
            if (extra.length > 0) aadCandidates.push(extra);
        }
        for (const aad of aadCandidates) {
            try {
                const decipher = crypto.createDecipheriv("aes-256-gcm", params.ownerKey, nonce);
                if (aad) decipher.setAAD(aad);
                decipher.setAuthTag(tag);
                const eik = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
                return { eik, ownerKeyVersionMismatch: false };
            } catch {
                // Try next AAD candidate before reporting version mismatch.
            }
        }
        // GCM auth failure when owner key rotated without version metadata still signals mismatch cleanly.
        return { eik: null, ownerKeyVersionMismatch: true };
    }

    throw new Error(`Unsupported encrypted identity key length: ${rawBytes.length} (expected 48 or 60)`);
}

export function deriveRingKey(eik: Buffer, explicitRingKey?: Buffer): Buffer {
    if (explicitRingKey && explicitRingKey.length >= 8) {
        return explicitRingKey.subarray(0, 8);
    }
    return crypto
        .createHash("sha256")
        .update(Buffer.concat([eik, Buffer.from([0x02])]))
        .digest()
        .subarray(0, 8);
}

// ---- BigInt Elliptic Curve Arithmetic (secp160r1 & secp256r1) ----

export interface CurveParams {
    name: "secp160r1" | "secp256r1";
    byteLen: number;
    p: bigint;
    a: bigint;
    b: bigint;
    n: bigint;
    Gx: bigint;
    Gy: bigint;
}

export const SECP160R1: CurveParams = {
    name: "secp160r1",
    byteLen: 20,
    p: BigInt("0xffffffffffffffffffffffffffffffff7fffffff"),
    a: BigInt("0xffffffffffffffffffffffffffffffff7ffffffc"),
    b: BigInt("0x1c97befc54bd7a8b65acf89f81d4d4adc565fa45"),
    n: BigInt("0x0100000000000000000001f4c8f927aed3ca752257"),
    Gx: BigInt("0x4a96b5688ef573284664698968c38bb913cbfc82"),
    Gy: BigInt("0x23a628553168947d59dcc912042351377ac5fb32")
};

export const SECP256R1: CurveParams = {
    name: "secp256r1",
    byteLen: 32,
    p: BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff"),
    a: BigInt("0xffffffff00000001000000000000000000000000fffffffffffffffffffffffc"),
    b: BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b"),
    n: BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"),
    Gx: BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
    Gy: BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5")
};

type JacobianPoint = [bigint, bigint, bigint]; // [X, Y, Z]; Z == BigInt(0) is infinity

const mod = (x: bigint, p: bigint): bigint => {
    const r = x % p;
    return r >= BigInt(0) ? r : r + p;
};

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
    let result = BigInt(1);
    let b = mod(base, m);
    let e = exp;
    while (e > BigInt(0)) {
        if ((e & BigInt(1)) === BigInt(1)) result = (result * b) % m;
        b = (b * b) % m;
        e >>= BigInt(1);
    }
    return result;
}

function modInv(a: bigint, m: bigint): bigint {
    let t = BigInt(0);
    let newT = BigInt(1);
    let r = m;
    let newR = mod(a, m);
    while (newR !== BigInt(0)) {
        const q = r / newR;
        [t, newT] = [newT, t - q * newT];
        [r, newR] = [newR, r - q * newR];
    }
    if (r > BigInt(1)) throw new Error("Scalar not invertible mod p");
    return t < BigInt(0) ? t + m : t;
}

function jacDouble(pt: JacobianPoint, p: bigint): JacobianPoint {
    const [X1, Y1, Z1] = pt;
    if (Z1 === BigInt(0) || Y1 === BigInt(0)) return [BigInt(0), BigInt(1), BigInt(0)];

    // Faster doubling exploiting a = -3 mod p (valid for both secp160r1 and secp256r1)
    const Z1sq = (Z1 * Z1) % p;
    const delta = Z1sq;
    const gamma = (Y1 * Y1) % p;
    const beta = (X1 * gamma) % p;
    const alpha = mod(BigInt(3) * mod(X1 - delta, p) * mod(X1 + delta, p), p);

    const X3 = mod(alpha * alpha - BigInt(8) * beta, p);
    const Z3 = mod((Y1 + Z1) * (Y1 + Z1) - gamma - delta, p);
    const Y3 = mod(alpha * mod(BigInt(4) * beta - X3, p) - BigInt(8) * gamma * gamma, p);
    return [X3, Y3, Z3];
}

function jacAdd(pt1: JacobianPoint, pt2: JacobianPoint, p: bigint): JacobianPoint {
    const [X1, Y1, Z1] = pt1;
    const [X2, Y2, Z2] = pt2;
    if (Z1 === BigInt(0)) return pt2;
    if (Z2 === BigInt(0)) return pt1;

    const Z1sq = (Z1 * Z1) % p;
    const Z2sq = (Z2 * Z2) % p;
    const U1 = (X1 * Z2sq) % p;
    const U2 = (X2 * Z1sq) % p;
    const S1 = (Y1 * Z2 * Z2sq) % p;
    const S2 = (Y2 * Z1 * Z1sq) % p;

    if (U1 === U2) {
        if (S1 !== S2) return [BigInt(0), BigInt(1), BigInt(0)];
        return jacDouble(pt1, p);
    }

    const H = mod(U2 - U1, p);
    const R = mod(S2 - S1, p);
    const H2 = (H * H) % p;
    const H3 = (H * H2) % p;
    const U1H2 = (U1 * H2) % p;

    const X3 = mod(R * R - H3 - BigInt(2) * U1H2, p);
    const Y3 = mod(R * mod(U1H2 - X3, p) - S1 * H3, p);
    const Z3 = (H * Z1 * Z2) % p;
    return [X3, Y3, Z3];
}

export function scalarMultiplyX(curve: CurveParams, scalar: bigint, px: bigint, py: bigint): bigint {
    const k = mod(scalar, curve.n);
    if (k === BigInt(0)) throw new Error("EC scalar cannot be zero");
    let acc: JacobianPoint = [BigInt(0), BigInt(1), BigInt(0)];
    let addend: JacobianPoint = [mod(px, curve.p), mod(py, curve.p), BigInt(1)];
    let e = k;
    while (e > BigInt(0)) {
        if ((e & BigInt(1)) === BigInt(1)) {
            acc = jacAdd(acc, addend, curve.p);
        }
        addend = jacDouble(addend, curve.p);
        e >>= BigInt(1);
    }
    if (acc[2] === BigInt(0)) throw new Error("EC point at infinity");
    const zInv = modInv(acc[2], curve.p);
    const zInv2 = (zInv * zInv) % curve.p;
    return (acc[0] * zInv2) % curve.p;
}

export function recoverEvenY(curve: CurveParams, x: bigint): bigint {
    const xMod = mod(x, curve.p);
    const rhs = mod(modPow(xMod, BigInt(3), curve.p) + curve.a * xMod + curve.b, curve.p);
    // Both secp160r1 and secp256r1 primes satisfy p % 4 == 3
    const y = modPow(rhs, (curve.p + BigInt(1)) >> BigInt(2), curve.p);
    if ((y * y) % curve.p !== rhs) {
        throw new Error(`Invalid x-coordinate on ${curve.name}`);
    }
    return (y & BigInt(1)) === BigInt(0) ? y : curve.p - y;
}

export function bigIntToFixedBuffer(value: bigint, byteLen: number): Buffer {
    const hex = value.toString(16).padStart(byteLen * 2, "0");
    if (hex.length > byteLen * 2) {
        return Buffer.from(hex.slice(hex.length - byteLen * 2), "hex");
    }
    return Buffer.from(hex, "hex");
}

// ---- Rolling EID Generator ----

export function buildFmdnPrfBlock(timestampSec: number, rotationExponent = 10): Buffer {
    const period = 1 << rotationExponent;
    const tMasked = (Math.floor(timestampSec / period) * period) >>> 0;

    const block = Buffer.alloc(32, 0);
    block.fill(0xff, 0, 11);
    block[11] = rotationExponent & 0xff;
    block.writeUInt32BE(tMasked, 12);
    // bytes 16..26 are already 0x00
    block[27] = rotationExponent & 0xff;
    block.writeUInt32BE(tMasked, 28);
    return block;
}

export function deriveFmdnScalar(eik: Buffer, timestampSec: number, rotationExponent: number, curve: CurveParams): bigint {
    if (eik.length !== 32) {
        throw new Error(`Expected 32-byte EIK, got ${eik.length}`);
    }
    const block = buildFmdnPrfBlock(timestampSec, rotationExponent);
    const cipher = crypto.createCipheriv("aes-256-ecb", eik, null);
    cipher.setAutoPadding(false);
    const rPrime = Buffer.concat([cipher.update(block), cipher.final()]);
    const r = BigInt("0x" + rPrime.toString("hex")) % curve.n;
    return r === BigInt(0) ? BigInt(1) : r;
}

export function generateEid(
    eik: Buffer,
    timestampSec: number,
    rotationExponent = 10,
    curveName: "secp160r1" | "secp256r1" = "secp160r1"
): Buffer {
    const curve = curveName === "secp256r1" ? SECP256R1 : SECP160R1;
    const r = deriveFmdnScalar(eik, timestampSec, rotationExponent, curve);

    if (curve.name === "secp256r1") {
        const ecdh = crypto.createECDH("prime256v1");
        ecdh.setPrivateKey(bigIntToFixedBuffer(r, 32));
        const pub = ecdh.getPublicKey() as Buffer;
        return Buffer.from(pub.subarray(1, 33));
    }

    const rx = scalarMultiplyX(curve, r, curve.Gx, curve.Gy);
    return bigIntToFixedBuffer(rx, 20);
}

export function generateRollingEids(params: {
    eik: Buffer;
    nowSec?: number;
    rotationExponent?: number;
    curve?: "secp160r1" | "secp256r1";
}): { eidsHex: string[]; expiresAt: number; periodSec: number } {
    const rotationExponent = params.rotationExponent ?? 10;
    const periodSec = 1 << rotationExponent;
    const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);
    const baseWindow = Math.floor(nowSec / periodSec) * periodSec;
    const curve = params.curve ?? "secp160r1";

    const seen = new Set<string>();
    const eidsHex: string[] = [];
    for (let offset = -2; offset <= 4; offset += 1) {
        const ts = Math.max(0, baseWindow + offset * periodSec);
        const hex = generateEid(params.eik, ts, rotationExponent, curve).toString("hex");
        if (!seen.has(hex)) {
            seen.add(hex);
            eidsHex.push(hex);
        }
    }
    return {
        eidsHex,
        expiresAt: (baseWindow + 3 * periodSec) * 1000,
        periodSec
    };
}

// ---- AES-256-EAX (OMAC1 + AES-256-CTR) ----

function aes256EcbBlock(key: Buffer, block16: Buffer): Buffer {
    const cipher = crypto.createCipheriv("aes-256-ecb", key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(block16), cipher.final()]);
}

function gf128Double(block16: Buffer): Buffer {
    const out = Buffer.alloc(16);
    let carry = 0;
    for (let i = 15; i >= 0; i -= 1) {
        const b = block16[i];
        out[i] = ((b << 1) | carry) & 0xff;
        carry = (b & 0x80) !== 0 ? 1 : 0;
    }
    if ((block16[0] & 0x80) !== 0) {
        out[15] ^= 0x87;
    }
    return out;
}

function omac1(key: Buffer, k1: Buffer, k2: Buffer, domainTag: number, data: Buffer): Buffer {
    const prefix = Buffer.alloc(16, 0);
    prefix[15] = domainTag & 0xff;
    const msg = data.length > 0 ? Buffer.concat([prefix, data]) : prefix;

    const fullBlocks = Math.floor((msg.length - 1) / 16);
    let state = Buffer.alloc(16, 0);
    for (let i = 0; i < fullBlocks; i += 1) {
        const block = msg.subarray(i * 16, (i + 1) * 16);
        for (let j = 0; j < 16; j += 1) state[j] ^= block[j];
        state = aes256EcbBlock(key, state);
    }

    const rem = msg.subarray(fullBlocks * 16);
    const last = Buffer.alloc(16, 0);
    if (rem.length === 16) {
        for (let j = 0; j < 16; j += 1) last[j] = rem[j] ^ k1[j];
    } else {
        rem.copy(last, 0);
        last[rem.length] = 0x80;
        for (let j = 0; j < 16; j += 1) last[j] ^= k2[j];
    }
    for (let j = 0; j < 16; j += 1) state[j] ^= last[j];
    return aes256EcbBlock(key, state);
}

function xor16(a: Buffer, b: Buffer, c: Buffer): Buffer {
    const out = Buffer.allocUnsafe(16);
    for (let i = 0; i < 16; i += 1) out[i] = a[i] ^ b[i] ^ c[i];
    return out;
}

export function aes256EaxEncrypt(
    key: Buffer,
    nonce: Buffer,
    plaintext: Buffer,
    header: Buffer = Buffer.alloc(0)
): { ciphertext: Buffer; tag: Buffer } {
    const l = aes256EcbBlock(key, Buffer.alloc(16, 0));
    const k1 = gf128Double(l);
    const k2 = gf128Double(k1);

    const nMac = omac1(key, k1, k2, 0, nonce);
    const hMac = omac1(key, k1, k2, 1, header);

    const ctr = crypto.createCipheriv("aes-256-ctr", key, nMac);
    const ciphertext = Buffer.concat([ctr.update(plaintext), ctr.final()]);
    const cMac = omac1(key, k1, k2, 2, ciphertext);
    const tag = xor16(nMac, hMac, cMac);
    return { ciphertext, tag };
}

export function aes256EaxDecrypt(
    key: Buffer,
    nonce: Buffer,
    ciphertext: Buffer,
    tag: Buffer,
    header: Buffer = Buffer.alloc(0)
): Buffer {
    if (tag.length !== 16) {
        throw new Error(`Invalid AES-EAX tag length: ${tag.length}`);
    }
    const l = aes256EcbBlock(key, Buffer.alloc(16, 0));
    const k1 = gf128Double(l);
    const k2 = gf128Double(k1);

    const nMac = omac1(key, k1, k2, 0, nonce);
    const hMac = omac1(key, k1, k2, 1, header);
    const cMac = omac1(key, k1, k2, 2, ciphertext);
    const expectedTag = xor16(nMac, hMac, cMac);

    if (!crypto.timingSafeEqual(expectedTag, tag)) {
        throw new Error("AES-256-EAX authentication tag mismatch");
    }

    const ctr = crypto.createDecipheriv("aes-256-ctr", key, nMac);
    return Buffer.concat([ctr.update(ciphertext), ctr.final()]);
}

// ---- Location Report Decryption ----

export function decryptOwnLocationReport(eik: Buffer, encryptedLocation: Buffer, canonicId?: string | null): ProtoLocation {
    if (encryptedLocation.length < 12 + 16) {
        throw new Error("Own encrypted location payload too short");
    }
    const nonce = encryptedLocation.subarray(0, 12);
    const body = encryptedLocation.subarray(12);
    const ciphertext = body.subarray(0, body.length - 16);
    const tag = body.subarray(body.length - 16);
    const candidateKeys: Buffer[] = [
        crypto.createHash("sha256").update(eik).digest(),
        ...[0x00, 0x01, 0x02, 0x03, 0x04, 0x05].map(b =>
            crypto.createHash("sha256").update(Buffer.concat([eik, Buffer.from([b])])).digest()
        ),
        ...(eik.length === 32 ? [eik] : []),
        hkdfSha256(eik, Buffer.alloc(0), Buffer.alloc(0), 32)
    ];
    const aadCandidates: Array<Buffer | undefined> = [undefined];
    if (canonicId?.trim()) {
        const rawId = canonicId.trim();
        const strippedId = rawId.replace(/^\$+/, "");
        for (const candidate of [rawId, rawId.toLowerCase(), strippedId, strippedId.toLowerCase()]) {
            if (candidate) aadCandidates.push(Buffer.from(candidate, "utf8"));
        }
    }

    let lastErr: unknown;
    for (const key of candidateKeys) {
        for (const aad of aadCandidates) {
            try {
                const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
                if (aad) decipher.setAAD(aad);
                decipher.setAuthTag(tag);
                const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
                return decodeLocation(plain);
            } catch (err) {
                lastErr = err;
            }
        }
    }
    for (const key of candidateKeys.slice(0, 2)) {
        try {
            const plain = aes256EaxDecrypt(key, nonce, ciphertext, tag);
            return decodeLocation(plain);
        } catch {
            // Keep primary AES-GCM error.
        }
    }
    throw lastErr;
}

export function decryptCrowdsourcedLocationReport(params: {
    eik: Buffer;
    encryptedLocation: Buffer;
    publicKeyRandom: Buffer;
    deviceTimeOffset: number;
    rotationExponent?: number;
}): ProtoLocation {
    if (params.encryptedLocation.length < 16) {
        throw new Error("Crowdsourced encrypted location payload too short");
    }

    let curve: CurveParams;
    if (params.publicKeyRandom.length === 20) {
        curve = SECP160R1;
    } else if (params.publicKeyRandom.length === 32) {
        curve = SECP256R1;
    } else {
        throw new Error(`Unsupported publicKeyRandom length: ${params.publicKeyRandom.length}`);
    }

    const r = deriveFmdnScalar(params.eik, params.deviceTimeOffset, params.rotationExponent ?? 10, curve);
    let rxBuf: Buffer;
    let sharedXBuf: Buffer;

    if (curve.name === "secp256r1") {
        const ecdh = crypto.createECDH("prime256v1");
        ecdh.setPrivateKey(bigIntToFixedBuffer(r, 32));
        rxBuf = Buffer.from((ecdh.getPublicKey() as Buffer).subarray(1, 33));
        const compressedPub = Buffer.concat([Buffer.from([0x02]), params.publicKeyRandom]);
        sharedXBuf = ecdh.computeSecret(compressedPub);
    } else {
        rxBuf = bigIntToFixedBuffer(scalarMultiplyX(curve, r, curve.Gx, curve.Gy), curve.byteLen);
        const sx = BigInt("0x" + params.publicKeyRandom.toString("hex"));
        const sy = recoverEvenY(curve, sx);
        const sharedX = scalarMultiplyX(curve, r, sx, sy);
        sharedXBuf = bigIntToFixedBuffer(sharedX, curve.byteLen);
    }

    const aesKey = hkdfSha256(sharedXBuf, Buffer.alloc(0), Buffer.alloc(0), 32);
    const nonce = Buffer.concat([
        rxBuf.subarray(rxBuf.length - 8),
        params.publicKeyRandom.subarray(params.publicKeyRandom.length - 8)
    ]);
    const ciphertext = params.encryptedLocation.subarray(0, params.encryptedLocation.length - 16);
    const tag = params.encryptedLocation.subarray(params.encryptedLocation.length - 16);

    const plain = aes256EaxDecrypt(aesKey, nonce, ciphertext, tag);
    return decodeLocation(plain);
}

// ---- 14-byte 0xFE2C BLE GATT Ring Packet Helper ----

export type GoogleFindSoundComponent = "all" | "right" | "left" | "case";

export function componentToBleStateMask(action: "start" | "stop", component: GoogleFindSoundComponent = "all"): number {
    if (action === "stop") return 0x00;
    if (component === "right") return 0x01;
    if (component === "left") return 0x02;
    if (component === "case") return 0x04;
    return 0xff;
}

export function componentToProtoEnum(component: GoogleFindSoundComponent = "all"): ExecuteActionDeviceComponent {
    if (component === "right") return ExecuteActionDeviceComponent.DEVICE_COMPONENT_RIGHT;
    if (component === "left") return ExecuteActionDeviceComponent.DEVICE_COMPONENT_LEFT;
    if (component === "case") return ExecuteActionDeviceComponent.DEVICE_COMPONENT_CASE;
    return ExecuteActionDeviceComponent.DEVICE_COMPONENT_UNSPECIFIED;
}

export function buildBleRingPacket(params: {
    ringKey: Buffer;
    version: number;
    nonce: Buffer;
    action: "start" | "stop";
    component?: GoogleFindSoundComponent;
    timeoutDeciseconds?: number;
    volume?: number;
}): Buffer {
    if (params.ringKey.length < 8) {
        throw new Error(`Expected >=8-byte ringKey, got ${params.ringKey.length}`);
    }
    if (params.nonce.length !== 8) {
        throw new Error(`Expected 8-byte nonce, got ${params.nonce.length}`);
    }
    const stateMask = componentToBleStateMask(params.action, params.component ?? "all");
    const timeout = params.action === "stop" ? 0 : params.timeoutDeciseconds ?? 0x0258;
    const volume = params.action === "stop" ? 0x00 : params.volume ?? 0xff;

    const additionalData = Buffer.from([
        stateMask & 0xff,
        (timeout >> 8) & 0xff,
        timeout & 0xff,
        volume & 0xff
    ]);
    const header = Buffer.from([0x05, 0x0c]);
    const hmacInput = Buffer.concat([Buffer.from([params.version & 0xff]), params.nonce, header, additionalData]);
    const mac8 = crypto.createHmac("sha256", params.ringKey.subarray(0, 8)).update(hmacInput).digest().subarray(0, 8);
    return Buffer.concat([header, mac8, additionalData]);
}
