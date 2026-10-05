import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import os from "os";
import path from "path";

// Security sweep 2026-10-05, H4 round 3 (verifier): runTaskNow() stores a
// failed task's raw err.message in Schedule History, and GET
// /api/scheduler/history (automation.manage) returned it as stored. A
// refused scheduled restart names the install folder there, so a custom
// "Scheduler" role, whose GET /api/servers view hides that folder, read it
// here -- though emitActionResult() redacts the same text live. Rows
// written before this release are stored the same way, so the route
// redacts on the way out.

const init = await import("../database/init.js");
const { default: schedulerRouter, emitActionResult } = await import("../routes/scheduler.js");
const { Scheduler } = await import("../services/scheduler.js");
const { namedStartupScriptRestartRefusedError } = await import("../services/serverManager.js");

const MARKER = `zcp-h4s-${process.pid}`;
const INSTALL_DIR = path.join(os.tmpdir(), MARKER, "pz install");
const SAVES_DIR = `/srv/${MARKER}/Zomboid/Saves/Multiplayer/servertest`;

let baseUrl;
let httpServer;
let currentRole = "admin";
let refusal;

async function history() {
  const res = await fetch(`${baseUrl}/api/scheduler/history`);
  expect(res.status).toBe(200);
  return (await res.json()).history;
}

beforeAll(async () => {
  await init.initDatabase();
  await init.insertRole({ id: "role-h4s-scheduler", name: "h4s-scheduler", capabilities: ["automation.manage"] });
  await init.insertRole({
    id: "role-h4s-diagnostics",
    name: "h4s-diagnostics",
    capabilities: ["automation.manage", "diagnostics.manage"],
  });
  const server = await init.createServer({ name: "H4S", serverName: "servertest", installPath: INSTALL_DIR });
  await init.setActiveServer(server.id);

  // The real failure path: a restart task refused because its startup
  // script is missing from the install folder.
  refusal = namedStartupScriptRestartRefusedError({
    script: "start-servertest.bat",
    folder: INSTALL_DIR,
    fallback: "StartServer64.bat",
  });
  const fakeScheduler = {
    runningTasks: new Set(),
    executeTask: async () => {
      throw refusal;
    },
  };
  const result = await Scheduler.prototype.runTaskNow.call(fakeScheduler, {
    id: 987654,
    name: "Nightly restart",
    command: "restart",
  });
  expect(result.success).toBe(false);
  // A row as an older version stored a deferred backup.
  await init.logScheduleExecution(null, "Scheduled backup", "backup", false, `Not run: Saves folder not found: ${SAVES_DIR}`, 0);

  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.set("scheduler", { getTaskNextRun: () => null, getStatus: () => ({}) });
  app.use("/api/scheduler", schedulerRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
});

describe("GET /api/scheduler/history", () => {
  it("gives a role that only manages automation the failures path-redacted", async () => {
    currentRole = "h4s-scheduler";
    const rows = await history();
    const restart = rows.find((row) => row.task_name === "Nightly restart");
    const backup = rows.find((row) => row.task_name === "Scheduled backup");
    expect(restart.success).toBe(0);
    expect(restart.message).toContain("startup script start-servertest.bat is missing from [path] and");
    expect(backup.message).toBe("Not run: Saves folder not found: [path]");
    expect(JSON.stringify(rows)).not.toContain(MARKER);

    // The same text as the live event shows it.
    const sent = [];
    emitActionResult({ emit: (_event, payload) => sent.push(payload) }, { kind: "task", message: refusal.message });
    expect(restart.message).toBe(sent[0].message);
  });

  for (const role of ["admin", "technician", "h4s-diagnostics"]) {
    it(`keeps the folders for ${role}`, async () => {
      currentRole = role;
      const rows = await history();
      expect(rows.find((row) => row.task_name === "Nightly restart").message).toBe(refusal.message);
      expect(rows.find((row) => row.task_name === "Scheduled backup").message).toContain(SAVES_DIR);
    });
  }
});
