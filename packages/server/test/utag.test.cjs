const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const serverSrc = path.join(__dirname, "..", "src");

function loadTsModule(relPath, extraMocks = {}) {
    const cache = new Map();
    const origLoad = Module._load;

    function compileAndLoad(absPath) {
        if (cache.has(absPath)) return cache.get(absPath).exports;
        const source = fs.readFileSync(absPath, "utf8");
        const compiled = ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
                esModuleInterop: true
            }
        });
        const mod = new Module(absPath, module);
        mod.filename = absPath;
        mod.paths = Module._nodeModulePaths(path.dirname(absPath));
        cache.set(absPath, mod);
        mod._compile(compiled.outputText, absPath);
        return mod.exports;
    }

    Module._load = function (request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(extraMocks, request)) {
            return extraMocks[request];
        }
        if (request === "@server/events") {
            return { NEW_FINDMY_DEVICE: "new-findmy-device" };
        }
        if (request.startsWith("@server/")) {
            const sub = request.slice("@server/".length);
            const candidate = path.join(serverSrc, "server", `${sub}.ts`);
            if (fs.existsSync(candidate)) return compileAndLoad(candidate);
        }
        if (request.startsWith(".") && parent?.filename) {
            const resolved = path.resolve(path.dirname(parent.filename), `${request}.ts`);
            if (fs.existsSync(resolved)) return compileAndLoad(resolved);
        }
        return origLoad.apply(this, arguments);
    };

    try {
        return compileAndLoad(path.join(serverSrc, relPath));
    } finally {
        Module._load = origLoad;
    }
}

function createFakeSafeStorage() {
    const key = crypto.createHash("sha256").update("test-safe-storage-key").digest();
    return {
        isEncryptionAvailable: () => true,
        encryptString: plainText => {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
            const enc = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
            const tag = cipher.getAuthTag();
            return Buffer.concat([Buffer.from("v10"), iv, tag, enc]);
        },
        decryptString: buf => {
            const iv = buf.subarray(3, 15);
            const tag = buf.subarray(15, 31);
            const enc = buf.subarray(31);
            const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
        }
    };
}

function kdf2Sha1(sharedSecret, outputLen) {
    const chunks = [];
    let generated = 0;
    let counter = 1;
    while (generated < outputLen) {
        const ctr = Buffer.alloc(4);
        ctr.writeUInt32BE(counter, 0);
        const digest = crypto.createHash("sha1").update(sharedSecret).update(ctr).digest();
        chunks.push(digest);
        generated += digest.length;
        counter += 1;
    }
    return Buffer.concat(chunks, outputLen);
}

function encryptEciesBc(plaintextStr, recipientPubUncompressed) {
    const eph = crypto.createECDH("prime256v1");
    eph.generateKeys();
    const V = eph.getPublicKey();
    const Z = eph.computeSecret(recipientPubUncompressed);
    const plaintext = Buffer.from(plaintextStr, "utf8");
    // BouncyCastle IESEngine: KDF2(V || Z), K2 (macKey 16B) first then K1 (encKey)
    const derived = kdf2Sha1(Buffer.concat([V, Z]), 16 + plaintext.length);
    const macKey = derived.subarray(0, 16);
    const encKey = derived.subarray(16);
    const ciphertext = Buffer.alloc(plaintext.length);
    for (let i = 0; i < plaintext.length; i += 1) {
        ciphertext[i] = plaintext[i] ^ encKey[i];
    }
    const mac = crypto.createHmac("sha1", macKey).update(ciphertext).update(Buffer.alloc(8)).digest();
    return Buffer.concat([V, ciphertext, mac]).toString("base64");
}

