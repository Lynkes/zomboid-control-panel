import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A scheduled restart of a REMOTE server shut it down and could not bring it
// back. performRestart() had no isRemote check -- only POST /restart-now and
// POST /server/restart refuse a remote server -- so the AUTO_RESTART_CRON job,
// a scheduled `restart` task, the mod-update restart and the Discord command
// all ran the whole sequence: the warning countdown, the RCON save and quit,
// and then startServer() found nothing it could launch ("Server path not
// configured"). The remote game was left down.
//
// performRestart() now refuses a remote target before the countdown (nothing
// announced, saved or stopped), and POST/PUT /tasks refuse to store an enabled
// `restart` task for a remote server.

const ROLES = {
  automation_only: {
    name: "automation_only",
    capabilities: ["automation.manage", "server.control"],
  },
};

const getServer = vi.fn();
const getActiveServer = vi.fn();
const logScheduleExecution = vi.fn().mockResolvedValue();
const getScheduledTasks = vi.fn();
const createScheduledTask = vi.fn();
const updateScheduledTask = vi.fn();

vi.mock("../database/init.js", () => ({
  getScheduledTasks: (...args) => getScheduledTasks(...args),
  createScheduledTask: (...args) => createScheduledTask(...args),
  updateScheduledTask: (...args) => updateScheduledTask(...args),
  deleteScheduledTask: vi.fn(),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: (...args) => logScheduleExecution(...args),
  getActiveServer: (...args) => getActiveServer(...args),
  getServer: (...args) => getServer(...args),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getRoleByName: vi.fn((name) => Promise.resolve(ROLES[name] || null)),
}));

const runManagedLifecycle = vi.fn();
vi.mock("../services/managedContainer.js", () => ({
  runManagedLifecycle: (...args) => runManagedLifecycle(...args),
}));

// Captures each cron.schedule() callback so a tick can be fired by hand.
const scheduled = [];
vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((expression, callback) => {
      scheduled.push({ expression, callback });
      return { stop: vi.fn(), getNextRun: () => null, on: vi.fn() };
    }),
    validate: vi.fn(() => true),
  },
}));

const { Scheduler } = await import("../services/scheduler.js");
const { ErrorCode } = await import("../utils/errorCodes.js");
const { default: router, codedActionResultFields } = await import("../routes/scheduler.js");

const REMOTE = { id: 7, name: "Hosted", serverName: "Hosted", isRemote: true };
const LOCAL = { id: 1, name: "Home", serverName: "Home", isRemote: false };
// Flagged remote, but a Docker container is mapped to it: the panel restarts it
// through Docker (runManagedLifecycle), whatever isRemote says.
const REMOTE_BUT_CONTAINER_MANAGED = { ...REMOTE, id: 8, dockerContainerName: "pz-server" };

function makeRcon() {
  return {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn().mockResolvedValue({ success: true }),
    connect: vi.fn().mockResolvedValue(),
  };
}

function makeManager(extra = {}) {
  return {
    getServerProcessDetails: vi.fn().mockResolvedValue({ running: true, scanFailed: false }),
    startServer: vi.fn().mockRejectedValue(new Error("Server path not configured")),
    stopServer: vi.fn().mockResolvedValue({ success: true }),
    ...extra,
  };
}

function expectNothingTouched(rcon, manager) {
  expect(rcon.serverMessage).not.toHaveBeenCalled();
  expect(rcon.execute).not.toHaveBeenCalled();
  expect(rcon.save).not.toHaveBeenCalled();
  expect(rcon.quit).not.toHaveBeenCalled();
  expect(manager.startServer).not.toHaveBeenCalled();
  expect(manager.stopServer).not.toHaveBeenCalled();
  expect(runManagedLifecycle).not.toHaveBeenCalled();
}

beforeEach(() => {
  scheduled.length = 0;
  getServer.mockReset();
  getActiveServer.mockReset();
  logScheduleExecution.mockClear();
  runManagedLifecycle.mockReset().mockResolvedValue({ handled: false });
  getScheduledTasks.mockReset().mockResolvedValue([]);
  createScheduledTask.mockReset();
  updateScheduledTask.mockReset();
  delete process.env.AUTO_RESTART_ENABLED;
  delete process.env.AUTO_RESTART_CRON;
});

afterEach(() => {
  delete process.env.AUTO_RESTART_ENABLED;
  delete process.env.AUTO_RESTART_CRON;
});

