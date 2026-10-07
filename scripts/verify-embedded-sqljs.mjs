// Run after `node build.js`: the bundle must carry sql.js's WebAssembly inline
// (SQL_WASM_B64, see build.js readSqlWasmBase64 and server/utils/sqlJs.js),
// and the release must not ship the old loose sql-wasm.wasm. Without the
// wasm, sql.js aborted and the panel closed (2026-10-07).
import fs from "fs";
import { createRequire } from "module";

const wasmPath = createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm");
const wasmBase64 = fs.readFileSync(wasmPath).toString("base64");
const bundle = fs.readFileSync("dist-exe/server.cjs", "utf8");

const problems = [];
if (!bundle.includes(wasmBase64)) {
  problems.push("dist-exe/server.cjs does not embed node_modules/sql.js/dist/sql-wasm.wasm");
}
if (fs.existsSync("release/sql-wasm.wasm")) {
  problems.push("release/sql-wasm.wasm exists; the wasm is embedded now and must not ship beside the exe");
}

if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`sql.js wasm embedded (${wasmBase64.length} base64 chars)`);
