import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";

// Security sweep 2026-10-04, adversary pass on the disk:* event scoping:
// disk:warning/critical/normal now reach only roles that can act on a full
// disk (diagnostics.manage, backups.manage), but GET /api/system/disk-space
// and /storage-health -- no capability gate, the banner every role polls --
// returned the same disk status objects, save-volume folder and panel data
// folder included. Those folders now go only to the same roles; every other
// role gets the readings with `path: null`.
const db = await import("../database/init.js");
const { default: systemRouter } = await import("../routes/system.js");

const SAVE_VOLUME = {
  path: "/srv/pz/Zomboid",
  totalBytes: 100,
  freeBytes: 50,
  usedPercent: 50,
  warning: false,
  critical: false,
  ok: true,
};

let baseUrl;
let httpServer;
let currentRole = "moderator";

async function getJson(url) {
  const res = await fetch(baseUrl + url);
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  await db.initDatabase();
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("diskMonitor", { getDiskStatus: () => ({ ...SAVE_VOLUME }) });
  app.use("/api/system", systemRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
});

describe("disk readings show their folders only to roles that act on a full disk", () => {
  it("a moderator gets the readings without the folders", async () => {
    currentRole = "moderator";
    const disk = await getJson("/api/system/disk-space");
    expect(disk.saveVolume).toMatchObject({ ...SAVE_VOLUME, path: null });
    expect(disk.panelData.path).toBeNull();
    expect(typeof disk.panelData.ok).toBe("boolean");

    const health = await getJson("/api/system/storage-health");
    expect(health.diskSpace.saveVolume.path).toBeNull();
    expect(health.diskSpace.panelData.path).toBeNull();
    expect(JSON.stringify(health)).not.toContain(SAVE_VOLUME.path);
  });

  it("a technician (backups.manage) still gets them", async () => {
    currentRole = "technician";
    const disk = await getJson("/api/system/disk-space");
    expect(disk.saveVolume.path).toBe(SAVE_VOLUME.path);
    expect(typeof disk.panelData.path).toBe("string");
  });
});
