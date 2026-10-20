import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";

const { apiKeyMock, logMock } = vi.hoisted(() => ({
  apiKeyMock: vi.fn(),
  logMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../services/steamApiKey.js", () => ({ getSteamApiKey: apiKeyMock }));
vi.mock("../utils/logger.js", () => ({ createLogger: () => logMock }));

import {
  STEAM_KNOWLEDGE_LIMITS,
  peekSteamKnowledge,
  fetchSteamKnowledge,
  startSteamKnowledgeFill,
  flushSteamKnowledge,
  parseRequiredItemsFromPage,
  parseModIdOrderFromDescription,
  _resetSteamKnowledgeForTests,
  _setSteamKnowledgeLimitsForTests,
} from "../services/modSteamKnowledge.js";
import { getDataPaths } from "../utils/paths.js";

const DETAILS_URL =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const CHILDREN_URL = "https://api.steampowered.com/IPublishedFileService/GetDetails/v1/";
const API_KEY = "ABCDEF0123456789SECRETKEY";
const STORE = () => path.join(getDataPaths().dataDir, "mod-steam-meta.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { "content-type": "text/html" } });
}

function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: location ? { location } : {} });
}

function formIds(body) {
  const params = new URLSearchParams(String(body));
  const count = Number(params.get("itemcount"));
  return Array.from({ length: count }, (_, i) => params.get(`publishedfileids[${i}]`));
}

function queryIds(url) {
  return [...new URL(url).searchParams.entries()]
    .filter(([k]) => k.startsWith("publishedfileids["))
    .map(([, v]) => v);
}

function hanging(signal) {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
}

function requiredLink(id, title) {
  return `<a href="https://steamcommunity.com/workshop/filedetails/?id=${id}"  target="_blank">\n<div class="requiredItem">\n${title}</div>\n</a>`;
}

function workshopPage(id, required = [], { after = "" } = {}) {
  const container = required.length
    ? `<div class="requiredItemsContainer" id="RequiredItems">\n${required
        .map(([rid, title]) => requiredLink(rid, title))
        .join("\n")}\n</div>`
    : "";
  return `<!DOCTYPE html><html><head><title>Steam Workshop::Item ${id}</title></head><body>
<div class="workshopItemTitle">Item ${id}</div>
<div class="rightDetailsBlock">
<div class="requiredItemsHeader">Required items</div>
${container}
</div>
${after}
</body></html>`;
}

