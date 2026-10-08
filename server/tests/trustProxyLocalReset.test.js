import { describe, expect, it, vi } from "vitest";

// Route-level coverage for the fail-closed ruling on isLocalPanelRequest
// (see server/tests/localPanelRequest.test.js for the underlying unit
// tests): once trust proxy is configured, the panel cannot verify a
// request's real origin, so it must refuse local-only recovery affordances
// entirely rather than guess. Two requirements this covers that the unit
// tests alone don't: (1) the refusal must explain WHY and WHAT TO DO
// INSTEAD, not just say "no" (2) GET /reset-status must stop advertising
// the affordance too, or the UI offers a button that always 403s.

const { default: router } = await import("../routes/auth.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function reqBehindTrustProxy(remoteAddress) {
  return {
    socket: { remoteAddress },
    connection: {},
    app: { get: (key) => (key === "trust proxy" ? 1 : undefined) },
    headers: {},
    cookies: {},
  };
}

function reqDirect(remoteAddress) {
  return {
    socket: { remoteAddress },
    connection: {},
    headers: {},
    cookies: {},
  };
}

describe("POST /auth/reset-token/local: fails closed behind a reverse proxy", () => {
  it("refuses a loopback-socket request once trust proxy is configured, and the message teaches why + what to do instead", async () => {
    const res = createResponse();
    await getHandler("/reset-token/local", "post")(
      reqBehindTrustProxy("127.0.0.1"),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe("LOCAL_RESET_BEHIND_PROXY");
    expect(body.error).toMatch(/reverse proxy/i);
    expect(body.error).toMatch(/reset-token\.txt|recovery code/i);
  });
});

describe("GET /auth/reset-status: localResetSupported follows the same fail-closed rule", () => {
  it("reports localResetSupported: false for a loopback peer once trust proxy is configured", async () => {
    const res = createResponse();
    await getHandler("/reset-status", "get")(
      reqBehindTrustProxy("127.0.0.1"),
      res,
    );

    expect(res.json.mock.calls[0][0].localResetSupported).toBe(false);
  });

  it("trust proxy off: a loopback peer still reports localResetSupported: true (unchanged)", async () => {
    const res = createResponse();
    await getHandler("/reset-status", "get")(reqDirect("127.0.0.1"), res);

    expect(res.json.mock.calls[0][0].localResetSupported).toBe(true);
  });
});

// Auth audit 2026-10-08 (#17): behind a proxy or tunnel on the same machine
// with TRUST_PROXY unset, every request arrives from 127.0.0.1, so every
// internet visitor counted as "on the panel host": it learned whether a
// reset-token file exists, got the host-only refusal reasons, and could make
// the panel write a token file. A request carrying a proxy's headers is now
// never local, and the panel says once that TRUST_PROXY looks missing.
describe("a loopback request that came through a proxy gets the remote answers", () => {
  function proxied(remoteAddress) {
    return { ...reqDirect(remoteAddress), headers: { "x-forwarded-for": "203.0.113.50" } };
  }

  it("GET /reset-status reports no local reset, and the panel warns once that TRUST_PROXY looks missing", async () => {
    const { onLog } = await import("../utils/logger.js");
    const warnings = [];
    const unsubscribe = onLog((entry) => {
      if (entry.level === "warn" && /TRUST_PROXY/.test(entry.message)) warnings.push(entry.message);
    });
    try {
      for (let i = 0; i < 2; i++) {
        const res = createResponse();
        await getHandler("/reset-status", "get")(proxied("127.0.0.1"), res);
        expect(res.json.mock.calls[0][0]).toEqual({ localResetSupported: false });
      }
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      unsubscribe();
    }
    expect(warnings).toHaveLength(1);
  });

  it("POST /reset-password gives the generic refusal, not the host-only reason", async () => {
    // Before the test below: no token file exists yet, which a caller on the
    // host is told (RESET_TOKEN_NOT_FOUND) and anyone else is not.
    const res = createResponse();
    await getHandler("/reset-password", "post")(
      { ...proxied("127.0.0.1"), body: { token: "a".repeat(48), newPassword: "new-password-1" } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe("RESET_TOKEN_INVALID");
  });

  it("POST /reset-token/local refuses with the proxy explanation", async () => {
    const res = createResponse();
    await getHandler("/reset-token/local", "post")(proxied("127.0.0.1"), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe("LOCAL_RESET_BEHIND_PROXY");
  });

  it("other proxy headers count too", async () => {
    for (const header of ["x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "cf-connecting-ip"]) {
      const res = createResponse();
      await getHandler("/reset-status", "get")(
        { ...reqDirect("127.0.0.1"), headers: { [header]: "x" } },
        res,
      );
      expect(res.json.mock.calls[0][0].localResetSupported).toBe(false);
    }
  });
});
