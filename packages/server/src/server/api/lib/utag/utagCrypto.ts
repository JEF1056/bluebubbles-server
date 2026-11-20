import crypto from "crypto";

export const CLIENT_ID_LOGIN = "yfrtglt53o";
export const CLIENT_ID_ONECONNECT = "6iado3s6jc";
export const ONECONNECT_SCOPE = "iot.client";
export const UTAG_REDIRECT_URI =
    "ms-app://s-1-15-2-4027708247-2189610-1983755848-2937435718-1578786913-2158692839-1974417358";
export const DEFAULT_SAMSUNG_SIGNIN_URL = "https://account.samsung.com/accounts/ANDROIDSDK/signInGate";

export interface PkcePair {
    codeVerifier: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
}

export interface SamsungEntryPoint {
    signInUrl?: string;
    pkiPublicKey: string;
    chkDoNum: string;
    countryCode?: string;
}

export interface SamsungSignInRequest {
    url: string;
    state: string;
    deviceId: string;
    codeVerifier: string;
    codeChallenge: string;
}

export interface DecryptedSamsungAuthRedirect {
    state: string;
    code: string;
    authServerUrl: string;
    retValue: string;
}

export interface UTagGeoPayload {
    latitude?: number | string | null;
    longitude?: number | string | null;
    encLatitude?: string | null;
    encLongitude?: string | null;
    accuracy?: number | string | null;
    horizontalAccuracy?: number | string | null;
    lastUpdateTime?: number | string | null;
}

export interface ResolvedGeoCoordinates {
    latitude: number;
    longitude: number;
    horizontalAccuracy?: number;
    lastUpdateTime?: number;
}

const ALPHANUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const toBase64Url = (buf: Buffer): string =>
    buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const normalizeBase64 = (value: string): string => {
    const replaced = value.trim().replace(/-/g, "+").replace(/_/g, "/");
    const pad = replaced.length % 4;
    return pad === 0 ? replaced : replaced + "=".repeat(4 - pad);
};

export const generateDeviceId = (): string => crypto.randomBytes(8).toString("hex");

export const generateState = (length = 20): string => {
    const bytes = crypto.randomBytes(length);
    let out = "";
    for (let i = 0; i < length; i += 1) {
        out += ALPHANUM[bytes[i] % ALPHANUM.length];
    }
    return out;
};

export const generatePkcePair = (): PkcePair => {
    const codeVerifier = toBase64Url(crypto.randomBytes(32));
    const codeChallenge = toBase64Url(crypto.createHash("sha256").update(codeVerifier).digest());
    return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
};

const formatRsaPublicKeyPem = (rawKey: string): string => {
    const trimmed = rawKey.trim();
    if (trimmed.includes("BEGIN PUBLIC KEY") || trimmed.includes("BEGIN RSA PUBLIC KEY")) {
        return trimmed;
    }
    const clean = trimmed.replace(/\s+/g, "");
    const lines = clean.match(/.{1,64}/g)?.join("\n") ?? clean;
    return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
};

