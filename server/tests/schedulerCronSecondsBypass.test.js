import { beforeEach, describe, expect, it, vi } from "vitest";

// hunt-code-patterns (conv-hunt-resume): isCronTooFrequent()'s "Security:
// Reject tasks that run more frequently than every 5 minutes to prevent
// DoS" guard always read parts[0] as MINUTES. node-cron accepts an
// optional leading SECONDS field (6 fields total) that this app has never
// documented, tested, or exposed a legitimate use for -- for a 6-field
// expression parts[0] is actually seconds, so "*/5 * * * * *" (fires every
// 5 SECONDS) read as minute="*/5", which looks like an ordinary
// once-every-5-minutes value and sailed through untouched. The bypass
// window was narrower than "any 6-field expression": "* * * * * *" and
// "*/1"-"*/4" seconds were caught BY ACCIDENT (parts[0] still matched the
// every-minute checks), which is exactly why this survived a spot-check.
// Fix: reject any non-5-field expression outright via
// hasUnsupportedCronFieldCount(), checked before isCronTooFrequent() at
// every entry point (POST /tasks, PUT /tasks/:id, POST /validate-cron).
//
// These tests prove: the exact bypass string from the live finding is now
// refused, the accidental-catch cases stay caught (for the right reason
// now, not by accident), and none of isCronTooFrequent's existing 5-field
// hardening (every-minute, range-step, comma-separated, hour-pinned burst)
// regressed.

const ROLES = {
  automation_only: { name: "automation_only", capabilities: ["automation.manage"] },
};

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  getServer: vi.fn(),
  getActiveServer: vi.fn().mockResolvedValue(null),
  getRoleByName: vi.fn((name) => Promise.resolve(ROLES[name] || null)),
}));

const { createScheduledTask, updateScheduledTask } = await import("../database/init.js");
const { default: router, hasUnsupportedCronFieldCount } = await import("../routes/scheduler.js");

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack[0].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function baseReq(overrides = {}) {
  return {
    user: { role: "automation_only" },
    app: { get: () => ({ scheduleTask: vi.fn() }) },
    ...overrides,
  };
}

describe("hasUnsupportedCronFieldCount() -- exact arity, not a floor", () => {
  it("accepts exactly 5 fields", () => {
    expect(hasUnsupportedCronFieldCount("0 */6 * * *")).toBe(false);
  });
  it("rejects 6 fields (seconds-precision)", () => {
    expect(hasUnsupportedCronFieldCount("*/5 * * * * *")).toBe(true);
  });
  it("rejects 4 fields", () => {
    expect(hasUnsupportedCronFieldCount("* * * *")).toBe(true);
  });
  it("tolerates extra whitespace between fields without miscounting", () => {
    expect(hasUnsupportedCronFieldCount("0   */6  *  *   *")).toBe(false);
  });
});

describe("POST /api/scheduler/tasks -- seconds-precision cron rejection", () => {
  beforeEach(() => {
    createScheduledTask.mockReset();
  });

  it("refuses the exact live bypass string ('*/5 * * * * *', fires every 5 seconds) that previously sailed through", async () => {
    const response = createResponse();
    await getHandler("/tasks", "post")(
      baseReq({
        body: { name: "x", cronExpression: "*/5 * * * * *", command: "restart" },
      }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/seconds-precision/i) }),
    );
    expect(createScheduledTask).not.toHaveBeenCalled();
  });

  it("still refuses '* * * * * *' (every second) -- the case that was already caught by accident, now caught for the right reason", async () => {
    const response = createResponse();
    await getHandler("/tasks", "post")(
      baseReq({
        body: { name: "x", cronExpression: "* * * * * *", command: "restart" },
      }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(createScheduledTask).not.toHaveBeenCalled();
  });

  it("does not regress: a genuinely too-frequent 5-field expression is still refused with the original message", async () => {
    const response = createResponse();
    await getHandler("/tasks", "post")(
      baseReq({
        body: { name: "x", cronExpression: "* * * * *", command: "restart" },
      }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Tasks cannot run more frequently than every 5 minutes" }),
    );
    expect(createScheduledTask).not.toHaveBeenCalled();
  });

  it("does not regress: a valid 5-field, not-too-frequent expression still creates the task", async () => {
    createScheduledTask.mockResolvedValue({ id: 99 });
    const response = createResponse();
    await getHandler("/tasks", "post")(
      baseReq({
        body: { name: "x", cronExpression: "0 */6 * * *", command: "restart" },
      }),
      response,
    );
    expect(createScheduledTask).toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalledWith(400);
  });
});

describe("PUT /api/scheduler/tasks/:id -- seconds-precision cron rejection", () => {
  beforeEach(() => {
    updateScheduledTask.mockReset();
  });

  it("refuses the exact live bypass string on update too", async () => {
    const response = createResponse();
    await getHandler("/tasks/:id", "put")(
      baseReq({
        params: { id: "1" },
        body: { cronExpression: "*/30 * * * * *" },
      }),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/seconds-precision/i) }),
    );
    expect(updateScheduledTask).not.toHaveBeenCalled();
  });

  it("does not regress: a valid 5-field expression still updates", async () => {
    updateScheduledTask.mockResolvedValue({ id: 1 });
    const response = createResponse();
    await getHandler("/tasks/:id", "put")(
      baseReq({
        params: { id: "1" },
        body: { cronExpression: "0 0 * * *" },
      }),
      response,
    );
    expect(updateScheduledTask).toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalledWith(400);
  });
});

describe("POST /api/scheduler/validate-cron -- preview stays consistent with what create/update will accept", () => {
  it("previews a 6-field expression as invalid, not valid, so the UI doesn't show success right before a real submit is refused", async () => {
    const response = createResponse();
    await getHandler("/validate-cron", "post")(
      baseReq({ body: { cronExpression: "*/5 * * * * *" } }),
      response,
    );
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ valid: false, error: expect.stringMatching(/seconds-precision/i) }),
    );
  });

  it("still previews a valid 5-field expression as valid", async () => {
    const response = createResponse();
    await getHandler("/validate-cron", "post")(
      baseReq({ body: { cronExpression: "0 */6 * * *" } }),
      response,
    );
    expect(response.json).toHaveBeenCalledWith({ valid: true });
  });
});
