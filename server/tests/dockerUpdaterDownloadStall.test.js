import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

// The all-in-one updater downloads the release source with curl, which has no
// timeout of its own: a stalled connection left updateState "running" for good
// and every later update was answered 409 until the updater container was
// restarted. The download now gives up on a silent host, a stalled transfer
// and one that takes too long, and a curl that gives up ends the update as
// "failed" so the next attempt is accepted.
const require = createRequire(import.meta.url);
const childProcess = require("child_process");
const Module = require("module");
const UPDATER = require.resolve("../../docker/all-in-one/updater/server.js");

const originalSpawn = childProcess.spawn;
const savedEnv = { ...process.env };
let tmpRoot;

// Every command fails with `curlExit` for curl (28 is curl's "operation
// timed out") and succeeds otherwise. Records what ran.
function stubSpawn(curlExit) {
  const calls = [];
  childProcess.spawn = (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit("close", command === "curl" ? curlExit : 0));
    return child;
  };
  return calls;
}

function loadUpdater() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-updater-"));
  Object.assign(process.env, { BUILD_ROOT: tmpRoot, SOURCE_DIR: path.join(tmpRoot, "source") });
  const updaterModule = new Module(UPDATER, null);
  updaterModule.filename = UPDATER;
  updaterModule.paths = Module._nodeModulePaths(path.dirname(UPDATER));
  updaterModule._compile(fs.readFileSync(UPDATER, "utf8"), UPDATER);
  return updaterModule.exports;
}

afterEach(() => {
  childProcess.spawn = originalSpawn;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("Docker updater release download", () => {
  it("bounds the connection, a stalled transfer and the whole download", async () => {
    const calls = stubSpawn(28);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const updater = loadUpdater();

    await updater.update("1.4.4");

    const curl = calls.find(([command]) => command === "curl");
    const flag = (name) => Number(curl[curl.indexOf(name) + 1]);
    expect(flag("--connect-timeout")).toBeGreaterThan(0);
    expect(flag("--speed-limit")).toBeGreaterThan(0);
    expect(flag("--speed-time")).toBeGreaterThan(0);
    expect(flag("--max-time")).toBeGreaterThan(flag("--speed-time"));
  });

  it("a download curl gave up on ends the update as failed, not running forever", async () => {
    stubSpawn(28);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const updater = loadUpdater();

    await updater.update("1.4.4");

    expect(updater.getUpdateState()).toMatchObject({ status: "failed", version: "1.4.4" });
    expect(updater.getUpdateState().message).toMatch(/curl exited with 28/);
  });
});
