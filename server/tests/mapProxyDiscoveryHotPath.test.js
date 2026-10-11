import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Upstream descriptor discovery sits on the hot path of every tile request:
//   - getB42TopFormat() cached only a success, so with base_top/layer0.dzi
//     blocked or 404 every /toptiles request, even one answered from the disk
//     cache, first ran a curl of up to 8 s.
//   - once the 24 h (or 5 min after a failure) lifetime of the resolved map
//     ran out, getB42Map() made every concurrent /tiles request wait for the
//     whole discovery (~16 s when the hosts drop packets) instead of serving
//     the map it already had.
// Time is faked with Date only; the curl calls are held and released by hand.

const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

function curlResult(status, body) {
  return { stdout: `${body}\n__CURL_HTTP_STATUS__:${status}`, stderr: "" };
}

const GEOMETRY = { tileSize: 2048, width: 2318656, height: 1019040 };
const dziXml = (g) =>
  `<?xml version="1.0"?><Image TileSize="${g.tileSize}" Overlap="0" Format="jpg"><Size Width="${g.width}" Height="${g.height}"/></Image>`;
const mapInfoJson = () => JSON.stringify({ x0: 1040384, y0: -139296, sqr: 128, skip: 0 });

// Answers curl calls with impl(url). A call for which impl returns "hold" is
// parked until the test releases or fails it. Returns the parked calls, every
// URL asked for and a per-suffix call counter.
function installCurl(impl) {
  const parked = [];
  const calls = [];
  mockExecFile.mockImplementation((_file, args, _options, callback) => {
    const url = args[args.length - 1];
    calls.push(url);
    let result;
    try {
      result = impl(url);
    } catch (err) {
      callback(err);
      return;
    }
    if (result === "hold") {
      parked.push({ url, release: (r) => callback(null, r), fail: (e) => callback(e) });
      return;
    }
    callback(null, result);
  });
  return { parked, calls, count: (suffix) => calls.filter((u) => u.endsWith(suffix)).length };
}

async function freshModule() {
  vi.resetModules();
  return await import("../routes/mapProxy.js");
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Resolves with the value, or "WAITING" when it has not settled in `ms`.
function settlesWithin(promise, ms = 150) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("WAITING"), ms))]);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
let originalFetch;

beforeEach(() => {
  mockExecFile.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
  originalFetch = global.fetch;
  global.fetch = vi.fn(async () => ({ ok: true }));
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
  vi.resetModules();
});

const advance = (ms) => vi.setSystemTime(Date.now() + ms);

describe("getB42TopFormat(): a descriptor that can't be read", () => {
  const TOP_DZI = "/base_top/layer0.dzi";

  it("is asked about once, then the fallback format is answered from memory", async () => {
    const curl = installCurl((url) => {
      if (url.endsWith(TOP_DZI)) return curlResult(404, "not found");
      throw new Error(`unexpected curl URL: ${url}`);
    });
    const { getB42TopFormat } = await freshModule();

    expect(await getB42TopFormat("42.20.0")).toBe("jpg");
    for (let i = 0; i < 5; i++) expect(await getB42TopFormat("42.20.0")).toBe("jpg");
    const burst = await Promise.all(Array.from({ length: 20 }, () => getB42TopFormat("42.20.0")));
    expect(burst).toEqual(Array(20).fill("jpg"));

    expect(curl.count(TOP_DZI)).toBe(1);
  });

  it("is asked again after 10 minutes without holding up the request, and the real format is used once it is read", async () => {
    let answer = curlResult(404, "not found");
    let hold = false;
    const curl = installCurl((url) => {
      if (!url.endsWith(TOP_DZI)) throw new Error(`unexpected curl URL: ${url}`);
      return hold ? "hold" : answer;
    });
    const { getB42TopFormat } = await freshModule();

    expect(await getB42TopFormat("42.20.0")).toBe("jpg");
    expect(curl.count(TOP_DZI)).toBe(1);

    advance(9 * MINUTE);
    expect(await getB42TopFormat("42.20.0")).toBe("jpg");
    expect(curl.count(TOP_DZI)).toBe(1);

    advance(2 * MINUTE);
    hold = true;
    const burst = await settlesWithin(
      Promise.all(Array.from({ length: 10 }, () => getB42TopFormat("42.20.0"))),
    );
    expect(burst).toEqual(Array(10).fill("jpg"));
    // One refresh for all ten, still waiting on upstream.
    expect(curl.count(TOP_DZI)).toBe(2);
    expect(curl.parked).toHaveLength(1);

    curl.parked[0].release(curlResult(200, '<?xml version="1.0"?><Image Format="webp"/>'));
    await tick();
    expect(await getB42TopFormat("42.20.0")).toBe("webp");
    advance(HOUR);
    expect(await getB42TopFormat("42.20.0")).toBe("webp");
    expect(curl.count(TOP_DZI)).toBe(2);
  });

  it("keeps the fallback and waits another 10 minutes when the refresh fails too", async () => {
    const curl = installCurl((url) => {
      if (url.endsWith(TOP_DZI)) return curlResult(403, "blocked");
      throw new Error(`unexpected curl URL: ${url}`);
    });
    const { getB42TopFormat } = await freshModule();

    await getB42TopFormat("42.20.0");
    advance(11 * MINUTE);
    expect(await getB42TopFormat("42.20.0")).toBe("jpg");
    await tick();
    expect(curl.count(TOP_DZI)).toBe(2);

    advance(5 * MINUTE);
    expect(await getB42TopFormat("42.20.0")).toBe("jpg");
    await tick();
    expect(curl.count(TOP_DZI)).toBe(2);
  });
});

