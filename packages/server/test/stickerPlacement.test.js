const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const ts = require("typescript");
const plist = require("plist");

const serializerPath = path.resolve(__dirname, "../src/server/api/serializers/AttachmentSerializer.ts");
const serverNodeModules = path.resolve(__dirname, "../node_modules");

function loadAttachmentSerializer() {
    const source = fs.readFileSync(serializerPath, "utf8");
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true
        }
    });

    const fakeModule = { exports: {} };
    const stubAttachmentInterface = { getLivePhotoPath: () => null };
    const stubServer = () => ({ log: () => {} });
    const mockRequire = id => {
        if (id === "@server") return { Server: stubServer };
        if (id === "@server/fileSystem") {
            return { FileSystem: { getRealPath: p => p ?? "", getLivePhotoPath: () => null } };
        }
        if (id === "@server/fileSystem/types") return {};
        if (id === "@server/databases/imessage/helpers/utils") {
            return {
                convertAudio: async () => null,
                convertImage: async () => null,
                getAttachmentMetadata: async () => ({})
            };
        }
        if (id === "@server/types") return {};
        if (id === "./constants") {
            return {
                DEFAULT_ATTACHMENT_CONFIG: {
                    loadData: false,
                    loadMetadata: false,
                    includeMessageGuids: false
                }
            };
        }
        if (id === "./types") return {};
        if (id === "../interfaces/attachmentInterface") return { AttachmentInterface: stubAttachmentInterface };
        return Module.createRequire(serializerPath)(id);
    };

    const fn = new Function("exports", "require", "module", "__filename", "__dirname", outputText);
    fn(fakeModule.exports, mockRequire, fakeModule, serializerPath, path.dirname(serializerPath));
    return fakeModule.exports;
}

function makeBinaryPlist(dict) {
    const xml = plist.build(dict);
    return execFileSync("/usr/bin/plutil", ["-convert", "binary1", "-o", "-", "--", "-"], {
        input: xml
    });
}

const { parseStickerPlacement, AttachmentSerializer } = loadAttachmentSerializer();

test("parseStickerPlacement decodes spv=0 binary plist with Apple string values", () => {
    // Matches real chat.db row 69323 (p:3/6724A661-... media-collection photo sticker)
    const buf = makeBinaryPlist({
        spv: 0,
        sir: false,
        sli: "0",
        sai: "0",
        sxs: "0.64425055",
        sys: "0.28432214",
        ssa: "1.07218242",
        sro: "0.00623223",
        spw: "160",
        suri: "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.Stickers.UserGenerated.MessagesExtension"
    });

    const placement = parseStickerPlacement(buf);
    assert.deepEqual(placement, {
        xScalar: 0.64425055,
        yScalar: 0.28432214,
        scale: 1.07218242,
        rotation: 0.00623223,
        parentPreviewWidth: 160
    });
});

test("parseStickerPlacement decodes spv=1 and spv=2 binary plists with numeric values and negative coordinates/rotation", () => {
    // Matches real chat.db row 68527 (spv=1) and row 67840 (spv=2)
    const spv1 = makeBinaryPlist({
        spv: 1,
        sir: false,
        sli: 0,
        sai: 0,
        sxs: 0.916058394160584,
        sys: 0.7212581344902386,
        ssa: 0.5804259958891867,
        sro: -0.16404237,
        spw: 277.1333333333333
    });

    const p1 = parseStickerPlacement(spv1);
    assert.ok(p1);
    assert.ok(Math.abs(p1.xScalar - 0.916058394160584) < 1e-12);
    assert.ok(Math.abs(p1.yScalar - 0.7212581344902386) < 1e-12);
    assert.ok(Math.abs(p1.scale - 0.5804259958891867) < 1e-12);
    assert.ok(Math.abs(p1.rotation - -0.16404237) < 1e-12);
    assert.ok(Math.abs(p1.parentPreviewWidth - 277.1333333333333) < 1e-12);

    const spv2 = makeBinaryPlist({
        spv: 2,
        sxs: -1.69753147,
        sys: 1.4608,
        ssa: 0.48,
        sro: 0.7577,
        spw: 54
    });

    const p2 = parseStickerPlacement(spv2);
    assert.ok(p2);
    assert.ok(Math.abs(p2.xScalar - -1.69753147) < 1e-12);
    assert.ok(Math.abs(p2.yScalar - 1.4608) < 1e-12);
    assert.ok(Math.abs(p2.scale - 0.48) < 1e-12);
    assert.ok(Math.abs(p2.rotation - 0.7577) < 1e-12);
    assert.equal(p2.parentPreviewWidth, 54);
});

