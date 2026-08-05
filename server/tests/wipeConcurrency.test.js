import { describe, expect, it, vi } from "vitest";

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
}));

const { default: router } = await import("../routes/server.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getWipeHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/wipe" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

describe("POST /api/server/wipe concurrency guard", () => {
  it("rejects a second wipe that arrives while the first is still validating", async () => {
    let releaseRunningCheck;
    let checkCalls = 0;

    const serverManager = {
      loadConfig: async () => {},
      checkServerRunning: () => {
        checkCalls += 1;
        // Suspend the first request inside its validation phase.
        if (checkCalls === 1) {
          return new Promise((resolve) => {
            releaseRunningCheck = () => resolve(true);
          });
        }
        return Promise.resolve(true);
      },
      savePath: null,
      serverName: "servertest",
    };

    const handler = getWipeHandler();
    const buildRequest = () => ({
      app: { get: () => serverManager },
      body: { targets: ["map"], confirm: true },
    });

    const firstResponse = createResponse();
    const secondResponse = createResponse();

    const firstCall = handler(buildRequest(), firstResponse);
    // Let the first request reach its await.
    await Promise.resolve();

    await handler(buildRequest(), secondResponse);

    expect(secondResponse.status).toHaveBeenCalledWith(409);

    releaseRunningCheck();
    await firstCall;
  });

  it("releases the guard so a later wipe is not blocked forever", async () => {
    const serverManager = {
      loadConfig: async () => {},
      checkServerRunning: async () => true,
      savePath: null,
      serverName: "servertest",
    };

    const handler = getWipeHandler();
    const request = () => ({
      app: { get: () => serverManager },
      body: { targets: ["map"], confirm: true },
    });

    const first = createResponse();
    await handler(request(), first);

    const second = createResponse();
    await handler(request(), second);

    // Both are rejected for "server running", never 409 from a stuck guard.
    expect(second.status).toHaveBeenCalledWith(400);
    expect(second.status).not.toHaveBeenCalledWith(409);
  });
});