export const buildSamsungSignInUrl = (
    entryPoint: SamsungEntryPoint,
    state: string,
    options?: { deviceId?: string; pkce?: PkcePair; countryCode?: string; locale?: string }
): SamsungSignInRequest => {
    const deviceId = options?.deviceId ?? generateDeviceId();
    const pkce = options?.pkce ?? generatePkcePair();
    const iterations = parseInt(entryPoint.chkDoNum, 10);
    if (!Number.isFinite(iterations) || iterations <= 0) {
        throw new Error(`Invalid Samsung chkDoNum: ${entryPoint.chkDoNum}`);
    }

    // SignInUtils.kt: password = base64(SHA256(chkDoNum)), salt = random 16B, key = PBKDF2-SHA256(16B)
    const hashedChkDoNum = crypto.createHash("sha256").update(entryPoint.chkDoNum, "utf8").digest("base64");
    const pbkdf2Salt = crypto.randomBytes(16);
    const generatedKey = crypto.pbkdf2Sync(Buffer.from(hashedChkDoNum, "utf8"), pbkdf2Salt, iterations, 16, "sha256");

    // svcEncKY = base64(RSA-PKCS1(base64(generatedKey)))
    const pubPem = formatRsaPublicKeyPem(entryPoint.pkiPublicKey);
    const svcEncKY = crypto
        .publicEncrypt(
            { key: pubPem, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(generatedKey.toString("base64"), "utf8")
        )
        .toString("base64");

    const svcParam = {
        clientId: CLIENT_ID_LOGIN,
        code_challenge: pkce.codeChallenge,
        code_challenge_method: "S256",
        competitorDeviceYNFlag: "Y",
        countryCode: (options?.countryCode ?? entryPoint.countryCode ?? "us").toLowerCase(),
        deviceInfo: "Google|com.android.chrome",
        deviceModelID: "Pixel",
        deviceName: "BlueBubbles Server",
        deviceOSVersion: "34",
        devicePhysicalAddressText: `ANID:${deviceId}`,
        deviceType: "APP",
        deviceUniqueID: deviceId,
        redirect_uri: UTAG_REDIRECT_URI,
        replaceableClientConnectYN: "N",
        replaceableClientId: "",
        replaceableDevicePhysicalAddressText: "",
        responseEncryptionType: "1",
        responseEncryptionYNFlag: "Y",
        scope: "",
        state,
        svcIptLgnID: "",
        iosYNFlag: "Y"
    };

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-128-cbc", generatedKey, iv);
    const svcEncParam = Buffer.concat([cipher.update(JSON.stringify(svcParam), "utf8"), cipher.final()]).toString(
        "base64"
    );

    const outerSvcParam = Buffer.from(
        JSON.stringify({
            chkDoNum: entryPoint.chkDoNum,
            svcEncParam,
            svcEncKY,
            svcEncIV: iv.toString("hex")
        }),
        "utf8"
    ).toString("base64");

    const baseUrl = entryPoint.signInUrl ?? DEFAULT_SAMSUNG_SIGNIN_URL;
    const url = new URL(baseUrl);
    url.searchParams.set("locale", options?.locale ?? "en-US");
    url.searchParams.set("svcParam", outerSvcParam);
    url.searchParams.set("mode", "C");

    return {
        url: url.toString(),
        state,
        deviceId,
        codeVerifier: pkce.codeVerifier,
        codeChallenge: pkce.codeChallenge
    };
};

const decryptAes128EcbHex = (encryptedHex: string, key16: Buffer): string => {
    const decipher = crypto.createDecipheriv("aes-128-ecb", key16, null);
    decipher.setAutoPadding(true);
    const raw = Buffer.from(encryptedHex.trim(), "hex");
    return Buffer.concat([decipher.update(raw), decipher.final()]).toString("utf8");
};

export const decryptSamsungAuthRedirect = (
    callbackUrl: string,
    expectedState: string
): DecryptedSamsungAuthRedirect => {
    const parsed = new URL(callbackUrl);
    const encState = parsed.searchParams.get("state");
    const encCode = parsed.searchParams.get("code");
    const encAuthServerUrl = parsed.searchParams.get("auth_server_url");
    const encRetValue = parsed.searchParams.get("retValue");

    if (!encState || !encCode || !encAuthServerUrl || !encRetValue) {
        throw new Error("Samsung auth redirect missing required encrypted parameters");
    }

    const expectedKey = Buffer.from(expectedState.slice(0, 16), "utf8");
    if (expectedKey.length !== 16) {
        throw new Error("Expected state must be at least 16 characters");
    }

    const state = decryptAes128EcbHex(encState, expectedKey);
    if (state !== expectedState) {
        throw new Error("Samsung auth redirect state mismatch");
    }

    const valueKey = Buffer.from(state.slice(0, 16), "utf8");
    const code = decryptAes128EcbHex(encCode, valueKey);
    const authServerUrl = decryptAes128EcbHex(encAuthServerUrl, valueKey);
    const retValue = decryptAes128EcbHex(encRetValue, valueKey);

    return { state, code, authServerUrl, retValue };
};

export const unwrapE2ePrivateKey = (
    encryptedPrivateKey: string,
    pin: string,
    options?: { userId?: string | null; iv?: string | Buffer | null }
): crypto.KeyObject => {
    if (!pin) throw new Error("E2EE PIN is required");
    if (!options?.iv) throw new Error("E2EE keyPair IV is required");

    const trimmed = encryptedPrivateKey.trim();
    const isV2 = trimmed.endsWith("_v2");
    const b64Payload = isV2 ? trimmed.slice(0, -3) : trimmed;

    let pinMaterial = pin;
    if (isV2) {
        if (!options?.userId) throw new Error("userId is required for _v2 E2EE key unwrap");
        pinMaterial = `${pin}${options.userId}`;
    }

    const aesKey = crypto.createHash("sha256").update(pinMaterial, "utf8").digest();
    const ivBuf = Buffer.isBuffer(options.iv)
        ? options.iv
        : Buffer.from(normalizeBase64(options.iv), "base64");
    const encryptedBytes = Buffer.from(normalizeBase64(b64Payload), "base64");

    const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, ivBuf);
    const der = Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);
    return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
};

