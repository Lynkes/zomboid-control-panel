import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { createRequire } from "module";

// server/utils/sqlJs.js: the one place sql.js starts. 2026-10-07 (finn on
// Discord): a packaged panel with no sql-wasm.wasm beside it closed as soon
// as Online Players opened. sql.js rejected the promise whitelistDb.js
// caught AND a promise of its own nobody held, and server/index.js's
// unhandledRejection handler exited. The loader now never lets sql.js load
// the wasm itself, and exe builds carry the bytes inline (SQL_WASM_B64).
//
// A start that fails after initSqlJs() was called poisons sql.js for the
// whole process, so that case has its own file: sqlJsLoaderPoisoned.test.js.

vi.mock("sql.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { default: vi.fn(actual.default) };
});

const wasmPath = createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm");
const wasmBase64 = fs.readFileSync(wasmPath).toString("base64");

async function freshLoader() {
  vi.resetModules();
  const { default: initSqlJs } = await import("sql.js");
  const loader = await import("../utils/sqlJs.js");
  return { initSqlJs, ...loader };
}

// Every unhandled rejection while a test runs, read after stray promises
// have had time to settle.
function watchUnhandledRejections() {
  const seen = [];
  const record = (reason) => seen.push(reason);
  process.on("unhandledRejection", record);
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.off("unhandledRejection", record);
    return seen;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getSqlJs", () => {
  // First on purpose: sql.js caches its first start for the whole process
  // (vi.resetModules can't reset a package outside vitest's registry), so
  // only this file's first real start shows which bytes sql.js runs on.
  it("exe builds start sql.js from the embedded bytes and never read sql-wasm.wasm from disk", async () => {
    vi.stubGlobal("SQL_WASM_B64", wasmBase64);
    const { getSqlJs } = await freshLoader();
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const instantiate = vi.spyOn(WebAssembly, "instantiate");

    const SQL = await getSqlJs();
    expect(new SQL.Database().exec("SELECT 1")[0].values).toEqual([[1]]);
    expect(instantiate).toHaveBeenCalledTimes(1);
    expect(Buffer.from(instantiate.mock.calls[0][0]).equals(Buffer.from(wasmBase64, "base64"))).toBe(true);
    const wasmReads = readFileSync.mock.calls.filter(([file]) => String(file).endsWith(".wasm"));
    expect(wasmReads).toEqual([]);
  });

  it("refuses unusable wasm bytes without starting sql.js, then works once they are fixed", async () => {
    const unhandled = watchUnhandledRejections();
    vi.stubGlobal("SQL_WASM_B64", "AAAA");
    const { initSqlJs, getSqlJs, SqlJsUnavailableError } = await freshLoader();
    const callsBefore = initSqlJs.mock.calls.length;

    const failure = await getSqlJs().catch((error) => error);
    expect(failure).toBeInstanceOf(SqlJsUnavailableError);
    expect(failure.message).toMatch(/SQLite engine unavailable: .*not a valid WebAssembly module/);
    expect(initSqlJs.mock.calls.length).toBe(callsBefore);

    // Nothing was cached, so the next request tries again.
    vi.unstubAllGlobals();
    const SQL = await getSqlJs();
    const db = new SQL.Database();
    expect(db.exec("SELECT 7")[0].values).toEqual([[7]]);
    db.close();

    expect(await unhandled()).toEqual([]);
  });

  it("unbundled runs (dev, Docker) read the installed sql.js package's wasm", async () => {
    const { getSqlJs } = await freshLoader();
    const readFileSync = vi.spyOn(fs, "readFileSync");

    await getSqlJs();
    expect(readFileSync).toHaveBeenCalledWith(wasmPath);
  });

  it("starts sql.js once and shares it", async () => {
    const { initSqlJs, getSqlJs } = await freshLoader();
    const callsBefore = initSqlJs.mock.calls.length;
    const [a, b] = await Promise.all([getSqlJs(), getSqlJs()]);
    expect(a).toBe(b);
    expect(initSqlJs.mock.calls.length - callsBefore).toBe(1);
  });
});
