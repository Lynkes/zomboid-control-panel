import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// The Backups page's "Schedule & retention" card now saves the
// "Include panel database (without passwords)" switch through POST
// /backup/settings with the schedule and limit. Up to v1.4.17 the Dashboard
// and Diagnostics backups always carried the panel database; since the
// stored backupIncludeDb setting alone decides (backupService.createBackup()),
// this route is the only way to turn it on. Pins the contract the page uses:
// a boolean is passed through, anything else is refused before it is stored,
// and only backups.manage may change it.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => ({ id: "server-current" })),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/backup.js");

function createResponse() {
  let statusCode = 200;
  let body = null;
  const response = {
    status(code) {
      statusCode = code;
      return response;
    },
    json(payload) {
      body = payload;
      return response;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
  return response;
}

async function postSettings(body, role = "admin") {
  const layer = router.stack.find((entry) => entry.route?.path === "/settings" && entry.route.methods.post);
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  const req = { user: { role }, body, app: { get: (key) => services[key] } };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

let services;
beforeEach(() => {
  services = {
    backupService: { updateSettings: vi.fn(async (allowed) => ({ enabled: false, ...allowed })) },
    scheduler: { setupBackupSchedule: vi.fn(async () => {}) },
  };
});

describe("POST /backup/settings: includeDb", () => {
  it("passes a boolean through with the rest of the card", async () => {
    const res = await postSettings({
      enabled: true,
      schedule: "0 */6 * * *",
      maxBackups: 10,
      includeDb: true,
      expectedServerId: "server-current",
    });
    expect(res.getStatusCode()).toBe(200);
    expect(services.backupService.updateSettings).toHaveBeenCalledWith({
      enabled: true,
      schedule: "0 */6 * * *",
      maxBackups: 10,
      includeDb: true,
    });
    expect(res.getBody().settings.includeDb).toBe(true);
  });

  it("refuses a value that is not a boolean before storing anything", async () => {
    const res = await postSettings({ includeDb: "yes" });
    expect(res.getStatusCode()).toBe(400);
    expect(services.backupService.updateSettings).not.toHaveBeenCalled();
  });

  it("needs backups.manage", async () => {
    const res = await postSettings({ includeDb: true }, "moderator");
    expect(res.getStatusCode()).toBe(403);
    expect(services.backupService.updateSettings).not.toHaveBeenCalled();
  });
});
