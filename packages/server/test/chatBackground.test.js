const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const sourcePath = path.join(
    __dirname,
    "..",
    "src",
    "server",
    "api",
    "interfaces",
    "chatBackground.ts"
);
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2018,
        esModuleInterop: true
    }
});
const bgModule = new Module(sourcePath, module);
bgModule.filename = sourcePath;
bgModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
bgModule._compile(compiled.outputText, sourcePath);

const {
    extractBackgroundGuid,
    findLayerStackImage,
    extractWatchBackgroundImage
} = bgModule.exports;

test("extractBackgroundGuid reads trabaid or backgroundChannelGUID from array or dict", () => {
    assert.equal(
        extractBackgroundGuid([
            {
                backgroundChannelGUID: "AB8083A0-FC1A-4315-9151-E7B57E2DF3C0",
                backgroundProperties: { trabaid: "11111111-2222-3333-4444-555555555555" }
            }
        ]),
        "11111111-2222-3333-4444-555555555555"
    );
    assert.equal(
        extractBackgroundGuid({ backgroundChannelGUID: "AB8083A0-FC1A-4315-9151-E7B57E2DF3C0" }),
        "AB8083A0-FC1A-4315-9151-E7B57E2DF3C0"
    );
    assert.equal(extractBackgroundGuid([{ backgroundChannelGUID: "../etc/passwd" }]), null);
    assert.equal(extractBackgroundGuid(null), null);
});

test("findLayerStackImage prefers portrait-layer_background over other layerStack images", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bb-bg-test-"));
    try {
        const layerDir = path.join(tmp, "configuration", "versions", "0", "contents", "id", "output.layerStack");
        fs.mkdirSync(layerDir, { recursive: true });
        fs.writeFileSync(path.join(layerDir, "Contents.json"), "{}");
        fs.writeFileSync(path.join(layerDir, "other.png"), "other");
        const target = path.join(layerDir, "portrait-layer_background.HEIC");
        fs.writeFileSync(target, "heic");
        assert.equal(findLayerStackImage(tmp), target);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("extractWatchBackgroundImage returns null on invalid or empty buffers", () => {
    assert.equal(extractWatchBackgroundImage(Buffer.alloc(0)), null);
    assert.equal(extractWatchBackgroundImage(Buffer.from("not a bplist")), null);
});