describe("getB42Dir(): an expired map is served while one refresh runs", () => {
  function discovery({ directory, holdDefault = () => false }) {
    return (url) => {
      if (url.endsWith("/api/builds/default")) {
        if (holdDefault()) return "hold";
        return curlResult(200, JSON.stringify({ directory: directory(), default: true }));
      }
      if (url.includes("/base/layer0.dzi")) return curlResult(200, dziXml(GEOMETRY));
      if (url.includes("/base/map_info.json")) return curlResult(200, mapInfoJson());
      throw new Error(`unexpected curl URL: ${url}`);
    };
  }

  it("after the 24 h lifetime, concurrent callers get the old build at once and one refresh picks up the new one", async () => {
    let directory = "42.20.0";
    let hold = false;
    const curl = installCurl(discovery({ directory: () => directory, holdDefault: () => hold }));
    const { getB42Dir, getB42ResolutionStatus } = await freshModule();

    expect(await getB42Dir()).toBe("42.20.0");
    expect(curl.count("/api/builds/default")).toBe(1);

    advance(25 * HOUR);
    hold = true;
    directory = "42.21.0";
    const burst = await settlesWithin(Promise.all(Array.from({ length: 20 }, () => getB42Dir())));
    expect(burst).toEqual(Array(20).fill("42.20.0"));
    expect(curl.count("/api/builds/default")).toBe(2);
    expect(curl.parked).toHaveLength(1);

    hold = false;
    curl.parked[0].release(curlResult(200, JSON.stringify({ directory: "42.21.0", default: true })));
    await vi.waitFor(async () => expect(await getB42Dir()).toBe("42.21.0"));
    expect(getB42ResolutionStatus()).toEqual({ source: "dynamic", directory: "42.21.0", reason: null });
    // The refresh is over: nothing else asks upstream.
    const before = curl.calls.length;
    await Promise.all(Array.from({ length: 10 }, () => getB42Dir()));
    expect(curl.calls.length).toBe(before);
  });

  it("when discovery was blocked, the fallback build is served at once when the 5 minute retry is due", async () => {
    let blocked = true;
    let hold = false;
    const curl = installCurl((url) => {
      if (blocked) {
        if (hold) return "hold";
        const err = new Error("spawn curl ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return discovery({ directory: () => "42.22.0" })(url);
    });
    const { getB42Dir, getB42ResolutionStatus } = await freshModule();

    expect(await getB42Dir()).toBe("42.20.0");
    expect(getB42ResolutionStatus().source).toBe("fallback");
    const afterFirst = curl.calls.length;

    advance(4 * MINUTE);
    expect(await getB42Dir()).toBe("42.20.0");
    expect(curl.calls.length).toBe(afterFirst);

    advance(2 * MINUTE);
    hold = true;
    const burst = await settlesWithin(Promise.all(Array.from({ length: 10 }, () => getB42Dir())));
    expect(burst).toEqual(Array(10).fill("42.20.0"));
    expect(curl.calls.length).toBe(afterFirst + 1);

    // Upstream comes back: the held request fails, the next retry resolves.
    blocked = false;
    hold = false;
    curl.parked[0].fail(Object.assign(new Error("spawn curl ENOENT"), { code: "ENOENT" }));
    await tick();
    advance(6 * MINUTE);
    await getB42Dir();
    await vi.waitFor(async () => expect(await getB42Dir()).toBe("42.22.0"));
    expect(getB42ResolutionStatus().source).toBe("dynamic");
  });

  it("a cold start still waits for the first discovery, shared by every caller", async () => {
    let hold = true;
    const curl = installCurl(discovery({ directory: () => "42.20.0", holdDefault: () => hold }));
    const { getB42Dir } = await freshModule();

    const pending = Promise.all(Array.from({ length: 5 }, () => getB42Dir()));
    expect(await settlesWithin(pending)).toBe("WAITING");
    expect(curl.count("/api/builds/default")).toBe(1);

    hold = false;
    curl.parked[0].release(curlResult(200, JSON.stringify({ directory: "42.20.0", default: true })));
    expect(await pending).toEqual(Array(5).fill("42.20.0"));
  });
});
