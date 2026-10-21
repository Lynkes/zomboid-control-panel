import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A 1.5.0 support bundle: every Windows process scan failed, so Start stayed
// refused and a scheduled restart quit the server and never started it
// again. When the scan can't answer, a refused RCON port plus the console
// log's shutdown lines now settle it -- never the RCON port alone.

import {
  evaluateStoppedEvidence,
  probeTcpPort,
  readConsoleTail,
  readStoppedEvidence,
  QUIET_AFTER_SHUTDOWN_STARTED_MS,
} from "../utils/stoppedEvidence.js";
import { ServerManager } from "../services/serverManager.js";
import { findServerErrors } from "../utils/serverErrorFinder.js";
import { codedActionResultFields } from "../routes/scheduler.js";

const NOW = 1_800_000_000_000;
const RUNNING_LOG = [
  "LOG  : General      f:0 st:195,161,382> Loading networking libraries...",
  "LOG  : General      f:0 st:195,170,001> *** SERVER STARTED ****",
].join("\n");
// The JVM shutdown hook's lines, as a 42 dedicated server writes them.
const SHUTDOWN_STARTED_LOG = [
  RUNNING_LOG,
  "LOG  : General      f:0 st:195,165,113> Shutdown handling started",
  "LOG  : Network      f:0 st:195,165,113> Server exited",
].join("\n");
const SHUTDOWN_FINISHED_LOG = `${SHUTDOWN_STARTED_LOG}\nLOG  : General      f:0 st:195,165,900> Shutdown handling finished`;

const log = (text, quietMs) => ({ text, mtimeMs: NOW - quietMs });

describe("evaluateStoppedEvidence()", () => {
  it("never counts the RCON port alone: open or silent is not stopped", () => {
    for (const rcon of ["open", "unknown"]) {
      expect(evaluateStoppedEvidence({ rcon, consoleLog: log(SHUTDOWN_FINISHED_LOG, 60_000), now: NOW }).stopped).toBe(false);
    }
    expect(evaluateStoppedEvidence({ rcon: "refused", consoleLog: null, now: NOW })).toMatchObject({
      stopped: false,
      reason: expect.stringMatching(/console log could not be read/),
    });
  });

  it("a refused port plus the finished shutdown is stopped", () => {
    expect(evaluateStoppedEvidence({ rcon: "refused", consoleLog: log(SHUTDOWN_FINISHED_LOG, 5_000), now: NOW })).toMatchObject({
      stopped: true,
      reason: expect.stringMatching(/Shutdown handling finished/),
    });
  });

  it("a shutdown still saving counts only once the log has been quiet a while", () => {
    expect(evaluateStoppedEvidence({ rcon: "refused", consoleLog: log(SHUTDOWN_STARTED_LOG, 10_000), now: NOW }).stopped).toBe(false);
    expect(
      evaluateStoppedEvidence({ rcon: "refused", consoleLog: log(SHUTDOWN_STARTED_LOG, QUIET_AFTER_SHUTDOWN_STARTED_MS + 1000), now: NOW }).stopped,
    ).toBe(true);
  });

  it("a quiet log without the shutdown lines is never stopped, even long after the panel's quit", () => {
    // A server hung while saving looks exactly like this; two servers on
    // one world corrupt its save.
    for (const quietMs of [10_000, 600_000]) {
      expect(
        evaluateStoppedEvidence({ rcon: "refused", consoleLog: log(RUNNING_LOG, quietMs), quitSentAt: NOW - 600_000, now: NOW }),
      ).toMatchObject({ stopped: false, reason: expect.stringMatching(/does not show the server stopped/) });
    }
  });
});

describe("probeTcpPort()", () => {
  it("tells an open port from a refused one", async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      await expect(probeTcpPort("127.0.0.1", port)).resolves.toBe("open");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    await expect(probeTcpPort("127.0.0.1", port)).resolves.toBe("refused");
    await expect(probeTcpPort("127.0.0.1", 0)).resolves.toBe("unknown");
  }, 20_000);
});

