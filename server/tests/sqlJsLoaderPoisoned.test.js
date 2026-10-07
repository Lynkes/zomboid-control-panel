import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// server/utils/sqlJs.js when the wasm bytes validate but are not sql.js's
// module (here the 8-byte empty module). sql.js's own loader would hang the
// start AND reject a promise nobody holds, which server/index.js's
// unhandledRejection handler turns into an exit (the 2026-10-07 crash).
// The loader instantiates the bytes itself, so the failure is a normal
// error instead. Its own file: once initSqlJs() has been called, sql.js
// caches that start for the whole process, so this poisons sql.js here.

vi.mock("sql.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { default: vi.fn(actual.default) };
});

vi.stubGlobal("SQL_WASM_B64", "AGFzbQEAAAA=");

const { default: initSqlJs } = await import("sql.js");
const { getSqlJs, SqlJsUnavailableError } = await import("../utils/sqlJs.js");
const { listWhitelistAccounts, listServerRoleNames } = await import("../utils/whitelistDb.js");

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sqljs-poisoned-"));

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe("getSqlJs with a module that is not sql.js's", () => {
  it("fails with a normal error, once, and never with an unhandled rejection", async () => {
    const seen = [];
    const record = (reason) => seen.push(reason);
    process.on("unhandledRejection", record);
    try {
      const first = await getSqlJs().catch((error) => error);
      expect(first).toBeInstanceOf(SqlJsUnavailableError);
      expect(first.message).toMatch(/^SQLite engine failed to start: /);

      // sql.js keeps that start for good, so the error is kept too.
      const second = await getSqlJs().catch((error) => error);
      expect(second).toBe(first);
      expect(initSqlJs).toHaveBeenCalledTimes(1);

      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.off("unhandledRejection", record);
    }
    expect(seen).toEqual([]);
  }, 10_000);

  it("the Players page's whitelist and access levels say the engine is down instead of crashing", async () => {
    fs.mkdirSync(path.join(dataRoot, "db"), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "db", "servertest.db"), "only its existence is checked first");

    const whitelist = await listWhitelistAccounts(dataRoot, "servertest");
    expect(whitelist).toMatchObject({ available: false, accounts: [] });
    expect(whitelist.reason).toMatch(/SQLite engine could not start/);

    const roles = await listServerRoleNames(dataRoot, "servertest");
    expect(roles).toMatchObject({ available: false, roleNames: [] });
    expect(roles.reason).toMatch(/SQLite engine could not start/);
  });
});
