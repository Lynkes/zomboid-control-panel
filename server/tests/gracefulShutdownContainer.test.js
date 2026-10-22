import fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SIGTERM in the all-in-one container ends every Project Zomboid server in it,
// so the panel has to save and quit them first. Anywhere else the panel does
// not stop servers it merely supervises.

vi.mock("../services/panelBridge.js", async () => {
  const { EventEmitter } = await import("events");
  const { vi: vitest } = await import("vitest");
  const fake = new EventEmitter();
  fake.isRunning = false;
  fake.stop = vitest.fn();
  return { default: fake };
});

vi.mock("../services/containerShutdown.js", async (importOriginal) => {
  const { vi: vitest } = await import("vitest");
  return {
    ...(await importOriginal()),
    saveAndStopLocalServers: vitest.fn(async () => ({ attempted: 1, stopped: true })),
  };
});

const originalEnv = process.env.PANEL_ALL_IN_ONE;

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, "exit").mockImplementation(() => undefined);
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.PANEL_ALL_IN_ONE;
  else process.env.PANEL_ALL_IN_ONE = originalEnv;
});

async function loadIndex() {
  const index = await import("../index.js");
  const containerShutdown = await import("../services/containerShutdown.js");
  containerShutdown.saveAndStopLocalServers.mockClear();
  return { gracefulShutdown: index.gracefulShutdown, containerShutdown };
}

describe("gracefulShutdown in the all-in-one container", () => {
  it("saves and quits the game servers before the process exits", async () => {
    process.env.PANEL_ALL_IN_ONE = "true";
    const { gracefulShutdown, containerShutdown } = await loadIndex();

    await gracefulShutdown("SIGTERM");

    expect(containerShutdown.saveAndStopLocalServers).toHaveBeenCalledTimes(1);
    const args = containerShutdown.saveAndStopLocalServers.mock.calls[0][0];
    expect(typeof args.getActiveServer).toBe("function");
    expect(typeof args.findOtherRunningServers).toBe("function");
    expect(typeof args.scanHost).toBe("function");
    expect(args.rconService).toBeTruthy();
    expect(args.serverManager).toBeTruthy();
  });

  it("leaves the servers alone outside the all-in-one image", async () => {
    delete process.env.PANEL_ALL_IN_ONE;
    const { gracefulShutdown, containerShutdown } = await loadIndex();

    await gracefulShutdown("SIGTERM");

    expect(containerShutdown.saveAndStopLocalServers).not.toHaveBeenCalled();
  });
});

describe("all-in-one container wiring", () => {
  const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

  it("gives Docker a stop timeout longer than the panel's 90 s drain", () => {
    const compose = read("docker/all-in-one/docker-compose.yml");
    const match = compose.match(/^\s+stop_grace_period:\s*(\d+)s\s*$/m);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThanOrEqual(120);
    // On the panel service, not the updater.
    expect(compose.indexOf("stop_grace_period")).toBeLessThan(compose.indexOf("\n  updater:"));
    expect(compose.indexOf("stop_grace_period")).toBeGreaterThan(compose.indexOf("\n  panel:"));
  });

  it("starts the panel as PID 1 so SIGTERM reaches it (su would SIGKILL it after 2 s)", () => {
    const entrypoint = read("docker/all-in-one/entrypoint.sh");
    const finalExec = entrypoint.split("\n").filter((line) => /^exec /.test(line)).pop();
    expect(finalExec).toMatch(/^exec setpriv .*node server\/index\.js/);
    expect(finalExec).not.toMatch(/\bsu\b/);
    expect(read("docker/all-in-one/Dockerfile")).toContain("command -v setpriv");
  });
});
