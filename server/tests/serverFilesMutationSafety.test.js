import { beforeEach, describe, expect, it, vi } from "vitest";

const { getActiveServer } = vi.hoisted(() => ({
  getActiveServer: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
}));

vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(),
  beginRemoteConfigSession: vi.fn(),
  getMirrorPath: vi.fn(),
  isRemoteConfigConfigured: vi.fn(() => false),
  pushRemoteConfigFiles: vi.fn(),
  validateRemoteConfigTransport: vi.fn(),
}));

const {
  isLocalConfigMutation,
} = await import("../routes/serverFiles.js");
const { requireStoppedForLocalConfigMutation } = await import(
  "../services/configMutationGuard.js"
);

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function createRequest(method, path, running = false) {
  return {
    method,
    path,
    app: {
      get: () => ({ checkServerRunning: vi.fn(async () => running) }),
    },
  };
}

describe("local config mutation safety", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getActiveServer.mockResolvedValue({ isRemote: false });
  });

  it("recognizes file and template config mutations but not metadata routes", () => {
    expect(isLocalConfigMutation(createRequest("PUT", "/ini"))).toBe(true);
    expect(isLocalConfigMutation(createRequest("POST", "/restore/world.bak"))).toBe(true);
    expect(isLocalConfigMutation(createRequest("POST", "/templates/demo/apply"))).toBe(true);
    expect(isLocalConfigMutation(createRequest("POST", "/templates"))).toBe(false);
    expect(isLocalConfigMutation(createRequest("POST", "/save-and-reload"))).toBe(false);
  });

  it("rejects mutations while the local server is running", async () => {
    const response = createResponse();
    const next = vi.fn();

    await requireStoppedForLocalConfigMutation(
      createRequest("PUT", "/sandbox", true),
      response,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      code: "SERVER_RUNNING",
      error: "Stop the server before editing configuration.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed when local server state cannot be checked", async () => {
    const response = createResponse();
    const next = vi.fn();
    const request = createRequest("PUT", "/ini");
    request.app.get = () => ({});

    await requireStoppedForLocalConfigMutation(request, response, next);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("allows stopped local and remote mutations", async () => {
    const stoppedResponse = createResponse();
    const stoppedNext = vi.fn();
    await requireStoppedForLocalConfigMutation(
      createRequest("PUT", "/ini", false),
      stoppedResponse,
      stoppedNext,
    );
    expect(stoppedNext).toHaveBeenCalledOnce();

    getActiveServer.mockResolvedValue({ isRemote: true });
    const remoteResponse = createResponse();
    const remoteNext = vi.fn();
    await requireStoppedForLocalConfigMutation(
      createRequest("PUT", "/ini", true),
      remoteResponse,
      remoteNext,
    );
    expect(remoteNext).toHaveBeenCalledOnce();
  });
});