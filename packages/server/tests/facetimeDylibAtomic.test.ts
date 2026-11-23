import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);

require.extensions[".ts"] = function (module: any, filename: string) {
    const source = fs.readFileSync(filename, "utf8");
    const { outputText } = ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
            experimentalDecorators: true,
            emitDecoratorMetadata: true
        }
    });
    return module._compile(outputText, filename);
};

function loadCameraHookModule() {
    const origLoad = (Module as any)._load;
    const targetPath = path.resolve(import.meta.dirname, "../src/server/api/lib/facetime/FaceTimeCameraHook.ts");
    delete require.cache[targetPath];

    (Module as any)._load = function (request: string) {
        if (request === "@server") return { Server: () => null };
        if (request === "@server/env") return { isMinBigSur: true, isMinMonterey: true };
        if (request === "@server/fileSystem") return { FileSystem: { resources: "/tmp" } };
        if (request === "@server/api/lib/facetime/FacetimeSessionManager") {
            return { FaceTimeSessionManager: () => ({ listActiveSessions: () => [] }) };
        }
        if (request === "@server/lib/logging/Loggable") {
            return { getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) };
        }
        return origLoad.apply(this, arguments);
    };

    try {
        return require(targetPath);
    } finally {
        (Module as any)._load = origLoad;
    }
}

test("installDylibAtomically replaces destination via temp+rename and creates a new inode", () => {
    const { installDylibAtomically } = loadCameraHookModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-dylib-atomic-"));
    try {
        const src1 = path.join(tmpDir, "src1.dylib");
        const src2 = path.join(tmpDir, "src2.dylib");
        const dest = path.join(tmpDir, "BlueBubblesCameraHook.dylib");

        fs.writeFileSync(src1, Buffer.from("OLD_DYLIB_BYTES_V1"));
        fs.writeFileSync(src2, Buffer.from("NEW_DYLIB_BYTES_V2"));

        installDylibAtomically(src1, dest, 0o644);
        const firstIno = fs.statSync(dest).ino;
        const openFd = fs.openSync(dest, "r");
        try {
            installDylibAtomically(src2, dest, 0o644);
            const secondIno = fs.statSync(dest).ino;

            assert.notEqual(secondIno, firstIno, "atomic rename must allocate a new inode");
            assert.equal(fs.readFileSync(dest, "utf8"), "NEW_DYLIB_BYTES_V2");

            const oldBuf = Buffer.alloc(18);
            fs.readSync(openFd, oldBuf, 0, oldBuf.length, 0);
            assert.equal(oldBuf.toString("utf8"), "OLD_DYLIB_BYTES_V1");
            assert.equal(fs.existsSync(`${dest}.tmp.${process.pid}`), false);
        } finally {
            fs.closeSync(openFd);
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