/** Fake Steam: details (POST), children (API GET) and Workshop pages. */
function fakeSteam({ details = {}, children = {}, pages = {}, detailsHandler, childrenHandler } = {}) {
  const calls = { details: [], children: [], pages: [], other: [] };
  const fetchMock = vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (u === DETAILS_URL) {
      calls.details.push({ url: u, init });
      if (detailsHandler) return detailsHandler(u, init);
      const ids = formIds(init.body);
      return jsonResponse({
        response: {
          result: 1,
          resultcount: ids.length,
          publishedfiledetails: ids.map((id) =>
            id in details
              ? { publishedfileid: id, result: 1, ...details[id] }
              : { publishedfileid: id, result: 9 },
          ),
        },
      });
    }
    if (u.startsWith(`${CHILDREN_URL}?`)) {
      calls.children.push({ url: u, init });
      if (childrenHandler) return childrenHandler(u, init);
      const ids = queryIds(u);
      return jsonResponse({
        response: {
          publishedfiledetails: ids.map((id) =>
            id in children
              ? { publishedfileid: id, result: 1, children: children[id] }
              : { publishedfileid: id, result: 9 },
          ),
        },
      });
    }
    const parsed = new URL(u);
    if (parsed.origin === "https://steamcommunity.com") {
      calls.pages.push({ url: u, init });
      const id = parsed.searchParams.get("id");
      const page = pages[id];
      if (typeof page === "function") return page(u, init);
      if (typeof page === "string") return htmlResponse(page);
      return htmlResponse("<html><body>Something went wrong</body></html>");
    }
    calls.other.push({ url: u, init });
    throw new Error(`unexpected host ${parsed.host}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function details(title, extra = {}) {
  return { title, tags: [{ tag: "Build 42" }], description: "", ...extra };
}

function loggedText() {
  return JSON.stringify(
    Object.values(logMock).flatMap((fn) => fn.mock.calls),
  );
}

beforeEach(() => {
  _resetSteamKnowledgeForTests();
  fs.rmSync(STORE(), { force: true });
  apiKeyMock.mockReset();
  apiKeyMock.mockResolvedValue(null);
  for (const fn of Object.values(logMock)) fn.mockClear();
});

afterEach(() => {
  _resetSteamKnowledgeForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Pure parsers ───────────────────────────────────────────────────────────

describe("parseRequiredItemsFromPage", () => {
  it("reads Steam's real RequiredItems markup", () => {
    const html = workshopPage("100", [
      ["2392709985", "tsarslib"],
      ["2619072426", "Common Sense"],
    ]);
    expect(parseRequiredItemsFromPage(html, "100")).toEqual([
      { workshopId: "2392709985", title: "tsarslib" },
      { workshopId: "2619072426", title: "Common Sense" },
    ]);
  });

  it("counts nested divs and ignores links after the container", () => {
    const html = `<div class="workshopItemTitle">X</div>
<div class="requiredItemsContainer" id="RequiredItems">
  <div class="inner"><div class="deeper">
    <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=111"><div class="requiredItem"><div>Nested <span>One</span></div></div></a>
  </div></div>
  <a href='https://steamcommunity.com/workshop/filedetails/?id=222'>Two</a>
</div>
<div class="moreFromAuthor"><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=999">Not required</a></div>`;
    expect(parseRequiredItemsFromPage(html, "1")).toEqual([
      { workshopId: "111", title: "Nested One" },
      { workshopId: "222", title: "Two" },
    ]);
  });

  it("strips injected tags and scripts from titles and decodes entities once", () => {
    const html = workshopPage("1", [
      ["301", '<script>alert(1)</script><b>Evil</b><img src=x onerror="alert(2)"> Mod<style>a{}</style>'],
      ["302", "&lt;script&gt;alert(1)&lt;/script&gt; Fancy &amp; Co &#39;x&#39; &#x41;&#66; &amp;lt;"],
      ["303", "   \n\t  "],
      ["304", "&#0;&#x110000;&#xD800; ok"],
    ]);
    const parsed = parseRequiredItemsFromPage(html, "1");
    expect(parsed).toEqual([
      { workshopId: "301", title: "Evil Mod" },
      { workshopId: "302", title: "<script>alert(1)</script> Fancy & Co 'x' AB &lt;" },
      { workshopId: "303", title: null },
      { workshopId: "304", title: "&#0;&#x110000;&#xD800; ok" },
    ]);
  });

  it("caps titles at maxTitle", () => {
    const parsed = parseRequiredItemsFromPage(workshopPage("1", [["5", "x".repeat(500)]]), "1");
    expect(parsed[0].title).toHaveLength(STEAM_KNOWLEDGE_LIMITS.maxTitle);
  });

  it("accepts only Workshop filedetails links on steamcommunity.com", () => {
    const links = [
      `<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=11&amp;searchtext=x">ok amp</a>`,
      `<a href="http://steamcommunity.com/workshop/filedetails/?id=12">ok http</a>`,
      `<a href="https://evil.example/sharedfiles/filedetails/?id=13">evil</a>`,
      `<a href="https://steamcommunity.com.evil.example/sharedfiles/filedetails/?id=14">evil</a>`,
      `<a href="javascript:alert(1)//https://steamcommunity.com/sharedfiles/filedetails/?id=15">js</a>`,
      `<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=16abc">bad id</a>`,
      `<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=1234567890123456">too long</a>`,
      `<a href="https://store.steampowered.com/app/108600/">dlc</a>`,
      `<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=11">dup</a>`,
      `<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=7">self</a>`,
      `<a name="x">no href</a>`,
    ].join("\n");
    const html = `<div class="workshopItemTitle">t</div><div id="RequiredItems">${links}</div>`;
    expect(parseRequiredItemsFromPage(html, "7")).toEqual([
      { workshopId: "11", title: "ok amp" },
      { workshopId: "12", title: "ok http" },
    ]);
  });

  it("caps the list at maxRequiredPerItem", () => {
    const required = Array.from({ length: 150 }, (_, i) => [String(1000 + i), `M${i}`]);
    const parsed = parseRequiredItemsFromPage(workshopPage("1", required), "1");
    expect(parsed).toHaveLength(STEAM_KNOWLEDGE_LIMITS.maxRequiredPerItem);
    expect(parsed[0].workshopId).toBe("1000");
  });

  it("returns [] for a Workshop page without a container and null for anything else", () => {
    expect(parseRequiredItemsFromPage(workshopPage("1", []), "1")).toEqual([]);
    expect(parseRequiredItemsFromPage("<html><body>Error</body></html>", "1")).toBeNull();
    expect(parseRequiredItemsFromPage("", "1")).toBeNull();
    expect(parseRequiredItemsFromPage(null, "1")).toBeNull();
    expect(parseRequiredItemsFromPage({ html: "x" }, "1")).toBeNull();
    // id literal only inside a script string: not a container, still a page
    expect(
      parseRequiredItemsFromPage(
        `<div class="workshopItemTitle">t</div><script>var s = 'x id="RequiredItems"';</script>`,
        "1",
      ),
    ).toEqual([]);
    // data-id is not id
    expect(
      parseRequiredItemsFromPage(
        `<div class="workshopItemTitle">t</div><div data-id="RequiredItems"><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=5">x</a></div>`,
        "1",
      ),
    ).toEqual([]);
  });

  it("stays fast and bounded on huge or hostile input", () => {
    const started = Date.now();
    // container that never closes: give up after 200 KB
    const unclosed =
      `<div class="workshopItemTitle">t</div><div id="RequiredItems">` + "<div>".repeat(300_000);
    expect(parseRequiredItemsFromPage(unclosed, "1")).toBeNull();
    // unterminated tags everywhere
    const junk =
      `<div class="workshopItemTitle">t</div><div id="RequiredItems">` + "<div<a href=".repeat(200_000);
    expect(parseRequiredItemsFromPage(junk, "1")).toBeNull();
    // anchors without a closing ">" inside a closed container
    const anchors =
      `<div class="workshopItemTitle">t</div><div id="RequiredItems">` + "<a x".repeat(40_000) + "</div>";
    expect(parseRequiredItemsFromPage(anchors, "1")).toEqual([]);
    // many fake candidates and "<" runs
    const fakes = `<div class="workshopItemTitle">` + ' id="RequiredItems"<'.repeat(200_000);
    expect(parseRequiredItemsFromPage(fakes, "1")).toEqual([]);
    // a real page after 3 MB of filler is still read
    const filler = "x".repeat(3 * 1024 * 1024) + workshopPage("1", [["42", "Late"]]);
    expect(parseRequiredItemsFromPage(filler, "1")).toEqual([{ workshopId: "42", title: "Late" }]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("parseModIdOrderFromDescription", () => {
  it("collects Mod ID values in order, strictly", () => {
    const text = [
      "Workshop ID: 2392709985",
      "Mod ID: tsarslib",
      "ModID:tsarslib_b42",
      "mod id = Other.Mod-1",
      "[b]Mod ID:[/b] boldmod",
      "Mod ID: [i]italic[/i]",
      "Mod ID: bad value with spaces",
      "Mod ID: endsAtBracket[url=x]",
      "Mod ID: endsAtTag<br>",
      "Mod Id: tsarslib",
      "Mod ID: ",
      "Mod ID: évil",
    ].join("\r\n");
    expect(parseModIdOrderFromDescription(text)).toEqual([
      "tsarslib",
      "tsarslib_b42",
      "Other.Mod-1",
      "boldmod",
      "italic",
      "endsAtBracket",
      "endsAtTag",
    ]);
  });

  it("returns [] for non-strings and caps count and scanned size", () => {
    expect(parseModIdOrderFromDescription(undefined)).toEqual([]);
    expect(parseModIdOrderFromDescription(42)).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => `Mod ID: m${i}`).join("\n");
    expect(parseModIdOrderFromDescription(many)).toHaveLength(STEAM_KNOWLEDGE_LIMITS.maxModIdOrder);
    const late = "a".repeat(100 * 1024 + 10) + "\nMod ID: tooLate";
    expect(parseModIdOrderFromDescription(late)).toEqual([]);
    const value = "x".repeat(101);
    expect(parseModIdOrderFromDescription(`Mod ID: ${value}`)).toEqual([]);
  });

  it("does not lose a label after an empty one and stays fast on hostile lines", () => {
    expect(parseModIdOrderFromDescription("Mod ID:\nMod ID: afterEmpty")).toEqual(["afterEmpty"]);
    const started = Date.now();
    const hostile = "Mod ID: ".repeat(20_000) + "x ".repeat(20_000);
    expect(parseModIdOrderFromDescription(hostile)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ─── Fetching ───────────────────────────────────────────────────────────────

describe("fetchSteamKnowledge with a Steam Web API key", () => {
  it("takes required items from file_type 0 children and never logs the key", async () => {
    apiKeyMock.mockResolvedValue(API_KEY);
    const many = Array.from({ length: 150 }, (_, i) => ({
      publishedfileid: String(5000 + i),
      file_type: 0,
    }));
    const { calls } = fakeSteam({
      details: {
        100: details("  Main Mod  ", { description: "Mod ID: mainmod\nMod ID: mainmod_extra" }),
        200: details("Big Pack"),
      },
      children: {
        100: [
          { publishedfileid: "222", sortorder: 0, file_type: 0 },
          { publishedfileid: "333", sortorder: 1, file_type: 2 },
          { publishedfileid: "100", sortorder: 2, file_type: 0 },
          { publishedfileid: "abc", sortorder: 3, file_type: 0 },
          { publishedfileid: "222", sortorder: 4, file_type: 0 },
          { publishedfileid: 444, sortorder: 5, file_type: 0 },
          { publishedfileid: "1234567890123456", file_type: 0 },
          { publishedfileid: "555", file_type: "0" },
          null,
        ],
        200: many,
      },
    });

    const { items, status } = await fetchSteamKnowledge(["100", "200", "not-an-id", "100"]);

    expect(calls.pages).toHaveLength(0);
    expect(calls.other).toHaveLength(0);
    expect(calls.children).toHaveLength(1);
    const childUrl = new URL(calls.children[0].url);
    expect(childUrl.searchParams.get("includechildren")).toBe("true");
    expect(queryIds(calls.children[0].url)).toEqual(["100", "200"]);
    expect(calls.children[0].init.headers["User-Agent"]).toBe("ZomboidControlPanel (+mod-insights)");
    expect(calls.details[0].init.method).toBe("POST");
    expect(formIds(calls.details[0].init.body)).toEqual(["100", "200"]);

    const main = items.get("100");
    expect(main.title).toBe("Main Mod");
    expect(main.requires).toEqual([
      { workshopId: "222", title: null },
      { workshopId: "444", title: null },
    ]);
    expect(main.requiresSource).toBe("api");
    expect(main.modIdOrder).toEqual(["mainmod", "mainmod_extra"]);
    expect(typeof main.detailsAt).toBe("number");
    expect(typeof main.requiresAt).toBe("number");
    expect(items.get("200").requires).toHaveLength(100);
    expect(status).toMatchObject({
      source: "api",
      stale: false,
      failed: false,
      pending: false,
      known: 2,
      total: 2,
    });
    expect(status.rateLimited).toBeUndefined();
    expect(typeof status.fetchedAt).toBe("string");
  });

  it("keeps the key out of logs when the API request fails", async () => {
    apiKeyMock.mockResolvedValue(API_KEY);
    fakeSteam({
      details: { 1: details("One") },
      childrenHandler: (url) => {
        throw new Error(`connect failed for ${url}`);
      },
    });
    const { items, status } = await fetchSteamKnowledge(["1"]);
    expect(status.failed).toBe(true);
    expect(items.get("1").requires).toBeNull();
    expect(items.get("1").title).toBe("One");
    expect(logMock.debug).toHaveBeenCalled();
    expect(loggedText()).not.toContain(API_KEY);
  });

  it("treats a too-short key as no key", async () => {
    apiKeyMock.mockResolvedValue("short");
    const { calls } = fakeSteam({
      details: { 1: details("One") },
      pages: { 1: workshopPage("1", []) },
    });
    const { status } = await fetchSteamKnowledge(["1"]);
    expect(calls.children).toHaveLength(0);
    expect(calls.pages).toHaveLength(1);
    expect(status.source).toBe("page");
  });
});

describe("fetchSteamKnowledge without a key (Workshop page fallback)", () => {
  it("parses required items from the item page", async () => {
    const { calls } = fakeSteam({
      details: { 10: details("Ten"), 20: details("Twenty") },
      pages: {
        10: workshopPage("10", [["2392709985", "tsarslib"], ["10", "self"]]),
        20: workshopPage("20", []),
      },
    });
    const { items, status } = await fetchSteamKnowledge(["10", "20"]);
    expect(calls.children).toHaveLength(0);
    expect(calls.pages).toHaveLength(2);
    const init = calls.pages[0].init;
    expect(init.redirect).toBe("manual");
    expect(init.headers["Accept-Language"]).toBe("en");
    expect(init.headers["User-Agent"]).toBe("ZomboidControlPanel (+mod-insights)");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(items.get("10").requires).toEqual([{ workshopId: "2392709985", title: "tsarslib" }]);
    expect(items.get("10").requiresSource).toBe("page");
    expect(items.get("20").requires).toEqual([]);
    expect(status).toMatchObject({ source: "page", stale: false, failed: false, known: 2, total: 2 });
  });

  it("fails an item whose page is not a Workshop item page, or answers an HTTP error", async () => {
    fakeSteam({
      details: { 1: details("One"), 2: details("Two") },
      pages: {
        1: "<html>login wall</html>",
        2: () => htmlResponse("busy", 503),
      },
    });
    const { items, status } = await fetchSteamKnowledge(["1", "2"]);
    expect(status.failed).toBe(true);
    expect(status.stale).toBe(true);
    expect(items.get("1").requires).toBeNull();
    expect(typeof items.get("1").failedAt).toBe("number");
    expect(items.get("2").requires).toBeNull();
    expect(items.get("1").title).toBe("One");
  });

  it("reads at most maxPageBytes of a page", async () => {
    _setSteamKnowledgeLimitsForTests({ maxPageBytes: 4096 });
    const page = workshopPage("1", []) + "<!--" + "x".repeat(50_000) + "-->";
    const pageTooLate = "x".repeat(8000) + workshopPage("2", [["9", "nine"]]);
    fakeSteam({
      details: { 1: details("One"), 2: details("Two") },
      pages: { 1: page, 2: pageTooLate },
    });
    const { items } = await fetchSteamKnowledge(["1", "2"]);
    expect(items.get("1").requires).toEqual([]);
    expect(items.get("2").requires).toBeNull();
  });

  it("follows only https redirects on steamcommunity.com, at most 3", async () => {
    const page = (id) => workshopPage(id, [["77", "Seventy-seven"]]);
    const { calls } = fakeSteam({
      details: Object.fromEntries(["1", "2", "3", "4", "5", "6", "7", "8"].map((id) => [id, details(id)])),
      pages: {
        1: (url) =>
          url.includes("l=english")
            ? htmlResponse(page("1"))
            : redirectResponse("/sharedfiles/filedetails/?id=1&l=english"),
        2: () => redirectResponse("https://evil.example/sharedfiles/filedetails/?id=2"),
        3: () => redirectResponse("http://steamcommunity.com/sharedfiles/filedetails/?id=3", 301),
        4: () => redirectResponse("https://steamcommunity.com/sharedfiles/filedetails/?id=4&loop=1"),
        5: () => redirectResponse("https://steamcommunity.com.evil.example/x?id=5"),
        6: () => redirectResponse("https://steamcommunity.com:8443/sharedfiles/filedetails/?id=6"),
        7: (url) => {
          const hop = Number(new URL(url).searchParams.get("hop") || 0);
          return hop < 3
            ? redirectResponse(`https://steamcommunity.com/sharedfiles/filedetails/?id=7&hop=${hop + 1}`, 307)
            : htmlResponse(page("7"));
        },
        8: () => redirectResponse(null),
      },
    });

    const ids = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const { items, status } = await fetchSteamKnowledge(ids);

    expect(calls.other).toHaveLength(0);
    for (const call of calls.pages) {
      const u = new URL(call.url);
      expect(u.protocol).toBe("https:");
      expect(u.host).toBe("steamcommunity.com");
    }
    expect(items.get("1").requires).toEqual([{ workshopId: "77", title: "Seventy-seven" }]);
    expect(items.get("7").requires).toEqual([{ workshopId: "77", title: "Seventy-seven" }]);
    for (const id of ["2", "3", "4", "5", "6", "8"]) {
      expect(items.get(id).requires, id).toBeNull();
      expect(typeof items.get(id).failedAt, id).toBe("number");
    }
    expect(calls.pages.filter((c) => new URL(c.url).searchParams.get("id") === "4")).toHaveLength(4);
    expect(calls.pages.filter((c) => new URL(c.url).searchParams.get("id") === "7")).toHaveLength(4);
    expect(status.failed).toBe(true);
  });

  it("never runs more than `concurrency` page fetches at once", async () => {
    const ids = Array.from({ length: 14 }, (_, i) => String(300 + i));
    let inFlight = 0;
    let maxInFlight = 0;
    const pages = Object.fromEntries(
      ids.map((id) => [
        id,
        async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(15);
          inFlight--;
          return htmlResponse(workshopPage(id, []));
        },
      ]),
    );
    fakeSteam({ details: Object.fromEntries(ids.map((id) => [id, details(id)])), pages });
    const { status } = await fetchSteamKnowledge(ids);
    expect(status.known).toBe(14);
    expect(maxInFlight).toBeLessThanOrEqual(STEAM_KNOWLEDGE_LIMITS.concurrency);
    expect(maxInFlight).toBeGreaterThan(1);

    _resetSteamKnowledgeForTests();
    _setSteamKnowledgeLimitsForTests({ concurrency: 2 });
    fs.rmSync(STORE(), { force: true });
    maxInFlight = 0;
    await fetchSteamKnowledge(ids);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe("budget", () => {
  it("aborts requests still running at the deadline and starts none after it", async () => {
    const { calls } = fakeSteam({
      detailsHandler: (_u, init) => hanging(init.signal),
      pages: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
          String(i + 1),
          async (_u, init) => {
            await sleep(60);
            if (init.signal.aborted) throw new Error("aborted");
            return htmlResponse(workshopPage(String(i + 1), []));
          },
        ]),
      ),
    });
    _setSteamKnowledgeLimitsForTests({ concurrency: 1 });
    const ids = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const started = Date.now();
    const { status, items } = await fetchSteamKnowledge(ids, { budgetMs: 250 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    const pageCalls = calls.pages.length;
    expect(pageCalls).toBeGreaterThan(0);
    expect(pageCalls).toBeLessThan(20);
    expect(status.stale).toBe(true);
    // budget aborts are not Steam failures
    expect(status.failed).toBe(false);
    const withRequires = [...items.values()].filter((e) => e.requires !== null);
    expect(withRequires.length).toBeLessThanOrEqual(pageCalls);
    expect(items.size).toBe(withRequires.length);
    await sleep(200);
    expect(calls.pages.length).toBe(pageCalls);
  });

  it("returns at the deadline even when fetch ignores the abort signal", async () => {
    fakeSteam({
      detailsHandler: () => new Promise(() => {}),
      pages: { 1: () => new Promise(() => {}) },
    });
    const started = Date.now();
    const { status } = await fetchSteamKnowledge(["1"], { budgetMs: 100 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(status).toMatchObject({ source: "none", known: 0, total: 1, stale: true });
  });

  it("treats a per-request timeout as a failure", async () => {
    _setSteamKnowledgeLimitsForTests({ fetchTimeoutMs: 50 });
    fakeSteam({
      detailsHandler: (_u, init) => hanging(init.signal),
      pages: { 1: workshopPage("1", []) },
    });
    const { status, items } = await fetchSteamKnowledge(["1"], { budgetMs: 2000 });
    expect(status.failed).toBe(true);
    expect(items.get("1").detailsAt).toBeNull();
    expect(items.get("1").requires).toEqual([]);
  });
});

describe("details batches", () => {
  it("batches, cleans titles/tags and reads modIdOrder", async () => {
    _setSteamKnowledgeLimitsForTests({ detailsBatch: 2 });
    const manyTags = Array.from({ length: 40 }, (_, i) => ({ tag: `t${i}` }));
    const { calls } = fakeSteam({
      details: {
        1: {
          title: `  ${"T".repeat(300)}  `,
          tags: [
            { tag: " Build 42 " },
            { tag: "Build 42" },
            { tag: "" },
            { tag: "x".repeat(60) },
            { notag: 1 },
            null,
            { tag: 5 },
            { tag: "Map" },
          ],
          description: "[b]Mod ID:[/b] one\nMod ID: two",
        },
        2: { title: 42, tags: "nope", description: null },
        3: { title: "Three", tags: manyTags },
        4: { title: "Four" },
        5: { title: "Five" },
      },
      pages: Object.fromEntries(["1", "2", "3", "4", "5"].map((id) => [id, workshopPage(id, [])])),
    });
    const { items, status } = await fetchSteamKnowledge(["1", "2", "3", "4", "5"]);
    expect(calls.details).toHaveLength(3);
    expect(calls.details.map((c) => formIds(c.init.body))).toEqual([["1", "2"], ["3", "4"], ["5"]]);
    expect(new URLSearchParams(calls.details[0].init.body).get("itemcount")).toBe("2");
    expect(calls.details[0].init.headers["User-Agent"]).toBe("ZomboidControlPanel (+mod-insights)");
    const one = items.get("1");
    expect(one.title).toBe("T".repeat(STEAM_KNOWLEDGE_LIMITS.maxTitle));
    expect(one.tags).toEqual(["Build 42", "Map"]);
    expect(one.modIdOrder).toEqual(["one", "two"]);
    expect(items.get("2")).toMatchObject({ title: null, tags: [], modIdOrder: [] });
    expect(items.get("3").tags).toHaveLength(STEAM_KNOWLEDGE_LIMITS.maxTags);
    expect(status.failed).toBe(false);
  });

  it("marks result != 1 as failed and keeps older data", async () => {
    let removed = false;
    fakeSteam({
      detailsHandler: (_u, init) => {
        const ids = formIds(init.body);
        return jsonResponse({
          response: {
            publishedfiledetails: ids.map((id) =>
              removed && id === "1"
                ? { publishedfileid: id, result: 9 }
                : { publishedfileid: id, result: 1, title: `Title ${id}`, tags: [] },
            ),
          },
        });
      },
      pages: { 1: workshopPage("1", []), 2: workshopPage("2", []) },
    });
    const first = await fetchSteamKnowledge(["1", "2"]);
    expect(first.status.failed).toBe(false);
    const firstDetailsAt = first.items.get("1").detailsAt;

    removed = true;
    const second = await fetchSteamKnowledge(["1", "2"], { refresh: true });
    expect(second.status.failed).toBe(true);
    const one = second.items.get("1");
    expect(one.title).toBe("Title 1");
    expect(one.detailsAt).toBe(firstDetailsAt);
    expect(typeof one.failedAt).toBe("number");
    expect(second.items.get("2").failedAt).toBeNull();
  });

  it("never throws on HTTP errors, bad JSON, wrong shapes or a throwing fetch", async () => {
    fakeSteam({
      detailsHandler: () => htmlResponse("oops", 500),
      pages: { 1: () => new Response("{not json", { status: 200 }) },
    });
    let res = await fetchSteamKnowledge(["1"]);
    expect(res.status.failed).toBe(true);
    expect(res.status.source).toBe("none");

    _resetSteamKnowledgeForTests();
    fakeSteam({
      detailsHandler: () => new Response("{not json", { status: 200 }),
      pages: { 1: workshopPage("1", []) },
    });
    res = await fetchSteamKnowledge(["1"]);
    expect(res.status.failed).toBe(true);
    expect(res.items.get("1").requires).toEqual([]);

    _resetSteamKnowledgeForTests();
    fakeSteam({
      detailsHandler: () => jsonResponse({ response: { publishedfiledetails: "nope" } }),
      pages: { 1: workshopPage("1", []) },
    });
    res = await fetchSteamKnowledge(["1"]);
    expect(res.status.failed).toBe(true);

    _resetSteamKnowledgeForTests();
    vi.stubGlobal("fetch", () => {
      throw new Error("sync boom");
    });
    res = await fetchSteamKnowledge(["1"]);
    expect(res.status.failed).toBe(true);
    expect(res.status.known).toBe(0);

    apiKeyMock.mockRejectedValue(new Error("db down"));
    res = await fetchSteamKnowledge(["1"]);
    expect(res.status).toMatchObject({ total: 1 });
  });
});

describe("status, TTL and refresh", () => {
  it("ignores invalid ids and reports none for unknown ids", () => {
    const { items, status } = peekSteamKnowledge(["abc", "1234567890123456", "", 12, null, "12"]);
    expect(items.size).toBe(0);
    expect(status).toEqual({
      source: "none",
      fetchedAt: null,
      stale: true,
      failed: false,
      pending: false,
      known: 0,
      total: 1,
    });
    expect(peekSteamKnowledge(null).status.total).toBe(0);
    expect(peekSteamKnowledge([]).status.stale).toBe(false);
  });

  it("goes stale after ttlMs and refetches only then", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-20T08:00:00Z").getTime();
    vi.setSystemTime(t0);
    const { calls } = fakeSteam({
      details: { 1: details("One") },
      pages: { 1: workshopPage("1", []) },
    });
    let res = await fetchSteamKnowledge(["1"]);
    expect(res.status.stale).toBe(false);
    expect(res.status.fetchedAt).toBe(new Date(t0).toISOString());
    expect(calls.details).toHaveLength(1);

    vi.setSystemTime(t0 + STEAM_KNOWLEDGE_LIMITS.ttlMs - 1000);
    res = await fetchSteamKnowledge(["1"]);
    expect(calls.details).toHaveLength(1);
    expect(calls.pages).toHaveLength(1);
    expect(peekSteamKnowledge(["1"]).status.stale).toBe(false);

    vi.setSystemTime(t0 + STEAM_KNOWLEDGE_LIMITS.ttlMs + 1000);
    expect(peekSteamKnowledge(["1"]).status.stale).toBe(true);
    res = await fetchSteamKnowledge(["1"]);
    expect(calls.details).toHaveLength(2);
    expect(calls.pages).toHaveLength(2);
    expect(res.status.stale).toBe(false);
  });

  it("only fetches the stale half of an entry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T08:00:00Z"));
    let pageOk = false;
    const { calls } = fakeSteam({
      details: { 1: details("One") },
      pages: { 1: () => (pageOk ? htmlResponse(workshopPage("1", [])) : htmlResponse("x", 500)) },
    });
    let res = await fetchSteamKnowledge(["1"]);
    expect(res.status.stale).toBe(true);
    expect(res.status.known).toBe(1);
    pageOk = true;
    res = await fetchSteamKnowledge(["1"]);
    expect(calls.details).toHaveLength(1);
    expect(calls.pages).toHaveLength(2);
    expect(res.status).toMatchObject({ stale: false, failed: false });
  });

  it("rate-limits refresh and fetches nothing, not even missing ids, when limited", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-20T08:00:00Z").getTime();
    vi.setSystemTime(t0);
    const { calls } = fakeSteam({
      details: { 1: details("One"), 2: details("Two") },
      pages: { 1: workshopPage("1", []), 2: workshopPage("2", []) },
    });
    let res = await fetchSteamKnowledge(["1"], { refresh: true });
    expect(res.status.rateLimited).toBeUndefined();
    expect(calls.details).toHaveLength(1);

    vi.setSystemTime(t0 + 30_000);
    res = await fetchSteamKnowledge(["1", "2"], { refresh: true });
    expect(res.status.rateLimited).toBe(true);
    expect(res.status).toMatchObject({ known: 1, total: 2, stale: true });
    expect(calls.details).toHaveLength(1);
    expect(calls.pages).toHaveLength(1);

    // a plain fetch is not rate-limited
    res = await fetchSteamKnowledge(["2"]);
    expect(res.status.rateLimited).toBeUndefined();
    expect(res.items.get("2").title).toBe("Two");

    vi.setSystemTime(t0 + STEAM_KNOWLEDGE_LIMITS.refreshMinIntervalMs + 1);
    res = await fetchSteamKnowledge(["1", "2"], { refresh: true });
    expect(res.status.rateLimited).toBeUndefined();
    expect(formIds(calls.details.at(-1).init.body)).toEqual(["1", "2"]);
  });
});

describe("startSteamKnowledgeFill", () => {
  it("runs one fill at a time and reports pending", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const { calls } = fakeSteam({
      detailsHandler: async (_u, init) => {
        await gate;
        const ids = formIds(init.body);
        return jsonResponse({
          response: { publishedfiledetails: ids.map((id) => ({ publishedfileid: id, result: 1, title: `T${id}` })) },
        });
      },
      pages: { 1: workshopPage("1", []), 2: workshopPage("2", []) },
    });
    expect(startSteamKnowledgeFill(["1", "2", "bogus"])).toBe(true);
    expect(startSteamKnowledgeFill(["1", "2"])).toBe(false);
    expect(startSteamKnowledgeFill(["3"])).toBe(false);
    expect(peekSteamKnowledge(["1"]).status.pending).toBe(true);

    // an explicit fetch waits for the running fill instead of asking twice
    const explicit = fetchSteamKnowledge(["1", "2"]);
    await sleep(20);
    release();
    const res = await explicit;
    expect(res.status).toMatchObject({ known: 2, stale: false, pending: false });
    expect(calls.details).toHaveLength(1);

    await flushSteamKnowledge();
    expect(peekSteamKnowledge(["1", "2"]).status).toMatchObject({ pending: false, known: 2 });
    expect(startSteamKnowledgeFill(["1", "2"])).toBe(false);
  });

  it("swallows errors and does not retry recently failed ids", async () => {
    fakeSteam({
      detailsHandler: () => {
        throw new Error("offline");
      },
      pages: { 1: () => Promise.reject(new Error("offline")) },
    });
    expect(startSteamKnowledgeFill(["1"])).toBe(true);
    await flushSteamKnowledge();
    const { status, items } = peekSteamKnowledge(["1"]);
    expect(status).toMatchObject({ failed: true, pending: false, known: 0 });
    expect(typeof items.get("1").failedAt).toBe("number");
    expect(startSteamKnowledgeFill(["1"])).toBe(false);
    // an explicit fetch still tries
    const res = await fetchSteamKnowledge(["1"]);
    expect(res.status.failed).toBe(true);
  });
});

// ─── Cache, LRU and persistence ─────────────────────────────────────────────

describe("cache and persistence", () => {
  it("evicts the least recently used entries over maxItems", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = new Date("2026-10-20T08:00:00Z").getTime();
    vi.setSystemTime(now);
    _setSteamKnowledgeLimitsForTests({ maxItems: 3 });
    const ids = ["1", "2", "3", "4"];
    fakeSteam({
      details: Object.fromEntries(ids.map((id) => [id, details(`T${id}`)])),
      pages: Object.fromEntries(ids.map((id) => [id, workshopPage(id, [])])),
    });
    for (const id of ["1", "2", "3"]) {
      await fetchSteamKnowledge([id]);
      now += 1000;
      vi.setSystemTime(now);
    }
    peekSteamKnowledge(["1"]); // 1 is now more recent than 2
    now += 1000;
    vi.setSystemTime(now);
    await fetchSteamKnowledge(["4"]);
    const { items } = peekSteamKnowledge(ids);
    expect([...items.keys()].sort()).toEqual(["1", "3", "4"]);
  });

  it("persists, and a fresh start reads it back", async () => {
    apiKeyMock.mockResolvedValue(API_KEY);
    fakeSteam({
      details: { 1: details("One", { description: "Mod ID: one" }), 2: details("Two") },
      children: { 1: [{ publishedfileid: "2", file_type: 0 }], 2: [] },
    });
    const fetched = await fetchSteamKnowledge(["1", "2"]);
    await flushSteamKnowledge();
    const stored = JSON.parse(fs.readFileSync(STORE(), "utf-8"));
    expect(stored.schema).toBe(1);
    expect(stored.items).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain(API_KEY);

    _resetSteamKnowledgeForTests();
    const fetchSpy = vi.fn(() => {
      throw new Error("no network in a peek");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { items, status } = peekSteamKnowledge(["1", "2"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const one = items.get("1");
    expect(one).toMatchObject({
      workshopId: "1",
      title: "One",
      tags: ["Build 42"],
      requires: [{ workshopId: "2", title: null }],
      requiresSource: "api",
      modIdOrder: ["one"],
      detailsAt: fetched.items.get("1").detailsAt,
    });
    expect(status).toMatchObject({ known: 2, total: 2, stale: false, source: "api" });
  });

  it("starts empty on a corrupt or foreign store", () => {
    fs.writeFileSync(STORE(), "{not json");
    expect(peekSteamKnowledge(["1"]).status).toMatchObject({ known: 0, source: "none" });

    _resetSteamKnowledgeForTests();
    fs.writeFileSync(STORE(), JSON.stringify({ schema: 2, items: [{ workshopId: "1", detailsAt: 1 }] }));
    expect(peekSteamKnowledge(["1"]).items.size).toBe(0);

    _resetSteamKnowledgeForTests();
    fs.writeFileSync(STORE(), JSON.stringify([1, 2, 3]));
    expect(peekSteamKnowledge(["1"]).items.size).toBe(0);
  });

  it("validates every persisted entry strictly", () => {
    const now = Date.now();
    fs.writeFileSync(
      STORE(),
      JSON.stringify({
        schema: 1,
        items: [
          null,
          "x",
          [1],
          { workshopId: "12a", detailsAt: now },
          { workshopId: 5, detailsAt: now },
          { workshopId: "6", usedAt: now },
          {
            workshopId: "1",
            title: `  ${"y".repeat(400)}`,
            tags: ["ok", 3, "", "z".repeat(80), "ok"],
            requires: [
              { workshopId: "2", title: "Two" },
              { workshopId: "1", title: "self" },
              { workshopId: "bad" },
              "3",
              { workshopId: "2", title: "dup" },
              { workshopId: "4", title: { evil: true } },
            ],
            requiresSource: "evil",
            modIdOrder: ["good", "bad id", 7, "good"],
            detailsAt: now,
            requiresAt: now,
            failedAt: "yesterday",
            usedAt: "soon",
            extra: "dropped",
          },
          {
            workshopId: "3",
            title: "No details time",
            tags: "nope",
            requires: "nope",
            requiresAt: now,
            detailsAt: null,
            failedAt: now,
            usedAt: now,
          },
        ],
      }),
    );
    const { items } = peekSteamKnowledge(["1", "3", "6", "12"]);
    expect([...items.keys()].sort()).toEqual(["1", "3"]);
    const one = items.get("1");
    expect(one.title).toHaveLength(STEAM_KNOWLEDGE_LIMITS.maxTitle);
    expect(one.tags).toEqual(["ok"]);
    expect(one.requires).toEqual([
      { workshopId: "2", title: "Two" },
      { workshopId: "4", title: null },
    ]);
    expect(one.requiresSource).toBeNull();
    expect(one.modIdOrder).toEqual(["good"]);
    expect(one.failedAt).toBeNull();
    expect(one).not.toHaveProperty("extra");
    const three = items.get("3");
    expect(three).toMatchObject({ title: null, tags: [], requires: null, requiresAt: null, failedAt: now });
  });

  it("keeps only the most recently used maxItems on load", () => {
    const now = Date.now();
    fs.writeFileSync(
      STORE(),
      JSON.stringify({
        schema: 1,
        items: ["1", "2", "3", "4", "5"].map((id, i) => ({
          workshopId: id,
          title: id,
          tags: [],
          requires: [],
          requiresSource: "page",
          modIdOrder: [],
          detailsAt: now,
          requiresAt: now,
          failedAt: null,
          usedAt: now - 10_000 + i * 1000,
        })),
      }),
    );
    _setSteamKnowledgeLimitsForTests({ maxItems: 2 });
    const { items } = peekSteamKnowledge(["1", "2", "3", "4", "5"]);
    expect([...items.keys()].sort()).toEqual(["4", "5"]);
  });

  it("returns copies, so callers cannot change the cache", async () => {
    fakeSteam({ details: { 1: details("One") }, pages: { 1: workshopPage("1", [["2", "Two"]]) } });
    const { items } = await fetchSteamKnowledge(["1"]);
    items.get("1").requires.push({ workshopId: "666", title: "x" });
    items.get("1").tags.push("x");
    const again = peekSteamKnowledge(["1"]).items.get("1");
    expect(again.requires).toEqual([{ workshopId: "2", title: "Two" }]);
    expect(again.tags).toEqual(["Build 42"]);
  });
});
