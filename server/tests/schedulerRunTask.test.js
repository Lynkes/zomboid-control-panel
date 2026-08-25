import { beforeEach, describe, expect, it, vi } from "vitest";

// Roles for the rcon.execute-gate tests below: mirrors the shape
// requirePermission() (services/permissions.js) actually reads --
// getRoleByName(req.user.role).capabilities.
const ROLES = {
  automation_only: { name: "automation_only", capabilities: ["automation.manage"] },
  automation_and_rcon: {
    name: "automation_and_rcon",
    capabilities: ["automation.manage", "rcon.execute"],
  },
};

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  getServer: vi.fn(),
  getActiveServer: vi.fn().mockResolvedValue(null),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  logPlayerAction: vi.fn().mockResolvedValue(),
  recordPlayerSession: vi.fn().mockResolvedValue(),
  getRoleByName: vi.fn((name) => Promise.resolve(ROLES[name] || null)),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { getScheduledTasks, createScheduledTask, logScheduleExecution } =
  await import("../database/init.js");
const { default: router } = await import("../routes/scheduler.js");

function makeScheduler() {
  const rconService = {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
  };
  const serverManager = { _serverId: null };
  const scheduler = new Scheduler(rconService, serverManager);
  return { scheduler, rconService, serverManager };
}

// These assert runTaskNow() — the dispatch a cron fire AND the manual
// "run now" route now share — routes every task type to its real handler
// instead of shelling task.command straight to RCON.
describe("Scheduler.runTaskNow command dispatch", () => {
  it("routes 'restart' through performRestart, not raw RCON", async () => {
    const { scheduler, rconService } = makeScheduler();
    scheduler.performRestart = vi.fn().mockResolvedValue({ success: true });

    await scheduler.runTaskNow({ id: 1, name: "Restart", command: "restart" });

    expect(scheduler.performRestart).toHaveBeenCalledWith(null, {
      rconService,
      serverManager: expect.any(Object),
    });
    expect(rconService.execute).not.toHaveBeenCalledWith("restart", expect.anything());
  });

  it("routes 'save' through rconService.save()", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({ id: 2, name: "Save", command: "save" });

    expect(rconService.save).toHaveBeenCalledWith({ skipLog: true });
  });

  it("routes 'servermsg <text>' through rconService.serverMessage()", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({
      id: 3,
      name: "Broadcast",
      command: "servermsg Server restarting soon",
    });

    expect(rconService.serverMessage).toHaveBeenCalledWith(
      "Server restarting soon",
      { skipLog: true },
    );
  });

  it("routes 'bridge:<action>' through executeBridgeAction()", async () => {
    const { scheduler } = makeScheduler();
    scheduler.executeBridgeAction = vi.fn().mockResolvedValue();

    await scheduler.runTaskNow({
      id: 4,
      name: "Storm",
      command: "bridge:triggerStorm",
    });

    expect(scheduler.executeBridgeAction).toHaveBeenCalledWith(
      "bridge:triggerStorm",
    );
  });

  it("falls back to a raw RCON command for anything else", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({ id: 5, name: "Players", command: "players" });

    expect(rconService.execute).toHaveBeenCalledWith("players", {
      skipLog: true,
    });
  });
});

function getRunNowHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/tasks/:id/run" && entry.route.methods.post,
  );
  return layer.route.stack[0].handle;
}

function getUpdateHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/tasks/:id" && entry.route.methods.put,
  );
  return layer.route.stack[0].handle;
}

function getCreateHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/tasks" && entry.route.methods.post,
  );
  return layer.route.stack[0].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("POST /api/scheduler/tasks/:id/run", () => {
  let runTaskNow;

  beforeEach(() => {
    runTaskNow = vi.fn().mockResolvedValue();
    getScheduledTasks.mockReset();
  });

  it("triggers the matching task through scheduler.runTaskNow()", async () => {
    const task = { id: 7, name: "Restart", command: "restart" };
    getScheduledTasks.mockResolvedValue([task]);
    const app = { get: vi.fn().mockReturnValue({ runTaskNow }) };
    const response = createResponse();

    await getRunNowHandler()({ app, params: { id: "7" } }, response);

    expect(runTaskNow).toHaveBeenCalledWith(task);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("returns 404 for a task id that doesn't exist", async () => {
    getScheduledTasks.mockResolvedValue([]);
    const app = { get: vi.fn().mockReturnValue({ runTaskNow }) };
    const response = createResponse();

    await getRunNowHandler()({ app, params: { id: "999" } }, response);

    expect(runTaskNow).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(404);
  });
});

describe("PUT /api/scheduler/tasks/:id", () => {
  it("keeps an enabled task scheduled when enabled is omitted", async () => {
    const { updateScheduledTask } = await import("../database/init.js");
    const scheduleTask = vi.fn();
    const cancelTask = vi.fn();
    updateScheduledTask.mockResolvedValue({
      id: 8,
      name: "Renamed task",
      cron_expression: "0 * * * *",
      command: "save",
      enabled: 1,
      server_id: null,
    });
    const response = createResponse();

    await getUpdateHandler()(
      {
        params: { id: "8" },
        body: { name: "Renamed task" },
        app: { get: () => ({ scheduleTask, cancelTask }) },
      },
      response,
    );

    expect(scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 8, enabled: 1 }),
    );
    expect(cancelTask).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("rejects stringified enabled values instead of treating false as true", async () => {
    const { updateScheduledTask } = await import("../database/init.js");
    updateScheduledTask.mockClear();
    const response = createResponse();

    await getUpdateHandler()(
      {
        params: { id: "8" },
        body: { enabled: "false" },
        app: { get: () => ({ scheduleTask: vi.fn(), cancelTask: vi.fn() }) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(updateScheduledTask).not.toHaveBeenCalled();
  });
});

// Finding 1 (docs/qa/kevin-adversarial-findings.md): a role holding only
// automation.manage must NOT be able to reach raw RCON execution through a
// scheduled task -- creating one, editing one's command, or running one now
// all require rcon.execute too when the command isn't one of the curated
// restart/save/servermsg/bridge: verbs. A cron fire has no req.user to
// check, so these three request-bound moments are the only places the gate
// can live; see the comment above requireCapabilityInline() in
// routes/scheduler.js for why.
describe("rcon.execute gate on raw scheduled commands", () => {
  describe("POST /api/scheduler/tasks", () => {
    const baseBody = {
      name: "Suspicious task",
      cronExpression: "0 * * * *",
    };

    it("refuses to create a raw-command task for automation.manage alone", async () => {
      const response = createResponse();
      await getCreateHandler()(
        {
          user: { role: "automation_only" },
          body: { ...baseBody, command: 'godmod "attacker" true' },
          app: { get: () => ({ scheduleTask: vi.fn() }) },
        },
        response,
      );

      expect(response.status).toHaveBeenCalledWith(403);
      expect(createScheduledTask).not.toHaveBeenCalled();
    });

    it("allows creating a raw-command task when the role also holds rcon.execute", async () => {
      createScheduledTask.mockResolvedValue({ id: 42 });
      const scheduleTask = vi.fn();
      const response = createResponse();

      await getCreateHandler()(
        {
          user: { role: "automation_and_rcon" },
          body: { ...baseBody, command: 'godmod "attacker" true' },
          app: { get: () => ({ scheduleTask }) },
        },
        response,
      );

      expect(createScheduledTask).toHaveBeenCalled();
      expect(scheduleTask).toHaveBeenCalled();
      expect(response.status).not.toHaveBeenCalledWith(403);
    });

    it("does not require rcon.execute for a curated verb like 'restart'", async () => {
      createScheduledTask.mockResolvedValue({ id: 43 });
      const scheduleTask = vi.fn();
      const response = createResponse();

      await getCreateHandler()(
        {
          user: { role: "automation_only" },
          body: { ...baseBody, command: "restart" },
          app: { get: () => ({ scheduleTask }) },
        },
        response,
      );

      expect(createScheduledTask).toHaveBeenCalled();
      expect(response.status).not.toHaveBeenCalledWith(403);
    });
  });

  describe("PUT /api/scheduler/tasks/:id", () => {
    it("refuses to change a task's command to a raw one for automation.manage alone", async () => {
      const { updateScheduledTask } = await import("../database/init.js");
      updateScheduledTask.mockClear();
      const response = createResponse();

      await getUpdateHandler()(
        {
          user: { role: "automation_only" },
          params: { id: "8" },
          body: { command: 'banuser "someone"' },
          app: { get: () => ({ scheduleTask: vi.fn(), cancelTask: vi.fn() }) },
        },
        response,
      );

      expect(response.status).toHaveBeenCalledWith(403);
      expect(updateScheduledTask).not.toHaveBeenCalled();
    });

    it("does not require rcon.execute when the update leaves command untouched, even if the task's stored command is raw", async () => {
      const { updateScheduledTask } = await import("../database/init.js");
      updateScheduledTask.mockClear();
      updateScheduledTask.mockResolvedValue({
        id: 8,
        name: "Renamed again",
        cron_expression: "0 * * * *",
        command: 'banuser "someone"', // pre-existing raw command, untouched by this request
        enabled: 1,
        server_id: null,
      });
      const response = createResponse();

      await getUpdateHandler()(
        {
          user: { role: "automation_only" },
          params: { id: "8" },
          body: { name: "Renamed again" },
          app: { get: () => ({ scheduleTask: vi.fn(), cancelTask: vi.fn() }) },
        },
        response,
      );

      expect(response.status).not.toHaveBeenCalledWith(403);
      expect(updateScheduledTask).toHaveBeenCalled();
    });
  });

  describe("POST /api/scheduler/tasks/:id/run", () => {
    it("refuses to run a task whose STORED command is raw for automation.manage alone", async () => {
      const task = { id: 9, name: "Suspicious", command: 'banuser "someone"' };
      getScheduledTasks.mockResolvedValue([task]);
      const runTaskNow = vi.fn().mockResolvedValue();
      const response = createResponse();

      await getRunNowHandler()(
        {
          user: { role: "automation_only" },
          app: { get: () => ({ runTaskNow }) },
          params: { id: "9" },
        },
        response,
      );

      expect(response.status).toHaveBeenCalledWith(403);
      expect(runTaskNow).not.toHaveBeenCalled();
    });

    it("allows running a raw-command task when the CURRENT caller holds rcon.execute, regardless of who created it", async () => {
      const task = { id: 10, name: "Suspicious", command: 'banuser "someone"' };
      getScheduledTasks.mockResolvedValue([task]);
      const runTaskNow = vi.fn().mockResolvedValue();
      const response = createResponse();

      await getRunNowHandler()(
        {
          user: { role: "automation_and_rcon" },
          app: { get: () => ({ runTaskNow }) },
          params: { id: "10" },
        },
        response,
      );

      expect(response.status).not.toHaveBeenCalledWith(403);
      expect(runTaskNow).toHaveBeenCalledWith(task);
    });

    it("does not require rcon.execute to run a curated verb like 'save'", async () => {
      const task = { id: 11, name: "Nightly save", command: "save" };
      getScheduledTasks.mockResolvedValue([task]);
      const runTaskNow = vi.fn().mockResolvedValue();
      const response = createResponse();

      await getRunNowHandler()(
        {
          user: { role: "automation_only" },
          app: { get: () => ({ runTaskNow }) },
          params: { id: "11" },
        },
        response,
      );

      expect(response.status).not.toHaveBeenCalledWith(403);
      expect(runTaskNow).toHaveBeenCalledWith(task);
    });
  });
});

// Finding 3 (docs/qa/kevin-adversarial-findings.md): performRestart() used
// to hardcode "Auto Restart" as the Schedule History task name for every
// caller, including a human clicking Restart Now. It now takes an optional
// label, defaulting to "Auto Restart" for genuinely unattended triggers.
describe("performRestart() Schedule History labeling", () => {
  function makeSchedulerForRestart() {
    const rconService = {
      connected: true,
      connect: vi.fn().mockResolvedValue(),
      execute: vi.fn().mockResolvedValue({ success: false, error: "RCON unavailable" }),
    };
    const serverManager = {
      _serverId: null,
      checkServerRunning: vi.fn().mockResolvedValue(true), // wasRunning=true -> skips the 10s "wait and start" path
    };
    return { scheduler: new Scheduler(rconService, serverManager), rconService };
  }

  beforeEach(() => {
    logScheduleExecution.mockClear();
  });

  it("defaults to 'Auto Restart' when no label is passed (genuinely unattended callers unchanged)", async () => {
    const { scheduler } = makeSchedulerForRestart();

    const result = await scheduler.performRestart();

    expect(result.success).toBe(false);
    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Auto Restart",
      "restart",
      false,
      expect.stringContaining("RCON not available"),
      expect.any(Number),
    );
  });

  it("uses the caller-supplied label instead", async () => {
    const { scheduler } = makeSchedulerForRestart();

    await scheduler.performRestart(null, { label: "Manual restart" });

    expect(logScheduleExecution).toHaveBeenCalledWith(
      null,
      "Manual restart",
      "restart",
      false,
      expect.stringContaining("RCON not available"),
      expect.any(Number),
    );
  });
});

describe("POST /api/scheduler/restart-now labels its Schedule History entry as manual", () => {
  function getRestartNowHandler() {
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/restart-now" && entry.route.methods.post,
    );
    return layer.route.stack[0].handle;
  }

  it("calls scheduler.performRestart with label: 'Manual restart'", async () => {
    const { getActiveServer } = await import("../database/init.js");
    getActiveServer.mockResolvedValue(null);
    const performRestart = vi.fn().mockResolvedValue({ success: true });
    const response = createResponse();

    await getRestartNowHandler()(
      {
        body: { warningMinutes: 5 },
        app: { get: () => ({ performRestart }) },
      },
      response,
    );

    expect(performRestart).toHaveBeenCalledWith(5, { label: "Manual restart" });
  });
});
