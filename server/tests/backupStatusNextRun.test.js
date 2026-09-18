import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// continuous-bug-hunt round 28 (ux-proposals-need-backend-data): the
// Scheduler page's backup-health card needs the backup schedule's own
// next-run time alongside lastScheduledBackupAttempt (already computed by
// backupService.getStatus()) -- backupService has no reference to the
// scheduler instance, so GET /backup/status composes the two at the route
// layer, same shape as GET /scheduler/tasks' own next_run field.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
}));

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

let getStatus;
let services;

beforeEach(() => {
  getStatus = vi.fn(async () => ({
    enabled: true,
    lastScheduledBackupAttempt: { success: true, message: null, executedAt: "2026-09-18T00:00:00.000Z" },
  }));
  services = { backupService: { getStatus } };
});

function getBackupStatus() {
  return runRoute("/status", "get", {
    user: { role: "admin" },
    app: { get: (key) => services[key] },
  });
}

describe("GET /backup/status: composes backupNextRun from the scheduler instance", () => {
  it("includes backupNextRun from scheduler.getBackupNextRun() alongside backupService's own fields", async () => {
    services.scheduler = { getBackupNextRun: vi.fn(() => "2026-09-19T00:00:00.000Z") };

    const res = await getBackupStatus();

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.backupNextRun).toBe("2026-09-19T00:00:00.000Z");
    // backupService's own fields still pass through untouched.
    expect(body.enabled).toBe(true);
    expect(body.lastScheduledBackupAttempt.success).toBe(true);
  });

  it("reports backupNextRun: null when the scheduler says backups are disabled (no backupJob)", async () => {
    services.scheduler = { getBackupNextRun: vi.fn(() => null) };

    const res = await getBackupStatus();

    expect(res.getBody().backupNextRun).toBeNull();
  });

  it("degrades to backupNextRun: null rather than erroring when no scheduler instance is registered", async () => {
    // services.scheduler intentionally left unset.
    const res = await getBackupStatus();

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().backupNextRun).toBeNull();
  });
});
