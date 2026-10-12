import http from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePanelUpdateDownload } from "../index.js";
import { ServerManager } from "../services/serverManager.js";
import { PanelUpdateChecker } from "../services/panelUpdateChecker.js";
import { DockerUpdateProxy } from "../services/dockerUpdateProxy.js";

// The Docker panel update saves the world and stops the game server first,
// then asks downloadUpdate() to hand the update to the update controller.
// That call can still refuse (no update known -- e.g. a stale tab in the 30 s
// after boot --, a download or apply already under way) and the controller can
// be unreachable, reject the token or be busy. All of it is asked BEFORE the
// server is touched now: the world used to be saved and the server left down
// for an update that never started.

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function fakeController(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// A controller that is healthy and idle unless a route is overridden.
function controllerHandler(overrides = {}) {
  return (req, res) => {
    const override = overrides[`${req.method} ${req.url}`];
    if (override) return override(req, res);
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { status: "ok" });
    if (req.method === "GET" && req.url === "/status") return json(res, 200, { status: "idle" });
    return json(res, 404, { error: "Not found" });
  };
}

function makeChecker(url, { updateAvailable = true, token = "secret" } = {}) {
  const checker = new PanelUpdateChecker();
  checker.updateAvailable = updateAvailable;
  checker.latestRelease = updateAvailable ? { version: "9.9.9" } : null;
  const proxy = new DockerUpdateProxy();
  proxy.url = url;
  proxy.token = token;
  checker.dockerUpdateProxy = proxy;
  checker.downloadUpdate = vi.fn(async () => ({ success: true, message: "started" }));
  return checker;
}

function makeRequest(checker, rconService) {
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

function makeRcon() {
  return {
    connected: true,
    save: vi.fn().mockResolvedValue({ success: true }),
    quit: vi.fn().mockResolvedValue({ success: true }),
  };
}

let servers = [];

beforeEach(() => {
  vi.spyOn(ServerManager.prototype, "scanHostForServerProcesses").mockResolvedValue({
    matched: [],
    scanFailed: false,
  });
  vi.spyOn(ServerManager.prototype, "getServerProcessDetails")
    .mockResolvedValueOnce({ running: true, scanFailed: false })
    .mockResolvedValue({ running: false, scanFailed: false });
  vi.spyOn(ServerManager.prototype, "sleep").mockResolvedValue();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
});

async function startController(overrides) {
  const { server, url } = await fakeController(controllerHandler(overrides));
  servers.push(server);
  return url;
}

function expectNothingStopped(rconService, checker) {
  expect(rconService.save).not.toHaveBeenCalled();
  expect(rconService.quit).not.toHaveBeenCalled();
  expect(checker.downloadUpdate).not.toHaveBeenCalled();
}

describe("Docker panel update: refusals are answered before the server is stopped", () => {
  it("no update known (a stale tab right after boot): no_update, server untouched", async () => {
    const url = await startController();
    const checker = makeChecker(url, { updateAvailable: false });
    const rconService = makeRcon();
    const response = createResponse();

    await handlePanelUpdateDownload(makeRequest(checker, rconService), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0]).toMatchObject({ success: false, code: "no_update" });
    expectNothingStopped(rconService, checker);
  });

  it("a download already under way: already_downloading, server untouched", async () => {
    const url = await startController();
    const checker = makeChecker(url);
    checker.isDownloading = true;
    const rconService = makeRcon();
    const response = createResponse();

    await handlePanelUpdateDownload(makeRequest(checker, rconService), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json.mock.calls[0][0]).toMatchObject({ code: "already_downloading" });
    expectNothingStopped(rconService, checker);
  });

  it("an update controller that cannot be reached: says so, server untouched", async () => {
    const url = await startController();
    const checker = makeChecker(url);
    // Nothing listens here any more.
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    servers = [];
    const rconService = makeRcon();
    const response = createResponse();

    await handlePanelUpdateDownload(makeRequest(checker, rconService), response);

    expect(response.status).toHaveBeenCalledWith(400);
    const body = response.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/could not be reached/i);
    expect(body.error).toMatch(/game server was not stopped/i);
    expectNothingStopped(rconService, checker);
  });

  it("an update controller that rejects the token (401): says so, server untouched", async () => {
    const url = await startController({
      "GET /status": (req, res) => json(res, 401, { error: "Unauthorized" }),
    });
    const checker = makeChecker(url);
    const rconService = makeRcon();
    const response = createResponse();

    await handlePanelUpdateDownload(makeRequest(checker, rconService), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0].error).toMatch(/token/i);
    expectNothingStopped(rconService, checker);
  });

  it("an update controller that is already running an update: apply_in_progress, server untouched", async () => {
    const url = await startController({
      "GET /status": (req, res) => json(res, 200, { status: "running" }),
    });
    const checker = makeChecker(url);
    const rconService = makeRcon();
    const response = createResponse();

    await handlePanelUpdateDownload(makeRequest(checker, rconService), response);

    expect(response.json.mock.calls[0][0]).toMatchObject({ success: false, code: "apply_in_progress" });
    expectNothingStopped(rconService, checker);
  });

  it("a healthy, idle controller and a known update: saves, quits and hands the update over", async () => {
    const url = await startController();
    const checker = makeChecker(url);
    const rconService = makeRcon();
    const response = createResponse();

    await handlePanelUpdateDownload(makeRequest(checker, rconService), response);

    expect(rconService.save).toHaveBeenCalledTimes(1);
    expect(rconService.quit).toHaveBeenCalledTimes(1);
    expect(checker.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

describe("DockerUpdateProxy.checkReady()", () => {
  it("is ok for a reachable, idle controller", async () => {
    const url = await startController();
    const proxy = new DockerUpdateProxy();
    proxy.url = url;
    proxy.token = "secret";
    await expect(proxy.checkReady()).resolves.toEqual({ ok: true });
  });

  it("sends the token only to /status", async () => {
    const seen = [];
    const url = await startController({
      "GET /health": (req, res) => {
        seen.push(["health", req.headers.authorization]);
        json(res, 200, { status: "ok" });
      },
      "GET /status": (req, res) => {
        seen.push(["status", req.headers.authorization]);
        json(res, 200, { status: "success" });
      },
    });
    const proxy = new DockerUpdateProxy();
    proxy.url = url;
    proxy.token = "secret";

    await expect(proxy.checkReady()).resolves.toEqual({ ok: true });
    expect(seen).toEqual([
      ["health", undefined],
      ["status", "Bearer secret"],
    ]);
  });

  it("refuses when the controller is not configured", async () => {
    const proxy = new DockerUpdateProxy();
    proxy.url = "";
    proxy.token = "";
    await expect(proxy.checkReady()).resolves.toMatchObject({
      ok: false,
      code: "docker_updater_not_configured",
    });
  });
});
