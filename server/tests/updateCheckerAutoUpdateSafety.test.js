import { describe, expect, it, vi } from "vitest";

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => {
    if (key === "serverAutoUpdate") return true;
    if (key === "steamcmdPath") return "/opt/steamcmd";
    return null;
  }),
  setSetting: vi.fn(),
  getActiveServer: vi.fn(async () => ({
    id: "server-1",
    installPath: "/opt/pzserver",
  })),
}));

vi.mock("../services/managedContainer.js", () => ({
  resolveManagedContainer: vi.fn(async () => ({ handled: false })),
}));

const { UpdateChecker } = await import("../services/updateChecker.js");

// runAutoUpdate() used to call serverManager.checkServerRunning(), which
// collapses a failed process-detection scan into `false` -- the same value
// as a confirmed-stopped server. This is the unattended auto-update path
// (no human reviewing the result before SteamCMD runs), so a silent scan
// failure here used to skip the RCON save+quit sequence entirely and run
// `steamcmd ... validate` straight against a possibly-live install.
describe("UpdateChecker.runAutoUpdate fails closed when process detection can't confirm the server is stopped", () => {
  function buildChecker({ getServerProcessDetails, startServer }) {
    const io = { emit: vi.fn() };
    const rconService = {
      connected: true,
      save: vi.fn(async () => ({ success: true })),
      quit: vi.fn(async () => ({ success: true })),
    };
    const serverManager = {
      getServerProcessDetails,
      startServer: startServer || vi.fn(async () => ({ success: true })),
    };
    const checker = new UpdateChecker(io, { rconService, serverManager });
    return { checker, io, rconService, serverManager };
  }

  it("abandons the update instead of assuming the server is stopped (scanFailed)", async () => {
    const { checker, io, serverManager } = buildChecker({
      getServerProcessDetails: vi.fn(async () => ({
        running: false,
        scanFailed: true,
      })),
    });

    await expect(
      checker.runAutoUpdate({ installed: { branch: "stable" } }),
    ).rejects.toThrow(/could not verify whether the server is running/i);

    expect(io.emit).toHaveBeenCalledWith(
      "server:autoUpdateComplete",
      expect.objectContaining({ success: false }),
    );
    // Never reached the "was running, needs restart after update" path.
    expect(serverManager.startServer).not.toHaveBeenCalled();
  });

  it("aborts if detection breaks again mid-wait for the server to stop", async () => {
    let call = 0;
    const { checker, io } = buildChecker({
      getServerProcessDetails: vi.fn(async () => {
        call += 1;
        // First call: confirmed running (enters the stop sequence).
        if (call === 1) return { running: true, scanFailed: false };
        // Second call (inside the "wait for stop" loop): detection breaks.
        return { running: false, scanFailed: true };
      }),
    });

    await expect(
      checker.runAutoUpdate({ installed: { branch: "stable" } }),
    ).rejects.toThrow(/lost the ability to verify/i);

    expect(io.emit).toHaveBeenCalledWith(
      "server:autoUpdateComplete",
      expect.objectContaining({ success: false }),
    );
  });
});