describe("performRestart() refuses a remote server before touching it", () => {
  it("the active server is remote: no warnings, save, quit or start, and the restart flag and lock stay free", async () => {
    getActiveServer.mockResolvedValue(REMOTE);
    const rcon = makeRcon();
    const manager = makeManager();
    const scheduler = new Scheduler(rcon, manager);
    scheduler.sleep = async () => {};

    const result = await scheduler.performRestart(5);

    expect(result).toMatchObject({
      success: false,
      code: ErrorCode.SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED,
      message: expect.stringMatching(/remote server/i),
    });
    expectNothingTouched(rcon, manager);
    expect(scheduler.restartInProgress).toBe(false);
    expect(scheduler.activeRestart).toBeNull();
    expect(manager.stopIntent).toBeUndefined();

    // The lock was not left behind: a second call is refused for the same
    // reason, not as "another operation is in progress".
    const again = await scheduler.performRestart(0);
    expect(again.code).toBe(ErrorCode.SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED);
  });

  it("a task pinned to a remote server that is not the active one (throwaway manager) is refused the same way", async () => {
    getActiveServer.mockResolvedValue(LOCAL);
    getServer.mockResolvedValue(REMOTE);
    const rcon = makeRcon();
    const manager = makeManager({ _serverId: REMOTE.id });
    const scheduler = new Scheduler(makeRcon(), makeManager());
    scheduler.sleep = async () => {};

    const result = await scheduler.performRestart(null, { rconService: rcon, serverManager: manager });

    expect(result.code).toBe(ErrorCode.SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED);
    expectNothingTouched(rcon, manager);
    expect(getServer).toHaveBeenCalledWith(REMOTE.id);
  });

  it("a server flagged remote that has a Docker container mapped is not refused: it restarts through Docker", async () => {
    getActiveServer.mockResolvedValue(REMOTE_BUT_CONTAINER_MANAGED);
    runManagedLifecycle.mockResolvedValue({ handled: true, success: true });
    const rcon = makeRcon();
    const manager = makeManager();
    const scheduler = new Scheduler(rcon, manager);
    scheduler.sleep = async () => {};

    const result = await scheduler.performRestart(0);

    expect(result.code).toBeUndefined();
    expect(result.success).toBe(true);
    expect(runManagedLifecycle).toHaveBeenCalledWith("restart", { serverId: REMOTE_BUT_CONTAINER_MANAGED.id });
    // Docker did the restart: no RCON quit, no spawn.
    expect(rcon.quit).not.toHaveBeenCalled();
    expect(manager.startServer).not.toHaveBeenCalled();
  });

  it("still restarts a local server (control)", async () => {
    getActiveServer.mockResolvedValue(LOCAL);
    getServer.mockResolvedValue(null);
    const rcon = makeRcon();
    const manager = makeManager({
      startServer: vi.fn().mockResolvedValue({ success: true }),
    });
    manager.getServerProcessDetails
      .mockResolvedValueOnce({ running: true, scanFailed: false })
      .mockResolvedValue({ running: false, scanFailed: false });
    const scheduler = new Scheduler(rcon, manager);
    scheduler.sleep = async () => {};

    const result = await scheduler.performRestart(0);

    expect(result.code).toBeUndefined();
    expect(rcon.save).toHaveBeenCalled();
    expect(rcon.quit).toHaveBeenCalled();
    expect(manager.startServer).toHaveBeenCalled();
  });

  it("the auto-restart job logs one Schedule History failure for a remote server and sends nothing", async () => {
    process.env.AUTO_RESTART_ENABLED = "true";
    process.env.AUTO_RESTART_CRON = "0 */6 * * *";
    getActiveServer.mockResolvedValue(REMOTE);
    const rcon = makeRcon();
    const manager = makeManager();
    const scheduler = new Scheduler(rcon, manager);
    scheduler.sleep = async () => {};
    scheduler.setupAutoRestart();
    expect(scheduled).toHaveLength(1);

    await scheduled[0].callback();

    expectNothingTouched(rcon, manager);
    const rows = logScheduleExecution.mock.calls.filter((call) => call[2] === "restart");
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe("Auto Restart");
    expect(rows[0][3]).toBe(false);
    expect(rows[0][4]).toMatch(/remote server/i);
    scheduler.stopAllJobs();
  });

  it("a scheduled restart task on a remote server fails with the translated code and one history row", async () => {
    getActiveServer.mockResolvedValue(LOCAL);
    getServer.mockResolvedValue(REMOTE);
    const scheduler = new Scheduler(makeRcon(), makeManager());
    scheduler.sleep = async () => {};

    const task = { id: 9, name: "Nightly", command: "restart", cron_expression: "0 4 * * *", server_id: REMOTE.id };
    const result = await scheduler.runTaskNow(task);

    expect(result).toMatchObject({
      success: false,
      code: ErrorCode.SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED,
    });
    const rows = logScheduleExecution.mock.calls.filter((call) => call[0] === 9);
    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe(false);
    // "Run now" reports the code to the toast, translated.
    expect(codedActionResultFields(result)).toEqual({ code: ErrorCode.SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED });
  });
});

