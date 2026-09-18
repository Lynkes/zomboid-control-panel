import { beforeEach, describe, expect, it, vi } from "vitest";

// continuous-bug-hunt round 28 (ux-proposals-need-backend-data): the UX
// deep pass (092bfac0) wanted a per-task next-run time on the Scheduler
// page but had no server data to show. GET /scheduler/tasks now attaches
// `next_run` per task via scheduler.getTaskNextRun(task) -- delegated to
// the scheduler service instance, not computed inline here, so this test
// only needs to prove the route forwards whatever the service returns
// (including null when there's no scheduler instance available at all).

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  deleteScheduledTask: vi.fn(),
  getScheduleHistory: vi.fn(),
  clearScheduleHistory: vi.fn(),
  getServer: vi.fn(),
  getActiveServer: vi.fn().mockResolvedValue(null),
}));

const { getScheduledTasks } = await import("../database/init.js");
const { default: router } = await import("../routes/scheduler.js");

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

beforeEach(() => {
  getScheduledTasks.mockReset();
});

describe("GET /api/scheduler/tasks -- attaches per-task next_run", () => {
  it("calls scheduler.getTaskNextRun(task) for each task and includes the result", async () => {
    const task1 = { id: 1, name: "Task One", cron_expression: "0 3 * * *", enabled: true };
    const task2 = { id: 2, name: "Task Two", cron_expression: "*/5 * * * *", enabled: false };
    getScheduledTasks.mockResolvedValue([task1, task2]);

    const getTaskNextRun = vi.fn((task) =>
      task.id === 1 ? "2026-09-19T07:00:00.000Z" : null,
    );
    const req = { app: { get: () => ({ getTaskNextRun }) } };
    const res = createResponse();

    await getHandler("/tasks", "get")(req, res);

    expect(getTaskNextRun).toHaveBeenCalledWith(task1);
    expect(getTaskNextRun).toHaveBeenCalledWith(task2);
    expect(res.json).toHaveBeenCalledWith({
      tasks: [
        { ...task1, next_run: "2026-09-19T07:00:00.000Z" },
        { ...task2, next_run: null },
      ],
    });
  });

  it("degrades to next_run: null for every task rather than 500ing when no scheduler instance is registered", async () => {
    const task1 = { id: 1, name: "Task One", cron_expression: "0 3 * * *", enabled: true };
    getScheduledTasks.mockResolvedValue([task1]);

    const req = { app: { get: () => null } };
    const res = createResponse();

    await getHandler("/tasks", "get")(req, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ tasks: [{ ...task1, next_run: null }] });
  });
});