describe("readConsoleTail() / readStoppedEvidence()", () => {
  let dir = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("reads the end of a long log and settles on it", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-evidence-"));
    const file = path.join(dir, "server-console.txt");
    fs.writeFileSync(file, `${"x".repeat(200_000)}\n${SHUTDOWN_FINISHED_LOG}\n`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);

    const tail = readConsoleTail(file);
    expect(tail.text.length).toBeLessThanOrEqual(64 * 1024);
    expect(tail.text).toMatch(/Shutdown handling finished/);
    expect(readConsoleTail(path.join(dir, "missing.txt"))).toBeNull();

    const probe = vi.fn(async () => "refused");
    await expect(readStoppedEvidence({ rconHost: "0.0.0.0", rconPort: 27015, consoleLogPath: file, probe })).resolves.toMatchObject({
      stopped: true,
    });
    expect(probe).toHaveBeenCalledWith("127.0.0.1", 27015);
  });
});

describe("startServer() when process detection fails", () => {
  const listeners = [];
  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });

  // A manager whose RCON port something listens on: a start that gets past
  // the scan guard stops at the RCON-port guard, so nothing is spawned.
  async function makeManager({ details = { running: false, scanFailed: true }, evidence }) {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    listeners.push(server);
    const manager = new ServerManager();
    manager.configLoaded = true;
    manager.serverPath = "C:\\pz";
    manager.rconHost = "127.0.0.1";
    manager.rconPort = server.address().port;
    manager.loadConfig = async () => {};
    manager.getServerProcessDetails = async () => details;
    manager.checkStoppedEvidence = vi.fn(async () => evidence);
    return manager;
  }

  it("refuses with a code the Dashboard turns into 'Start anyway'", async () => {
    const manager = await makeManager({ evidence: { stopped: false, reason: "the RCON port accepts connections" } });
    const error = await manager.startServer().catch((e) => e);
    expect(error).toMatchObject({ code: "SERVER_START_STATE_UNKNOWN" });
    expect(error.message).toMatch(/process detection failed/i);
    expect(codedActionResultFields(error)).toEqual({ code: "SERVER_START_STATE_UNKNOWN" });
  });

  it("goes on when the evidence says stopped, or the operator confirmed -- and every other guard still applies", async () => {
    const stopped = await makeManager({ evidence: { stopped: true, reason: "test" } });
    await expect(stopped.startServer()).rejects.toThrow(/RCON port .* already in use/);

    const confirmed = await makeManager({ evidence: { stopped: false, reason: "test" } });
    await expect(confirmed.startServer({ ignoreUnknownState: true })).rejects.toThrow(/RCON port .* already in use/);
    expect(confirmed.checkStoppedEvidence).toHaveBeenCalledOnce();
  });

  it("the flag never starts over a server the scan sees running", async () => {
    const manager = await makeManager({ details: { running: true, scanFailed: false }, evidence: { stopped: true } });
    await expect(manager.startServer({ ignoreUnknownState: true })).rejects.toThrow(/already running/);
    expect(manager.checkStoppedEvidence).not.toHaveBeenCalled();
  });
});

describe("Problems found: a Windows process scan that keeps failing", () => {
  const entry = (i, cause = "timed out") => ({
    level: "warn",
    source: "Server",
    timestamp: new Date(NOW + i * 10_000).toISOString(),
    message: `getServerProcessDetails: Windows process scan failed (${cause}), cannot determine server state`,
  });

  it("is one plain finding with the count, and no fix button", () => {
    const panelLog = [entry(0), entry(1, "Command failed: powershell.exe ..."), entry(2), entry(3)];
    const { findings } = findServerErrors({ panelLog });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "processScanFailing",
      category: "panel",
      severity: "warning",
      count: 4,
      params: { n: 4, timedOut: true },
      fixes: [],
      firstSeen: new Date(NOW).toISOString(),
      lastSeen: new Date(NOW + 30_000).toISOString(),
    });
    expect(findings[0].cause).toMatch(/slow or antivirus/);
  });

  it("stays quiet for one or two failures", () => {
    expect(findServerErrors({ panelLog: [entry(0), entry(1)] }).findings).toEqual([]);
  });
});
