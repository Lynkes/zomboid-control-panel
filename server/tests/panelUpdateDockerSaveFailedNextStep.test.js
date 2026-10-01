import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePanelUpdateDownload } from "../index.js";
import { ServerManager } from "../services/serverManager.js";

// 2026-10-01 incident (Unraid all-in-one, 1.4.0 -> 1.4.1): the Docker panel
// update saves the world and stops the game server first. The 42.21 server's
// game thread had died during a save, so the pre-update save failed every
// time ("RCON connection closed") and Settings > Updates showed "Download
// Failed" with no way forward -- the operator worked out Force stop alone.
// Each refusal now names Force stop and what it costs; nothing is
// downloaded, quit or force-stopped on the operator's behalf.

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function dockerUpdateRequest(rconService, downloadUpdate) {
  return {
    body: { confirm: true },
    app: {
      get: (key) => {
        if (key === "panelUpdateChecker") return { dockerUpdateProxy: { enabled: true }, downloadUpdate };
        if (key === "rconService") return rconService;
        return undefined;
      },
    },
  };
}

describe("Docker panel update: a server that can't be saved and stopped", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("save_failed names Force stop and its cost, and nothing else happens", async () => {
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: true,
      scanFailed: false,
    });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: false, error: "RCON connection closed" }),
      quit: vi.fn(),
    };
    const downloadUpdate = vi.fn();
    const response = createResponse();

    await handlePanelUpdateDownload(dockerUpdateRequest(rconService, downloadUpdate), response);

    expect(response.status).toHaveBeenCalledWith(409);
    const body = response.json.mock.calls[0][0];
    expect(body.code).toBe("save_failed");
    expect(body.params).toEqual({ reason: "RCON connection closed" });
    expect(body.error).toContain("the update was not applied");
    expect(body.error).toContain("Force stop on the Dashboard");
    expect(body.error).toMatch(/since the last successful save can be lost/);
    expect(rconService.quit).not.toHaveBeenCalled();
    expect(downloadUpdate).not.toHaveBeenCalled();
  });

  it("SERVER_RUNNING_RCON_UNAVAILABLE names Force stop too", async () => {
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: true,
      scanFailed: false,
    });
    const rconService = { connected: false, save: vi.fn(), quit: vi.fn() };
    const downloadUpdate = vi.fn();
    const response = createResponse();

    await handlePanelUpdateDownload(dockerUpdateRequest(rconService, downloadUpdate), response);

    expect(response.status).toHaveBeenCalledWith(409);
    const body = response.json.mock.calls[0][0];
    expect(body.code).toBe("SERVER_RUNNING_RCON_UNAVAILABLE");
    expect(body.error).toContain("Force stop on the Dashboard");
    expect(rconService.save).not.toHaveBeenCalled();
    expect(downloadUpdate).not.toHaveBeenCalled();
  });

  it("stop_failed (saved, but the quit failed) points at Force stop", async () => {
    vi.spyOn(ServerManager.prototype, "getServerProcessDetails").mockResolvedValue({
      running: true,
      scanFailed: false,
    });
    const rconService = {
      connected: true,
      save: vi.fn().mockResolvedValue({ success: true }),
      quit: vi.fn().mockResolvedValue({ success: false, error: "timed out" }),
    };
    const downloadUpdate = vi.fn();
    const response = createResponse();

    await handlePanelUpdateDownload(dockerUpdateRequest(rconService, downloadUpdate), response);

    expect(response.status).toHaveBeenCalledWith(502);
    const body = response.json.mock.calls[0][0];
    expect(body.code).toBe("stop_failed");
    expect(body.error).toContain("Force stop on the Dashboard");
    expect(downloadUpdate).not.toHaveBeenCalled();
  });
});
