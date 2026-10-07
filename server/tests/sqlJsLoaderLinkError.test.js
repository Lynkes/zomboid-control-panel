import { afterAll, describe, expect, it, vi } from "vitest";

// server/utils/sqlJs.js when the wasm validates but won't link: what a wasm
// from a different sql.js build gives. This module imports "a"."zz", which
// sql.js doesn't supply, so WebAssembly.instantiate rejects with a
// LinkError. Without the loader's rejection handler that promise is never
// settled and the LinkError is an unhandled rejection: server/index.js
// exits, the 2026-10-07 crash. Its own file, because the failed start
// poisons sql.js for the process (see sqlJsLoaderPoisoned.test.js).

vi.stubGlobal("SQL_WASM_B64", "AGFzbQEAAAABBAFgAAACCAEBYQJ6egAA");

const { getSqlJs, SqlJsUnavailableError } = await import("../utils/sqlJs.js");

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("getSqlJs with a wasm that does not link", () => {
  it("fails with a normal error, once, and never with an unhandled rejection", async () => {
    const seen = [];
    const record = (reason) => seen.push(reason);
    process.on("unhandledRejection", record);
    try {
      const first = await getSqlJs().catch((error) => error);
      expect(first).toBeInstanceOf(SqlJsUnavailableError);
      expect(first.message).toMatch(/^SQLite engine failed to start: /);
      expect(first.cause).toBeInstanceOf(WebAssembly.LinkError);
      expect(await getSqlJs().catch((error) => error)).toBe(first);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.off("unhandledRejection", record);
    }
    expect(seen).toEqual([]);
  }, 10_000);
});