describe("Discord /restart and the mod-update restart do not announce a restart of a remote server", () => {
  it("the Discord command answers with the refusal before telling anyone a restart began", async () => {
    getActiveServer.mockResolvedValue(REMOTE);
    const { DiscordBot } = await import("../services/discordBot.js");
    const bot = Object.create(DiscordBot.prototype);
    const replies = [];
    const interaction = {
      options: { getInteger: () => 5 },
      user: { tag: "someone#0001" },
      deferReply: vi.fn(),
      editReply: vi.fn(async (text) => replies.push(text)),
    };
    bot.serverManager = {
      getServerProcessDetails: async () => ({ running: true, scanFailed: false }),
    };
    bot.rconService = { connected: true, serverMessage: vi.fn(async () => ({ success: true })) };
    bot.scheduler = { performRestart: vi.fn(), restartInProgress: false };
    bot.sendNotification = vi.fn();

    await bot.handleRestart(interaction);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/remote server/i);
    expect(bot.sendNotification).not.toHaveBeenCalled();
    expect(bot.rconService.serverMessage).not.toHaveBeenCalled();
    expect(bot.scheduler.performRestart).not.toHaveBeenCalled();
  });

  it("a mod update on a remote server is counted handled, with no warning broadcast and no restart", async () => {
    getActiveServer.mockResolvedValue(REMOTE);
    const { ModChecker } = await import("../services/modChecker.js");
    const rcon = makeRcon();
    const scheduler = { rconService: rcon, performRestart: vi.fn() };
    const checker = new ModChecker();
    checker.scheduler = scheduler;

    const result = await checker.handleModUpdate([{ workshopId: "1", name: "Some Mod" }]);

    expect(result).toMatchObject({ success: true, skipped: true, markProcessed: true, reason: "server_remote" });
    expect(rcon.serverMessage).not.toHaveBeenCalled();
    expect(scheduler.performRestart).not.toHaveBeenCalled();
    expect(checker.pendingRestart).toBeFalsy();
  });
});

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

function req(scheduler, overrides = {}) {
  return {
    user: { role: "automation_only" },
    app: { get: () => scheduler },
    ...overrides,
  };
}

function fakeScheduler() {
  return { scheduleTask: vi.fn().mockReturnValue({ scheduled: true, dstWarning: null }), cancelTask: vi.fn() };
}

