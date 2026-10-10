import { describe, expect, it, vi } from "vitest";

vi.mock("../database/init.js", () => ({
  logPlayerAction: vi.fn(),
  getPlayerLogs: vi.fn(),
  getPlayerNotes: vi.fn(),
  getPlayerNote: vi.fn(),
  upsertPlayerNote: vi.fn(),
  deletePlayerNote: vi.fn(),
  getPlayerStats: vi.fn(),
  getPlayerStat: vi.fn(),
  getSteamIdBans: vi.fn(),
  addSteamIdBan: vi.fn(),
  removeSteamIdBan: vi.fn(),
  getActiveServer: vi.fn(),
}));

vi.mock("../services/panelBridge.js", () => ({
  default: { isRunning: false, sendCommand: vi.fn() },
}));

const { default: router } = await import("../routes/players.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getRouteHandler(method, routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRequest(body, rconService) {
  return { body, app: { get: () => rconService } };
}

function makeRconService() {
  return {
    kickPlayer: vi.fn(async () => ({ success: true, response: "ok" })),
    banPlayer: vi.fn(async () => ({ success: true, response: "ok", sentReason: "" })),
    unbanPlayer: vi.fn(async () => ({ success: true, response: "ok" })),
  };
}

// PZ accepts usernames with a leading or trailing space and parsePlayers()
// reports them as such, so the routes must pass them to RCON as typed, and
// must check the string that is actually sent, not a trimmed copy of it.
describe("usernames with a leading or trailing space reach RCON as typed", () => {
  it("POST /kick passes ' Bob' and 'Bob ' through untrimmed", async () => {
    for (const username of [" Bob", "Bob "]) {
      const rconService = makeRconService();
      const response = createResponse();

      await getRouteHandler("post", "/kick")(
        createRequest({ username }, rconService),
        response,
      );

      expect(response.status).not.toHaveBeenCalled();
      expect(rconService.kickPlayer).toHaveBeenCalledWith(username, undefined);
    }
  });

  it("a trailing newline is no longer hidden by trimming before the check", async () => {
    const rconService = makeRconService();
    const response = createResponse();

    await getRouteHandler("post", "/kick")(
      createRequest({ username: "Bob\n" }, rconService),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(rconService.kickPlayer).not.toHaveBeenCalled();
  });

  it("a name of only spaces is still refused", async () => {
    const rconService = makeRconService();
    const response = createResponse();

    await getRouteHandler("post", "/kick")(
      createRequest({ username: "   " }, rconService),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(rconService.kickPlayer).not.toHaveBeenCalled();
  });
});

describe("POST /ban and /unban", () => {
  it("pass 'Bob ' through untrimmed, so the account 'Bob' is not the one affected", async () => {
    const rconService = makeRconService();
    const banResponse = createResponse();
    await getRouteHandler("post", "/ban")(
      createRequest({ username: "Bob " }, rconService),
      banResponse,
    );
    expect(rconService.banPlayer).toHaveBeenCalledWith("Bob ", undefined, undefined);

    const unbanResponse = createResponse();
    await getRouteHandler("post", "/unban")(
      createRequest({ username: "Bob " }, rconService),
      unbanResponse,
    );
    expect(rconService.unbanPlayer).toHaveBeenCalledWith("Bob ");
    expect(banResponse.status).not.toHaveBeenCalled();
    expect(unbanResponse.status).not.toHaveBeenCalled();
  });
});
