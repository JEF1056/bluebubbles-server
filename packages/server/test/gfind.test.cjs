const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { Duplex } = require("node:stream");
const test = require("node:test");
const ts = require("typescript");

const serverSrcRoot = path.join(__dirname, "..", "src", "server");

function installTsLoader() {
    if (installTsLoader.installed) return;
    installTsLoader.installed = true;

    const origResolveFilename = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
        if (request === "electron") {
            return "electron";
        }
        if (request.startsWith("@server/")) {
            const target = path.join(serverSrcRoot, request.slice("@server/".length));
            return origResolveFilename.call(this, target, parent, isMain, options);
        }
        if (request === "@server") {
            return origResolveFilename.call(this, path.join(serverSrcRoot, "index.ts"), parent, isMain, options);
        }
        return origResolveFilename.call(this, request, parent, isMain, options);
    };

    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === "electron") {
            return {
                app: { getPath: () => os.tmpdir() },
                safeStorage: {
                    isEncryptionAvailable: () => false,
                    encryptString: v => Buffer.from(v, "utf8"),
                    decryptString: b => b.toString("utf8")
                }
            };
        }
        return origLoad.call(this, request, parent, isMain);
    };

    require.extensions[".ts"] = function (mod, filename) {
        const source = fs.readFileSync(filename, "utf8");
        const compiled = ts.transpileModule(source, {
            fileName: filename,
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
                esModuleInterop: true
            }
        });
        mod._compile(compiled.outputText, filename);
    };
}

installTsLoader();

const gfind = require(path.join(serverSrcRoot, "api", "lib", "gfind", "index.ts"));

function makeMemoryTrackerDeps(tmpDir) {
    const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: text => Buffer.concat([Buffer.from("MOCKENC:"), Buffer.from(text, "utf8")]),
        decryptString: buf => {
            const str = buf.toString("utf8");
            if (!str.startsWith("MOCKENC:")) throw new Error("Bad encrypted blob");
            return str.slice("MOCKENC:".length);
        }
    };
    return { baseDir: tmpDir, safeStorage };
}

