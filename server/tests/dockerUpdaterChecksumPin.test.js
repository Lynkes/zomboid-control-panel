import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

// The all-in-one updater's optional UPDATE_SHA256 pin (#193). The panel only
// hears "update started" from the updater, after it has already stopped the
// game server, and /status needs the update token: when the pinned hash
// refused an archive, nothing anywhere said so. The refusal has to reach the
// container log (docker logs zomboid-panel-updater), and nothing past the
// download may run.
const require = createRequire(import.meta.url);
const childProcess = require("child_process");
const Module = require("module");
const UPDATER = require.resolve("../../docker/all-in-one/updater/server.js");

const ARCHIVE = Buffer.from("release source archive bytes");
const ARCHIVE_SHA256 = crypto.createHash("sha256").update(ARCHIVE).digest("hex");

const originalSpawn = childProcess.spawn;
const savedEnv = { ...process.env };
let tmpRoot;

// curl "downloads" ARCHIVE to its --output path; every other command just
// succeeds. Records what ran.
function stubSpawn() {
  const calls = [];
  childProcess.spawn = (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (command === "curl") fs.writeFileSync(args[args.indexOf("--output") + 1], ARCHIVE);
      child.emit("close", 0);
    });
    return child;
  };
  return calls;
}

// server.js is CommonJS in the updater image (no package.json there), but
// this repo's package.json says "type": "module", so require() would read it
// as ESM. Compile it as the CommonJS module it is in production; it reads
// its env at load, so each test gets a fresh copy.
function loadUpdater(env) {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-updater-"));
  Object.assign(process.env, { BUILD_ROOT: tmpRoot, SOURCE_DIR: path.join(tmpRoot, "source"), ...env });
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

describe("Docker updater UPDATE_SHA256 pin", () => {
  it("refuses an archive that does not match, logs why, and stops after the download", async () => {
    const calls = stubSpawn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const updater = loadUpdater({ UPDATE_SHA256: "0".repeat(64) });

    await updater.update("1.4.4");

    expect(updater.getUpdateState()).toMatchObject({ status: "failed", version: "1.4.4" });
    expect(updater.getUpdateState().message).toMatch(/checksum mismatch for v1\.4\.4/);
    expect(calls.map(([command]) => command)).toEqual(["curl"]);
    expect(errors).toHaveBeenCalledWith(
      expect.stringMatching(/^\[updater\] update to v1\.4\.4 failed: Release archive checksum mismatch/),
    );
  });

  it("goes on to unpack an archive that matches the pin", async () => {
    const calls = stubSpawn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const updater = loadUpdater({ UPDATE_SHA256: ARCHIVE_SHA256.toUpperCase() });

    await updater.update("1.4.4");

    expect(calls.map(([command]) => command)).toContain("tar");
    expect(updater.getUpdateState().message).not.toMatch(/checksum/);
  });

  it("is off by default: an unpinned archive is unpacked, with a warning", async () => {
    const calls = stubSpawn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.UPDATE_SHA256;
    const updater = loadUpdater({});

    await updater.update("1.4.4");

    expect(calls.map(([command]) => command)).toContain("tar");
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("NOT checksum-verified"));
  });
});
