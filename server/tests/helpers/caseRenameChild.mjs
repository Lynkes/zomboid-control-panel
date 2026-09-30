// Run by fileManagerLocalFailures.test.js in a child process: a case-only
// rename whose second step and rollback both fail (a scanner holding the
// file), after which the process exits -- a panel restart, as far as the pid
// in a temp file's name is concerned. Prints "@@result <json>" on a line of
// its own (the panel's logger writes to stdout too).
import fs from "fs";

const [rootDir, from, to] = process.argv.slice(2);
const { localBackend } = await import("../../services/fileManagerLocalBackend.js");

const realRename = fs.renameSync;
fs.renameSync = function renameSync(oldPath, newPath) {
  if (String(oldPath).endsWith(".zcptmp")) throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
  return realRename.call(fs, oldPath, newPath);
};

const root = { id: "data", available: true, real: rootDir, path: rootDir };
let code = "ok";
try {
  await localBackend.rename(await localBackend.resolve(root, [from], "rename"), to);
} catch (err) {
  code = err?.code ?? "error";
}
process.stdout.write(`\n@@result ${JSON.stringify({ code })}\n`);