test("trackerCommon encrypted 0o600 store and LRU reverse-geocode cache", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tracker-common-"));
    const safeStorage = createFakeSafeStorage();
    const common = loadTsModule("server/api/lib/findmy/trackerCommon.ts");
    common.resetTrackerCommonForTests();

    const deps = { baseDir: tmpDir, safeStorage, nominatimMinIntervalMs: 1 };
    common.writeEncryptedJson("secret.json", { token: "abc123" }, deps);

    const filePath = path.join(tmpDir, "secret.json");
    const stat = fs.statSync(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(filePath, "utf8").includes("abc123"), false);
    assert.deepEqual(common.readEncryptedJson("secret.json", deps), { token: "abc123" });
    assert.equal(common.deleteEncryptedJson("secret.json", deps), true);
    assert.equal(common.readEncryptedJson("secret.json", deps), null);

    let fetchCalls = 0;
    const mockFetch = async () => {
        fetchCalls += 1;
        return new Response(
            JSON.stringify({
                display_name: "1600 Amphitheatre Pkwy, Mountain View, CA, USA",
                address: {
                    house_number: "1600",
                    road: "Amphitheatre Pkwy",
                    city: "Mountain View",
                    "ISO3166-2-lvl4": "US-CA",
                    country: "United States"
                }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
        );
    };

    const geoDeps = { ...deps, fetchFn: mockFetch };
    const [a, b] = await Promise.all([
        common.reverseGeocode(37.42201, -122.08401, geoDeps),
        common.reverseGeocode(37.42204, -122.08404, geoDeps)
    ]);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(a, {
        label: "1600 Amphitheatre Pkwy, Mountain View, CA",
        mapItemFullAddress: "1600 Amphitheatre Pkwy, Mountain View, CA, USA",
        streetAddress: "1600 Amphitheatre Pkwy",
        locality: "Mountain View",
        stateCode: "CA",
        country: "United States"
    });
    assert.deepEqual(b, a);

    // Cache hit avoids fetch
    const c = await common.reverseGeocode(37.42202, -122.08402, geoDeps);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(c, a);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("utagCrypto signInUrl, redirect decrypt, PIN unwrap (v1 & _v2), and ECIES (BC 1.79 vectors)", () => {
    const utagCrypto = loadTsModule("server/api/lib/utag/utagCrypto.ts");

    const { publicKey: rsaPub, privateKey: rsaPriv } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048
    });
    const state = utagCrypto.generateState(20);
    assert.equal(state.length, 20);
    const devId = utagCrypto.generateDeviceId();
    assert.match(devId, /^[0-9a-f]{16}$/);

    const signIn = utagCrypto.buildSamsungSignInUrl(
        {
            pkiPublicKey: rsaPub.export({ type: "spki", format: "pem" }).toString(),
            chkDoNum: "1000",
            countryCode: "US"
        },
        state,
        { deviceId: devId }
    );
    const parsedUrl = new URL(signIn.url);
    assert.equal(parsedUrl.searchParams.get("mode"), "C");
    assert.equal(parsedUrl.searchParams.get("locale"), "en-US");
    const outer = JSON.parse(Buffer.from(parsedUrl.searchParams.get("svcParam"), "base64").toString("utf8"));
    assert.equal(outer.chkDoNum, "1000");
    const aesKeyBase64 = crypto
        .privateDecrypt({ key: rsaPriv, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(outer.svcEncKY, "base64"))
        .toString("utf8");
    const aesKey = Buffer.from(aesKeyBase64, "base64");
    const decipherSvc = crypto.createDecipheriv("aes-128-cbc", aesKey, Buffer.from(outer.svcEncIV, "hex"));
    const innerSvc = JSON.parse(
        Buffer.concat([decipherSvc.update(Buffer.from(outer.svcEncParam, "base64")), decipherSvc.final()]).toString("utf8")
    );
    assert.equal(innerSvc.clientId, utagCrypto.CLIENT_ID_LOGIN);
    assert.equal(innerSvc.deviceUniqueID, devId);
    assert.equal(innerSvc.state, state);
    assert.equal(innerSvc.redirect_uri, utagCrypto.UTAG_REDIRECT_URI);

    // AES-128-ECB hex redirect callback encrypted with state.slice(0, 16)
    const ecbKey = Buffer.from(state.slice(0, 16), "utf8");
    const encEcbHex = str => {
        const cipher = crypto.createCipheriv("aes-128-ecb", ecbKey, null);
        return Buffer.concat([cipher.update(str, "utf8"), cipher.final()]).toString("hex");
    };
    const callbackUrl = `${utagCrypto.UTAG_REDIRECT_URI}?state=${encEcbHex(state)}&code=${encEcbHex(
        "auth-code-123"
    )}&auth_server_url=${encEcbHex("us-auth2.samsungosp.com")}&retValue=${encEcbHex("user@example.com")}`;

    const redirected = utagCrypto.decryptSamsungAuthRedirect(callbackUrl, state);
    assert.equal(redirected.code, "auth-code-123");
    assert.equal(redirected.authServerUrl, "us-auth2.samsungosp.com");
    assert.equal(redirected.retValue, "user@example.com");

    assert.throws(
        () => utagCrypto.decryptSamsungAuthRedirect(callbackUrl, "wrongState0123456789"),
        /state mismatch|wrong final block|bad decrypt/i
    );

    // P-256 keypair for E2EE PIN unwrap & ECIES
    const ecPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pkcs8Der = ecPair.privateKey.export({ type: "pkcs8", format: "der" });
    const ecdhPub = crypto.createECDH("prime256v1");
    const jwk = ecPair.privateKey.export({ format: "jwk" });
    ecdhPub.setPrivateKey(Buffer.from(jwk.d, "base64url"));
    const pubUncompressed = ecdhPub.getPublicKey();
    const keyIv = crypto.randomBytes(16);

    // v1 unwrap (no _v2 suffix -> SHA-256(pin))
    const v1Key = crypto.createHash("sha256").update("123456", "utf8").digest();
    const v1Cipher = crypto.createCipheriv("aes-256-cbc", v1Key, keyIv);
    const v1Enc = Buffer.concat([v1Cipher.update(pkcs8Der), v1Cipher.final()]).toString("base64");
    const unwrappedV1 = utagCrypto.unwrapE2ePrivateKey(v1Enc, "123456", { iv: keyIv.toString("base64") });

    // _v2 unwrap (_v2 suffix stripped before base64 decode -> SHA-256(pin + userId))
    const v2Key = crypto.createHash("sha256").update("654321user-abc", "utf8").digest();
    const v2Cipher = crypto.createCipheriv("aes-256-cbc", v2Key, keyIv);
    const v2Enc = `${Buffer.concat([v2Cipher.update(pkcs8Der), v2Cipher.final()]).toString("base64")}_v2`;
    const unwrappedV2 = utagCrypto.unwrapE2ePrivateKey(v2Enc, "654321", {
        userId: "user-abc",
        iv: keyIv.toString("base64")
    });
    assert.throws(() =>
        utagCrypto.unwrapE2ePrivateKey(v2Enc, "000000", { userId: "user-abc", iv: keyIv.toString("base64") })
    );

    // ECIES coordinate decrypt + HMAC tamper rejection
    const encLat = encryptEciesBc("37.334606", pubUncompressed);
    const encLon = encryptEciesBc("-122.009102", pubUncompressed);
    assert.equal(utagCrypto.decryptEciesCoordinate(encLat, unwrappedV1), "37.334606");

    // Real BouncyCastle 1.79 ECIES vectors (prime239v1 + prime256v1)
    const bcVectors = [
        {
            pkcs8B64:
                "MIGNAgEAMBMGByqGSM49AgEGCCqGSM49AwEEBHMwcQIBAQQeDYEfL5QCBxrImWucNpaNhppdRl0LTEfKwp0gW+WJoAoGCCqGSM49AwEEoUADPgAEaTlX+tCzxSI5pQHPBdDzltWkXvo16r+nfEdhzBPRUWJRj8BPwT4+xYrpr8/r+M6DqGF+xLDiy11yNSNm",
            ctB64: "BDgJWDoBgeHkKc2T1Is3JBcY6Oh6JcokjJjiG6kNcTSGtfXtFy9Njy0cmwSzikuvauY1FMPzvOi3NS32pIi75HrtNCUegMVlQEmMVgAW5KIl79BPegwSi+Vp"
        },
        {
            pkcs8B64:
                "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg6VR2XocQlPp7v0x2xcyFsqyszGi6lNZQw94v09ZfQYOgCgYIKoZIzj0DAQehRANCAARz5NkJay5UJUEkb156j6K+vfGnjeEFX7bavzrh72vQ3zKUgNt1KsVpbupggTXZJZLeynrbuUoLe7t786RrYR00",
            ctB64: "BG4Z+Oac3+TiUo7TGy67RhfzNPTs0yzR9UeQ25QavEPn1I3GXTwYOglnJBMeAdQvp0Pf0wVdk8Gd68Lu/yq/YMxRL8kEIv7ZKxHPvoBrnFSru5Mx8HX89lRzdj6ldQ=="
        }
    ];
    for (const vec of bcVectors) {
        const keyObj = crypto.createPrivateKey({
            key: Buffer.from(vec.pkcs8B64, "base64"),
            format: "der",
            type: "pkcs8"
        });
        assert.equal(utagCrypto.decryptEciesCoordinate(vec.ctB64, keyObj), "37.334606");
    }

    const tampered = Buffer.from(encLat, "base64");
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => utagCrypto.decryptEciesCoordinate(tampered.toString("base64"), unwrappedV2), /HMAC/i);

    const noPin = utagCrypto.resolveGeoCoordinates({ encLatitude: encLat, encLongitude: encLon }, null);
    assert.equal(noPin.needsPin, true);
    assert.equal(noPin.coords, null);

    const resolved = utagCrypto.resolveGeoCoordinates({ encLatitude: encLat, encLongitude: encLon }, unwrappedV2);
    assert.equal(resolved.needsPin, false);
    assert.deepEqual(resolved.coords, {
        latitude: 37.334606,
        longitude: -122.009102,
        horizontalAccuracy: undefined,
        lastUpdateTime: undefined
    });
});

test("utagClient OAuth privacy retry, single-flight 401 refresh, pagination, FME 403 & ring", async () => {
    const utagClientMod = loadTsModule("server/api/lib/utag/utagClient.ts");
    let authCalls = 0;
    let refreshCalls = 0;
    let geoCalls = 0;
    let termsAgreedCalls = 0;
    let shareableCalls = 0;
    let currentIotToken = "iot-1";
    const ringPayloads = [];
    const searchingPayloads = [];
    const geoEnvelopes = [];

    const mockFetch = async (url, init = {}) => {
        const u = String(url);
        if (u === "https://account.samsung.com/accounts/ANDROIDSDK/getEntryPoint") {
            assert.equal(init.method ?? "GET", "GET");
            return new Response(
                JSON.stringify({
                    signInURI: "https://account.samsung.com/accounts/ANDROIDSDK/signInGate",
                    chkDoNum: "1",
                    pkiPublicKey: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA"
                }),
                { status: 200 }
            );
        }
        if (u.endsWith("/auth/oauth2/authenticate")) {
            assert.equal(init.method, "POST");
            const body = new URLSearchParams(String(init.body ?? ""));
            assert.equal(body.get("grant_type"), "authorization_code");
            assert.equal(body.get("serviceType"), "M");
            assert.equal(body.get("username"), "user@example.com");
            return new Response(JSON.stringify({ userauth_token: "user-auth-1", userId: "u-1" }), { status: 200 });
        }
        if (u.includes("/auth/oauth2/v2/authorize?")) {
            assert.equal(init.method ?? "GET", "GET");
            authCalls += 1;
            const parsed = new URL(u);
            assert.equal(parsed.searchParams.get("userauth_token"), "user-auth-1");
            assert.equal(parsed.searchParams.get("serviceType"), "M");
            assert.equal(parsed.searchParams.get("childAccountSupported"), "Y");
            if (parsed.searchParams.get("login_id")) {
                return new Response(JSON.stringify({ privacyAccepted: "N" }), { status: 200 });
            }
            return new Response(JSON.stringify({ code: "oneconnect-code" }), { status: 200 });
        }
        if (u.endsWith("/auth/oauth2/token")) {
            assert.equal(init.method, "POST");
            const body = String(init.body ?? "");
            if (body.includes("grant_type=refresh_token")) {
                refreshCalls += 1;
                currentIotToken = "iot-2";
                return new Response(JSON.stringify({ access_token: "iot-2", refresh_token: "iot-ref-2" }), {
                    status: 200
                });
            }
            return new Response(
                JSON.stringify({ access_token: "iot-1", refresh_token: "iot-ref-1", userId: "u-1" }),
                { status: 200 }
            );
        }
        if (u.startsWith("https://client.smartthings.com/devices")) {
            if (init.headers?.Authorization !== `Bearer ${currentIotToken}` || currentIotToken === "iot-1") {
                return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
            }
            if (!u.includes("page=2")) {
                return new Response(
                    JSON.stringify({
                        items: [
                            { deviceId: "other-1", ocfDeviceType: "oic.d.light" },
                            {
                                deviceId: "tag-1",
                                label: "Keys",
                                ocfDeviceType: "x.com.st.d.tag",
                                modelName: "EI-T5600",
                                bleD2D: { privacyId: "aabbccddeeff0011" }
                            }
                        ],
                        _links: { next: { href: "https://client.smartthings.com/devices?page=2" } }
                    }),
                    { status: 200 }
                );
            }
            return new Response(
                JSON.stringify({
                    items: [{ deviceId: "tag-2", label: "Bag", ocfDeviceType: "x.com.st.d.tag", modelName: "EI-T5300" }]
                }),
                { status: 200 }
            );
        }
        if (u === "https://api.smartthings.com/installedapps?allowed=true") {
            return new Response(
                JSON.stringify({
                    items: [{ installedAppId: "other-app", ui: { pluginId: "com.samsung.other" } }],
                    _links: { next: { href: "https://api.smartthings.com/installedapps?allowed=true&page=2" } }
                }),
                { status: 200 }
            );
        }
        if (u === "https://api.smartthings.com/installedapps?allowed=true&page=2") {
            return new Response(
                JSON.stringify({
                    items: [{ installedAppId: "fme-app-1", ui: { pluginId: "com.samsung.android.plugin.fme" } }]
                }),
                { status: 200 }
            );
        }
        if (u === "https://api.smartthings.com/installedapps/fme-app-1/execute") {
            const payload = JSON.parse(String(init.body));
            const params = payload.parameters;
            if (params.uri === "/trackers/geolocation") {
                geoEnvelopes.push(payload);
                geoCalls += 1;
                if (geoCalls === 1) {
                    return new Response(
                        JSON.stringify({
                            statusCode: 403,
                            requestId: "req-403",
                            errorCode: "FORBIDDEN",
                            message: "terms"
                        }),
                        { status: 200 }
                    );
                }
                if (geoCalls === 2) {
                    return new Response(
                        JSON.stringify({
                            statusCode: 200,
                            requestId: "req-2",
                            errorCode: null,
                            message: { items: [{ deviceId: "tag-1", resultCode: "403", geolocations: [] }], keyPairs: [] }
                        }),
                        { status: 200 }
                    );
                }
                return new Response(
                    JSON.stringify({
                        statusCode: 200,
                        requestId: "req-3",
                        errorCode: null,
                        message: {
                            items: [
                                {
                                    deviceId: "tag-1",
                                    resultCode: "200",
                                    geolocations: [
                                        { latitude: "10", longitude: "20", lastUpdateTime: 100 },
                                        { latitude: "37.42", longitude: "-122.08", accuracy: "11.691", lastUpdateTime: 200 }
                                    ]
                                }
                            ],
                            keyPairs: []
                        }
                    }),
                    { status: 200 }
                );
            }
            if (params.uri === "/user/options") {
                termsAgreedCalls += 1;
                assert.equal(params.method, "POST");
                assert.equal(params.ppVersion, "1.0.0");
                assert.equal(params.fmmAgreement, "true");
                const ag = JSON.parse(Buffer.from(params.encodedAgreement, "base64").toString("utf8"));
                assert.deepEqual(ag, [
                    { type: "service.location", agreed: true },
                    { type: "service.pp", agreed: true }
                ]);
                return new Response(
                    JSON.stringify({ statusCode: 200, requestId: "req-terms", errorCode: null, message: { ok: true } }),
                    { status: 200 }
                );
            }
            if (params.uri === "/trackerapi" && params.extraUri?.endsWith("/shareable/members")) {
                shareableCalls += 1;
                assert.equal(params.method, "POST");
                assert.deepEqual(JSON.parse(Buffer.from(params.encodedBody, "base64").toString("utf8")), {
                    saGuid: "u-1"
                });
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (params.uri === "/trackerapi" && params.extraUri?.endsWith("/ring")) {
                ringPayloads.push(payload);
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            if (params.uri === "/trackerapi" && params.extraUri?.endsWith("/searchingstatus")) {
                searchingPayloads.push(payload);
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
        }
        throw new Error(`Unexpected URL: ${u}`);
    };

    const client = new utagClientMod.UTagClient(null, { fetchFn: mockFetch });
    const entryPoint = await client.fetchEntryPoint();
    assert.equal(entryPoint.signInUrl, "https://account.samsung.com/accounts/ANDROIDSDK/signInGate");
    assert.equal(entryPoint.chkDoNum, "1");

    const loginTokens = await client.exchangeAuthCode({
        code: "login-code-1",
        codeVerifier: "verifier-1",
        authServerUrl: "us-auth2.samsungosp.com",
        deviceId: "0123456789abcdef",
        username: "user@example.com"
    });
    assert.equal(loginTokens.userAuthToken, "user-auth-1");
    assert.equal(loginTokens.userId, "u-1");

    const tokens = await client.authorizeOneConnect({
        userAuthToken: loginTokens.userAuthToken,
        authServerUrl: loginTokens.authServerUrl,
        deviceId: "0123456789abcdef",
        userId: loginTokens.userId,
        loginId: "user@example.com"
    });
    assert.equal(authCalls, 2);
    assert.equal(tokens.iotToken, "iot-1");

    // HTML 200 from getEntryPoint throws UTagHttpError
    const badClient = new utagClientMod.UTagClient(null, {
        fetchFn: async () => new Response("<html><body>Error</body></html>", { status: 200 })
    });
    await assert.rejects(() => badClient.fetchEntryPoint(), /entryPoint \(200\)/);

    // Concurrent calls hitting 401 trigger only ONE refresh
    const [tags1, tags2] = await Promise.all([client.getSmartTagDevices(), client.getSmartTagDevices()]);
    assert.equal(refreshCalls, 1);
    assert.equal(tags1.length, 2);
    assert.equal(tags2.length, 2);
    assert.equal(tags1[0].deviceId, "tag-1");

    const fmeId = await client.getFmeInstalledAppId();
    assert.equal(fmeId, "fme-app-1");

    const geoRes = await client.getTagGeolocation(fmeId, "tag-1");
    assert.equal(geoCalls, 3);
    assert.equal(termsAgreedCalls, 1);
    assert.equal(shareableCalls, 1);
    assert.equal(geoRes.geo.latitude, "37.42");
    assert.equal(geoRes.geo.lastUpdateTime, 200);

    // Verify FME execute envelope shape (including UTC-prefixed timeZoneOffset)
    const env = geoEnvelopes[0];
    assert.equal(env.client.displayMode, "LIGHT");
    assert.equal(env.client.os, "Android");
    assert.match(env.client.timeZoneOffset, /^UTC[+-]\d{2}:\d{2}$/);
    assert.equal(env.client.mobileDeviceId, "0123456789abcdef");
    assert.equal(env.client.samsungAccountId, "u-1");
    assert.equal(env.client.supportedTemplates.includes("BASIC_V7"), true);
    assert.equal(env.parameters.requester, "u-1");
    assert.equal(env.parameters.requesterToken, "iot-2");
    assert.equal(env.parameters.clientType, "aPlugin");
    assert.equal(env.parameters.clientVersion, "1");
    assert.equal(env.parameters.uri, "/trackers/geolocation");
    assert.equal(env.parameters.stDids, "tag-1");
    assert.equal(env.parameters.encodedHeaders, "");
    assert.equal(env.parameters.encodedBody, "");

    await client.ringTag(fmeId, "tag-1", "start");
    await client.ringTag(fmeId, "tag-1", "stop");
    assert.equal(ringPayloads.length, 2);
    assert.equal(ringPayloads[0].parameters.uri, "/trackerapi");
    assert.equal(ringPayloads[0].parameters.extraUri, "/trackers/tag-1/ring");
    assert.deepEqual(
        ringPayloads.map(p => JSON.parse(Buffer.from(p.parameters.encodedBody, "base64").toString("utf8"))),
        [{ command: "start" }, { command: "stop" }]
    );

    await client.setSearchingStatus(fmeId, "tag-1", true);
    assert.equal(searchingPayloads[0].parameters.uri, "/trackerapi");
    assert.equal(searchingPayloads[0].parameters.extraUri, "/trackers/tag-1/searchingstatus");
    assert.deepEqual(
        JSON.parse(Buffer.from(searchingPayloads[0].parameters.encodedBody, "base64").toString("utf8")),
        { searchingStatus: "searching" }
    );
});

test("utagMapper & UTagService end-to-end mapping, ble-spec, and zero secret leakage", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-utag-service-"));
    const safeStorage = createFakeSafeStorage();
    const common = loadTsModule("server/api/lib/findmy/trackerCommon.ts");
    common.resetTrackerCommonForTests();

    const utagServiceMod = loadTsModule("server/api/lib/utag/utagService.ts");
    const emitted = [];

    const ecPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pkcs8Der = ecPair.privateKey.export({ type: "pkcs8", format: "der" });
    const ecdhPub = crypto.createECDH("prime256v1");
    ecdhPub.setPrivateKey(Buffer.from(ecPair.privateKey.export({ format: "jwk" }).d, "base64url"));
    const pubUncompressed = ecdhPub.getPublicKey();
    const keyIv = crypto.randomBytes(16);
    const v2Key = crypto.createHash("sha256").update("2468user-1", "utf8").digest();
    const v2Cipher = crypto.createCipheriv("aes-256-cbc", v2Key, keyIv);
    const v2Enc = `${Buffer.concat([v2Cipher.update(pkcs8Der), v2Cipher.final()]).toString("base64")}_v2`;
    const encLatBc = encryptEciesBc("37.7749", pubUncompressed);
    const encLonBc = encryptEciesBc("-122.4194", pubUncompressed);

    const mockFetch = async url => {
        const u = String(url);
        if (u.startsWith("https://client.smartthings.com/devices")) {
            return new Response(
                JSON.stringify({
                    items: [
                        {
                            deviceId: "raw-tag-99",
                            label: "House Keys",
                            ocfDeviceType: "x.com.st.d.tag",
                            modelName: "EI-T5600",
                            icon: "keys",
                            bleD2D: { privacyId: "DEADBEEF00112233", encryptionKey: "super-secret-raw-key" }
                        }
                    ]
                }),
                { status: 200 }
            );
        }
        if (u === "https://api.smartthings.com/installedapps?allowed=true") {
            return new Response(
                JSON.stringify({
                    items: [{ installedAppId: "fme-1", ui: { pluginId: "com.samsung.android.plugin.fme" } }]
                }),
                { status: 200 }
            );
        }
        if (u === "https://api.smartthings.com/installedapps/fme-1/execute") {
            return new Response(
                JSON.stringify({
                    statusCode: 200,
                    requestId: "req-geo-1",
                    errorCode: null,
                    message: {
                        items: [
                            {
                                deviceId: "raw-tag-99",
                                resultCode: 200,
                                geolocations: [
                                    { encLatitude: encLatBc, encLongitude: encLonBc, lastUpdateTime: 1700000000000, battery: "LOW" }
                                ]
                            }
                        ],
                        keyPairs: [
                            {
                                userId: "user-1",
                                privateKey: v2Enc,
                                iv: keyIv.toString("base64")
                            }
                        ]
                    }
                }),
                { status: 200 }
            );
        }
        if (u.includes("nominatim.openstreetmap.org")) {
            return new Response(
                JSON.stringify({
                    display_name: "San Francisco, CA, USA",
                    address: { road: "Market St", city: "San Francisco", "ISO3166-2-lvl4": "US-CA", country: "USA" }
                }),
                { status: 200 }
            );
        }
        throw new Error(`Unexpected URL: ${u}`);
    };

    const storageDeps = { baseDir: tmpDir, safeStorage, fetchFn: mockFetch, nominatimMinIntervalMs: 1 };
    const service = new utagServiceMod.UTagService({
        storageDeps,
        fetchFn: mockFetch,
        emitDevice: d => {
            emitted.push(d);
        }
    });

    // Seed encrypted store with token + PIN only (keyPair comes from /trackers/geolocation)
    common.writeEncryptedJson(
        "utag-auth.enc.json",
        {
            deviceId: "0123456789abcdef",
            tokens: {
                userAuthToken: "secret-user-token",
                iotToken: "secret-iot-token",
                authServerUrl: "https://us-auth2.samsungosp.com",
                deviceId: "0123456789abcdef",
                userId: "user-1"
            }
        },
        storageDeps
    );
    service.setE2eePin("2468");

    const devices = await service.refreshDevices();
    assert.equal(devices.length, 1);
    assert.equal(emitted.length, 1);
    const tag = devices[0];
    assert.equal(tag.id, "utag:raw-tag-99");
    assert.equal(tag.isConsideredAccessory, true);
    assert.equal(tag.modelDisplayName, "Galaxy SmartTag2");
    assert.equal(tag.role.emoji, "🔑");
    assert.equal(tag.batteryLevel, 0.25);
    assert.equal(tag.features.TRACKER_PROVIDER, "utag");
    assert.equal(tag.features.SUPPORTS_UWB, true);
    assert.equal(tag.address.locality, "San Francisco");

    const bleSpec = service.getBleSpec("utag:raw-tag-99");
    assert.equal(bleSpec.deviceId, "utag:raw-tag-99");
    assert.equal(bleSpec.rawId, "raw-tag-99");
    assert.equal(bleSpec.provider, "utag");
    assert.equal(bleSpec.serviceUuid, "fd5a");
    assert.deepEqual(bleSpec.expectedPrivacyIdsHex, ["deadbeef00112233"]);
    assert.equal(bleSpec.supportsUwb, true);
    assert.equal(bleSpec.uwbPackage, "com.kieronquinn.app.utag");
    assert.equal(bleSpec.uwbAction, "com.kieronquinn.app.utag.MAP");
    assert.equal(bleSpec.uwbClass, "com.kieronquinn.app.utag.ui.activities.TagActivity");
    assert.equal(bleSpec.uwbExtraKey, "target_id");
    assert.equal(bleSpec.uwbFallbackPackage, "com.samsung.android.oneconnect");
    assert.equal(JSON.stringify(bleSpec).includes("super-secret-raw-key"), false);
    assert.equal(JSON.stringify(service.getStatus()).includes("secret-iot-token"), false);

    service.disconnect();
    assert.equal(service.getStatus().connected, false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("utagClient nested bleD2D metadata and UTagService geolocation failure preservation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-utag-nested-"));
    const safeStorage = createFakeSafeStorage();
    const common = loadTsModule("server/api/lib/findmy/trackerCommon.ts");
    common.resetTrackerCommonForTests();
    const utagServiceMod = loadTsModule("server/api/lib/utag/utagService.ts");

    let failGeo = false;
    const mockFetch = async url => {
        const u = String(url);
        if (u.startsWith("https://client.smartthings.com/devices")) {
            return new Response(
                JSON.stringify({
                    items: [
                        {
                            deviceId: "tag-live-1",
                            label: "Camera Cube",
                            ocfDeviceType: "x.com.st.d.tag",
                            presentationId: "IM-SmartTag2-BLE-UWB",
                            icons: { iconKey: "oneui/ic_briefcase" },
                            components: [{ id: "main", icon: "oneui/ic_briefcase", categories: [{ name: "SmartTag" }] }],
                            bleD2D: {
                                metadata: {
                                    battery: { level: "FULL" },
                                    vendor: { modelName: "EI-T5600" }
                                }
                            }
                        }
                    ]
                }),
                { status: 200 }
            );
        }
        if (u === "https://api.smartthings.com/installedapps?allowed=true") {
            return new Response(
                JSON.stringify({
                    items: [{ installedAppId: "fme-live", ui: { pluginId: "com.samsung.android.plugin.fme" } }]
                }),
                { status: 200 }
            );
        }
        if (u === "https://api.smartthings.com/installedapps/fme-live/execute") {
            if (failGeo) {
                return new Response(JSON.stringify({ error: "ValidationError" }), { status: 422 });
            }
            return new Response(
                JSON.stringify({
                    statusCode: 200,
                    message: {
                        items: [
                            {
                                deviceId: "tag-live-1",
                                resultCode: "200",
                                geolocations: [
                                    {
                                        latitude: "37.422",
                                        longitude: "-122.084",
                                        accuracy: "11.691",
                                        battery: "FULL",
                                        lastUpdateTime: 1795158001375
                                    }
                                ]
                            }
                        ],
                        keyPairs: []
                    }
                }),
                { status: 200 }
            );
        }
        if (u.includes("nominatim.openstreetmap.org")) {
            return new Response(
                JSON.stringify({
                    display_name: "Mountain View, CA, USA",
                    address: { road: "Amphitheatre Pkwy", city: "Mountain View", "ISO3166-2-lvl4": "US-CA", country: "USA" }
                }),
                { status: 200 }
            );
        }
        throw new Error(`Unexpected URL: ${u}`);
    };

    const storageDeps = { baseDir: tmpDir, safeStorage, fetchFn: mockFetch, nominatimMinIntervalMs: 1 };
    const service = new utagServiceMod.UTagService({ storageDeps, fetchFn: mockFetch });
    common.writeEncryptedJson(
        "utag-auth.enc.json",
        {
            deviceId: "0123456789abcdef",
            tokens: {
                userAuthToken: "ua",
                iotToken: "iot",
                authServerUrl: "https://us-auth2.samsungosp.com",
                deviceId: "0123456789abcdef",
                userId: "user-1"
            }
        },
        storageDeps
    );

    const first = await service.refreshDevices();
    assert.equal(first.length, 1);
    assert.equal(first[0].modelDisplayName, "Galaxy SmartTag2");
    assert.equal(first[0].deviceModel, "EI-T5600");
    assert.equal(first[0].role.emoji, "💼");
    assert.equal(first[0].batteryLevel, 1.0);
    assert.equal(first[0].batteryStatus, "Full");
    assert.equal(first[0].deviceStatus, "online");
    assert.equal(first[0].location.latitude, 37.422);
    assert.equal(first[0].location.longitude, -122.084);
    assert.equal(first[0].location.horizontalAccuracy, 11.691);
    assert.equal(first[0].location.timeStamp, 1795158001375);
    assert.equal(first[0].last_updated, 1795158001375);
    assert.equal(service.getStatus().lastError, null);

    // Transient geolocation failure surfaces lastError and preserves cached location
    failGeo = true;
    const second = await service.refreshDevices();
    assert.match(service.getStatus().lastError ?? "", /422/);
    assert.equal(second[0].location.latitude, 37.422);
    assert.equal(second[0].location.timeStamp, 1795158001375);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("UTagOAuthWindow avoids custom-scheme webRequest filters and intercepts ms-app:// via protocol + navigation hooks", async () => {
    const protocolHandlers = new Map();
    const unhandleCalls = [];
    const webRequestCalls = [];
    const createdWindows = [];

    class FakeBrowserWindow {
        constructor(opts) {
            this.opts = opts;
            this.destroyed = false;
            this.events = new Map();
            this.loadedUrls = [];
            this.windowOpenHandler = null;
            this.webContents = {
                events: new Map(),
                on: (ev, fn) => {
                    const list = this.webContents.events.get(ev) ?? [];
                    list.push(fn);
                    this.webContents.events.set(ev, list);
                },
                setWindowOpenHandler: fn => {
                    this.windowOpenHandler = fn;
                }
            };
            createdWindows.push(this);
        }
        on(ev, fn) {
            const list = this.events.get(ev) ?? [];
            list.push(fn);
            this.events.set(ev, list);
        }
        isDestroyed() {
            return this.destroyed;
        }
        destroy() {
            this.destroyed = true;
            for (const fn of this.events.get("closed") ?? []) fn();
        }
        close() {
            this.destroy();
        }
        loadURL(url, opts) {
            this.loadedUrls.push({ url, opts });
            return Promise.resolve();
        }
    }

    const fakeSession = {
        webRequest: {
            onBeforeRequest: (...args) => {
                webRequestCalls.push(args);
            }
        },
        protocol: {
            handle: (scheme, fn) => {
                if (protocolHandlers.has(scheme)) {
                    throw new Error(`Failed to register protocol: ${scheme}`);
                }
                protocolHandlers.set(scheme, fn);
            },
            unhandle: scheme => {
                unhandleCalls.push(scheme);
                protocolHandlers.delete(scheme);
            }
        }
    };

    const fakeElectron = {
        BrowserWindow: FakeBrowserWindow,
        session: { fromPartition: () => fakeSession }
    };

    const windowPath = path.join(serverSrc, "windows", "UTagOAuthWindow.ts");
    const origLoad = Module._load;
    const cache = new Map();
    function loadWinMod(absPath) {
        if (cache.has(absPath)) return cache.get(absPath).exports;
        const source = fs.readFileSync(absPath, "utf8");
        const compiled = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
        });
        const mod = new Module(absPath, module);
        mod.filename = absPath;
        mod.paths = Module._nodeModulePaths(path.dirname(absPath));
        cache.set(absPath, mod);
        mod._compile(compiled.outputText, absPath);
        return mod.exports;
    }

    Module._load = function (request, parent) {
        if (request === "electron") return fakeElectron;
        if (request === "." && parent?.filename?.endsWith("UTagOAuthWindow.ts")) {
            return loadWinMod(path.join(serverSrc, "windows", "index.ts"));
        }
        return origLoad.apply(this, arguments);
    };

    let UTagOAuthWindow;
    try {
        ({ UTagOAuthWindow } = loadWinMod(windowPath));
    } finally {
        Module._load = origLoad;
    }

    const callbacks = [];
    UTagOAuthWindow.open({
        url: "https://account.samsung.com/accounts/ANDROIDSDK/signInGate?foo=bar",
        onCallbackUrl: async url => {
            callbacks.push(url);
        }
    });

    assert.equal(webRequestCalls.length, 0, "Must never register ms-app://*/* on session.webRequest");
    assert.equal(protocolHandlers.has("ms-app"), true, "Must register ms-app protocol handler");

    const win = createdWindows[0];
    assert.equal(win.loadedUrls.length, 1);
    assert.match(win.loadedUrls[0].opts.userAgent, /Chrome\//);

    // 1. protocol.handle captures ms-app:// callback
    const res = await protocolHandlers.get("ms-app")({ url: "ms-app://s-1-15-2-test?code=abc&state=xyz" });
    assert.equal(res.status, 200);
    await new Promise(r => setImmediate(r));
    assert.deepEqual(callbacks, ["ms-app://s-1-15-2-test?code=abc&state=xyz"]);
    assert.equal(win.isDestroyed(), true);
    assert.equal(unhandleCalls.includes("ms-app"), true);

    // 2. Re-opening works cleanly without duplicate protocol error and will-redirect works too
    const callbacks2 = [];
    UTagOAuthWindow.open({
        url: "https://account.samsung.com/accounts/ANDROIDSDK/signInGate?foo=baz",
        onCallbackUrl: async url => {
            callbacks2.push(url);
        }
    });
    const win2 = createdWindows[1];
    let prevented = false;
    for (const fn of win2.webContents.events.get("will-redirect") ?? []) {
        fn({ preventDefault: () => { prevented = true; } }, "ms-app://s-1-15-2-test?code=def");
    }
    await new Promise(r => setImmediate(r));
    assert.equal(prevented, true);
    assert.deepEqual(callbacks2, ["ms-app://s-1-15-2-test?code=def"]);

    // 3. S2-17: setWindowOpenHandler denies non-ms-app:// popups and intercepts ms-app:// popups while denying
    assert.equal(typeof win2.windowOpenHandler, "function");
    assert.deepEqual(win2.windowOpenHandler({ url: "https://evil.example/popup" }), { action: "deny" });
    const callbacks3 = [];
    UTagOAuthWindow.open({
        url: "https://account.samsung.com/accounts/ANDROIDSDK/signInGate?foo=pop",
        onCallbackUrl: async url => {
            callbacks3.push(url);
        }
    });
    const win3 = createdWindows[2];
    assert.deepEqual(win3.windowOpenHandler({ url: "ms-app://s-1-15-2-test?code=popup" }), { action: "deny" });
    await new Promise(r => setImmediate(r));
    assert.deepEqual(callbacks3, ["ms-app://s-1-15-2-test?code=popup"]);
});

test("utagMapper propagates SmartThings coloredIcon as iconUrl and iconCategory=tracker", () => {
    const utagMapper = loadTsModule("server/api/lib/utag/utagMapper.ts");
    const mapped = utagMapper.mapSmartTagToFindMyDevice({
        deviceId: "st-icon-1",
        label: "Keys",
        modelName: "EI-T5600",
        iconUrl: "https://client.smartthings.com/icons/oneui/ic_car_key.png"
    });
    assert.equal(mapped.iconUrl, "https://client.smartthings.com/icons/oneui/ic_car_key.png");
    assert.equal(mapped.iconCategory, "tracker");
});

test("UTagClient.ringTag surfaces FME inner resultCode >= 400 errors and UTagService.refreshDevices({ force: true }) bypasses cooldown", async () => {
    const { UTagClient, UTagHttpError } = loadTsModule("server/api/lib/utag/utagClient.ts");
    const utagServiceMod = loadTsModule("server/api/lib/utag/utagService.ts");
    const common = loadTsModule("server/api/lib/findmy/trackerCommon.ts");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utag-force-"));

    try {
        let listCalls = 0;
        const mockFetch = async (url, init) => {
            const u = String(url);
            if (u.startsWith("https://client.smartthings.com/devices")) {
                listCalls += 1;
                return new Response(
                    JSON.stringify({
                        items: [
                            {
                                deviceId: "tag-force-1",
                                label: "Bag Tag",
                                ocfDeviceType: "x.com.st.d.tag",
                                bleD2D: { privacyId: "AABBCCDDEEFF0011" }
                            }
                        ]
                    }),
                    { status: 200 }
                );
            }
            if (u === "https://api.smartthings.com/installedapps?allowed=true") {
                return new Response(
                    JSON.stringify({
                        items: [{ installedAppId: "fme-1", ui: { pluginId: "com.samsung.android.plugin.fme" } }]
                    }),
                    { status: 200 }
                );
            }
            if (u === "https://api.smartthings.com/installedapps/fme-1/execute") {
                const body = JSON.parse(init?.body ?? "{}");
                const uri = body?.parameters?.uri;
                const extraUri = body?.parameters?.extraUri ?? "";
                if (uri === "/trackerapi" && extraUri.endsWith("/ring")) {
                    return new Response(
                        JSON.stringify({
                            statusCode: 200,
                            message: { resultCode: 404, resultMessage: "Tracker offline" }
                        }),
                        { status: 200 }
                    );
                }
                return new Response(JSON.stringify({ statusCode: 200, message: { items: [] } }), { status: 200 });
            }
            throw new Error(`Unexpected URL: ${u}`);
        };

        const client = new UTagClient(null, { fetchFn: mockFetch });
        client.setTokens({
            userAuthToken: "u",
            iotToken: "i",
            expiresAt: Date.now() + 3600_000,
            authServerUrl: "https://us-auth2.samsungosp.com",
            deviceId: "dev1",
            userId: "user1"
        });
        await assert.rejects(
            () => client.ringTag("fme-1", "tag-force-1", "start"),
            err => err instanceof UTagHttpError && err.status === 404 && /Tracker offline/.test(err.message)
        );

        const storageDeps = {
            baseDir: tmpDir,
            safeStorage: {
                isEncryptionAvailable: () => true,
                encryptString: s => Buffer.from(s, "utf8"),
                decryptString: b => b.toString("utf8")
            },
            fetchFn: mockFetch
        };
        const service = new utagServiceMod.UTagService({
            storageDeps,
            fetchFn: mockFetch,
            cooldownMs: 60_000,
            emitDevice: () => {}
        });
        common.writeEncryptedJson(
            "utag-auth.enc.json",
            {
                deviceId: "dev1",
                tokens: {
                    userAuthToken: "u",
                    iotToken: "i",
                    expiresAt: Date.now() + 3600_000,
                    authServerUrl: "https://us-auth2.samsungosp.com",
                    deviceId: "dev1",
                    userId: "user1"
                }
            },
            storageDeps
        );

        await service.refreshDevices("utag:tag-force-1");
        assert.equal(listCalls, 1);
        await service.refreshDevices("utag:tag-force-1");
        assert.equal(listCalls, 1, "Cooldown should skip second targeted refresh");
        await service.refreshDevices("utag:tag-force-1", { force: true });
        assert.equal(listCalls, 2, "force: true should bypass cooldown");
        const ble = service.getBleSpec("utag:tag-force-1");
        assert.deepEqual(ble.expectedPrivacyIdsHex, ["aabbccddeeff0011"]);
        service.disconnect();
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("UTagService (U1) auto-stops searching after timer & on disconnect, (U2) queues targeted refresh and preserves needsPin, (S2-18) guards empty userId and 403 retries", async () => {
    const { UTagClient, UTagHttpError } = loadTsModule("server/api/lib/utag/utagClient.ts");
    const utagServiceMod = loadTsModule("server/api/lib/utag/utagService.ts");
    const common = loadTsModule("server/api/lib/findmy/trackerCommon.ts");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utag-u1u2-"));

    try {
        // S2-18: empty userId skips setShareableMembers, and 403 is remembered per session until setTokens changes
        let shareCalls = 0;
        let termsCalls = 0;
        let geoMode = "terms403";
        const s2MockFetch = async (url, init) => {
            const u = String(url);
            if (u === "https://api.smartthings.com/installedapps/fme-s2/execute") {
                const body = JSON.parse(init?.body ?? "{}");
                const uri = body?.parameters?.uri;
                const extraUri = body?.parameters?.extraUri ?? "";
                if (uri === "/user/options") {
                    termsCalls += 1;
                    return new Response(JSON.stringify({ statusCode: 403, message: { resultCode: 403 } }), { status: 200 });
                }
                if (uri === "/trackerapi" && extraUri.includes("/shareable/members")) {
                    shareCalls += 1;
                    return new Response(JSON.stringify({ statusCode: 403, message: { resultCode: 403 } }), { status: 200 });
                }
                if (uri === "/trackers/geolocation") {
                    if (geoMode === "terms403") {
                        return new Response(JSON.stringify({ statusCode: 403, message: { resultCode: 403 } }), { status: 200 });
                    }
                    return new Response(
                        JSON.stringify({ statusCode: 200, message: { items: [{ deviceId: "tag-s2", resultCode: 403 }] } }),
                        { status: 200 }
                    );
                }
            }
            throw new Error(`Unexpected S2-18 URL: ${u}`);
        };
        const s2Client = new UTagClient(null, { fetchFn: s2MockFetch });
        s2Client.setTokens({
            userAuthToken: "u1",
            iotToken: "i1",
            expiresAt: Date.now() + 3600_000,
            authServerUrl: "https://us-auth2.samsungosp.com",
            deviceId: "dev1",
            userId: ""
        });
        await s2Client.setShareableMembers("fme-s2", "tag-s2", "   ");
        assert.equal(shareCalls, 0, "Empty userId must skip setShareableMembers");

        await assert.rejects(() => s2Client.getTagGeolocation("fme-s2", "tag-s2"), UTagHttpError);
        await assert.rejects(() => s2Client.getTagGeolocation("fme-s2", "tag-s2"), UTagHttpError);
        assert.equal(termsCalls, 1, "403 on setTermsAgreed must be remembered for the session");

        geoMode = "share403";
        s2Client.setTokens({
            userAuthToken: "u2",
            iotToken: "i2",
            expiresAt: Date.now() + 3600_000,
            authServerUrl: "https://us-auth2.samsungosp.com",
            deviceId: "dev1",
            userId: "user-s2"
        });
        await assert.rejects(() => s2Client.getTagGeolocation("fme-s2", "tag-s2"), UTagHttpError);
        await s2Client.getTagGeolocation("fme-s2", "tag-s2");
        assert.equal(shareCalls, 1, "403 on setShareableMembers must be remembered for the device/session");

        // U1 + U2 on UTagService
        const searchEvents = [];
        const geoRequests = [];
        let holdTag1Geo = null;
        let releaseTag1Geo = null;

        const uMockFetch = async (url, init) => {
            const u = String(url);
            if (u.startsWith("https://client.smartthings.com/devices")) {
                return new Response(
                    JSON.stringify({
                        items: [
                            { deviceId: "tag-1", label: "Tag One", ocfDeviceType: "x.com.st.d.tag" },
                            { deviceId: "tag-2", label: "Tag Two", ocfDeviceType: "x.com.st.d.tag" }
                        ]
                    }),
                    { status: 200 }
                );
            }
            if (u === "https://api.smartthings.com/installedapps?allowed=true") {
                return new Response(
                    JSON.stringify({
                        items: [{ installedAppId: "fme-u", ui: { pluginId: "com.samsung.android.plugin.fme" } }]
                    }),
                    { status: 200 }
                );
            }
            if (u === "https://api.smartthings.com/installedapps/fme-u/execute") {
                const body = JSON.parse(init?.body ?? "{}");
                const uri = body?.parameters?.uri;
                const extraUri = body?.parameters?.extraUri ?? "";
                const stDids = body?.parameters?.stDids;
                if (uri === "/trackerapi" && extraUri.endsWith("/searchingstatus")) {
                    const m = extraUri.match(/\/trackers\/([^/]+)\/searchingstatus/);
                    const innerBody = JSON.parse(
                        Buffer.from(body?.parameters?.encodedBody ?? "", "base64").toString("utf8") || "{}"
                    );
                    searchEvents.push({ deviceId: m?.[1], searching: innerBody?.searchingStatus === "searching" });
                    return new Response(JSON.stringify({ statusCode: 200, message: { resultCode: 200 } }), { status: 200 });
                }
                if (uri === "/trackers/geolocation") {
                    geoRequests.push(stDids);
                    if (stDids === "tag-1" && holdTag1Geo) {
                        await holdTag1Geo;
                    }
                    if (stDids === "tag-1") {
                        return new Response(
                            JSON.stringify({
                                statusCode: 200,
                                message: {
                                    items: [
                                        {
                                            deviceId: "tag-1",
                                            geolocations: [{ latitude: "enc-lat", longitude: "enc-lon", timeStamp: Date.now() }]
                                        }
                                    ]
                                }
                            }),
                            { status: 200 }
                        );
                    }
                    return new Response(
                        JSON.stringify({
                            statusCode: 200,
                            message: {
                                items: [{ deviceId: "tag-2", geolocations: [] }]
                            }
                        }),
                        { status: 200 }
                    );
                }
                return new Response(JSON.stringify({ statusCode: 200, message: {} }), { status: 200 });
            }
            throw new Error(`Unexpected U1/U2 URL: ${u}`);
        };

        const storageDeps = {
            baseDir: tmpDir,
            safeStorage: {
                isEncryptionAvailable: () => true,
                encryptString: s => Buffer.from(s, "utf8"),
                decryptString: b => b.toString("utf8")
            },
            fetchFn: uMockFetch
        };
        const service = new utagServiceMod.UTagService({
            storageDeps,
            fetchFn: uMockFetch,
            cooldownMs: 60_000,
            searchStopDelayMs: 30,
            emitDevice: () => {}
        });
        common.writeEncryptedJson(
            "utag-auth.enc.json",
            {
                deviceId: "dev-u",
                tokens: {
                    userAuthToken: "u",
                    iotToken: "i",
                    expiresAt: Date.now() + 3600_000,
                    authServerUrl: "https://us-auth2.samsungosp.com",
                    deviceId: "dev-u",
                    userId: "user-u"
                }
            },
            storageDeps
        );

        // U2: start an untargeted refresh and hold tag-1 geo; a concurrent targeted refresh for tag-2 must NOT be dropped,
        // and tag-2's non-PIN geo must NOT clobber tag-1's needsPin=true.
        holdTag1Geo = new Promise(resolve => {
            releaseTag1Geo = resolve;
        });
        const fullPromise = service.refreshDevices();
        await new Promise(r => setTimeout(r, 15));
        const targetedPromise = service.refreshDevices("utag:tag-2", { force: true });
        holdTag1Geo = null;
        releaseTag1Geo();
        await Promise.all([fullPromise, targetedPromise]);

        // geoRequests should contain tag-1, tag-2 (from full), then tag-2 again (from queued targeted refresh)
        assert.deepEqual(geoRequests, ["tag-1", "tag-2", "tag-2"]);
        assert.equal(service.getStatus().needsPin, true, "Targeted tag-2 refresh must not clobber global needsPin");

        // U1: targeted refresh armed setSearchingStatus(true) and auto-disarms to false after searchStopDelayMs
        assert.deepEqual(searchEvents, [{ deviceId: "tag-2", searching: true }]);
        await new Promise(r => setTimeout(r, 60));
        assert.deepEqual(searchEvents, [
            { deviceId: "tag-2", searching: true },
            { deviceId: "tag-2", searching: false }
        ]);

        // U1: disconnect() flushes pending stop before deleting tokens and does not double-fire
        searchEvents.length = 0;
        await service.refreshDevices("utag:tag-2", { force: true });
        assert.deepEqual(searchEvents, [{ deviceId: "tag-2", searching: true }]);
        service.disconnect();
        await new Promise(r => setTimeout(r, 50));
        assert.deepEqual(searchEvents, [
            { deviceId: "tag-2", searching: true },
            { deviceId: "tag-2", searching: false }
        ]);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("UTagService.ringDevice rejects BLE-only tags when remoteRing.enabled !== true and mapper reflects remoteRing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utag-ring-guard-"));
    const ringCalls = [];
    try {
        const { mapSmartTagToFindMyDevice } = loadTsModule("server/api/lib/utag/utagMapper.ts");
        const { UTagService } = loadTsModule("server/api/lib/utag/utagService.ts", {
            "@server": { Server: () => ({ emitMessage: () => {} }) }
        });

        const mappedDisabled = mapSmartTagToFindMyDevice(
            {
                deviceId: "tag-ble-only",
                label: "BLE Tag",
                bleD2D: { metadata: { remoteRing: { enabled: false } } }
            },
            { coords: { latitude: 37.7, longitude: -122.4, lastUpdateTime: Date.now() } }
        );
        assert.equal(mappedDisabled.features.CAN_RING, true);
        assert.equal(mappedDisabled.features.HAS_BLE_RING, true);
        assert.equal(mappedDisabled.features.UTAG_REMOTE_RING, false);

        const mappedEnabled = mapSmartTagToFindMyDevice(
            {
                deviceId: "tag-remote-ok",
                label: "Remote Tag",
                bleD2D: { metadata: { remoteRing: { enabled: true } } }
            },
            { coords: { latitude: 37.7, longitude: -122.4, lastUpdateTime: Date.now() } }
        );
        assert.equal(mappedEnabled.features.UTAG_REMOTE_RING, true);

        const mockClient = {
            setTokens: () => undefined,
            getTokens: () => ({ accessToken: "tok" }),
            getSmartTagDevices: async () => [
                {
                    deviceId: "tag-ble-only",
                    label: "BLE Tag",
                    bleD2D: { metadata: { remoteRing: { enabled: false } } }
                },
                {
                    deviceId: "tag-remote-ok",
                    label: "Remote Tag",
                    bleD2D: { metadata: { remoteRing: { enabled: true } } }
                }
            ],
            getFmeInstalledAppId: async () => "fme-app",
            ringTag: async (appId, deviceId, action) => {
                ringCalls.push({ appId, deviceId, action });
            }
        };
        const service = new UTagService({
            storageDeps: {
                baseDir: tmpDir,
                safeStorage: { isEncryptionAvailable: () => false }
            },
            client: mockClient,
            emitDevice: () => undefined
        });

        await assert.rejects(
            () => service.ringDevice("utag:tag-ble-only", "start"),
            err => err?.name === "UTagHttpError" && err?.status === 400
        );
        assert.equal(ringCalls.length, 0);

        await service.ringDevice("utag:tag-remote-ok", "start");
        assert.deepEqual(ringCalls, [{ appId: "fme-app", deviceId: "tag-remote-ok", action: "start" }]);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