// BouncyCastle KDF2BytesGenerator with SHA-1 (1-based 32-bit big-endian counter)
const kdf2Sha1 = (input: Buffer, outputLength: number): Buffer => {
    const chunks: Buffer[] = [];
    let generated = 0;
    let counter = 1;
    while (generated < outputLength) {
        const ctr = Buffer.alloc(4);
        ctr.writeUInt32BE(counter, 0);
        const digest = crypto.createHash("sha1").update(input).update(ctr).digest();
        chunks.push(digest);
        generated += digest.length;
        counter += 1;
    }
    return Buffer.concat(chunks, outputLength);
};

const extractEcPrivateScalarFromPkcs8 = (privateKey: crypto.KeyObject): Buffer => {
    const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
    // Inner ECPrivateKey SEQUENCE starts with INTEGER 1 (02 01 01) followed by OCTET STRING (04 <len> <d>)
    const marker = Buffer.from([0x02, 0x01, 0x01, 0x04]);
    const ix = der.indexOf(marker);
    if (ix === -1 || ix + 5 > der.length) {
        throw new Error("Unable to extract EC private scalar from PKCS#8 DER");
    }
    const len = der[ix + 4];
    if (ix + 5 + len > der.length) {
        throw new Error("Invalid EC private scalar length in PKCS#8 DER");
    }
    return der.subarray(ix + 5, ix + 5 + len);
};

export const decryptEciesCoordinate = (
    encryptedBase64: string,
    privateKey: crypto.KeyObject
): string => {
    const payload = Buffer.from(normalizeBase64(encryptedBase64), "base64");
    const macLen = 20; // HMAC-SHA1
    const macKeyLen = 16; // BouncyCastle default ECIES macKeySize = 128 bits

    const curve = (privateKey as any).asymmetricKeyDetails?.namedCurve ?? "prime256v1";
    const scalar = extractEcPrivateScalarFromPkcs8(privateKey);
    const ecdh = crypto.createECDH(curve);
    ecdh.setPrivateKey(scalar);
    const vLen = ecdh.getPublicKey().length;

    if (payload.length <= vLen + macLen) {
        throw new Error("Encrypted ECIES coordinate payload is too short");
    }

    const V = payload.subarray(0, vLen);
    const C = payload.subarray(vLen, payload.length - macLen);
    const receivedMac = payload.subarray(payload.length - macLen);

    const Z = ecdh.computeSecret(V);
    // BouncyCastle IESEngine with ECIES: KDF2(V || Z), K2 (macKey 16B) first then K1 (encKey)
    const derived = kdf2Sha1(Buffer.concat([V, Z]), macKeyLen + C.length);
    const macKey = derived.subarray(0, macKeyLen);
    const encKey = derived.subarray(macKeyLen);

    // BouncyCastle IESEngine appends 8-byte big-endian L2 (0 for empty P2) to HMAC input
    const expectedMac = crypto.createHmac("sha1", macKey).update(C).update(Buffer.alloc(8)).digest();
    if (!crypto.timingSafeEqual(expectedMac, receivedMac)) {
        throw new Error("ECIES HMAC-SHA1 verification failed");
    }

    const plaintext = Buffer.allocUnsafe(C.length);
    for (let i = 0; i < C.length; i += 1) {
        plaintext[i] = C[i] ^ encKey[i];
    }
    return plaintext.toString("utf8");
};

const parseCoordinateNumber = (val: unknown): number | null => {
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string" && val.trim().length > 0) {
        const parsed = Number(val.trim());
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
};

export const resolveGeoCoordinates = (
    geo: UTagGeoPayload | null | undefined,
    privateKey?: crypto.KeyObject | null
): { coords: ResolvedGeoCoordinates | null; needsPin: boolean } => {
    if (!geo) return { coords: null, needsPin: false };

    let lat = parseCoordinateNumber(geo.latitude);
    let lon = parseCoordinateNumber(geo.longitude);
    const encLat =
        geo.encLatitude ?? (typeof geo.latitude === "string" && lat === null ? geo.latitude : null);
    const encLon =
        geo.encLongitude ?? (typeof geo.longitude === "string" && lon === null ? geo.longitude : null);

    if ((lat === null || lon === null) && (encLat || encLon)) {
        if (!privateKey) {
            return { coords: null, needsPin: true };
        }
        if (encLat) lat = parseCoordinateNumber(decryptEciesCoordinate(encLat, privateKey));
        if (encLon) lon = parseCoordinateNumber(decryptEciesCoordinate(encLon, privateKey));
    }

    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return { coords: null, needsPin: Boolean(encLat || encLon) };
    }

    const horizontalAccuracy =
        parseCoordinateNumber(geo.horizontalAccuracy) ?? parseCoordinateNumber(geo.accuracy) ?? undefined;
    const lastUpdateTime = parseCoordinateNumber(geo.lastUpdateTime) ?? undefined;

    return {
        coords: {
            latitude: lat,
            longitude: lon,
            horizontalAccuracy,
            lastUpdateTime
        },
        needsPin: false
    };
};