test("parseStickerPlacement supports XML plist buffers", () => {
    const xmlBuf = Buffer.from(
        plist.build({
            spv: 0,
            sxs: "0.5",
            sys: "0.25",
            ssa: "1.2",
            sro: "-0.3",
            spw: "220"
        }),
        "utf8"
    );

    assert.deepEqual(parseStickerPlacement(xmlBuf), {
        xScalar: 0.5,
        yScalar: 0.25,
        scale: 1.2,
        rotation: -0.3,
        parentPreviewWidth: 220
    });
});

test("parseStickerPlacement returns null for standalone stickers, tapbacks, invalid values, and corrupt buffers", () => {
    // Standalone sticker (no placement keys)
    const standalone = makeBinaryPlist({
        pid: "com.apple.Stickers.UserGenerated.MessagesExtension",
        suri: "sticker-uri",
        stickerEffectType: 0
    });
    assert.equal(parseStickerPlacement(standalone), null);

    // Emoji/sticker tapback (amt=2007)
    const tapback = makeBinaryPlist({ spv: 0, sir: false });
    assert.equal(parseStickerPlacement(tapback), null);

    // Invalid scale <= 0 or negative parentPreviewWidth
    assert.equal(
        parseStickerPlacement({ sxs: 0.5, sys: 0.5, ssa: 0, sro: 0, spw: 200 }),
        null
    );
    assert.equal(
        parseStickerPlacement({ sxs: 0.5, sys: 0.5, ssa: -1, sro: 0, spw: 200 }),
        null
    );
    assert.equal(
        parseStickerPlacement({ sxs: 0.5, sys: 0.5, ssa: 1, sro: 0, spw: -10 }),
        null
    );

    // Blank string / NaN / missing key / corrupt binary
    assert.equal(
        parseStickerPlacement({ sxs: "", sys: "0.5", ssa: "1", sro: "0", spw: "200" }),
        null
    );
    assert.equal(
        parseStickerPlacement({ sxs: "0.5", sys: "0.5", ssa: "1", sro: "0" }),
        null
    );
    assert.equal(parseStickerPlacement(Buffer.from("bplist00corrupt", "utf8")), null);
    assert.equal(parseStickerPlacement(Buffer.from("not-a-plist", "utf8")), null);
    assert.equal(parseStickerPlacement(null), null);
    assert.equal(parseStickerPlacement(undefined), null);
});

test("AttachmentSerializer.serialize includes stickerPlacement for both REST and live notification payloads", async () => {
    const placedBuf = makeBinaryPlist({
        spv: 1,
        sxs: 0.85,
        sys: 0.35,
        ssa: 0.75,
        sro: 0.2,
        spw: 240
    });
    const standaloneBuf = makeBinaryPlist({ stickerEffectType: 0 });

    const baseAttachment = {
        ROWID: 42,
        guid: "at_0_TEST-STICKER",
        uti: "public.png",
        mimeType: "image/png",
        transferName: "sticker.png",
        totalBytes: 1234,
        transferState: 5,
        isOutgoing: true,
        hideAttachment: false,
        isSticker: true,
        originalGuid: "at_0_TEST-STICKER",
        filePath: null,
        getMimeType: () => "image/png"
    };

    const restOut = await AttachmentSerializer.serialize({
        attachment: { ...baseAttachment, stickerUserInfo: placedBuf },
        isForNotification: false
    });
    assert.deepEqual(restOut.stickerPlacement, {
        xScalar: 0.85,
        yScalar: 0.35,
        scale: 0.75,
        rotation: 0.2,
        parentPreviewWidth: 240
    });

    const notifOut = await AttachmentSerializer.serialize({
        attachment: { ...baseAttachment, stickerUserInfo: placedBuf },
        isForNotification: true
    });
    assert.deepEqual(notifOut.stickerPlacement, restOut.stickerPlacement);

    const standaloneOut = await AttachmentSerializer.serialize({
        attachment: { ...baseAttachment, stickerUserInfo: standaloneBuf },
        isForNotification: false
    });
    assert.equal(standaloneOut.stickerPlacement, undefined);
});
