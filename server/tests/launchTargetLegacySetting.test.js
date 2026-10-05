import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";

// RCE-STARTCMD (security sweep 2026-10-04): the legacy single-server
// `serverPath` setting (PUT /api/config/app-settings) mirrors a server
// record's installPath -- serverManager.js's loadConfig() falls back to it
// -- so a launcher-shaped value (.bat/.sh/.exe) puts it into CUSTOM LAUNCHER
// mode just like the servers.js field. That endpoint is panel.settings-only
// (admin by default), but a custom role holding panel.settings + servers.manage
// yet NOT files.manage could otherwise set serverPath to a launcher and run
// it on the next start, bypassing servers.js's own files.manage gate.
// Changing serverPath to a launcher now needs files.manage here too.
//
// Real, unmocked database/init.js + config router (per-file temp dataDir
// isolates it); a custom role is seeded straight into the DB and injected as
// req.user so requirePermission() resolves it for real.
const { initDatabase, insertRole, removeRoleById, setSetting, getSetting } =
  await import("../database/init.js");
const { default: configRouter } = await import("../routes/config.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

const ROLE_WITHOUT_FILES = "settings-manager-no-files";
const ROLE_WITH_FILES = "settings-manager-with-files";

let baseUrl;
let httpServer;
let currentRole = ROLE_WITHOUT_FILES;

async function put(settings) {
  const res = await fetch(`${baseUrl}/api/config/app-settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  await initDatabase();
  // Both roles can reach the endpoint (panel.settings) and the field
  // (servers.manage); only one also holds files.manage.
  await insertRole({
    id: `role-${ROLE_WITHOUT_FILES}`,
    name: ROLE_WITHOUT_FILES,
    capabilities: ["panel.settings", "servers.manage"],
  });
  await insertRole({
    id: `role-${ROLE_WITH_FILES}`,
    name: ROLE_WITH_FILES,
    capabilities: ["panel.settings", "servers.manage", "files.manage"],
  });
  await setSetting("serverPath", "");

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    req.user = { id: "u1", username: "someone", role: currentRole };
    next();
  });
  app.use("/api/config", configRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await removeRoleById(`role-${ROLE_WITHOUT_FILES}`).catch(() => {});
  await removeRoleById(`role-${ROLE_WITH_FILES}`).catch(() => {});
  await setSetting("serverPath", "");
  await new Promise((r) => httpServer?.close(r));
});

describe("PUT /api/config/app-settings -- legacy serverPath launcher is admin-only (RCE-STARTCMD)", () => {
  it("refuses a panel.settings+servers.manage role without files.manage (403)", async () => {
    currentRole = ROLE_WITHOUT_FILES;
    const r = await put({
      serverPath: process.platform === "win32" ? "C:\\x\\evil.bat" : "/x/evil.sh",
    });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe(ErrorCode.CONFIG_APP_SETTINGS_CAPABILITY_REQUIRED);
    expect(r.json.missing).toEqual([
      { key: "serverPath", requiredCapability: "files.manage" },
    ]);
    // Nothing was stored.
    expect(await getSetting("serverPath")).toBe("");
  });

  it("still lets that role set a plain directory serverPath (not a launcher)", async () => {
    currentRole = ROLE_WITHOUT_FILES;
    const dir = process.platform === "win32" ? "C:\\pz\\server" : "/pz/server";
    const r = await put({ serverPath: dir });
    expect(r.status).toBe(200);
    expect(await getSetting("serverPath")).toBe(dir);
    await setSetting("serverPath", "");
  });

  it("lets a role that holds files.manage set a launcher serverPath", async () => {
    currentRole = ROLE_WITH_FILES;
    const launcher = process.platform === "win32" ? "C:\\x\\run.bat" : "/x/run.sh";
    const r = await put({ serverPath: launcher });
    expect(r.status).toBe(200);
    expect(await getSetting("serverPath")).toBe(launcher);
    await setSetting("serverPath", "");
  });
});
