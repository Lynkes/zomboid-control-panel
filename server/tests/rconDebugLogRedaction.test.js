import { beforeEach, describe, expect, it, vi } from "vitest";

// Console / RCON audit (2026-10-12): RconService.execute() logged
// `executing: <command>` through redactRconCommandSecrets(), but the debug
// lines "response: ..." (a reply can echo the command it answers) and
// "command skipped (...): <command>" printed the raw text, so the password of
// `adduser "name" "password"` reached the panel log (and the Debug page's
// live stream) in plain text at debug level.

const debugLines = vi.hoisted(() => []);

vi.mock("../utils/logger.js", () => {
  const record = (...args) => debugLines.push(args.map(String).join(" "));
  return {
    createLogger: () => ({ debug: record, info: () => {}, warn: () => {}, error: () => {} }),
  };
});

vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
  logCommand: () => {},
}));

const { RconService } = await import("../services/rcon.js");

describe("RconService: debug lines never carry an adduser password", () => {
  let service;

  beforeEach(() => {
    debugLines.length = 0;
    service = new RconService();
    service.connected = true;
  });

  it("redacts the reply that echoes the command", async () => {
    service.client = {
      connected: true,
      execute: vi.fn(async (command) => `received ${command}`),
      disconnect: vi.fn(),
    };

    await service.execute('adduser "Bob" "hunter2"', { skipLog: true });

    const logged = debugLines.join("\n");
    expect(logged).toContain("[REDACTED]");
    expect(logged).not.toContain("hunter2");
  });

  it("redacts the command in the 'command skipped' line", async () => {
    service.client = {
      connected: true,
      execute: vi.fn(async () => {
        throw new Error("read ECONNRESET");
      }),
      disconnect: vi.fn(),
    };

    await service.execute('adduser "Bob" "hunter2"', { skipLog: true });

    const logged = debugLines.join("\n");
    expect(logged).toMatch(/command skipped/);
    expect(logged).toContain("[REDACTED]");
    expect(logged).not.toContain("hunter2");
  });
});
