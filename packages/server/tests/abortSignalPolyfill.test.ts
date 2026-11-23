import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
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
            esModuleInterop: true
        }
    });
    return module._compile(outputText, filename);
};

const { ensureAbortSignalAny } = require(
    path.resolve(import.meta.dirname, "../src/server/lib/abortSignalPolyfill.ts")
);

function withPolyfill(fn: () => void) {
    const desc = Object.getOwnPropertyDescriptor(AbortSignal, "any");
    delete (AbortSignal as any).any;
    try {
        ensureAbortSignalAny();
        fn();
    } finally {
        if (desc) Object.defineProperty(AbortSignal, "any", desc);
    }
}

test("AbortSignal.any polyfill propagates abort reason and cleans up listeners", () => {
    withPolyfill(() => {
        assert.equal(typeof (AbortSignal as any).any, "function");

        const c1 = new AbortController();
        const c2 = new AbortController();
        let removedCount = 0;
        const origRemove = c2.signal.removeEventListener.bind(c2.signal);
        c2.signal.removeEventListener = ((type: string, listener: any, opts?: any) => {
            if (type === "abort") removedCount++;
            return origRemove(type, listener, opts);
        }) as any;

        const combined = (AbortSignal as any).any([c1.signal, c2.signal, c1.signal]);
        assert.equal(combined.aborted, false);
        c1.abort("first-reason");
        assert.equal(combined.aborted, true);
        assert.equal(combined.reason, "first-reason");
        assert.equal(removedCount, 1);

        // Pre-aborted input returns immediately aborted with its reason.
        const pre = new AbortController();
        pre.abort("pre-reason");
        const immediate = (AbortSignal as any).any([new AbortController().signal, pre.signal]);
        assert.equal(immediate.aborted, true);
        assert.equal(immediate.reason, "pre-reason");
    });
});
