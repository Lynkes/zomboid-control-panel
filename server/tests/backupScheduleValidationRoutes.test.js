import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// 2026-09-27 community request: a "Custom (cron expression)" option on the
// Backups page's frequency picker, validated live the way the Scheduler
// page validates a task's cron. The Scheduler's /validate-cron lives behind
// automation.manage, so the backup schedule gets its own backups.manage
// preview -- sharing ONE verdict function with POST /settings, so the
// preview can't call "valid" what the save then refuses. The same responses
// carry the restart-overlap warning (scheduled restarts the schedule lands
// inside), and GET /status carries it for the saved schedule.

// A custom role on top of the three seeded ones: may run backups but not
// the Scheduler (no automation.manage) -- the case the restart-overlap
// redaction below exists for.
const BACKUP_OPERATOR_ROLE = {
  id: "role-backup-operator",
  name: "backup-operator",
  capabilities: ["backups.manage", "backups.download"],
  isSeeded: false,
};

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: async (name) =>
    name === BACKUP_OPERATOR_ROLE.name ? BACKUP_OPERATOR_ROLE : mockGetRoleByName(name),
}));

const { default: router } = await import("../routes/backup.js");

function createResponse() {
  const response = {};
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

async function runRoute(routePath, method, req) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  const handlers = layer.route.stack.map((s) => s.handle);
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

let services;
const OVERLAP = {
  kind: "task",
  name: "Restart every 4h",
  cron: "0 */4 * * *",
  restartTime: "00:00",
  backupTime: "00:00",
  allBackups: true,
  windowMinutes: 10,
};

beforeEach(() => {
  services = {
    scheduler: {
      effectiveTimezone: "UTC",
      getBackupNextRun: vi.fn(() => null),
      getBackupRestartOverlaps: vi.fn(async () => [OVERLAP]),
      getDeferredBackupSince: vi.fn(() => null),
      setupBackupSchedule: vi.fn(async () => {}),
    },
    backupService: {
      getStatus: vi.fn(async () => ({ enabled: true, schedule: "0 */4 * * *" })),
      updateSettings: vi.fn(async (allowed) => ({ ...allowed })),
    },
  };
});

const request = (body, role = "admin") => ({
  user: { role },
  body,
  app: { get: (key) => services[key] },
});

describe("POST /backup/validate-schedule", () => {
  it("accepts a valid custom expression and returns next run, timezone and restart overlaps", async () => {
    const res = await runRoute("/validate-schedule", "post", request({ schedule: " 0 */4 * * * " }));

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.valid).toBe(true);
    expect(body.timezone).toBe("UTC");
    expect(typeof body.nextRun).toBe("string");
    expect(new Date(body.nextRun).getUTCMinutes()).toBe(0);
    expect(new Date(body.nextRun).getUTCHours() % 4).toBe(0);
    expect(body.restartOverlaps).toEqual([OVERLAP]);
    expect(services.scheduler.getBackupRestartOverlaps).toHaveBeenCalledWith("0 */4 * * *");
  });

  it.each([
    ["not cron at all", "every day please", "SCHEDULER_INVALID_CRON_EXPRESSION"],
    ["seconds-precision (6 fields)", "0 0 */4 * * *", "SCHEDULER_CRON_SECONDS_UNSUPPORTED"],
    ["more often than every 5 minutes", "*/2 * * * *", "BACKUP_SCHEDULE_TOO_FREQUENT"],
    ["empty", "   ", "SCHEDULER_INVALID_CRON_EXPRESSION"],
  ])("rejects %s with a translatable code", async (_label, schedule, code) => {
    const res = await runRoute("/validate-schedule", "post", request({ schedule }));

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ valid: false, code }));
    expect(services.scheduler.getBackupRestartOverlaps).not.toHaveBeenCalled();
  });
});

