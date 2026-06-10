import { FileAccess, Node } from "godot";
import { beginAsyncTest, endAsyncTest, reportTestFailure } from "../test-status";

declare function require(id: string): any;

const jsb = require("godot-jsb") as { internal: { scan_external_changes: () => void } };

const SCRIPT_PATH = "res://tests/reload/script-class-target.ts";
const BASE_PATH = "res://tests/reload/transitive-base.ts";
const DEPENDENT_PATH = "res://tests/reload/transitive-dependent.ts";
const ACCESSOR_PATH = "res://tests/reload/accessor-reload-target.ts";

function readFile(path: string): string {
    const reader = FileAccess.open(path, FileAccess.ModeFlags.READ);
    if (!reader) throw new Error(`failed to open ${path} for read`);
    const s = reader.get_as_text();
    reader.close();
    return s;
}

function writeFile(path: string, content: string): void {
    const writer = FileAccess.open(path, FileAccess.ModeFlags.WRITE);
    if (!writer) throw new Error(`failed to open ${path} for write`);
    writer.store_string(content);
    writer.close();
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Verifies the fix for the SWC `Object.defineProperty(exports, "default", { configurable: false, ... })`
// trap: re-running a reloaded module that uses ES `export default` would throw
// "Cannot redefine property: default" on the second run and the engine would
// silently swallow the error, leaving the class identity (and prototype)
// pointing at the pre-reload class.
async function runDirectScriptClassReloadTest(): Promise<void> {
    const original = readFile(SCRIPT_PATH);
    try {
        const before = require("./script-class-target");
        const beforeProto = before?.default?.prototype;
        if (typeof beforeProto?.getValue !== "function") {
            throw new Error("baseline: getValue() not found on prototype");
        }

        // FileAccess::get_modified_time is 1-second-granular on most platforms.
        await sleep(1100);
        const mutated = original.replace("return 1;", "return 2;\n    }\n    getSentinel(): string { return \"hot-reload-ok\";");
        if (mutated === original) throw new Error("mutation produced no diff");
        writeFile(SCRIPT_PATH, mutated);

        jsb.internal.scan_external_changes();

        const after = require("./script-class-target");
        const afterProto = after?.default?.prototype;
        if (typeof afterProto?.getSentinel !== "function") {
            throw new Error("post-reload: new getSentinel() method missing from prototype — exports.default did not pick up the reloaded class (likely the SWC defineProperty trap)");
        }
        // Confirm the existing method body also changed.
        const sentinelValue = afterProto.getSentinel.call(null);
        if (sentinelValue !== "hot-reload-ok") {
            throw new Error(`post-reload: getSentinel() returned ${JSON.stringify(sentinelValue)} (expected "hot-reload-ok")`);
        }
        console.log("TestScriptClassReload: direct-reload OK");
    } finally {
        writeFile(SCRIPT_PATH, original);
        await sleep(1100);
        jsb.internal.scan_external_changes();
    }
}

// Verifies the transitive cascade: when an imported dependency reloads, any
// module whose `children` array contains the dirty module is also re-executed
// so its top-level closures (and any class declarations that depend on the
// imported values) pick up the new module state.
async function runTransitiveReloadTest(): Promise<void> {
    const baseOriginal = readFile(BASE_PATH);
    try {
        const beforeDep = require("./transitive-dependent");
        const beforeCombined = beforeDep?.default?.prototype?.getCombined?.call(null);
        if (beforeCombined !== 11) {
            throw new Error(`baseline: getCombined() returned ${beforeCombined} (expected 11)`);
        }

        await sleep(1100);
        const baseMutated = baseOriginal.replace("return 10;", "return 100;");
        if (baseMutated === baseOriginal) throw new Error("base mutation produced no diff");
        writeFile(BASE_PATH, baseMutated);

        jsb.internal.scan_external_changes();

        const afterDep = require("./transitive-dependent");
        const afterCombined = afterDep?.default?.prototype?.getCombined?.call(null);
        if (afterCombined !== 101) {
            throw new Error(`post-cascade: getCombined() returned ${afterCombined} (expected 101 — the dependent module did not transitively reload after its base changed)`);
        }
        console.log("TestScriptClassReload: transitive-reload OK");
    } finally {
        writeFile(BASE_PATH, baseOriginal);
        await sleep(1100);
        jsb.internal.scan_external_changes();
    }
}

// Verifies that an exported `accessor` field stays readable and writable on a
// LIVE instance after that instance's class is hot-reloaded. A TC39 accessor
// lowers to a per-class #private brand; the editor reload swaps the class in
// place (Environment::_rebind does a v8 SetPrototype, no reconstruction), so
// without a reload-stable backing the reloaded class's getter/setter throw
// "Cannot read/write private member ... whose class did not declare it" on the
// pre-reload instance the moment the inspector (or code) touches the field.
async function runAccessorReloadTest(): Promise<void> {
    const original = readFile(ACCESSOR_PATH);
    let node: (Node & { label: string }) | undefined;
    try {
        const before = require("./accessor-reload-target");
        const Target = before?.default;
        if (typeof Target !== "function") {
            throw new Error("baseline: accessor-reload-target default export missing");
        }
        node = new Target() as Node & { label: string };
        node.label = "before";
        if (node.label !== "before") {
            throw new Error(`baseline: accessor getter returned ${JSON.stringify(node.label)} (expected "before")`);
        }

        await sleep(1100);
        const mutated = original.replace("return 1;", "return 2;");
        if (mutated === original) throw new Error("mutation produced no diff");
        writeFile(ACCESSOR_PATH, mutated);

        jsb.internal.scan_external_changes();

        // The class was swapped in place and the live instance rebound to the
        // new prototype. Reading the pre-reload value must not throw and must be
        // preserved; the accessor must remain writable.
        let preserved: string;
        try {
            preserved = node.label;
        } catch (error) {
            throw new Error(`post-reload: reading exported accessor on a hot-reloaded instance threw: ${error}`);
        }
        if (preserved !== "before") {
            throw new Error(`post-reload: exported accessor value not preserved, got ${JSON.stringify(preserved)}`);
        }
        try {
            node.label = "after";
        } catch (error) {
            throw new Error(`post-reload: writing exported accessor on a hot-reloaded instance threw: ${error}`);
        }
        if (node.label !== "after") {
            throw new Error(`post-reload: exported accessor not writable after reload, got ${JSON.stringify(node.label)}`);
        }
        console.log("TestScriptClassReload: accessor-reload OK");
    } finally {
        node?.free();
        writeFile(ACCESSOR_PATH, original);
        await sleep(1100);
        jsb.internal.scan_external_changes();
    }
}

export default class TestScriptClassReload extends Node {
    _ready(): void {
        beginAsyncTest();
        (async () => {
            await runDirectScriptClassReloadTest();
            await runTransitiveReloadTest();
            await runAccessorReloadTest();
        })()
            .catch((error) => reportTestFailure("script-class-reload", error))
            .finally(() => endAsyncTest());
    }
}