function makeFakeSafeGcm(key32, plaintext, nonce12) {
    const iv = nonce12 ?? crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key32, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

// Independent affine double-and-add for secp160r1 vector verification
function independentSecp160r1ScalarMult(scalar, px, py) {
    const p = BigInt("0xffffffffffffffffffffffffffffffff7fffffff");
    const a = BigInt("0xffffffffffffffffffffffffffffffff7ffffffc");
    const mod = x => ((x % p) + p) % p;
    const modInv = v => {
        let t = 0n;
        let newT = 1n;
        let r = p;
        let newR = mod(v);
        while (newR !== 0n) {
            const q = r / newR;
            [t, newT] = [newT, t - q * newT];
            [r, newR] = [newR, r - q * newR];
        }
        return t < 0n ? t + p : t;
    };
    const add = (pt1, pt2) => {
        if (!pt1) return pt2;
        if (!pt2) return pt1;
        const [x1, y1] = pt1;
        const [x2, y2] = pt2;
        if (x1 === x2 && mod(y1 + y2) === 0n) return null;
        const lambda =
            x1 === x2 && y1 === y2
                ? mod((3n * x1 * x1 + a) * modInv(2n * y1))
                : mod((y2 - y1) * modInv(x2 - x1));
        const x3 = mod(lambda * lambda - x1 - x2);
        const y3 = mod(lambda * (x1 - x3) - y1);
        return [x3, y3];
    };
    let res = null;
    let cur = [px, py];
    let k = scalar;
    while (k > 0n) {
        if (k & 1n) res = add(res, cur);
        cur = add(cur, cur);
        k >>= 1n;
    }
    return res;
}

test("gfindProto preserves unknown fields across DevicesList and nested DeviceMetadata round-trips", () => {
    const unknownOuter = { fieldNumber: 99, wireType: gfind.WIRE_VARINT, value: 12345n };
    const unknownInner = {
        fieldNumber: 77,
        wireType: gfind.WIRE_LENGTH_DELIMITED,
        value: Buffer.from("future-field", "utf8")
    };

    const original = {
        deviceMetadata: [
            {
                userDefinedDeviceName: "Backpack Tag",
                identifierInformation: {
                    type: gfind.IdentifierInformationType.IDENTIFIER_SPOT,
                    trackerInformation: {
                        canonicIds: ["canonic-spot-1"]
                    }
                },
                information: {
                    deviceRegistration: {
                        spotDeviceType: gfind.SpotDeviceType.DEVICE_TYPE_BAG,
                        manufacturer: "Chipolo",
                        fastPairModelId: "abc123",
                        rotationExponent: 10,
                        ringKey: Buffer.from("0102030405060708", "hex"),
                        model: "ONE Point",
                        encryptedKeys: {
                            ownerKeyVersion: 3,
                            encryptedIdentityKey: Buffer.alloc(60, 0xaa)
                        },
                        _unknownFields: [unknownInner]
                    },
                    reports: [
                        {
                            semanticLocation: { locationName: "Home" },
                            timestampSeconds: 1730000000,
                            timestampNanos: 500000000,
                            status: 1,
                            geoLocation: {
                                deviceTimeOffset: 1729999872,
                                accuracy: 12.5,
                                encryptedReport: {
                                    publicKeyRandom: Buffer.alloc(20, 0x22),
                                    encryptedLocation: Buffer.alloc(48, 0x33),
                                    isOwnReport: false
                                }
                            }
                        }
                    ]
                },
                _unknownFields: [unknownOuter]
            },
            {
                userDefinedDeviceName: "Pixel 9",
                identifierInformation: {
                    type: gfind.IdentifierInformationType.IDENTIFIER_ANDROID,
                    phoneInformation: {
                        canonicIds: ["canonic-phone-1"],
                        manufacturer: "Google",
                        modelNumber: "Pixel 9",
                        deviceInformation: {
                            reports: [
                                {
                                    timestampSeconds: 1730000100,
                                    geoLocation: {
                                        accuracy: 8,
                                        unencryptedLocation: { latitude: 37.422, longitude: -122.084, altitude: 15 }
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        ],
        _unknownFields: [{ fieldNumber: 88, wireType: gfind.WIRE_VARINT, value: 9n }]
    };

    const wire1 = gfind.encodeDevicesList(original);
    const decoded1 = gfind.decodeDevicesList(wire1);
    const wire2 = gfind.encodeDevicesList(decoded1);
    assert.equal(wire2.equals(wire1), true, "round-trip bytes with unknown fields should match identically");

    assert.equal(decoded1.deviceMetadata.length, 2);
    assert.equal(decoded1.deviceMetadata[0].userDefinedDeviceName, "Backpack Tag");
    assert.equal(decoded1.deviceMetadata[0]._unknownFields[0].fieldNumber, 99);
    assert.equal(decoded1.deviceMetadata[0].information.deviceRegistration._unknownFields[0].value.toString("utf8"), "future-field");
    assert.equal(decoded1.deviceMetadata[1].identifierInformation.phoneInformation.manufacturer, "Google");
    assert.equal(decoded1.deviceMetadata[1].identifierInformation.phoneInformation.modelNumber, "Pixel 9");
    assert.ok(Math.abs(decoded1.deviceMetadata[1].identifierInformation.phoneInformation.deviceInformation.reports[0].geoLocation.unencryptedLocation.latitude - 37.422) < 1e-6);
});

test("gfindProto ExecuteActionRequest, DeviceUpdate, Spot gRPC, Checkin, and MCS frames", () => {
    const execBuf = gfind.encodeExecuteActionRequest({
        deviceType: gfind.NovaDeviceType.SPOT_DEVICE,
        canonicId: "spot-1",
        requestUuid: "req-123",
        fcmRegistrationId: "fcm-tok",
        action: { kind: "startSound", component: gfind.ExecuteActionDeviceComponent.DEVICE_COMPONENT_LEFT }
    });
    const execFields = gfind.decodeRawFields(execBuf);
    assert.equal(execFields.length, 3);

    const eidReq = gfind.encodeGetEidInfoForE2eeDevicesRequest();
    const eidReqFields = gfind.decodeRawFields(eidReq);
    assert.equal(BigInt.asIntN(32, eidReqFields[0].value), -1n);
    assert.equal(eidReqFields[1].value, 1n);

    const eidRespBuf = gfind.encodeGetEidInfoForE2eeDevicesResponse({
        ownerKeys: [{ encryptedOwnerKey: Buffer.from("secret-ok"), ownerKeyVersion: 4, securityDomain: "finder_hw" }]
    });
    const eidResp = gfind.decodeGetEidInfoForE2eeDevicesResponse(eidRespBuf);
    assert.equal(eidResp.ownerKeys.length, 1);
    assert.equal(eidResp.ownerKeys[0].ownerKeyVersion, 4);
    assert.equal(eidResp.ownerKeys[0].securityDomain, "finder_hw");

    const kdiBuf = gfind.encodeEncryptionUnlockRequestExtras("finder_hw", "00000000-0000-0000-0000-000000000000");
    const kdiFields = gfind.decodeRawFields(kdiBuf);
    assert.equal(kdiFields.find(f => f.fieldNumber === 1).value, 1n);
    const kdiDomain = gfind.decodeRawFields(kdiFields.find(f => f.fieldNumber === 2).value);
    assert.equal(kdiDomain.find(f => f.fieldNumber === 1).value.toString("utf8"), "finder_hw");
    assert.equal(kdiFields.find(f => f.fieldNumber === 6).value.toString("utf8"), "00000000-0000-0000-0000-000000000000");

    const stanzaWire = gfind.encodeMcsDataMessageStanza({
        id: "m1",
        from: "google",
        persistentId: "pid-1",
        streamId: 3,
        appData: { key: "val" },
        rawData: Buffer.from([1, 2, 3])
    });
    const reader = new gfind.McsFrameReader(true);
    const loginAckWire = gfind.encodeMcsFrame(gfind.MCS_TAG_LOGIN_RESPONSE, Buffer.from([0x0a, 0x02, 0x6f, 0x6b]));
    const frames = reader.push(Buffer.concat([Buffer.from([gfind.MCS_VERSION]), loginAckWire, stanzaWire]));
    assert.equal(frames.length, 2);
    assert.equal(frames[0].tag, gfind.MCS_TAG_LOGIN_RESPONSE);
    assert.equal(frames[1].tag, gfind.MCS_TAG_DATA_MESSAGE_STANZA);
    const decodedStanza = gfind.decodeMcsDataMessageStanza(frames[1].payload);
    assert.equal(decodedStanza.persistentId, "pid-1");
    assert.equal(decodedStanza.appData.key, "val");
});

test("owner_key plain GCM + index-keyed finder_hw, 48B CBC/60B GCM/MCU flip_bits EIK unwrap, ownerKeyVersion mismatch, and ringKey", () => {
    const domainKey = crypto.createHash("sha256").update("finder_hw_domain_key").digest();
    const ownerKey = crypto.createHash("sha256").update("owner_key_v2").digest();
    const encryptedOwnerKey = gfind.encryptOwnerKey(domainKey, ownerKey, Buffer.alloc(12, 0x11));

    // Reference response_parser._transform_to_byte_array shape: {"0": b0, "1": b1, ...}
    const indexKeyedDomainKey = Object.fromEntries([...domainKey.entries()].map(([i, b]) => [String(i), b]));
    const extracted = gfind.extractFinderHwDomainKey({
        finder_hw: [{ epoch: 1, key: Buffer.alloc(32, 0x01).toString("base64") }, { epoch: 2, key: indexKeyedDomainKey }]
    });
    assert.equal(extracted.equals(domainKey), true);
    assert.equal(gfind.decryptOwnerKey(extracted, encryptedOwnerKey).equals(ownerKey), true);

    assert.throws(() => {
        const tampered = Buffer.from(encryptedOwnerKey);
        tampered[tampered.length - 1] ^= 0xff;
        gfind.decryptOwnerKey(extracted, tampered);
    });

    // Also verify SECUREBOX v2 primitive still round-trips for shared-key chain callers
    const sbCipher = gfind.encryptSecureBoxV2(domainKey, ownerKey, Buffer.alloc(12, 0x12));
    assert.equal(gfind.decryptSecureBoxV2(domainKey, sbCipher).equals(ownerKey), true);

    const eik = crypto.createHash("sha256").update("device-eik").digest();

    // 60B AES-256-GCM EIK
    const encEik60 = makeFakeSafeGcm(ownerKey, eik, Buffer.alloc(12, 0x22));
    assert.equal(encEik60.length, 60);
    const ok60 = gfind.unwrapDeviceEik({
        ownerKey,
        encryptedIdentityKey: encEik60,
        deviceOwnerKeyVersion: 5,
        expectedOwnerKeyVersion: 5
    });
    assert.equal(ok60.ownerKeyVersionMismatch, false);
    assert.equal(ok60.eik.equals(eik), true);

    // 48B AES-256-CBC (no padding: iv16 || ct32) EIK
    const iv16 = Buffer.alloc(16, 0x33);
    const cbcCipher = crypto.createCipheriv("aes-256-cbc", ownerKey, iv16);
    cbcCipher.setAutoPadding(false);
    const encEik48 = Buffer.concat([iv16, cbcCipher.update(eik), cbcCipher.final()]);
    assert.equal(encEik48.length, 48);
    const ok48 = gfind.unwrapDeviceEik({ ownerKey, encryptedIdentityKey: encEik48 });
    assert.equal(ok48.eik.equals(eik), true);

    // MCU tracker fastPairModelId "003200": XOR 0xFF first (flip_bits) before decrypt
    const encEikMcu = Buffer.from(encEik48.map(b => b ^ 0xff));
    const okMcu = gfind.unwrapDeviceEik({
        ownerKey,
        encryptedIdentityKey: encEikMcu,
        fastPairModelId: "003200"
    });
    assert.equal(okMcu.eik.equals(eik), true);

    // Unsupported length errors
    assert.throws(() => gfind.unwrapDeviceEik({ ownerKey, encryptedIdentityKey: Buffer.alloc(32) }));

    const verMismatch = gfind.unwrapDeviceEik({
        ownerKey,
        encryptedIdentityKey: encEik60,
        deviceOwnerKeyVersion: 4,
        expectedOwnerKeyVersion: 5
    });
    assert.equal(verMismatch.eik, null);
    assert.equal(verMismatch.ownerKeyVersionMismatch, true);

    const wrongKey = gfind.unwrapDeviceEik({
        ownerKey: Buffer.alloc(32, 0x99),
        encryptedIdentityKey: encEik60
    });
    assert.equal(wrongKey.eik, null);
    assert.equal(wrongKey.ownerKeyVersionMismatch, true);

    const expectedRing = crypto.createHash("sha256").update(Buffer.concat([eik, Buffer.from([0x02])])).digest().subarray(0, 8);
    assert.equal(gfind.deriveRingKey(eik).equals(expectedRing), true);
});

test("Dual-curve rolling EID generator (SECP160R1 20B + SECP256R1 32B) matches reference math", () => {
    const eik = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
    const ts = 1730000123;
    const K = 10;

    // 1. Verify FMDN PRF block layout
    const prfBlock = gfind.buildFmdnPrfBlock(ts, K);
    assert.equal(prfBlock.length, 32);
    assert.equal(prfBlock.subarray(0, 11).equals(Buffer.alloc(11, 0xff)), true);
    assert.equal(prfBlock[11], 10);
    assert.equal(prfBlock.readUInt32BE(12), Math.floor(ts / 1024) * 1024);
    assert.equal(prfBlock.subarray(16, 27).equals(Buffer.alloc(11, 0x00)), true);
    assert.equal(prfBlock[27], 10);
    assert.equal(prfBlock.readUInt32BE(28), Math.floor(ts / 1024) * 1024);

    // 2. Verify SECP160R1 20B EID against independent affine scalar multiplication
    const eid160 = gfind.generateEid(eik, ts, K, "secp160r1");
    assert.equal(eid160.length, 20);
    const scalar160 = gfind.deriveFmdnScalar(eik, ts, K, gfind.SECP160R1);
    const [refX] = independentSecp160r1ScalarMult(scalar160, gfind.SECP160R1.Gx, gfind.SECP160R1.Gy);
    assert.equal(eid160.equals(gfind.bigIntToFixedBuffer(refX, 20)), true);

    // 3. Verify SECP256R1 32B EID
    const eid256 = gfind.generateEid(eik, ts, K, "secp256r1");
    assert.equal(eid256.length, 32);
    const scalar256 = gfind.deriveFmdnScalar(eik, ts, K, gfind.SECP256R1);
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(gfind.bigIntToFixedBuffer(scalar256, 32));
    assert.equal(eid256.equals(ecdh.getPublicKey().subarray(1, 33)), true);

    // 4. Rolling window (t-2P..t+4P) yields 7 distinct EIDs
    const rolling = gfind.generateRollingEids({ eik, nowSec: ts, rotationExponent: K, curve: "secp160r1" });
    assert.equal(rolling.eidsHex.length, 7);
    assert.equal(rolling.periodSec, 1024);
});

test("Own-report AES-GCM and Crowdsourced SECP160R1/SECP256R1 + AES-256-EAX location decryption", () => {
    const eik = crypto.createHash("sha256").update("track-eik-loc").digest();
    const locBytes = gfind.encodeLocation({ latitude: 37.7749, longitude: -122.4194, altitude: 42 });

    // Own report
    const ownKey = crypto.createHash("sha256").update(eik).digest();
    const ownCipher = makeFakeSafeGcm(ownKey, locBytes, Buffer.alloc(12, 0x44));
    const ownDecoded = gfind.decryptOwnLocationReport(eik, ownCipher);
    assert.ok(Math.abs(ownDecoded.latitude - 37.7749) < 1e-6);
    assert.ok(Math.abs(ownDecoded.longitude - -122.4194) < 1e-6);
    assert.equal(ownDecoded.altitude, 42);

    // Crowdsourced SECP160R1 (20B) — reference flow: nonce = R.x[-8:] || S.x[-8:], payload = ciphertext || tag
    const offsetSec = 1730000000;
    const r160 = gfind.deriveFmdnScalar(eik, offsetSec, 10, gfind.SECP160R1);
    const [rxFull, ryFull] = independentSecp160r1ScalarMult(r160, gfind.SECP160R1.Gx, gfind.SECP160R1.Gy);
    const rx160Buf = gfind.bigIntToFixedBuffer(rxFull, 20);
    let s160 = 123456789n;
    let [sx160, sy160] = independentSecp160r1ScalarMult(s160, gfind.SECP160R1.Gx, gfind.SECP160R1.Gy);
    if ((sy160 & 1n) === 1n) {
        s160 = gfind.SECP160R1.n - s160;
        [sx160, sy160] = independentSecp160r1ScalarMult(s160, gfind.SECP160R1.Gx, gfind.SECP160R1.Gy);
    }
    const sx160Buf = gfind.bigIntToFixedBuffer(sx160, 20);
    const [sharedX160] = independentSecp160r1ScalarMult(s160, rxFull, ryFull);
    const aesKey160 = gfind.hkdfSha256(gfind.bigIntToFixedBuffer(sharedX160, 20), Buffer.alloc(0), Buffer.alloc(0), 32);
    const nonce160 = Buffer.concat([rx160Buf.subarray(rx160Buf.length - 8), sx160Buf.subarray(sx160Buf.length - 8)]);
    const eax160 = gfind.aes256EaxEncrypt(aesKey160, nonce160, locBytes);
    const csPayload160 = Buffer.concat([eax160.ciphertext, eax160.tag]);

    const csDecoded160 = gfind.decryptCrowdsourcedLocationReport({
        eik,
        encryptedLocation: csPayload160,
        publicKeyRandom: sx160Buf,
        deviceTimeOffset: offsetSec,
        rotationExponent: 10
    });
    assert.ok(Math.abs(csDecoded160.latitude - 37.7749) < 1e-6);
    assert.ok(Math.abs(csDecoded160.longitude - -122.4194) < 1e-6);
    assert.equal(csDecoded160.altitude, 42);

    // Tampered EAX tag fails
    const badCs = Buffer.from(csPayload160);
    badCs[badCs.length - 1] ^= 0x01;
    assert.throws(() =>
        gfind.decryptCrowdsourcedLocationReport({
            eik,
            encryptedLocation: badCs,
            publicKeyRandom: sx160Buf,
            deviceTimeOffset: offsetSec,
            rotationExponent: 10
        })
    );

    // Crowdsourced SECP256R1 (32B) with MCU time counter = 0 and R.x[-8:] || S.x[-8:] nonce
    const r256 = gfind.deriveFmdnScalar(eik, 0, 10, gfind.SECP256R1);
    const ownerEcdh = crypto.createECDH("prime256v1");
    ownerEcdh.setPrivateKey(gfind.bigIntToFixedBuffer(r256, 32));
    const ownerCompressed = ownerEcdh.getPublicKey(null, "compressed");
    const rx256Buf = ownerCompressed.subarray(1, 33);

    const finderEcdh = crypto.createECDH("prime256v1");
    let finderPub;
    while (true) {
        finderEcdh.generateKeys();
        finderPub = finderEcdh.getPublicKey(null, "compressed");
        if (finderPub[0] === 0x02) break; // even y
    }
    const sx256Buf = finderPub.subarray(1, 33);
    const shared256 = finderEcdh.computeSecret(ownerCompressed);
    const aesKey256 = gfind.hkdfSha256(shared256, Buffer.alloc(0), Buffer.alloc(0), 32);
    const nonce256 = Buffer.concat([rx256Buf.subarray(rx256Buf.length - 8), sx256Buf.subarray(sx256Buf.length - 8)]);
    const eax256 = gfind.aes256EaxEncrypt(aesKey256, nonce256, locBytes);
    const csDecoded256 = gfind.decryptCrowdsourcedLocationReport({
        eik,
        encryptedLocation: Buffer.concat([eax256.ciphertext, eax256.tag]),
        publicKeyRandom: sx256Buf,
        deviceTimeOffset: 0,
        rotationExponent: 10
    });
    assert.ok(Math.abs(csDecoded256.latitude - 37.7749) < 1e-6);
});

test("14-byte 0xFE2C BLE GATT ring packet HMAC-SHA256 vector", () => {
    const ringKey = Buffer.from("0102030405060708", "hex");
    const nonce = Buffer.from("a1a2a3a4a5a6a7a8", "hex");
    const version = 0x01;

    const pktStart = gfind.buildBleRingPacket({
        ringKey,
        version,
        nonce,
        action: "start",
        component: "left",
        timeoutDeciseconds: 0x0258,
        volume: 0xff
    });
    assert.equal(pktStart.length, 14);
    assert.equal(pktStart[0], 0x05);
    assert.equal(pktStart[1], 0x0c);
    assert.deepEqual([...pktStart.subarray(10, 14)], [0x02, 0x02, 0x58, 0xff]);
    const expectedMac = crypto
        .createHmac("sha256", ringKey)
        .update(Buffer.concat([Buffer.from([version]), nonce, Buffer.from([0x05, 0x0c, 0x02, 0x02, 0x58, 0xff])]))
        .digest()
        .subarray(0, 8);
    assert.equal(pktStart.subarray(2, 10).equals(expectedMac), true);

    const pktStop = gfind.buildBleRingPacket({ ringKey, version, nonce, action: "stop" });
    assert.equal(pktStop.length, 14);
    assert.deepEqual([...pktStop.subarray(10, 14)], [0x00, 0x00, 0x00, 0x00]);
});

test("gfindMapper maps Spot tags/earbuds to Items and Android phones/tablets to Devices", async () => {
    const ownerKey = crypto.createHash("sha256").update("mapper-owner").digest();
    const eik = crypto.createHash("sha256").update("mapper-eik").digest();
    const encEik = makeFakeSafeGcm(ownerKey, eik, Buffer.alloc(12, 0x77));
    const ownLoc = makeFakeSafeGcm(
        crypto.createHash("sha256").update(eik).digest(),
        gfind.encodeLocation({ latitude: 47.6062, longitude: -122.3321, altitude: 10 }),
        Buffer.alloc(12, 0x88)
    );

    const tagRecord = await gfind.mapProtoDeviceToFindMy(
        {
            userDefinedDeviceName: "House Keys",
            identifierInformation: {
                type: gfind.IdentifierInformationType.IDENTIFIER_SPOT,
                trackerInformation: { canonicIds: ["tag-keys-1"] }
            },
            information: {
                deviceRegistration: {
                    spotDeviceType: gfind.SpotDeviceType.DEVICE_TYPE_KEYS,
                    manufacturer: "Pebblebee",
                    model: "Clip",
                    fastPairModelId: "pb-clip",
                    rotationExponent: 10,
                    encryptedKeys: { ownerKeyVersion: 2, encryptedIdentityKey: encEik }
                },
                reports: [
                    {
                        timestampSeconds: 1730000000,
                        geoLocation: { encryptedReport: { encryptedLocation: ownLoc, isOwnReport: true }, accuracy: 10 }
                    }
                ]
            }
        },
        {
            ownerKey,
            ownerKeyVersion: 2,
            reverseGeocodeFn: async () => ({
                label: "Seattle, WA",
                mapItemFullAddress: "100 Pike St, Seattle, WA",
                streetAddress: "100 Pike St",
                locality: "Seattle",
                stateCode: "WA",
                country: "United States"
            })
        }
    );
    assert.equal(tagRecord.device.id, "gfind:tag-keys-1");
    assert.equal(tagRecord.device.isConsideredAccessory, true);
    assert.equal(tagRecord.device.role.emoji, "🔑");
    assert.equal(tagRecord.device.features.TRACKER_PROVIDER, "gfind");
    assert.equal(tagRecord.device.features.CAN_FIND_NEARBY, true);
    assert.equal(tagRecord.device.features.HAS_BLE_RING, true);
    assert.equal(tagRecord.device.features.SUPPORTS_UWB, true);
    assert.deepEqual(tagRecord.device.features.RING_COMPONENTS, []);
    assert.ok(Math.abs(tagRecord.device.crowdSourcedLocation.latitude - 47.6062) < 1e-5);
    assert.ok(Math.abs(tagRecord.device.location.latitude - 47.6062) < 1e-5);

    const budsRecord = await gfind.mapProtoDeviceToFindMy(
        {
            userDefinedDeviceName: "Pixel Buds Pro 2",
            identifierInformation: {
                type: gfind.IdentifierInformationType.IDENTIFIER_SPOT,
                trackerInformation: { canonicIds: ["buds-1"] }
            },
            information: {
                deviceRegistration: {
                    spotDeviceType: gfind.SpotDeviceType.DEVICE_TYPE_HEADPHONES,
                    manufacturer: "Google",
                    model: "Pixel Buds Pro 2"
                },
                reports: [{ semanticLocation: { locationName: "Office" }, timestampSeconds: 1730000000 }]
            }
        },
        { ownerKey: null, ownerKeyVersion: null }
    );
    assert.equal(budsRecord.device.isConsideredAccessory, true);
    assert.equal(budsRecord.device.role.emoji, "🎧");
    assert.deepEqual(budsRecord.device.features.RING_COMPONENTS, ["left", "right", "case"]);
    assert.equal(budsRecord.device.short_address, "Office");

    const phoneRecord = await gfind.mapProtoDeviceToFindMy(
        {
            userDefinedDeviceName: "Pixel 9 Pro",
            identifierInformation: {
                type: gfind.IdentifierInformationType.IDENTIFIER_ANDROID,
                phoneInformation: {
                    canonicIds: ["phone-1"],
                    manufacturer: "Google",
                    modelNumber: "Pixel 9 Pro",
                    deviceInformation: {
                        reports: [
                            {
                                timestampSeconds: 1730000500,
                                geoLocation: {
                                    accuracy: 5,
                                    unencryptedLocation: { latitude: 37.422, longitude: -122.084 }
                                }
                            }
                        ]
                    }
                }
            }
        },
        { ownerKey: null, ownerKeyVersion: null, reverseGeocodeFn: async () => null }
    );
    assert.equal(phoneRecord.device.id, "gfind:phone-1");
    assert.equal(phoneRecord.device.isConsideredAccessory, false);
    assert.equal(phoneRecord.device.deviceModel, "AndroidPhone");
    assert.equal(phoneRecord.device.features.SUPPORTS_UWB, false);
    assert.ok(Math.abs(phoneRecord.device.location.latitude - 37.422) < 1e-5);
    assert.equal(phoneRecord.device.crowdSourcedLocation, null);

    const ownRecord = await gfind.mapProtoDeviceToFindMy(
        {
            userDefinedDeviceName: "Own Report Keys",
            identifierInformation: {
                type: gfind.IdentifierInformationType.IDENTIFIER_SPOT,
                trackerInformation: { canonicIds: ["tag-own-empty-pub"] }
            },
            information: {
                deviceRegistration: {
                    spotDeviceType: gfind.SpotDeviceType.DEVICE_TYPE_KEYS,
                    encryptedKeys: { ownerKeyVersion: 2, encryptedIdentityKey: encEik }
                },
                reports: [
                    {
                        timestampSeconds: 1730000000,
                        // Reference branches on empty publicKeyRandom even if isOwnReport is false
                        geoLocation: { encryptedReport: { encryptedLocation: ownLoc, isOwnReport: false }, accuracy: 8 }
                    }
                ]
            }
        },
        { ownerKey, ownerKeyVersion: 2, reverseGeocodeFn: async () => null }
    );
    assert.ok(Math.abs(ownRecord.device.crowdSourcedLocation.latitude - 47.6062) < 1e-5);

    // MCU "003200" forces time_offset = 0 in gfindMapper even if geo.deviceTimeOffset is non-zero
    const mcuEik = crypto.createHash("sha256").update("mcu-eik").digest();
    const ivMcu = Buffer.alloc(16, 0x2a);
    const cbcMcu = crypto.createCipheriv("aes-256-cbc", ownerKey, ivMcu);
    cbcMcu.setAutoPadding(false);
    const encMcuEikRaw = Buffer.concat([ivMcu, cbcMcu.update(mcuEik), cbcMcu.final()]);
    const encMcuEikFlipped = Buffer.from(encMcuEikRaw.map(b => b ^ 0xff));
    const rMcu = gfind.deriveFmdnScalar(mcuEik, 0, 10, gfind.SECP160R1);
    const [rxMcu, ryMcu] = independentSecp160r1ScalarMult(rMcu, gfind.SECP160R1.Gx, gfind.SECP160R1.Gy);
    const rxMcuBuf = gfind.bigIntToFixedBuffer(rxMcu, 20);
    let sMcu = 987654321n;
    let [sxMcu, syMcu] = independentSecp160r1ScalarMult(sMcu, gfind.SECP160R1.Gx, gfind.SECP160R1.Gy);
    if ((syMcu & 1n) === 1n) {
        sMcu = gfind.SECP160R1.n - sMcu;
        [sxMcu, syMcu] = independentSecp160r1ScalarMult(sMcu, gfind.SECP160R1.Gx, gfind.SECP160R1.Gy);
    }
    const sxMcuBuf = gfind.bigIntToFixedBuffer(sxMcu, 20);
    const [sharedMcuX] = independentSecp160r1ScalarMult(sMcu, rxMcu, ryMcu);
    const mcuAesKey = gfind.hkdfSha256(gfind.bigIntToFixedBuffer(sharedMcuX, 20), Buffer.alloc(0), Buffer.alloc(0), 32);
    const mcuNonce = Buffer.concat([rxMcuBuf.subarray(rxMcuBuf.length - 8), sxMcuBuf.subarray(sxMcuBuf.length - 8)]);
    const mcuEax = gfind.aes256EaxEncrypt(
        mcuAesKey,
        mcuNonce,
        gfind.encodeLocation({ latitude: 51.5074, longitude: -0.1278 })
    );
    const mcuRecord = await gfind.mapProtoDeviceToFindMy(
        {
            userDefinedDeviceName: "MCU Tag",
            identifierInformation: {
                type: gfind.IdentifierInformationType.IDENTIFIER_SPOT,
                trackerInformation: { canonicIds: ["tag-mcu-1"] }
            },
            information: {
                deviceRegistration: {
                    spotDeviceType: gfind.SpotDeviceType.DEVICE_TYPE_BEACON,
                    fastPairModelId: "003200",
                    rotationExponent: 10,
                    encryptedKeys: { ownerKeyVersion: 2, encryptedIdentityKey: encMcuEikFlipped }
                },
                reports: [
                    {
                        timestampSeconds: 1730000000,
                        geoLocation: {
                            deviceTimeOffset: 999999,
                            encryptedReport: {
                                encryptedLocation: Buffer.concat([mcuEax.ciphertext, mcuEax.tag]),
                                publicKeyRandom: sxMcuBuf
                            }
                        }
                    }
                ]
            }
        },
        { ownerKey, ownerKeyVersion: 2, reverseGeocodeFn: async () => null }
    );
    assert.ok(Math.abs(mcuRecord.device.crowdSourcedLocation.latitude - 51.5074) < 1e-5);

    const mismatchRecord = await gfind.mapProtoDeviceToFindMy(
        {
            userDefinedDeviceName: "Rotated Tag",
            identifierInformation: {
                type: gfind.IdentifierInformationType.IDENTIFIER_SPOT,
                trackerInformation: { canonicIds: ["tag-rot-1"] }
            },
            information: {
                deviceRegistration: {
                    spotDeviceType: gfind.SpotDeviceType.DEVICE_TYPE_BEACON,
                    encryptedKeys: { ownerKeyVersion: 1, encryptedIdentityKey: encEik }
                },
                reports: [
                    {
                        timestampSeconds: 1730000000,
                        geoLocation: { encryptedReport: { encryptedLocation: ownLoc, isOwnReport: true } }
                    }
                ]
            }
        },
        { ownerKey, ownerKeyVersion: 2 }
    );
    assert.equal(mismatchRecord.ownerKeyVersionMismatch, true);
    assert.equal(mismatchRecord.device.short_address, "E2EE Key Rotation Required");
});

test("End-to-end GoogleFindService flow, FCM gating/stop/dedup, and zero secret leaks in getBleSpec", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfind-test-"));
    try {
        const trackerDeps = makeMemoryTrackerDeps(tmpDir);
        const domainKey = crypto.createHash("sha256").update("e2e-domain").digest();
        const ownerKey = crypto.createHash("sha256").update("e2e-owner").digest();
        const eik = crypto.createHash("sha256").update("e2e-eik").digest();
        const encOwnerKey = gfind.encryptOwnerKey(domainKey, ownerKey);
        const iv16 = Buffer.alloc(16, 0x45);
        const cbc = crypto.createCipheriv("aes-256-cbc", ownerKey, iv16);
        cbc.setAutoPadding(false);
        const encEik = Buffer.concat([iv16, cbc.update(eik), cbc.final()]);
        const ownLoc = makeFakeSafeGcm(
            crypto.createHash("sha256").update(eik).digest(),
            gfind.encodeLocation({ latitude: 40.7128, longitude: -74.006 })
        );

        let tlsConnectCount = 0;
        let lastSock = null;
        const sentMcsFrames = [];
        let executedActions = 0;
        let enabled = false;

        const checkinResp = gfind.encodeRawFields([
            {
                fieldNumber: 7,
                wireType: gfind.WIRE_FIXED64,
                value: (() => {
                    const b = Buffer.alloc(8);
                    b.writeBigUInt64LE(111111n, 0);
                    return b;
                })()
            },
            {
                fieldNumber: 8,
                wireType: gfind.WIRE_FIXED64,
                value: (() => {
                    const b = Buffer.alloc(8);
                    b.writeBigUInt64LE(222222n, 0);
                    return b;
                })()
            }
        ]);

        const emitted = [];
        const service = new gfind.GoogleFindService({
            trackerDeps,
            isEnabled: () => enabled,
            emitDevice: d => emitted.push(d),
            reverseGeocodeFn: async () => null,
            locateTimeoutMs: 500,
            minLocateIntervalMs: 10_000,
            authDeps: {
                trackerDeps,
                httpPost: async (url, body) => {
                    if (url.includes("/checkin")) return checkinResp;
                    const form = new URLSearchParams(String(body));
                    if (form.get("service") === "ac2dm") {
                        assert.equal(form.get("droidguard_results"), "dummy123");
                        assert.equal(form.get("has_permission"), "1");
                        assert.equal(form.get("sdk_version"), "17");
                        return Buffer.from("Email=user@example.com\nToken=aas_et/SUPER_SECRET_AAS\n", "utf8");
                    }
                    assert.equal(form.get("EncryptedPasswd"), "aas_et/SUPER_SECRET_AAS");
                    assert.equal(form.get("has_permission"), "1");
                    if (String(form.get("service")).includes("android_device_manager")) {
                        assert.equal(form.get("app"), "com.google.android.apps.adm");
                        return Buffer.from("Auth=adm_token_123\n", "utf8");
                    }
                    assert.equal(form.get("app"), "com.google.android.gms");
                    return Buffer.from("Auth=spot_token_123\n", "utf8");
                }
            },
            fcmDeps: {
                httpPost: async (url, body) => {
                    if (url.includes("/c2dm/register3")) {
                        const form = new URLSearchParams(body);
                        assert.equal(form.get("app"), "org.chromium.linux");
                        assert.match(String(form.get("X-subtype")), /^wp:com\.google\.android\.apps\.adm#/);
                        return "token=gcm_tok_123";
                    }
                    if (url.includes("firebaseinstallations.googleapis.com")) {
                        return JSON.stringify({ authToken: { token: "fis_auth_123" } });
                    }
                    if (url.includes("fcmregistrations.googleapis.com")) {
                        const parsed = JSON.parse(body);
                        assert.equal(parsed.web.endpoint, "https://fcm.googleapis.com/fcm/send/gcm_tok_123");
                        return JSON.stringify({ token: "fcm_reg_123" });
                    }
                    throw new Error(`Unexpected FCM URL: ${url}`);
                },
                connectTls: () => {
                    tlsConnectCount += 1;
                    const sock = new Duplex({
                        read() {},
                        write(chunk, _enc, cb) {
                            sentMcsFrames.push(Buffer.from(chunk));
                            cb();
                        }
                    });
                    sock.destroy = () => {
                        sock.destroyed = true;
                        sock.end();
                        return sock;
                    };
                    lastSock = sock;
                    queueMicrotask(() => sock.emit("secureConnect"));
                    return sock;
                }
            },
            clientDeps: {
                spotGrpcCall: async () => {
                    const msg = gfind.encodeGetEidInfoForE2eeDevicesResponse({
                        ownerKeys: [{ encryptedOwnerKey: encOwnerKey, ownerKeyVersion: 7, securityDomain: "finder_hw" }]
                    });
                    const hdr = Buffer.alloc(5);
                    hdr[0] = 0;
                    hdr.writeUInt32BE(msg.length, 1);
                    return Buffer.concat([hdr, msg]);
                },
                novaPost: async (endpoint, body) => {
                    if (endpoint === "nbe_list_devices") {
                        const reqFields = gfind.decodeRawFields(body);
                        const payloadFields = gfind.decodeRawFields(reqFields.find(f => f.fieldNumber === 1).value);
                        const reqType = Number(payloadFields.find(f => f.fieldNumber === 1).value);
                        if (reqType === gfind.NovaDeviceType.SPOT_DEVICE) {
                            return {
                                status: 200,
                                data: gfind.encodeDevicesList({
                                    deviceMetadata: [
                                        {
                                            userDefinedDeviceName: "Wallet Tag",
                                            identifierInformation: {
                                                type: gfind.IdentifierInformationType.IDENTIFIER_SPOT,
                                                trackerInformation: { canonicIds: ["spot-wallet-1"] }
                                            },
                                            information: {
                                                deviceRegistration: {
                                                    spotDeviceType: gfind.SpotDeviceType.DEVICE_TYPE_WALLET,
                                                    encryptedKeys: { ownerKeyVersion: 7, encryptedIdentityKey: encEik }
                                                },
                                                reports: [
                                                    {
                                                        timestampSeconds: 1730001000,
                                                        geoLocation: { encryptedReport: { encryptedLocation: ownLoc, isOwnReport: true } }
                                                    }
                                                ]
                                            }
                                        }
                                    ]
                                })
                            };
                        }
                        return { status: 200, data: gfind.encodeDevicesList({ deviceMetadata: [] }) };
                    }
                    if (endpoint === "nbe_execute_action") {
                        executedActions += 1;
                        return { status: 200, data: Buffer.alloc(0) };
                    }
                    return { status: 404, data: Buffer.alloc(0) };
                }
            }
        });

        // Disabled -> start() must NOT open MCS TLS
        service.start();
        assert.equal(tlsConnectCount, 0);

        // Enable + sign in -> opens MCS TLS once
        enabled = true;
        const oauthRes = await service.completeOAuthToken("oauth2_code_xyz");
        await new Promise(r => setImmediate(r));
        assert.equal(oauthRes.connected, true);
        assert.equal(oauthRes.email, "user@example.com");
        const kdiFields = gfind.decodeRawFields(Buffer.from(oauthRes.kdi, "base64"));
        assert.equal(kdiFields.find(f => f.fieldNumber === 1).value, 1n);
        assert.equal(tlsConnectCount, 1);

        // Simulate MCS LoginResponse + push DeviceUpdate with duplicate persistentId
        const loginResp = gfind.encodeMcsFrame(gfind.MCS_TAG_LOGIN_RESPONSE, Buffer.from([0x0a, 0x02, 0x6f, 0x6b]));
        lastSock.emit("data", Buffer.concat([Buffer.from([gfind.MCS_VERSION]), loginResp]));

        // Complete vault unlock (with index-keyed finder_hw key) -> refreshes devices
        const indexDomainKey = Object.fromEntries([...domainKey.entries()].map(([i, b]) => [String(i), b]));
        const unlocked = await service.completeVaultUnlock({
            vaultKeys: JSON.stringify({ finder_hw: [{ epoch: 1, key: indexDomainKey }] })
        });
        assert.equal(unlocked.e2eeUnlocked, true);
        assert.equal(unlocked.tagCount, 1);
        assert.equal(unlocked.fcmConnected, true);
        assert.equal(emitted.length, 1);

        // BleSpec must NOT expose aas_token, owner_key, or raw EIK
        const spec = service.getBleSpec("gfind:spot-wallet-1");
        assert.equal(spec.provider, "gfind");
        assert.equal(spec.serviceUuid, "feaa");
        assert.equal(spec.eidsHex.length, 7);
        const serializedSpec = JSON.stringify(spec);
        assert.equal(serializedSpec.includes("SUPER_SECRET_AAS"), false);
        assert.equal(serializedSpec.includes(ownerKey.toString("hex")), false);
        assert.equal(serializedSpec.includes(eik.toString("hex")), false);

        // Ring + 10s per-device floor on targeted locate (completeVaultUnlock already triggered 1 locate)
        assert.equal(executedActions, 1);
        await service.ringDevice("gfind:spot-wallet-1", "start");
        assert.equal(executedActions, 2);
        await service.refreshDevices("gfind:spot-wallet-1");
        assert.equal(executedActions, 2, "10s per-device floor should throttle rapid locate");

        // WebPush JSON FCM_PAYLOAD + SelectiveAck + persistentId dedup
        const updatePayload = gfind.encodeDeviceUpdate({
            deviceMetadata: {
                userDefinedDeviceName: "Wallet Tag Renamed",
                identifierInformation: {
                    type: gfind.IdentifierInformationType.IDENTIFIER_SPOT,
                    trackerInformation: { canonicIds: ["spot-wallet-1"] }
                }
            }
        });
        const jsonFcmRaw = Buffer.from(
            JSON.stringify({
                data: { "com.google.android.apps.adm.FCM_PAYLOAD": updatePayload.toString("base64") }
            }),
            "utf8"
        );
        const stanza = gfind.encodeMcsDataMessageStanza({
            persistentId: "dup-pid-1",
            streamId: 1,
            appData: {},
            rawData: jsonFcmRaw
        });
        lastSock.emit("data", stanza);
        await new Promise(r => setTimeout(r, 20));
        assert.equal(service.getCachedDevices()[0].name, "Wallet Tag Renamed");
        const ackBuf = Buffer.concat(sentMcsFrames);
        assert.equal(ackBuf.includes(Buffer.from("dup-pid-1")), true, "SelectiveAck should include persistentId");

        // Clean stop() and disconnect()
        service.disconnect();
        assert.equal(service.getStatus().connected, false);
        assert.equal(service.getCachedDevices().length, 0);
        assert.equal(lastSock.destroyed, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("gfindProto upstream wire numbers, ExecuteAction layout, and sanitized HTTP error handling", () => {
    assert.equal(gfind.SpotDeviceType.DEVICE_TYPE_EARBUDS, 26);
    assert.equal(gfind.ExecuteActionLocationType.FMDN_HIGH_TRAFFIC, 1);
    assert.equal(gfind.ExecuteActionLocationType.FMDN_ALL_LOCATIONS, 2);

    const execBuf = gfind.encodeExecuteActionRequest({
        deviceType: gfind.NovaDeviceType.SPOT_DEVICE,
        canonicId: "spot-abc",
        requestUuid: "req-uuid-1",
        fmdClientUuid: "client-uuid-1",
        fcmRegistrationId: "fcm-reg-1",
        action: { kind: "locateTracker", contributors: [gfind.ExecuteActionLocationType.FMDN_ALL_LOCATIONS] }
    });
    const execTop = gfind.decodeRawFields(execBuf);
    const scope = gfind.decodeRawFields(execTop.find(f => f.fieldNumber === 1).value);
    assert.equal(scope.find(f => f.fieldNumber === 2).value, BigInt(gfind.NovaDeviceType.SPOT_DEVICE));
    const dev = gfind.decodeRawFields(scope.find(f => f.fieldNumber === 3).value);
    const canonic = gfind.decodeRawFields(dev.find(f => f.fieldNumber === 1).value);
    assert.equal(canonic.find(f => f.fieldNumber === 1).value.toString("utf8"), "spot-abc");

    const meta = gfind.decodeRawFields(execTop.find(f => f.fieldNumber === 3).value);
    assert.equal(meta.find(f => f.fieldNumber === 3).value.toString("utf8"), "client-uuid-1");
    const gcmReg = gfind.decodeRawFields(meta.find(f => f.fieldNumber === 4).value);
    assert.equal(gcmReg.find(f => f.fieldNumber === 1).value.toString("utf8"), "fcm-reg-1");

    const selAckFrame = gfind.encodeMcsSelectiveAck(["p-1"]);
    assert.equal(selAckFrame[0], gfind.MCS_TAG_IQ_STANZA);
});

test("Live pre-auth smoke: Android checkin, EmbeddedSetup URL, and /auth params pass droidguard validation", async t => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfind-live-"));
    try {
        const auth = new gfind.GoogleFindAuthManager({ trackerDeps: makeMemoryTrackerDeps(tmpDir) });
        let checkin;
        try {
            checkin = await auth.ensureCheckin();
        } catch (err) {
            const msg = String(err?.message ?? err);
            if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ENETUNREACH/i.test(msg)) {
                t.skip(`Offline sandbox: ${msg}`);
                return;
            }
            throw err;
        }
        assert.ok(checkin.androidId > 0n, "live checkin should return non-zero androidId");
        assert.ok(checkin.securityToken > 0n, "live checkin should return non-zero securityToken");

        // Dummy oauth_token must reach BadAuthentication (403) rather than HTTP 400 MissingDroidguard
        await assert.rejects(
            () => auth.exchangeOAuthToken("oauth2_4/dummy_invalid_smoke_token"),
            err => {
                const msg = String(err?.message ?? err);
                assert.equal(msg.includes("MissingDroidguard"), false, `Unexpected MissingDroidguard: ${msg}`);
                assert.equal(msg.includes("HTTP 400"), false, `Unexpected HTTP 400: ${msg}`);
                assert.match(msg, /HTTP 403|BadAuthentication/);
                return true;
            }
        );

        const axios = require("axios");
        const setupRes = await axios.get("https://accounts.google.com/EmbeddedSetup", {
            timeout: 15_000,
            validateStatus: () => true
        });
        assert.equal(setupRes.status, 200);

        // Vault unlock URL wrapped via ServiceLogin must return HTTP 200 (never 401 Malformed)
        const kdi = gfind.encodeEncryptionUnlockKdi();
        const unlockServiceUrl = `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(
            `https://accounts.google.com/encryption/unlock/android?kdi=${encodeURIComponent(kdi)}`
        )}`;
        const unlockRes = await axios.get(unlockServiceUrl, {
            timeout: 15_000,
            validateStatus: () => true
        });
        assert.equal(unlockRes.status, 200);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("GoogleFindOAuthWindow uses persist:gfind-oauth, ServiceLogin wrapper, stripped UA, and handles vault IPC", async () => {
    installTsLoader();

    const vaultPayload = {
        vaultKeys: {
            finder_hw: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
        }
    };
    const extracted = gfind.extractFinderHwDomainKey(JSON.stringify(vaultPayload));
    assert.equal(extracted.length, 32);

    const partitionsSeen = [];
    const createdWindows = [];

    class FakeBrowserWindow {
        constructor(opts) {
            this.opts = opts;
            this.destroyed = false;
            this.events = new Map();
            this.loadedUrls = [];
            this.currentUrl = "https://accounts.google.com/encryption/unlock/android?kdi=abc";
            this.setUa = null;
            const ipcHandlers = new Map();
            const ipcListeners = new Map();
            this.webContents = {
                getURL: () => this.currentUrl,
                setUserAgent: ua => {
                    this.setUa = ua;
                },
                ipc: {
                    handle: (ch, fn) => ipcHandlers.set(ch, fn),
                    on: (ch, fn) => ipcListeners.set(ch, fn),
                    _handlers: ipcHandlers,
                    _listeners: ipcListeners
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

    let clearedStorage = 0;
    const fakeSession = {
        getUserAgent: () =>
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) BlueBubbles/1.9.9 Chrome/114.0.0.0 Electron/25.9.8 Safari/537.36",
        clearStorageData: async () => {
            clearedStorage += 1;
        },
        cookies: {
            on: () => {},
            removeListener: () => {}
        }
    };

    const origLoad = Module._load;
    Module._load = function (request) {
        if (request === "@server/fileSystem") {
            return {
                FileSystem: {
                    resources: path.join(__dirname, "..", "appResources")
                }
            };
        }
        if (request === "electron") {
            return {
                app: {
                    getPath: () => os.tmpdir(),
                    getName: () => "bluebubbles-server",
                    getVersion: () => "1.9.9",
                    isPackaged: false
                },
                BrowserWindow: FakeBrowserWindow,
                session: {
                    fromPartition: p => {
                        partitionsSeen.push(p);
                        return fakeSession;
                    }
                }
            };
        }
        return origLoad.apply(this, arguments);
    };

    let winMod;
    try {
        delete require.cache[require.resolve("../src/windows/GoogleFindOAuthWindow.ts")];
        winMod = require("../src/windows/GoogleFindOAuthWindow.ts");
    } finally {
        Module._load = origLoad;
    }

    const receivedKeys = [];
    winMod.GoogleFindOAuthWindow.open({
        mode: "vault",
        kdi: "TEST_KDI+1/2=",
        email: "user@example.com",
        onVaultKeys: async payload => {
            receivedKeys.push(payload);
        }
    });

    assert.deepEqual(partitionsSeen, ["persist:gfind-oauth"]);
    const win = createdWindows[0];
    assert.equal(win.loadedUrls.length, 1);
    const loadedUrl = new URL(win.loadedUrls[0].url);
    assert.equal(loadedUrl.origin, "https://accounts.google.com");
    assert.equal(loadedUrl.pathname, "/ServiceLogin");
    assert.equal(loadedUrl.searchParams.get("Email"), "user@example.com");
    assert.equal(
        loadedUrl.searchParams.get("continue"),
        "https://accounts.google.com/encryption/unlock/android?kdi=TEST_KDI%2B1%2F2%3D"
    );
    assert.equal(win.setUa.includes("Electron/"), false);
    assert.equal(win.setUa.includes("BlueBubbles/"), false);

    // Rejects non-Google origins
    win.currentUrl = "https://evil.example/";
    await assert.rejects(() => win.webContents.ipc._handlers.get("gfind-vault-keys")(null, { vaultKeys: "{}" }), /Unauthorized/);

    // Accepts Google origin and forwards keys
    win.currentUrl = "https://accounts.google.com/encryption/unlock/android?kdi=TEST_KDI";
    await win.webContents.ipc._handlers.get("gfind-vault-keys")(null, { vaultKeys: "{\"finder_hw\":\"abc\"}" });
    assert.equal(receivedKeys.length, 1);

    await win.webContents.ipc._handlers.get("gfind-vault-close")(null);
    assert.equal(win.isDestroyed(), true);

    await winMod.GoogleFindOAuthWindow.clearSession();
    assert.equal(clearedStorage, 1);
});

test("decodeDeviceUpdate field-2 deviceMetadata, sha256(eik||0x00) own-report fallback, and refreshDevices preserves FCM locations", async () => {
    installTsLoader();
    const { Duplex } = require("node:stream");

    // 1. DeviceUpdate with fcmMetadata on field 1 and deviceMetadata on field 2
    const metaBuf = gfind.encodeDeviceMetadata({
        userDefinedDeviceName: "Pixel 10",
        identifierInformation: {
            type: gfind.IdentifierInformationType.IDENTIFIER_ANDROID,
            phoneInformation: {
                canonicIds: ["android-pixel-10"],
                manufacturer: "Google",
                modelNumber: "Pixel 10"
            }
        }
    });
    const fcmMetaBuf = gfind.encodeRawFields([
        { fieldNumber: 1, wireType: gfind.WIRE_VARINT, value: BigInt(gfind.NovaDeviceType.ANDROID_DEVICE) },
        { fieldNumber: 2, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("req-field2-test", "utf8") }
    ]);
    const rawUpdate = gfind.encodeRawFields([
        { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: fcmMetaBuf },
        { fieldNumber: 2, wireType: gfind.WIRE_LENGTH_DELIMITED, value: metaBuf }
    ]);
    const decoded = gfind.decodeDeviceUpdate(rawUpdate);
    assert.equal(decoded.fcmMetadata?.requestUuid, "req-field2-test");
    assert.equal(decoded.deviceMetadata?.userDefinedDeviceName, "Pixel 10");

    // 2. Own location report encrypted with sha256(eik || 0x00)
    const eik = crypto.randomBytes(32);
    const keyWithZero = crypto.createHash("sha256").update(Buffer.concat([eik, Buffer.from([0x00])])).digest();
    const nonce = crypto.randomBytes(12);
    const plainLoc = gfind.encodeLocation({ latitude: 37.3861, longitude: -122.0839, altitude: 10 });
    const cipher = crypto.createCipheriv("aes-256-gcm", keyWithZero, nonce);
    const enc = Buffer.concat([nonce, cipher.update(plainLoc), cipher.final(), cipher.getAuthTag()]);
    const decrypted = gfind.decryptOwnLocationReport(eik, enc);
    assert.ok(Math.abs(decrypted.latitude - 37.3861) < 1e-5);
    assert.ok(Math.abs(decrypted.longitude - -122.0839) < 1e-5);

    // 3. refreshDevices() locates both Android + Spot and preserves FCM location across empty nbe_list_devices
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfind-refresh-"));
    try {
        const trackerDeps = makeMemoryTrackerDeps(tmpDir);
        const ownerKey = crypto.randomBytes(32);
        const locatedIds = [];
        let lastSock = null;

        const service = new gfind.GoogleFindService({
            trackerDeps,
            isEnabled: () => true,
            emitDevice: () => {},
            reverseGeocodeFn: async () => null,
            locateTimeoutMs: 300,
            minLocateIntervalMs: 0,
            authDeps: {
                trackerDeps,
                httpPost: async () => Buffer.from("Auth=tok_123\n", "utf8")
            },
            fcmDeps: {
                httpPost: async url => {
                    if (url.includes("/c2dm/register3")) return "token=gcm_1";
                    if (url.includes("firebaseinstallations")) return JSON.stringify({ authToken: { token: "fis_1" } });
                    return JSON.stringify({ token: "fcm_1" });
                },
                connectTls: () => {
                    const sock = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
                    sock.destroy = () => { sock.destroyed = true; return sock; };
                    lastSock = sock;
                    queueMicrotask(() => sock.emit("secureConnect"));
                    return sock;
                }
            },
            clientDeps: {
                novaPost: async (endpoint, body) => {
                    if (endpoint === "nbe_list_devices") {
                        const reqFields = gfind.decodeRawFields(body);
                        const payloadFields = gfind.decodeRawFields(reqFields.find(f => f.fieldNumber === 1).value);
                        const reqType = Number(payloadFields.find(f => f.fieldNumber === 1).value);
                        if (reqType === gfind.NovaDeviceType.ANDROID_DEVICE) {
                            return {
                                status: 200,
                                data: gfind.encodeDevicesList({
                                    deviceMetadata: [
                                        {
                                            userDefinedDeviceName: "Pixel 10",
                                            identifierInformation: {
                                                type: gfind.IdentifierInformationType.IDENTIFIER_ANDROID,
                                                phoneInformation: { canonicIds: ["android-1"] }
                                            }
                                        }
                                    ]
                                })
                            };
                        }
                        return {
                            status: 200,
                            data: gfind.encodeDevicesList({
                                deviceMetadata: [
                                    {
                                        userDefinedDeviceName: "WF-1000XM6",
                                        identifierInformation: {
                                            type: gfind.IdentifierInformationType.IDENTIFIER_SPOT,
                                            trackerInformation: { canonicIds: ["spot-1"] }
                                        }
                                    }
                                ]
                            })
                        };
                    }
                    if (endpoint === "nbe_execute_action") {
                        const top = gfind.decodeRawFields(body);
                        const scope = gfind.decodeRawFields(top.find(f => f.fieldNumber === 1).value);
                        const dev = gfind.decodeRawFields(scope.find(f => f.fieldNumber === 3).value);
                        const canonic = gfind.decodeRawFields(dev.find(f => f.fieldNumber === 1).value);
                        const id = canonic.find(f => f.fieldNumber === 1).value.toString("utf8");
                        locatedIds.push(id);
                        return { status: 200, data: Buffer.alloc(0) };
                    }
                    return { status: 404, data: Buffer.alloc(0) };
                }
            }
        });

        // Seed signed-in auth state
        const authMgr = service["auth"];
        authMgr.load();
        authMgr["state"].aasToken = "aas_et/TEST";
        authMgr["state"].androidId = "111";
        authMgr["state"].securityToken = "222";
        authMgr["state"].fcmToken = "fcm_1";
        authMgr["state"].ownerKeyHex = ownerKey.toString("hex");
        authMgr["state"].ownerKeyVersion = 1;

        await service.refreshDevices();
        assert.deepEqual(locatedIds.sort(), ["android-1", "spot-1"]);

        // Simulate FCM DeviceUpdate for android-1 with location
        await service["handleFcmEvent"]({
            persistentId: "p-loc-1",
            deviceUpdate: {
                deviceMetadata: {
                    userDefinedDeviceName: "Pixel 10",
                    identifierInformation: {
                        type: gfind.IdentifierInformationType.IDENTIFIER_ANDROID,
                        phoneInformation: { canonicIds: ["android-1"] }
                    },
                    information: {
                        reports: [
                            {
                                timestampSeconds: 1730002000,
                                geoLocation: {
                                    accuracy: 12,
                                    unencryptedLocation: { latitude: 37.422, longitude: -122.084 }
                                }
                            }
                        ]
                    }
                }
            }
        });
        assert.ok(Math.abs(service.getCachedDevices().find(d => d.identifier === "android-1").location.latitude - 37.422) < 1e-5);

        // Subsequent refreshDevices() where nbe_list_devices returns empty reports must preserve FCM location
        await service.refreshDevices();
        const preserved = service.getCachedDevices().find(d => d.identifier === "android-1");
        assert.ok(preserved.location);
        assert.ok(Math.abs(preserved.location.latitude - 37.422) < 1e-5);
        service.disconnect();
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("extractDeviceUpdateFromStanza decrypts aesgcm JSON string data envelope with field-3 DeviceMetadata", () => {
    const clientEcdh = crypto.createECDH("prime256v1");
    clientEcdh.generateKeys();
    const keys = {
        publicKeyB64: clientEcdh.getPublicKey().toString("base64"),
        privateKeyB64: clientEcdh.getPrivateKey().toString("base64"),
        authSecretB64: crypto.randomBytes(16).toString("base64")
    };
    const serverEcdh = crypto.createECDH("prime256v1");
    serverEcdh.generateKeys();
    const serverPub = serverEcdh.getPublicKey();
    const salt = crypto.randomBytes(16);

    const fcmMetaBuf = gfind.encodeRawFields([
        { fieldNumber: 1, wireType: gfind.WIRE_VARINT, value: BigInt(gfind.NovaDeviceType.SPOT_DEVICE) },
        { fieldNumber: 2, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("req-uuid-123", "utf8") }
    ]);
    const metaBuf = gfind.encodeDeviceMetadata({
        userDefinedDeviceName: "WF-1000XM6",
        identifierInformation: {
            type: gfind.IdentifierInformationType.IDENTIFIER_SPOT,
            trackerInformation: { canonicIds: ["spot-canonic-1"] }
        },
        information: {
            reports: [
                {
                    timestampSeconds: 1730003000,
                    geoLocation: {
                        accuracy: 15,
                        unencryptedLocation: { latitude: 37.422, longitude: -122.084 }
                    }
                }
            ]
        }
    });
    const protoUpdate = gfind.encodeRawFields([
        { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: fcmMetaBuf },
        { fieldNumber: 3, wireType: gfind.WIRE_LENGTH_DELIMITED, value: metaBuf }
    ]);

    const jsonEnvelope = Buffer.from(JSON.stringify({ data: protoUpdate.toString("base64") }), "utf8");
    const padded = Buffer.concat([Buffer.from([0x00, 0x00]), jsonEnvelope]);

    const uaPub = Buffer.from(keys.publicKeyB64, "base64");
    const authSecret = Buffer.from(keys.authSecretB64, "base64");
    const sharedSecret = serverEcdh.computeSecret(uaPub);
    const prk = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, authSecret, Buffer.from("Content-Encoding: auth\x00"), 32));
    const context = Buffer.concat([
        Buffer.from("P-256\x00"),
        Buffer.from([0x00, 0x41]),
        uaPub,
        Buffer.from([0x00, 0x41]),
        serverPub
    ]);
    const cek = Buffer.from(
        crypto.hkdfSync("sha256", prk, salt, Buffer.concat([Buffer.from("Content-Encoding: aesgcm\x00"), context]), 16)
    );
    const nonce = Buffer.from(
        crypto.hkdfSync("sha256", prk, salt, Buffer.concat([Buffer.from("Content-Encoding: nonce\x00"), context]), 12)
    );
    const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

    const update = gfind.extractDeviceUpdateFromStanza(
        {
            rawData: encrypted,
            appData: {
                encryption: `salt=${salt.toString("base64url")}`,
                "crypto-key": `dh=${serverPub.toString("base64url")}`
            }
        },
        keys
    );

    assert.ok(update);
    assert.equal(update.fcmMetadata?.requestUuid, "req-uuid-123");
    assert.equal(gfind.extractCanonicIdFromMetadata(update.deviceMetadata), "spot-canonic-1");
    assert.equal(update.deviceMetadata?.information?.reports?.length, 1);
    assert.equal(update.deviceMetadata?.information?.reports?.[0]?.geoLocation?.accuracy, 15);
});

test("ANDROID_DEVICE f3/f6/f8 mapping, SPOT_DEVICE ExecuteAction coercion, AAD EIK unwrap, and findMyIcons SSRF/raster checks", async () => {
    const icons = require(path.join(serverSrcRoot, "api", "lib", "findmy", "findMyIcons.ts"));

    // 1. ANDROID_DEVICE ExecuteAction coerces scope.type & requestMetadata.type to SPOT_DEVICE (2) with unknownFlag=true and highTraffic=0
    const execReq = gfind.encodeExecuteActionRequest({
        canonicId: "6aef7c19-0000-272b-a2c3-000000000001",
        deviceType: gfind.NovaDeviceType.ANDROID_DEVICE,
        requestUuid: "req-android-1",
        action: { kind: "locateTracker", lastHighTrafficEnablingTimeSec: 1700000000 }
    });
    const topFields = gfind.decodeRawFields(execReq);
    const scopeFields = gfind.decodeRawFields(topFields.find(f => f.fieldNumber === 1).value);
    assert.equal(Number(scopeFields.find(f => f.fieldNumber === 2).value), gfind.NovaDeviceType.SPOT_DEVICE);
    const metaFields = gfind.decodeRawFields(topFields.find(f => f.fieldNumber === 3).value);
    assert.equal(Number(metaFields.find(f => f.fieldNumber === 1).value), gfind.NovaDeviceType.SPOT_DEVICE);
    assert.equal(Number(metaFields.find(f => f.fieldNumber === 6).value), 1);

    // 2. ANDROID_DEVICE PhoneInformation (f3/f4/f5/f26) + ImageInformation (f6) + deviceCategory=4 (Watch) + AAD EIK unwrap
    const ownerKey = crypto.randomBytes(32);
    const eik = crypto.randomBytes(32);
    const canonicId = "6aef7c19-0000-272b-a2c3-000000000002";
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", ownerKey, iv);
    cipher.setAAD(Buffer.from(canonicId, "utf8"));
    const wrappedEik = Buffer.concat([iv, cipher.update(eik), cipher.final(), cipher.getAuthTag()]);

    const encKeysBuf = gfind.encodeRawFields([
        { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: wrappedEik },
        { fieldNumber: 3, wireType: gfind.WIRE_VARINT, value: 3n }
    ]);
    const regBuf = gfind.encodeRawFields([
        { fieldNumber: 2, wireType: gfind.WIRE_LENGTH_DELIMITED, value: gfind.encodeRawFields([{ fieldNumber: 2, wireType: gfind.WIRE_VARINT, value: 4n }]) },
        { fieldNumber: 19, wireType: gfind.WIRE_LENGTH_DELIMITED, value: encKeysBuf }
    ]);
    const devInfoBuf = gfind.encodeRawFields([
        { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: regBuf }
    ]);
    const phoneInfoBuf = gfind.encodeRawFields([
        { fieldNumber: 3, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("Pixel Watch 5") },
        { fieldNumber: 4, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("Google") },
        { fieldNumber: 5, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("wisteria_lte") },
        { fieldNumber: 26, wireType: gfind.WIRE_LENGTH_DELIMITED, value: devInfoBuf }
    ]);
    const imgInfoBuf = gfind.encodeRawFields([
        { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("https://lh3.googleusercontent.com/watch5-test") }
    ]);
    const idInfoBuf = gfind.encodeRawFields([
        {
            fieldNumber: 1,
            wireType: gfind.WIRE_LENGTH_DELIMITED,
            value: gfind.encodeRawFields([
                { fieldNumber: 1, wireType: gfind.WIRE_VARINT, value: 123456n },
                {
                    fieldNumber: 2,
                    wireType: gfind.WIRE_LENGTH_DELIMITED,
                    value: gfind.encodeRawFields([
                        {
                            fieldNumber: 1,
                            wireType: gfind.WIRE_LENGTH_DELIMITED,
                            value: gfind.encodeRawFields([
                                { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from(`$${canonicId}`) }
                            ])
                        }
                    ])
                }
            ])
        },
        { fieldNumber: 2, wireType: gfind.WIRE_VARINT, value: BigInt(gfind.NovaDeviceType.ANDROID_DEVICE) }
    ]);
    const metaBuf = gfind.encodeRawFields([
        { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: idInfoBuf },
        { fieldNumber: 3, wireType: gfind.WIRE_LENGTH_DELIMITED, value: phoneInfoBuf },
        { fieldNumber: 5, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("Pixel Watch 5") },
        { fieldNumber: 6, wireType: gfind.WIRE_LENGTH_DELIMITED, value: imgInfoBuf },
        { fieldNumber: 8, wireType: gfind.WIRE_VARINT, value: 4n }
    ]);

    // decodeDeviceUpdate with empty f1 + requestUuid on f2 + DeviceMetadata on f3
    const f1EmptyMeta = gfind.encodeRawFields([{ fieldNumber: 1, wireType: gfind.WIRE_VARINT, value: 2n }]);
    const f2WithUuid = gfind.encodeRawFields([
        { fieldNumber: 1, wireType: gfind.WIRE_VARINT, value: 2n },
        { fieldNumber: 2, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("req-watch-5") }
    ]);
    const upd = gfind.decodeDeviceUpdate(
        gfind.encodeRawFields([
            { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: f1EmptyMeta },
            { fieldNumber: 2, wireType: gfind.WIRE_LENGTH_DELIMITED, value: f2WithUuid },
            { fieldNumber: 3, wireType: gfind.WIRE_LENGTH_DELIMITED, value: metaBuf }
        ])
    );
    assert.equal(upd.fcmMetadata?.requestUuid, "req-watch-5");
    assert.ok(upd.deviceMetadata);

    const mapped = await gfind.mapProtoDeviceToFindMy(upd.deviceMetadata, { ownerKey, ownerKeyVersion: 3 });
    assert.equal(mapped.device.iconCategory, "watch");
    assert.equal(mapped.device.iconUrl, "https://lh3.googleusercontent.com/watch5-test");
    assert.equal(mapped.device.modelDisplayName, "Google Pixel Watch 5");
    assert.equal(mapped.device.deviceClass, "Watch");
    assert.equal(mapped.eik?.equals(eik), true);

    // 3. findMyIcons normalization, SSRF lock, soft-404 HTML rejection, and lookup
    assert.equal(icons.normalizeAppleDeviceModel("iPhone16-1-1-1-0"), "iPhone16,1-1-1-0");
    assert.equal(icons.normalizeAppleDeviceModel("MacBookPro17_1-spacegray"), "MacBookPro17,1-spacegray");
    assert.equal(icons.normalizeAppleDeviceModel("iphone7-2-4-0"), "iPhone7,2-4-0");
    assert.equal(icons.isAllowedUpstreamIconUrl("https://lh3.googleusercontent.com/abc"), true);
    assert.equal(icons.isAllowedUpstreamIconUrl("https://statici.icloud.com/fmipmobile/deviceImages-9.0/iPhone/iPhone16,1-1-1-0/online-infobox__2x.png"), true);
    assert.equal(icons.isAllowedUpstreamIconUrl("https://169.254.169.254/latest/meta-data/"), false);
    assert.equal(icons.isAllowedUpstreamIconUrl("http://localhost:8080/x.png"), false);
    assert.equal(icons.detectRasterContentType(Buffer.from("\x89PNG\r\n\x1a\nxxxx", "latin1")), "image/png");
    assert.equal(icons.detectRasterContentType(Buffer.from("<html><body>Not found</body></html>")), null);

    const enrichedApple = icons.enrichFindMyDeviceIcon({
        id: "apple-1",
        name: "iPhone 15 Pro",
        deviceClass: "iPhone",
        rawDeviceModel: "iPhone16-1-1-1-0"
    });
    assert.equal(enrichedApple.iconCategory, "phone");
    assert.equal(enrichedApple.role?.emoji, "📱");
    assert.match(enrichedApple.iconUrl, /^https:\/\/statici\.icloud\.com\/fmipmobile\/deviceImages-9\.0\/iPhone\/iPhone16,1-1-1-0\//);
    assert.equal(icons.findDeviceForIconLookup([enrichedApple], "apple-1")?.id, "apple-1");
});

test("mapProtoDeviceToFindMy unwraps f29 rotated EIK (encrypted under old EIK) and multi-component earbud Kc keys", async () => {
    const encryptGcm60 = (key, plaintext32, aad) => {
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
        if (aad) cipher.setAAD(aad);
        const ct = Buffer.concat([cipher.update(plaintext32), cipher.final()]);
        return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
    };

    const ownerKey = crypto.randomBytes(32);
    const oldEik = crypto.randomBytes(32);
    const rotatedEik = crypto.randomBytes(32);
    const canonicId = "665c1ba2-0000-2479-99d4-14c14ef182a4";

    // Own report encrypted with sha256(rotatedEik)
    const locBuf = gfind.encodeLocation({ latitude: 37.3349, longitude: -122.009, altitude: 12 });
    const ownNonce = crypto.randomBytes(12);
    const ownCipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(rotatedEik).digest(), ownNonce);
    const ownEnc = Buffer.concat([ownNonce, ownCipher.update(locBuf), ownCipher.final(), ownCipher.getAuthTag()]);

    const f19Buf = gfind.encodeRawFields([
        { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: encryptGcm60(ownerKey, oldEik) },
        { fieldNumber: 3, wireType: gfind.WIRE_VARINT, value: 1n }
    ]);
    const f29Buf = gfind.encodeRawFields([
        {
            fieldNumber: 1,
            wireType: gfind.WIRE_LENGTH_DELIMITED,
            value: gfind.encodeRawFields([
                { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: encryptGcm60(oldEik, rotatedEik) }
            ])
        }
    ]);
    const devRegBuf = gfind.encodeRawFields([
        { fieldNumber: 19, wireType: gfind.WIRE_LENGTH_DELIMITED, value: f19Buf },
        { fieldNumber: 20, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("Google") },
        { fieldNumber: 29, wireType: gfind.WIRE_LENGTH_DELIMITED, value: f29Buf },
        { fieldNumber: 34, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("Pixel 8 Pro") }
    ]);
    const reportBuf = gfind.encodeLocationReport({
        timestampSeconds: 1777041600,
        status: 1,
        geoLocation: {
            accuracy: 15,
            encryptedReport: { encryptedLocation: ownEnc }
        }
    });
    const locInfoBuf = gfind.encodeRawFields([
        {
            fieldNumber: 3,
            wireType: gfind.WIRE_LENGTH_DELIMITED,
            value: gfind.encodeRawFields([
                {
                    fieldNumber: 4,
                    wireType: gfind.WIRE_LENGTH_DELIMITED,
                    value: gfind.encodeRawFields([{ fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: reportBuf }])
                }
            ])
        }
    ]);
    const phoneInfoBuf = gfind.encodeRawFields([
        { fieldNumber: 3, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("Pixel 8 Pro") },
        { fieldNumber: 4, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("Google") },
        {
            fieldNumber: 26,
            wireType: gfind.WIRE_LENGTH_DELIMITED,
            value: gfind.encodeRawFields([
                { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: devRegBuf },
                { fieldNumber: 2, wireType: gfind.WIRE_LENGTH_DELIMITED, value: locInfoBuf }
            ])
        }
    ]);
    const idInfoBuf = gfind.encodeRawFields([
        {
            fieldNumber: 1,
            wireType: gfind.WIRE_LENGTH_DELIMITED,
            value: gfind.encodeRawFields([
                { fieldNumber: 1, wireType: gfind.WIRE_VARINT, value: 99n },
                {
                    fieldNumber: 2,
                    wireType: gfind.WIRE_LENGTH_DELIMITED,
                    value: gfind.encodeRawFields([
                        {
                            fieldNumber: 1,
                            wireType: gfind.WIRE_LENGTH_DELIMITED,
                            value: gfind.encodeRawFields([
                                { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from(`$${canonicId}`) }
                            ])
                        }
                    ])
                }
            ])
        },
        { fieldNumber: 2, wireType: gfind.WIRE_VARINT, value: BigInt(gfind.NovaDeviceType.ANDROID_DEVICE) }
    ]);
    const meta = gfind.decodeDeviceMetadata(
        gfind.encodeRawFields([
            { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: idInfoBuf },
            { fieldNumber: 3, wireType: gfind.WIRE_LENGTH_DELIMITED, value: phoneInfoBuf },
            { fieldNumber: 5, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("Pixel 8 Pro") },
            { fieldNumber: 8, wireType: gfind.WIRE_VARINT, value: 1n }
        ])
    );
    const mapped = await gfind.mapProtoDeviceToFindMy(meta, {
        ownerKey,
        ownerKeyVersion: 1,
        reverseGeocodeFn: async () => null
    });
    assert.ok(mapped.device.location);
    assert.ok(Math.abs(mapped.device.location.latitude - 37.3349) < 1e-4);
    assert.ok(Math.abs(mapped.device.location.longitude - -122.009) < 1e-4);
    assert.equal(mapped.eik?.equals(rotatedEik), true);

    // Multi-component earbuds (Kc = sha256(EIK || 0x04 || 1))
    const budEik = crypto.randomBytes(32);
    const kc1 = crypto.createHash("sha256").update(Buffer.concat([budEik, Buffer.from([0x04, 0x01])])).digest();
    const offsetSec = 2048;
    const r = gfind.deriveFmdnScalar(kc1, offsetSec, 10, gfind.SECP160R1);
    const rxBuf = Buffer.from(
        gfind.scalarMultiplyX(gfind.SECP160R1, r, gfind.SECP160R1.Gx, gfind.SECP160R1.Gy).toString(16).padStart(40, "0"),
        "hex"
    );
    const senderPriv = 0x1234567890abcdefn;
    const pubRand = Buffer.from(
        gfind.scalarMultiplyX(gfind.SECP160R1, senderPriv, gfind.SECP160R1.Gx, gfind.SECP160R1.Gy).toString(16).padStart(40, "0"),
        "hex"
    );
    const sy = gfind.recoverEvenY(gfind.SECP160R1, BigInt("0x" + rxBuf.toString("hex")));
    const sharedX = Buffer.from(
        gfind.scalarMultiplyX(gfind.SECP160R1, senderPriv, BigInt("0x" + rxBuf.toString("hex")), sy).toString(16).padStart(40, "0"),
        "hex"
    );
    const aesKey = gfind.hkdfSha256(sharedX, Buffer.alloc(0), Buffer.alloc(0), 32);
    const eaxNonce = Buffer.concat([rxBuf.subarray(12), pubRand.subarray(12)]);
    const { ciphertext, tag } = gfind.aes256EaxEncrypt(aesKey, eaxNonce, gfind.encodeLocation({ latitude: 37.1302, longitude: -121.6498 }));

    const budMeta = gfind.decodeDeviceMetadata(
        gfind.encodeRawFields([
            {
                fieldNumber: 1,
                wireType: gfind.WIRE_LENGTH_DELIMITED,
                value: gfind.encodeRawFields([
                    { fieldNumber: 2, wireType: gfind.WIRE_VARINT, value: 2n },
                    {
                        fieldNumber: 3,
                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                        value: gfind.encodeRawFields([
                            {
                                fieldNumber: 1,
                                wireType: gfind.WIRE_LENGTH_DELIMITED,
                                value: gfind.encodeRawFields([{ fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("$earbud-id-1") }])
                            }
                        ])
                    }
                ])
            },
            {
                fieldNumber: 4,
                wireType: gfind.WIRE_LENGTH_DELIMITED,
                value: gfind.encodeRawFields([
                    {
                        fieldNumber: 1,
                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                        value: gfind.encodeRawFields([
                            { fieldNumber: 2, wireType: gfind.WIRE_LENGTH_DELIMITED, value: gfind.encodeRawFields([{ fieldNumber: 2, wireType: gfind.WIRE_VARINT, value: 26n }]) },
                            { fieldNumber: 11, wireType: gfind.WIRE_LENGTH_DELIMITED, value: gfind.encodeRawFields([{ fieldNumber: 6, wireType: gfind.WIRE_VARINT, value: 2n }]) },
                            {
                                fieldNumber: 19,
                                wireType: gfind.WIRE_LENGTH_DELIMITED,
                                value: gfind.encodeRawFields([
                                    { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: encryptGcm60(ownerKey, budEik) },
                                    { fieldNumber: 3, wireType: gfind.WIRE_VARINT, value: 1n }
                                ])
                            },
                            { fieldNumber: 24, wireType: gfind.WIRE_VARINT, value: 10n }
                        ])
                    },
                    {
                        fieldNumber: 2,
                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                        value: gfind.encodeRawFields([
                            {
                                fieldNumber: 3,
                                wireType: gfind.WIRE_LENGTH_DELIMITED,
                                value: gfind.encodeRawFields([
                                    {
                                        fieldNumber: 4,
                                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                                        value: gfind.encodeRawFields([
                                            {
                                                fieldNumber: 1,
                                                wireType: gfind.WIRE_LENGTH_DELIMITED,
                                                value: gfind.encodeLocationReport({
                                                    timestampSeconds: 1777041700,
                                                    status: 2,
                                                    geoLocation: {
                                                        deviceTimeOffset: offsetSec,
                                                        accuracy: 22,
                                                        encryptedReport: {
                                                            publicKeyRandom: pubRand,
                                                            encryptedLocation: Buffer.concat([ciphertext, tag])
                                                        }
                                                    }
                                                })
                                            }
                                        ])
                                    }
                                ])
                            }
                        ])
                    }
                ])
            },
            { fieldNumber: 5, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("WF-1000XM5") },
            { fieldNumber: 8, wireType: gfind.WIRE_VARINT, value: 11n }
        ])
    );
    const budMapped = await gfind.mapProtoDeviceToFindMy(budMeta, {
        ownerKey,
        ownerKeyVersion: 1,
        reverseGeocodeFn: async () => null
    });
    assert.ok(budMapped.device.location);
    assert.ok(Math.abs(budMapped.device.location.latitude - 37.1302) < 1e-4);
    assert.equal(budMapped.eik?.equals(budEik), true);

    // 3) Derived wrapping key (sha256(primaryEik || 0x01)) for f29 + own report with canonicId AAD
    const p8Id = "$665c1ba2-0000-2479-99d4-14c14ef182a4";
    const p8OldEik = crypto.randomBytes(32);
    const p8NewEik = crypto.randomBytes(32);
    const p8WrapKey = crypto.createHash("sha256").update(Buffer.concat([p8OldEik, Buffer.from([0x01])])).digest();
    const p8Nonce = crypto.randomBytes(12);
    const p8Cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(p8NewEik).digest(), p8Nonce);
    p8Cipher.setAAD(Buffer.from(p8Id.replace(/^\$+/, ""), "utf8"));
    const p8LocCt = Buffer.concat([
        p8Cipher.update(gfind.encodeLocation({ latitude: 37.4103, longitude: -121.9417, altitude: 10 })),
        p8Cipher.final()
    ]);
    const p8EncLoc = Buffer.concat([p8Nonce, p8LocCt, p8Cipher.getAuthTag()]);
    const p8Meta = gfind.decodeDeviceMetadata(
        gfind.encodeRawFields([
            {
                fieldNumber: 1,
                wireType: gfind.WIRE_LENGTH_DELIMITED,
                value: gfind.encodeRawFields([
                    { fieldNumber: 2, wireType: gfind.WIRE_VARINT, value: 1n },
                    {
                        fieldNumber: 1,
                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                        value: gfind.encodeRawFields([
                            {
                                fieldNumber: 2,
                                wireType: gfind.WIRE_LENGTH_DELIMITED,
                                value: gfind.encodeRawFields([
                                    {
                                        fieldNumber: 1,
                                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                                        value: gfind.encodeRawFields([
                                            { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from(p8Id) }
                                        ])
                                    }
                                ])
                            }
                        ])
                    }
                ])
            },
            {
                fieldNumber: 3,
                wireType: gfind.WIRE_LENGTH_DELIMITED,
                value: gfind.encodeRawFields([
                    { fieldNumber: 3, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("Pixel 8 Pro") },
                    {
                        fieldNumber: 26,
                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                        value: gfind.encodeRawFields([
                            {
                                fieldNumber: 1,
                                wireType: gfind.WIRE_LENGTH_DELIMITED,
                                value: gfind.encodeRawFields([
                                    {
                                        fieldNumber: 19,
                                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                                        value: gfind.encodeRawFields([
                                            { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: encryptGcm60(ownerKey, p8OldEik) },
                                            { fieldNumber: 3, wireType: gfind.WIRE_VARINT, value: 1n }
                                        ])
                                    },
                                    {
                                        fieldNumber: 29,
                                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                                        value: gfind.encodeRawFields([
                                            {
                                                fieldNumber: 1,
                                                wireType: gfind.WIRE_LENGTH_DELIMITED,
                                                value: gfind.encodeRawFields([
                                                    { fieldNumber: 1, wireType: gfind.WIRE_LENGTH_DELIMITED, value: encryptGcm60(p8WrapKey, p8NewEik) }
                                                ])
                                            }
                                        ])
                                    }
                                ])
                            },
                            {
                                fieldNumber: 2,
                                wireType: gfind.WIRE_LENGTH_DELIMITED,
                                value: gfind.encodeRawFields([
                                    {
                                        fieldNumber: 3,
                                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                                        value: gfind.encodeRawFields([
                                            {
                                                fieldNumber: 4,
                                                wireType: gfind.WIRE_LENGTH_DELIMITED,
                                                value: gfind.encodeRawFields([
                                                    {
                                                        fieldNumber: 1,
                                                        wireType: gfind.WIRE_LENGTH_DELIMITED,
                                                        value: gfind.encodeLocationReport({
                                                            timestampSeconds: 1777041800,
                                                            status: 1,
                                                            geoLocation: {
                                                                accuracy: 15,
                                                                encryptedReport: {
                                                                    encryptedLocation: p8EncLoc,
                                                                    isOwnReport: true
                                                                }
                                                            }
                                                        })
                                                    }
                                                ])
                                            }
                                        ])
                                    }
                                ])
                            }
                        ])
                    }
                ])
            },
            { fieldNumber: 5, wireType: gfind.WIRE_LENGTH_DELIMITED, value: Buffer.from("Pixel 8 Pro") },
            { fieldNumber: 8, wireType: gfind.WIRE_VARINT, value: 1n }
        ])
    );
    const p8Mapped = await gfind.mapProtoDeviceToFindMy(p8Meta, {
        ownerKey,
        ownerKeyVersion: 1,
        reverseGeocodeFn: async () => null
    });
    assert.ok(p8Mapped.device.location);
    assert.ok(Math.abs(p8Mapped.device.location.latitude - 37.4103) < 1e-4);
    assert.equal(p8Mapped.eik?.equals(p8NewEik), true);
});

test("GoogleFindService.refreshDevices({ force: true }) bypasses minLocateIntervalMs and ringDevice sends start/stop", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfind-force-"));
    try {
        const locateCalls = [];
        const ringCalls = [];
        let fakeNow = 1_700_000_000_000;
        const service = new gfind.GoogleFindService({
            authDeps: { trackerDeps: makeMemoryTrackerDeps(tmpDir) },
            now: () => fakeNow,
            minLocateIntervalMs: 10_000,
            locateTimeoutMs: 50,
            isEnabled: () => true
        });
        service.auth.isSignedIn = () => true;
        service.auth.getState = () => ({ fcmToken: "fcm-tok-1" });
        service.fcm.isConnected = () => false;
        service.fcm.ensureReady = async () => null;
        service.client.listDevices = async () => [];
        service.client.locateDevice = async params => {
            locateCalls.push(params);
            return params.requestUuid ?? "req-1";
        };
        service.client.ringDevice = async params => {
            ringCalls.push(params);
            return "ring-req-1";
        };
        service.recordsById.set("6a5d987b-0000-225b-89c6-14c14ef20e10", {
            deviceId: "gfind:6a5d987b-0000-225b-89c6-14c14ef20e10",
            canonicId: "6a5d987b-0000-225b-89c6-14c14ef20e10",
            novaDeviceType: gfind.NovaDeviceType.ANDROID_DEVICE,
            isSpotAccessory: false,
            isEarbuds: false,
            rotationExponent: 10,
            curve: "secp160r1",
            eik: null,
            ringKey: null,
            device: { id: "gfind:6a5d987b-0000-225b-89c6-14c14ef20e10", name: "Pixel 10" }
        });

        await service.refreshDevices("gfind:6a5d987b-0000-225b-89c6-14c14ef20e10");
        assert.equal(locateCalls.length, 1);

        // Within 10s cooldown: skipped unless force: true
        fakeNow += 2_000;
        await service.refreshDevices("gfind:6a5d987b-0000-225b-89c6-14c14ef20e10");
        assert.equal(locateCalls.length, 1);

        await service.refreshDevices("gfind:6a5d987b-0000-225b-89c6-14c14ef20e10", { force: true });
        assert.equal(locateCalls.length, 2);

        await service.ringDevice("gfind:6a5d987b-0000-225b-89c6-14c14ef20e10", "start", "all");
        await service.ringDevice("gfind:6a5d987b-0000-225b-89c6-14c14ef20e10", "stop", "all");
        assert.equal(ringCalls.length, 2);
        assert.equal(ringCalls[0].action, "start");
        assert.equal(ringCalls[1].action, "stop");
        assert.equal(ringCalls[0].fcmRegistrationId, "fcm-tok-1");
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
