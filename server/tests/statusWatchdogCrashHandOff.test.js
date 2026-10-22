import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logServerEvent: vi.fn(async () => ({})) };
});

const { app, checkServerStatusNow, io } = await import("../index.js");
const { ServerManager } = await import("../services/serverManager.js");
const { ServerWatch } = await import("../services/serverWatch.js");

// The status watchdog hands the active server's stops to the server watch,
// which starts a server chosen in restartOnCrashServerIds again. The
// watchdog's running -> stopped also fires when the active server is
// switched from a running one to a stopped one: that is no stop at all, so
// the hand-off happens only when the server seen stopped is the one last
// seen running (the shared ServerManager's record).
describe("checkServerStatusNow() and the server watch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands over a stop of the same server, never a switch to a stopped one", async () => {
    vi.spyOn(io, "emit").mockImplementation(() => {});
    const handOff = vi.spyOn(ServerWatch.prototype, "onActiveServerStopped").mockResolvedValue(undefined);
    const scan = vi.spyOn(ServerManager.prototype, "getServerProcessDetails");
    const sharedManager = app.get("serverManager");
    const originalRecord = sharedManager._serverRecord;

    try {
      sharedManager._serverRecord = { id: "handoff-a" };
      scan.mockResolvedValue({ running: true, scanFailed: false });
      await checkServerStatusNow("seed");

      scan.mockResolvedValue({ running: false, scanFailed: false });
      await checkServerStatusNow("test-stop");
      expect(handOff).toHaveBeenCalledTimes(1);
      expect(handOff).toHaveBeenCalledWith({
        serverId: "handoff-a",
        reason: expect.any(String),
      });

      scan.mockResolvedValue({ running: true, scanFailed: false });
      await checkServerStatusNow("test-start");

      // The active server is switched to another one, which is stopped.
      handOff.mockClear();
      sharedManager._serverRecord = { id: "handoff-b" };
      scan.mockResolvedValue({ running: false, scanFailed: false });
      await checkServerStatusNow("test-switch");
      expect(handOff).not.toHaveBeenCalled();
    } finally {
      sharedManager._serverRecord = originalRecord;
    }
  });
});
