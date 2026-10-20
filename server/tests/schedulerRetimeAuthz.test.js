import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, startApp, tokenWithCapabilities } from "./helpers/authzHarness.js";

// SECURITY (2026-10-20, access-control audit): PUT /api/scheduler/tasks/:id
// checked the stored command's capability only when the request changed
// the command or turned the task on. automation.manage alone could move an
// armed admin-made "restart" task to every five minutes, or onto another
// server. A cron or server change on a task that is or stays enabled now
// needs that capability too.

const { default: schedulerRouter } = await import("../routes/scheduler.js");

const scheduled = [];
let app;
let automationOnly;
let automationControl;
let s1;
let s2;

beforeAll(async () => {
  s1 = await init.createServer({ name: "A", serverName: "a", installPath: "C:/x", rconHost: "127.0.0.1", rconPort: 27015, rconPassword: "x", isRemote: false });
  s2 = await init.createServer({ name: "B", serverName: "b", installPath: "C:/y", rconHost: "127.0.0.1", rconPort: 27016, rconPassword: "x", isRemote: false });
  automationOnly = await tokenWithCapabilities(["automation.manage"]);
  automationControl = await tokenWithCapabilities(["automation.manage", "server.control"]);
  app = await startApp([["/api/scheduler", schedulerRouter]], {
    scheduler: {
      scheduleTask: (task) => {
        scheduled.push(task);
        return { dstWarning: null };
      },
      cancelTask() {},
      getTaskNextRun: () => null,
    },
  });
});

afterAll(async () => {
  await app?.close();
});

async function armedRestartTask() {
  const created = await init.createScheduledTask("Nightly restart", "0 4 * * *", "restart", s1.id);
  return created.id;
}

async function storedTask(id) {
  return (await init.getScheduledTasks()).find((task) => task.id === id);
}

describe("PUT /api/scheduler/tasks/:id on an armed restart task", () => {
  it("refuses automation.manage alone a new schedule", async () => {
    const id = await armedRestartTask();
    const res = await app.call("PUT", `/api/scheduler/tasks/${id}`, automationOnly, { cronExpression: "*/5 * * * *" });
    expect(res.status).toBe(403);
    expect((await storedTask(id)).cron_expression).toBe("0 4 * * *");
  });

  it("refuses automation.manage alone a new target server", async () => {
    const id = await armedRestartTask();
    const res = await app.call("PUT", `/api/scheduler/tasks/${id}`, automationOnly, { serverId: s2.id });
    expect(res.status).toBe(403);
    expect(String((await storedTask(id)).server_id)).toBe(String(s1.id));
    // null means "whichever server is active": a new target too.
    const unpin = await app.call("PUT", `/api/scheduler/tasks/${id}`, automationOnly, { serverId: null });
    expect(unpin.status).toBe(403);
  });

  it("refuses a rename sent together with a new schedule (enabled left out, so it stays on)", async () => {
    const id = await armedRestartTask();
    const res = await app.call("PUT", `/api/scheduler/tasks/${id}`, automationOnly, { name: "renamed", cronExpression: "0 5 * * *", serverId: s1.id });
    expect(res.status).toBe(403);
  });

  it("lets automation.manage rename it, or resend its own schedule and server unchanged", async () => {
    const id = await armedRestartTask();
    const res = await app.call("PUT", `/api/scheduler/tasks/${id}`, automationOnly, {
      name: "Renamed restart",
      cronExpression: "0 4 * * *",
      serverId: s1.id,
    });
    expect(res.status).toBe(200);
    expect((await storedTask(id)).name).toBe("Renamed restart");
  });

  it("lets automation.manage retime it once it is being disabled in the same request", async () => {
    const id = await armedRestartTask();
    const res = await app.call("PUT", `/api/scheduler/tasks/${id}`, automationOnly, { cronExpression: "0 6 * * *", enabled: false });
    expect(res.status).toBe(200);
    const task = await storedTask(id);
    expect(task.enabled).toBe(0);
    expect(task.cron_expression).toBe("0 6 * * *");
  });

  it("lets a role holding the command's capability retime and retarget it", async () => {
    const id = await armedRestartTask();
    const res = await app.call("PUT", `/api/scheduler/tasks/${id}`, automationControl, { cronExpression: "0 5 * * *", serverId: s2.id });
    expect(res.status).toBe(200);
    const task = await storedTask(id);
    expect(task.cron_expression).toBe("0 5 * * *");
    expect(String(task.server_id)).toBe(String(s2.id));
  });
});
