import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";

// continuous-bug-hunt, 2026-09-18 (update-check-truth round): fetchLatestReleaseOnce
// used to resolve(null) on ANY 404 from api.github.com/repos/.../releases/latest,
// on the assumption that a 404 there only ever means "this repo genuinely has
// no releases yet" -- checkForUpdate() then reports that as a clean, error-free
// "nothing to check against" (lastError cleared, no exception). But a captive
// portal, an SSL-inspecting corporate proxy, a DNS override, or GitHub itself
// briefly serving an unrelated error page all produce a plain 404 too, with a
// body that looks nothing like GitHub's real "no releases" response -- and
// every one of those was silently reported as "checked, up to date" instead of
// surfacing as the failed fetch it actually was. Fixed by checking the 404
// body against GitHub's own documented shape ({"message":"Not Found", ...})
// before treating it as "no releases published" rather than a real failure.

let mockReq;
let responseHandler;

function makeResponse({ statusCode, body }) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.resume = vi.fn();
  queueMicrotask(() => {
    if (body !== undefined) res.emit("data", Buffer.from(body));
    res.emit("end");
  });
  return res;
}

vi.mock("https", () => ({
  default: {
    get: vi.fn((_options, callback) => {
      responseHandler = callback;
      mockReq = new EventEmitter();
      mockReq.setTimeout = vi.fn();
      mockReq.destroy = vi.fn();
      return mockReq;
    }),
  },
}));

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("../services/dockerUpdateProxy.js", () => ({
  DockerUpdateProxy: vi.fn(function DockerUpdateProxy() {
    this.mode = "none";
  }),
}));

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("PanelUpdateChecker.fetchLatestReleaseOnce: a 404 is only 'no releases' when it actually looks like GitHub's own response", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves null (no error) for GitHub's real 'no releases yet' 404 body", async () => {
    const checker = new PanelUpdateChecker({ emit: vi.fn() });
    checker.currentVersion = "1.0.0";

    const promise = checker.fetchLatestReleaseOnce();
    responseHandler(
      makeResponse({
        statusCode: 404,
        body: JSON.stringify({
          message: "Not Found",
          documentation_url: "https://docs.github.com/rest",
        }),
      }),
    );

    await expect(promise).resolves.toBeNull();
  });

  it("rejects (does not silently resolve null) when a 404 arrives with a body that is not GitHub's own shape -- e.g. a captive portal or proxy page", async () => {
    const checker = new PanelUpdateChecker({ emit: vi.fn() });
    checker.currentVersion = "1.0.0";

    const promise = checker.fetchLatestReleaseOnce();
    responseHandler(
      makeResponse({
        statusCode: 404,
        body: "<html><body>Wi-Fi sign-in required</body></html>",
      }),
    );

    await expect(promise).rejects.toThrow(/404/);
  });

  it("checkForUpdate() does not silently report 'up to date' for that ambiguous 404 -- it surfaces lastError instead", async () => {
    const checker = new PanelUpdateChecker({ emit: vi.fn() });
    checker.currentVersion = "1.0.0";
    checker.updateAvailable = true; // pretend a real update was known from a previous, successful check
    checker.lastError = null;

    const checkPromise = checker.checkForUpdate();
    // fetchLatestReleaseOnce is called once per attempt; the retry loop in
    // requestGitHubReleaseWithRetry re-invokes https.get for each retry, so
    // resolve every attempt with the same ambiguous 404 body.
    const respondOnce = () => {
      if (!responseHandler) return;
      const handler = responseHandler;
      responseHandler = null;
      handler(
        makeResponse({
          statusCode: 404,
          body: "not github at all",
        }),
      );
    };
    // Drain microtasks a few times so each retry attempt gets its response.
    for (let i = 0; i < 5 && !checker.lastError; i++) {
      await Promise.resolve();
      respondOnce();
      await Promise.resolve();
    }

    const status = await checkPromise;

    expect(status.lastError).toBeTruthy();
    // The bug's own symptom: a real prior updateAvailable:true must not be
    // silently forgotten/misreported by an ambiguous 404 either -- it's
    // simply preserved as stale, exactly like every other genuine fetch
    // failure already does elsewhere in this file.
    expect(status.updateAvailable).toBe(true);
  });
});