describe("POST /api/scheduler/tasks refuses a restart task for a remote server", () => {
  const body = { name: "Nightly", cronExpression: "0 4 * * *", command: "restart" };

  it("the active server is remote and no server is named", async () => {
    getActiveServer.mockResolvedValue(REMOTE);
    const scheduler = fakeScheduler();
    const response = createResponse();

    await getHandler("/tasks", "post")(req(scheduler, { body }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED }),
    );
    expect(createScheduledTask).not.toHaveBeenCalled();
    expect(scheduler.scheduleTask).not.toHaveBeenCalled();
  });

  it("a remote server is named explicitly while a local one is active", async () => {
    getActiveServer.mockResolvedValue(LOCAL);
    getServer.mockResolvedValue(REMOTE);
    const scheduler = fakeScheduler();
    const response = createResponse();

    await getHandler("/tasks", "post")(req(scheduler, { body: { ...body, serverId: REMOTE.id } }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createScheduledTask).not.toHaveBeenCalled();
  });

  it("other commands may still target a remote server (save, broadcast, raw RCON)", async () => {
    getActiveServer.mockResolvedValue(REMOTE);
    createScheduledTask.mockResolvedValue({ id: 5 });
    const scheduler = fakeScheduler();
    const response = createResponse();

    await getHandler("/tasks", "post")(
      req(scheduler, { body: { ...body, command: "save" } }),
      response,
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("a restart task for a remote server that has a Docker container mapped is accepted", async () => {
    getActiveServer.mockResolvedValue(REMOTE_BUT_CONTAINER_MANAGED);
    createScheduledTask.mockResolvedValue({ id: 7 });
    const scheduler = fakeScheduler();
    const response = createResponse();

    await getHandler("/tasks", "post")(req(scheduler, { body }), response);

    expect(response.status).not.toHaveBeenCalled();
    expect(scheduler.scheduleTask).toHaveBeenCalled();
  });

  it("a restart task for a local server is still created (control)", async () => {
    getActiveServer.mockResolvedValue(LOCAL);
    createScheduledTask.mockResolvedValue({ id: 6 });
    const scheduler = fakeScheduler();
    const response = createResponse();

    await getHandler("/tasks", "post")(req(scheduler, { body }), response);

    expect(response.status).not.toHaveBeenCalled();
    expect(scheduler.scheduleTask).toHaveBeenCalled();
  });
});

describe("PUT /api/scheduler/tasks/:id refuses a restart task that would be enabled on a remote server", () => {
  const stored = (overrides = {}) => ({
    id: 3,
    name: "Nightly",
    cron_expression: "0 4 * * *",
    command: "restart",
    server_id: REMOTE.id,
    enabled: 0,
    ...overrides,
  });

  async function put(body, task) {
    getScheduledTasks.mockResolvedValue([task]);
    updateScheduledTask.mockResolvedValue({ ...task, ...("enabled" in body ? { enabled: body.enabled ? 1 : 0 } : {}) });
    const scheduler = fakeScheduler();
    const response = createResponse();
    await getHandler("/tasks/:id", "put")(req(scheduler, { params: { id: "3" }, body }), response);
    return { scheduler, response };
  }

  beforeEach(() => {
    getServer.mockImplementation(async (id) => (String(id) === String(REMOTE.id) ? REMOTE : LOCAL));
    getActiveServer.mockResolvedValue(LOCAL);
  });

  it("enabling a stored restart task that points at a remote server", async () => {
    const { response } = await put({ enabled: true }, stored());
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED }),
    );
    expect(updateScheduledTask).not.toHaveBeenCalled();
  });

  it("re-pointing an enabled restart task at a remote server", async () => {
    const { response } = await put({ serverId: REMOTE.id }, stored({ enabled: 1, server_id: LOCAL.id }));
    expect(response.status).toHaveBeenCalledWith(400);
    expect(updateScheduledTask).not.toHaveBeenCalled();
  });

  it("turning an enabled task on a remote server into a restart", async () => {
    const { response } = await put({ command: "restart" }, stored({ enabled: 1, command: "save" }));
    expect(response.status).toHaveBeenCalledWith(400);
    expect(updateScheduledTask).not.toHaveBeenCalled();
  });

  it("disabling a restart task saved before this check existed still works", async () => {
    const { response, scheduler } = await put({ enabled: false }, stored({ enabled: 1 }));
    expect(response.status).not.toHaveBeenCalled();
    expect(scheduler.cancelTask).toHaveBeenCalledWith(3);
  });

  it("renaming a disabled restart task on a remote server still works", async () => {
    const { response } = await put({ name: "Old nightly" }, stored());
    expect(response.status).not.toHaveBeenCalled();
    expect(updateScheduledTask).toHaveBeenCalled();
  });

  it("moving the task to a local server is accepted", async () => {
    const { response, scheduler } = await put({ serverId: LOCAL.id, enabled: true }, stored());
    expect(response.status).not.toHaveBeenCalled();
    expect(scheduler.scheduleTask).toHaveBeenCalled();
  });
});

describe("isUnmanagedRemoteServer()", () => {
  it("is true for a remote server with no container, false for local and for a container-managed one", async () => {
    const { isUnmanagedRemoteServer } = await import("../utils/serverStatusModel.js");
    expect(isUnmanagedRemoteServer({ isRemote: true })).toBe(true);
    expect(isUnmanagedRemoteServer({ isRemote: true, dockerContainerName: "" })).toBe(true);
    expect(isUnmanagedRemoteServer({ isRemote: true, dockerContainerName: "pz" })).toBe(false);
    expect(isUnmanagedRemoteServer({ isRemote: true, dockerContainerId: "abc123" })).toBe(false);
    expect(isUnmanagedRemoteServer({ isRemote: false })).toBe(false);
    expect(isUnmanagedRemoteServer(null)).toBe(false);
    expect(isUnmanagedRemoteServer(undefined)).toBe(false);
  });
});
