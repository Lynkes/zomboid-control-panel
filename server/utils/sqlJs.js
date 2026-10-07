// The one place the panel starts sql.js (SQLite compiled to WebAssembly),
// shared by whitelistDb.js, vehiclesDb.js and browserCookies.js.
//
// Why this exists (2026-10-07, finn on Discord: opening Online Players closed
// the panel): when sql.js cannot load its .wasm it rejects the promise
// initSqlJs() returns, which callers catch, AND throws from an internal async
// loader whose promise nobody holds (node_modules/sql.js/dist/sql-wasm.js,
// abort() and the loader at the end of the file). That second rejection
// reaches server/index.js's unhandledRejection handler, which exits the
// panel. So sql.js must never be left to load the wasm itself:
//   - the bytes are read and validated here first, and initSqlJs() is not
//     called at all when they are missing or invalid (the next call retries);
//   - instantiateWasm instantiates them here too, so a module that validates
//     but cannot link fails our promise instead of aborting inside sql.js.
// sql.js also caches its first initSqlJs() call for the whole process, so a
// start that fails after initSqlJs() was called stays failed until restart.

import fs from "fs";
import { createRequire } from "module";
import initSqlJs from "sql.js";

export class SqlJsUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SqlJsUnavailableError";
  }
}

let ready = null;
let fatal = null;

// Exe builds carry the wasm inside server.cjs (build.js defines SQL_WASM_B64),
// so a packaged panel never looks for sql-wasm.wasm on disk and the bytes
// always match the sql.js code bundled with them, even after a binary-only
// update. Unbundled runs (npm run dev, Docker, tests) read the installed
// package's copy. Deliberately no next-to-the-exe lookup: a wasm left over
// from an older release can validate and still not match.
function readSqlWasmBytes() {
  const embedded = typeof SQL_WASM_B64 !== "undefined" ? SQL_WASM_B64 : "";
  const bytes = embedded
    ? Buffer.from(embedded, "base64")
    : fs.readFileSync(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm"));
  if (!WebAssembly.validate(bytes)) {
    throw new Error("sql-wasm.wasm is not a valid WebAssembly module");
  }
  return bytes;
}

export function getSqlJs() {
  if (fatal) return Promise.reject(fatal);
  if (ready) return ready;

  let bytes;
  try {
    bytes = readSqlWasmBytes();
  } catch (error) {
    return Promise.reject(
      new SqlJsUnavailableError(`SQLite engine unavailable: ${error.message}`, { cause: error }),
    );
  }

  ready = new Promise((resolve, reject) => {
    const fail = (error) => {
      fatal ??= new SqlJsUnavailableError(
        `SQLite engine failed to start: ${error?.message ?? error}`,
        { cause: error },
      );
      reject(fatal);
    };
    initSqlJs({
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(bytes, imports).then(({ instance, module }) => {
          try {
            done(instance, module);
          } catch (error) {
            fail(error);
          }
        }, fail);
        return {};
      },
    }).then(resolve, fail);
  });
  return ready;
}
