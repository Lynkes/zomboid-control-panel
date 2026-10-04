import { describe, expect, it, vi } from "vitest";

// security audit M2: ?token= used to be accepted on every /api route, so any
// request that put it in a URL (the client does for the SSE conflicts stream)
// leaked a 15-minute access token into proxy access logs and browser history.
// The rewrite is now restricted to the SSE endpoints that cannot set headers.
const { getRoleByNameMock } = vi.hoisted(() => ({ getRoleByNameMock: vi.fn() }));

vi.mock("../database/init.js", () => ({
  getRoleByName: getRoleByNameMock,
  getDb: vi.fn(async () => ({ data: {} })),
  peekServerDisplayName: vi.fn(() => null),
}));

const { acceptsQueryToken, QUERY_TOKEN_PATHS } = await import("../index.js");

const req = (originalUrl) => ({ originalUrl, url: originalUrl, path: originalUrl.split("?")[0] });

describe("acceptsQueryToken() — ?token= only on SSE endpoints", () => {
  it("accepts the known SSE stream path, query string and case included", () => {
    expect(acceptsQueryToken(req("/api/mods/conflicts/stream?token=abc"))).toBe(true);
    expect(acceptsQueryToken(req("/API/mods/conflicts/stream?token=abc"))).toBe(true);
  });

  it("refuses every other API path", () => {
    for (const url of [
      "/api/config/app-settings?token=abc",
      "/api/servers?token=abc",
      "/api/auth/users?token=abc",
      "/api/mods/conflicts/stream/extra?token=abc",
    ]) {
      expect(acceptsQueryToken(req(url))).toBe(false);
    }
  });

  it("has exactly the one SSE endpoint in the allowlist", () => {
    expect([...QUERY_TOKEN_PATHS]).toEqual(["/api/mods/conflicts/stream"]);
  });
});
