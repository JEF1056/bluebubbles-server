const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const sourcePath = path.join(
    __dirname,
    "..",
    "src",
    "server",
    "databases",
    "imessage",
    "helpers",
    "imageConversion.ts"
);
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2018
    }
});
const conversionModule = new Module(sourcePath, module);
conversionModule.filename = sourcePath;
conversionModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
conversionModule._compile(compiled.outputText, sourcePath);

const { getConvertedImageName, getImageConversion } = conversionModule.exports;

test("converts HEIC and HEIF attachments to JPEG by default and PNG when hasAlpha is true", () => {
    assert.deepEqual(getImageConversion("public.heic", "image/heic"), {
        sourceExtension: "heic",
        outputExtension: "jpeg",
        outputMimeType: "image/jpeg"
    });
    assert.deepEqual(getImageConversion("public.heif", "image/heif-sequence"), {
        sourceExtension: "heif",
        outputExtension: "jpeg",
        outputMimeType: "image/jpeg"
    });
    assert.deepEqual(getImageConversion("public.heic", "image/heic", true), {
        sourceExtension: "heic",
        outputExtension: "png",
        outputMimeType: "image/png"
    });
    assert.deepEqual(getImageConversion("public.heif", "image/heif-sequence", true), {
        sourceExtension: "heif",
        outputExtension: "png",
        outputMimeType: "image/png"
    });
});

test("keeps TIFF attachments on the JPEG conversion path", () => {
    assert.deepEqual(getImageConversion("public.tiff", "image/tiff"), {
        sourceExtension: "tiff",
        outputExtension: "jpeg",
        outputMimeType: "image/jpeg"
    });
    assert.deepEqual(getImageConversion(null, "image/tif"), {
        sourceExtension: "tiff",
        outputExtension: "jpeg",
        outputMimeType: "image/jpeg"
    });
});

test("ignores image types that do not require conversion", () => {
    assert.equal(getImageConversion("public.png", "image/png"), null);
});

test("replaces source extensions without duplicating the output extension", () => {
    const jpegConversion = getImageConversion("public.heic", "image/heic");
    assert.equal(getConvertedImageName("photo.HEIC", jpegConversion), "photo.jpeg");
    assert.equal(getConvertedImageName("photo", jpegConversion), "photo.jpeg");
    assert.equal(getConvertedImageName("photo.jpeg", jpegConversion), "photo.jpeg");

    const pngConversion = getImageConversion("public.heic", "image/heic", true);
    assert.equal(getConvertedImageName("photo.HEIC", pngConversion), "photo.png");
    assert.equal(getConvertedImageName("photo", pngConversion), "photo.png");
    assert.equal(getConvertedImageName("photo.png", pngConversion), "photo.png");
});