// 1.4.0 pre-release bug round: the preview's "Next backup" came from the
// panel's own calculation, which applied classic cron's "day-of-month OR
// weekday" rule -- node-cron, which fires the job, requires BOTH. And a
// wrap-around range ("22-2") node-cron runs fine was refused as "more often
// than every 5 minutes".
describe("POST /backup/validate-schedule -- node-cron's reading of the schedule", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const at = (iso) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  };

  it.each([
    // [schedule, node-cron's first run from 2026-09-28 12:00 UTC]
    ["0 4 1 * 1", "2027-02-01T04:00:00.000Z"], // a 1st that is a Monday, not Oct 1
    ["0 4 1-7 * 1", "2026-10-05T04:00:00.000Z"], // first Monday, not Oct 1
    ["0 4 13 * 5", "2026-11-13T04:00:00.000Z"], // Friday the 13th, not Oct 2
  ])("%s: next backup %s, flagged as restricting both day fields", async (schedule, nextRun) => {
    at("2026-09-28T12:00:00Z");
    const res = await runRoute("/validate-schedule", "post", request({ schedule }));

    expect(res.getBody()).toEqual(
      expect.objectContaining({ valid: true, nextRun, bothDayFieldsRestricted: true }),
    );
  });

  it("does not flag a schedule restricting only one day field", async () => {
    at("2026-09-28T12:00:00Z");
    const res = await runRoute("/validate-schedule", "post", request({ schedule: "0 4 * * MON" }));

    expect(res.getBody()).toEqual(
      expect.objectContaining({
        valid: true,
        nextRun: "2026-10-05T04:00:00.000Z",
        bothDayFieldsRestricted: false,
      }),
    );
  });

  it("accepts a wrap-around hour range as the hourly schedule it is -- preview and save", async () => {
    at("2026-09-28T12:00:00Z");
    const preview = await runRoute(
      "/validate-schedule",
      "post",
      request({ schedule: "0 22-2 * * *" }),
    );
    expect(preview.getBody()).toEqual(
      expect.objectContaining({ valid: true, nextRun: "2026-09-28T22:00:00.000Z" }),
    );

    const save = await runRoute("/settings", "post", request({ schedule: "0 22-2 * * *" }));
    expect(save.getStatusCode()).toBe(200);
    expect(services.backupService.updateSettings).toHaveBeenCalledWith({ schedule: "0 22-2 * * *" });
  });

  it("still refuses a wrap-around range that really is too frequent", async () => {
    const res = await runRoute("/validate-schedule", "post", request({ schedule: "50-2 * * * *" }));

    expect(res.getBody()).toEqual(
      expect.objectContaining({ valid: false, code: "BACKUP_SCHEDULE_TOO_FREQUENT" }),
    );
  });
});

describe("POST /backup/settings -- same verdict as the preview", () => {
  it("refuses a too-frequent custom schedule with BACKUP_SCHEDULE_TOO_FREQUENT and saves nothing", async () => {
    const res = await runRoute("/settings", "post", request({ schedule: "*/2 * * * *" }));

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: false, code: "BACKUP_SCHEDULE_TOO_FREQUENT" }));
    expect(services.backupService.updateSettings).not.toHaveBeenCalled();
  });

  it("saves a valid custom schedule (trimmed) and re-arms the backup job", async () => {
    const res = await runRoute("/settings", "post", request({ schedule: " 30 3 * * 1-5 " }));

    expect(res.getStatusCode()).toBe(200);
    expect(services.backupService.updateSettings).toHaveBeenCalledWith({ schedule: "30 3 * * 1-5" });
    expect(services.scheduler.setupBackupSchedule).toHaveBeenCalled();
  });
});

describe("GET /backup/status -- restart interactions for the saved schedule", () => {
  it("includes restartOverlaps and backupDeferredSince from the scheduler", async () => {
    services.scheduler.getDeferredBackupSince.mockReturnValue("2026-09-27T04:00:00.000Z");

    const res = await runRoute("/status", "get", request(undefined));

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().restartOverlaps).toEqual([OVERLAP]);
    expect(res.getBody().backupDeferredSince).toBe("2026-09-27T04:00:00.000Z");
  });

  it("reports no overlaps for a disabled schedule, and never 500s if the overlap check itself throws", async () => {
    services.backupService.getStatus.mockResolvedValue({ enabled: false, schedule: "0 */4 * * *" });
    let res = await runRoute("/status", "get", request(undefined));
    expect(res.getBody().restartOverlaps).toEqual([]);
    expect(services.scheduler.getBackupRestartOverlaps).not.toHaveBeenCalled();

    services.backupService.getStatus.mockResolvedValue({ enabled: true, schedule: "0 */4 * * *" });
    services.scheduler.getBackupRestartOverlaps.mockRejectedValue(new Error("db locked"));
    res = await runRoute("/status", "get", request(undefined));
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().restartOverlaps).toEqual([]);
  });
});

describe("who may preview a schedule, and who sees which restart it collides with", () => {
  it("refuses POST /validate-schedule without backups.manage, before any overlap work", async () => {
    const res = await runRoute(
      "/validate-schedule",
      "post",
      request({ schedule: "0 */4 * * *" }, "moderator"),
    );

    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody()).toEqual(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(services.scheduler.getBackupRestartOverlaps).not.toHaveBeenCalled();
  });

  it("keeps the restart task's name and cron for a caller who can read the Scheduler", async () => {
    const res = await runRoute(
      "/validate-schedule",
      "post",
      request({ schedule: "0 */4 * * *" }, "technician"),
    );

    expect(res.getBody().restartOverlaps).toEqual([OVERLAP]);
  });

  it("drops the task's name and cron -- keeping the warning itself -- for a backups-only role", async () => {
    const redacted = { ...OVERLAP, name: null, cron: null };

    let res = await runRoute(
      "/validate-schedule",
      "post",
      request({ schedule: "0 */4 * * *" }, BACKUP_OPERATOR_ROLE.name),
    );
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().restartOverlaps).toEqual([redacted]);

    res = await runRoute("/status", "get", request(undefined, BACKUP_OPERATOR_ROLE.name));
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().restartOverlaps).toEqual([redacted]);
  });
});
