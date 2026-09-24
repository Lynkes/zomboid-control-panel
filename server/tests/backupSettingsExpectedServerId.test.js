import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// continuous-bug-hunt round 23 (backup settings update has no server
// check): POST /backup/settings (schedule/maxBackups/includeDb, AND the
// backup enable toggle -- all three share this one route, see its own
// `req.body.enabled` handling) and POST /backup/delete-older-than both
// applied to whichever server backupService is currently scoped to (the
// active one), with no way for the caller to say which server it MEANT --
// unlike delete/restore, which check the named backup file's own
// ownership (backupReadPathsOwnership.test.js). An operator who loads the
// Backups page, then switches the active server in another tab/device
// before saving, silently applied their edit to the NEW server instead of
// the one they were looking at. Fixed by accepting an optional
// expectedServerId, mirroring chunks.js's own expectedServerId/
// CHUNKS_STALE_SERVER_SCAN convention exactly: undefined skips the check
// (an old client that hasn't been updated to send it keeps working
// unchanged), a real mismatch refuses with a coded 409.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/backup.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

let updateSettings;
let deleteBackupsOlderThan;
let services;

beforeEach(() => {
  getActiveServer.mockReset().mockResolvedValue({ id: "server-current" });
  updateSettings = vi.fn(async (allowed) => ({ enabled: true, ...allowed }));
  deleteBackupsOlderThan = vi.fn(async () => ({ success: true, deleted: 3 }));
  services = {
    backupService: { updateSettings, deleteBackupsOlderThan },
    scheduler: { setupBackupSchedule: vi.fn(async () => {}) },
    io: { emit: vi.fn() },
  };
});

function postSettings(body) {
  return runRoute("/settings", "post", {
    user: { role: "admin" },
    body,
    app: { get: (key) => services[key] },
  });
}

function postDeleteOlderThan(body) {
  return runRoute("/delete-older-than", "post", {
    user: { role: "admin" },
    body,
    app: { get: (key) => services[key] },
  });
}

describe("POST /backup/settings: expectedServerId guards against a stale active-server assumption", () => {
  it("applies the update when no expectedServerId is sent (back-compat, old client)", async () => {
    const res = await postSettings({ maxBackups: 10 });

    expect(res.getStatusCode()).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({ maxBackups: 10 });
  });

  it("applies the update when expectedServerId matches the active server", async () => {
    const res = await postSettings({ maxBackups: 10, expectedServerId: "server-current" });

    expect(res.getStatusCode()).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({ maxBackups: 10 });
  });

  it("refuses with a coded 409 when expectedServerId no longer matches the active server", async () => {
    const res = await postSettings({ maxBackups: 10, expectedServerId: "server-old" });

    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({ code: "BACKUP_ACTIVE_SERVER_CHANGED" });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  // The enable toggle shares this exact route (req.body.enabled) -- proves
  // the guard covers it too, not just schedule/maxBackups/includeDb.
  it("refuses the enable toggle too when the active server changed underneath it", async () => {
    const res = await postSettings({ enabled: false, expectedServerId: "server-old" });

    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({ code: "BACKUP_ACTIVE_SERVER_CHANGED" });
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe("POST /backup/delete-older-than: expectedServerId guards against a stale active-server assumption", () => {
  it("deletes when no expectedServerId is sent (back-compat, old client)", async () => {
    const res = await postDeleteOlderThan({ days: 30 });

    expect(res.getStatusCode()).toBe(200);
    expect(deleteBackupsOlderThan).toHaveBeenCalledWith(30);
  });

  it("deletes when expectedServerId matches the active server", async () => {
    const res = await postDeleteOlderThan({ days: 30, expectedServerId: "server-current" });

    expect(res.getStatusCode()).toBe(200);
    expect(deleteBackupsOlderThan).toHaveBeenCalledWith(30);
  });

  it("refuses with a coded 409 when expectedServerId no longer matches the active server, deleting nothing", async () => {
    const res = await postDeleteOlderThan({ days: 30, expectedServerId: "server-old" });

    expect(res.getStatusCode()).toBe(409);
    expect(res.getBody()).toMatchObject({ code: "BACKUP_ACTIVE_SERVER_CHANGED" });
    expect(deleteBackupsOlderThan).not.toHaveBeenCalled();
  });
});
