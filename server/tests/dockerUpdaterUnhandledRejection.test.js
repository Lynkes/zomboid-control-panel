import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

// The all-in-one updater answered POST /update with 202 and started the
// update with `void update(version)`, but update() created its work folder
// (fs.mkdtemp under BUILD_ROOT) before its try block. A BUILD_ROOT that is
// missing or not writable then rejected after the 202: an unhandled
// rejection (fatal on Node's default) with the state never set to "failed".
// The state also turned "running" only after that await, so two quick
// requests could both start an update.
const require = createRequire(import.meta.url);
const childProcess = require("child_process");
const Module = require("module");
const UPDATER = require.resolve("../../docker/all-in-one/updater/server.js");

const originalSpawn = childProcess.spawn;
const savedEnv = { ...process.env };
const TOKEN = "updater-test-token";
let tmpRoot;
let updater;

// Every command succeeds at once; curl never gets that far in these tests.
function stubSpawn() {
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit("close", 0));
    return child;
  };
}

function loadUpdater(buildRoot) {
  Object.assign(process.env, { BUILD_ROOT: buildRoot, SOURCE_DIR: path.join(buildRoot, "source"), UPDATE_TOKEN: TOKEN });
  const updaterModule = new Module(UPDATER, null);
  updaterModule.filename = UPDATER;
  updaterModule.paths = Module._nodeModulePaths(path.dirname(UPDATER));
  updaterModule._compile(fs.readFileSync(UPDATER, "utf8"), UPDATER);
  return updaterModule.exports;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const postUpdate = (base, version = "1.4.4") =>
  fetch(`${base}/update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  if (updater?.server?.listening) await new Promise((resolve) => updater.server.close(resolve));
  updater = null;
  childProcess.spawn = originalSpawn;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

describe("Docker updater: a failure before the download", () => {
  it("update() resolves and ends as failed when its work folder can't be created", async () => {
    stubSpawn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-updater-"));
    updater = loadUpdater(path.join(tmpRoot, "missing", "build"));

    await expect(updater.update("1.4.4")).resolves.toBeUndefined();
    expect(updater.getUpdateState()).toMatchObject({ status: "failed", version: "1.4.4" });
    expect(updater.getUpdateState().message).toMatch(/ENOENT/);
  });

  it("POST /update answers 202, then reports failed, with no unhandled rejection", async () => {
    stubSpawn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-updater-"));
    updater = loadUpdater(path.join(tmpRoot, "missing", "build"));
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const base = await listen(updater.server);
      const response = await postUpdate(base);
      expect(response.status).toBe(202);
      await waitFor(() => updater.getUpdateState().status === "failed");
      // Give a stray rejection a turn to surface.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);

      // Not stuck: the next attempt is accepted.
      expect((await postUpdate(base)).status).toBe(202);
      await waitFor(() => updater.getUpdateState().status === "failed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a clean-up that fails doesn't turn into a rejection either", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-updater-"));
    updater = loadUpdater(tmpRoot);
    expect(updater.startUpdate).toBeTypeOf("function");
    // A failure in the final clean-up, past update()'s own catch.
    vi.spyOn(fs.promises, "rm").mockRejectedValue(new Error("EBUSY: resource busy"));
    stubSpawn();
    await expect(updater.startUpdate("1.4.4")).resolves.toBeUndefined();
    expect(updater.getUpdateState().status).toBe("failed");
  });

  it("a second request while the first is starting gets 409, not a second update", async () => {
    stubSpawn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-updater-"));
    updater = loadUpdater(tmpRoot);
    // Hold the first update at its first step.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const realMkdtemp = fs.promises.mkdtemp;
    vi.spyOn(fs.promises, "mkdtemp").mockImplementation(async (...args) => {
      await gate;
      return realMkdtemp(...args);
    });
    const base = await listen(updater.server);
    const [first, second] = await Promise.all([postUpdate(base), postUpdate(base)]);
    expect([first.status, second.status].sort()).toEqual([202, 409]);
    expect(fs.promises.mkdtemp).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => updater.getUpdateState().status !== "running");
  });
});
