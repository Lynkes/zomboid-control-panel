import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePanelUpdateDownload } from "../index.js";
import { ServerManager } from "../services/serverManager.js";

// continuous-bug-hunt, 2026-09-18: rconService.quit()'s success:true only
// means the RCON "quit" command was acknowledged or its connection reset
// (see rcon.js's own comment on quit()) -- it is not proof the JVM has
// actually exited. PZ can spend many more seconds after that flushing world
// state to disk. The Docker update path used to trust quit()'s success
// straight into checker.downloadUpdate(), which recreates the all-in-one
// container this same process runs in -- killing that in-flight write the
// same way starting a new JVM over a still-running one would elsewhere in
// this codebase (/wipe, /delete-files, template-apply all guard against
// exactly this). This is the regression test for the fix: poll
// getServerProcessDetails() after quit() and refuse the update if the
// process never confirms stopped.
function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function createRequest(checker, rconService) {
  return {
    body: { confirm: true },
    app: {
      get: (key) => {
        if (key === "panelUpdateChecker") return checker;
        if (key === "rconService") return rconService;
        return undefined;
      },
    },
  };
}

describe("Docker panel update: quit() success is not trusted as confirmed-stopped", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses the update and never calls downloadUpdate() when the process still reports running after quit()", async () => {
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: true,
      scanFailed: false,
    });
    vi.spyOn(ServerManager.prototype, "sleep").mockResolvedValue(undefined);
    const rconService = {
      connected: true,
      save: vi.fn(async () => ({ success: true })),
      quit: vi.fn(async () => ({ success: true })),
    };
    const downloadUpdate = vi.fn();
    const response = createResponse();

    await handlePanelUpdateDownload(
      createRequest({ dockerUpdateProxy: { enabled: true }, downloadUpdate }, rconService),
      response,
    );

    expect(rconService.quit).toHaveBeenCalledOnce();
    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: "SERVER_STATE_UNKNOWN",
      }),
    );
  });

  it("proceeds to downloadUpdate() once the process confirms stopped on a later poll", async () => {
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails")
      .mockResolvedValueOnce({ running: true, scanFailed: false }) // pre-quit check
      .mockResolvedValueOnce({ running: true, scanFailed: false }) // still shutting down
      .mockResolvedValueOnce({ running: true, scanFailed: false }) // still shutting down
      .mockResolvedValue({ running: false, scanFailed: false }); // confirmed stopped
    vi.spyOn(ServerManager.prototype, "sleep").mockResolvedValue(undefined);
    const rconService = {
      connected: true,
      save: vi.fn(async () => ({ success: true })),
      quit: vi.fn(async () => ({ success: true })),
    };
    const downloadUpdate = vi.fn(async () => ({ success: true, message: "Applied" }));
    const response = createResponse();

    await handlePanelUpdateDownload(
      createRequest({ dockerUpdateProxy: { enabled: true }, downloadUpdate }, rconService),
      response,
    );

    expect(downloadUpdate).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});
