import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { UNPUBLISHED_WORKSHOP_RELEASE } from "./helpers/workshopRelease.js";

// Issue #235: with the bridge delivered through the Steam Workshop, a new
// PanelBridge version never triggered the mod-update restart. Steam's public
// GetPublishedFileDetails answers result 9 ("not found") for the item (it is
// unlisted), so the check that sees every other Workshop mod had no time for
// it. The item's public change-note page does list its updates, each note's id
// being the Unix time it was made: that time now stands in, with a slack
// because Steam stamps the note a little after the content (34 s for 1.7.75),
// so the copy the server downloaded is not forever "older" than its own note.

const BRIDGE_ID = "3809901056";
const OTHER_ID = "2169435993";
const NOTE_TIME = 1791766354; // the real 1.7.75 note

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
const getTrackedMods = vi.fn(async () => []);
vi.mock("../database/init.js", () => ({
  getTrackedMods,
  updateModTimestamp: vi.fn(),
  logServerEvent: vi.fn(),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(),
  addTrackedMod: vi.fn(),
  getActiveServer: vi.fn(async () => null),
  isModIgnored: vi.fn(async () => false),
  markModsChecked: vi.fn(),
}));

const {
  ModChecker,
  newestChangeNoteTime,
  steamUpdateTimeFor,
  BRIDGE_NOTE_SLACK_SECONDS,
} = await import("../services/modChecker.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");

function changelogPage(noteTimes) {
  const blocks = noteTimes
    .map(
      (time) => `<div class="detailBox workshopAnnouncement noFooter changeLogCtn">
<div class="changelog headline">
Update: 11 Oct @ 5:52pm						</div>
<div class="changelog author">by <a href="https://steamcommunity.com/id/someone">Someone</a></div>
<p id="${time}">v1.7.75 Changes:<br>- Fix: something</p>
</div>`,
    )
    .join("\n");
  return `<html><body><div class="workshopBrowsePagingInfo">Showing entries</div>${blocks}</body></html>`;
}

// Steam's public API: the bridge item is "not found", everything else answers.
function stubSteam({ page, pageStatus = 200, apiFails = false, notes = [NOTE_TIME] } = {}) {
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes("/sharedfiles/filedetails/changelog/")) {
      if (page instanceof Error) throw page;
      return { ok: pageStatus === 200, status: pageStatus, text: async () => page ?? changelogPage(notes) };
    }
    if (apiFails) throw new Error("socket hang up");
    return {
      ok: true,
      json: async () => ({
        response: {
          publishedfiledetails: [
            { publishedfileid: BRIDGE_ID, result: 9 },
            { publishedfileid: OTHER_ID, result: 1, time_updated: 1700000000, title: "Other mod" },
          ],
        },
      }),
    };
  });
}

let originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
  vi.stubGlobal("PANEL_BRIDGE_WORKSHOP_JSON", UNPUBLISHED_WORKSHOP_RELEASE);
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", BRIDGE_ID);
  _resetWorkshopReleaseCacheForTests();
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetWorkshopReleaseCacheForTests();
});

describe("newestChangeNoteTime()", () => {
  it("returns the newest note's time", () => {
    expect(newestChangeNoteTime(changelogPage([1791481624, NOTE_TIME, 1791378439]))).toBe(NOTE_TIME);
  });

  it("is null for a page without notes, an empty page and non-text", () => {
    expect(newestChangeNoteTime("<html>nothing here</html>")).toBeNull();
    expect(newestChangeNoteTime("")).toBeNull();
    expect(newestChangeNoteTime(undefined)).toBeNull();
  });

  it("ignores a time in the future and a paragraph id outside a change note", () => {
    const now = 1791800000;
    expect(newestChangeNoteTime(changelogPage([NOTE_TIME, now + 10 * 86400]), now)).toBe(NOTE_TIME);
    expect(newestChangeNoteTime(`<p id="1791999999">not a note</p>${changelogPage([NOTE_TIME])}`, now)).toBe(NOTE_TIME);
  });
});

describe("fetchSteamTimestamps(): the bridge item's time comes from its change notes", () => {
  it("adds the item with the note's time and the slack, and still lists it as unavailable", async () => {
    stubSteam();
    const checker = new ModChecker();
    const result = await checker.fetchSteamTimestamps([BRIDGE_ID, OTHER_ID]);

    expect(result.get(BRIDGE_ID)).toMatchObject({ time_updated: NOTE_TIME, slackSeconds: BRIDGE_NOTE_SLACK_SECONDS });
    expect(result.get(OTHER_ID).time_updated).toBe(1700000000);
    expect(checker.lastUnavailableWorkshopIds.get(BRIDGE_ID)).toEqual({ resultCode: 9, reason: "removed" });
  });

  it("leaves the item out when its page can't be read", async () => {
    for (const options of [{ pageStatus: 503 }, { page: new Error("ENOTFOUND") }, { page: "<html></html>" }]) {
      stubSteam(options);
      const result = await new ModChecker().fetchSteamTimestamps([BRIDGE_ID, OTHER_ID]);
      expect(result.has(BRIDGE_ID)).toBe(false);
      expect(result.has(OTHER_ID)).toBe(true);
    }
  });

  it("does not read the page at all when Steam gave no answer (the ACF-only comparison runs instead)", async () => {
    stubSteam({ apiFails: true });
    const result = await new ModChecker().fetchSteamTimestamps([BRIDGE_ID]);
    expect(result.size).toBe(0);
    const urls = vi.mocked(global.fetch).mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("/changelog/"))).toBe(false);
  });

  it("only goes to the page for the bridge item, never for another mod Steam doesn't list", async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes("/changelog/")) return { ok: true, text: async () => changelogPage([NOTE_TIME]) };
      return {
        ok: true,
        json: async () => ({ response: { publishedfiledetails: [{ publishedfileid: OTHER_ID, result: 9 }] } }),
      };
    });
    const result = await new ModChecker().fetchSteamTimestamps([OTHER_ID]);
    expect(result.size).toBe(0);
    const urls = vi.mocked(global.fetch).mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("/changelog/"))).toBe(false);
  });
});

describe("steamUpdateTimeFor()", () => {
  it("subtracts a slack only where the entry carries one", () => {
    expect(steamUpdateTimeFor({ time_updated: 5000 })).toBe(5000);
    expect(steamUpdateTimeFor({ time_updated: 5000, slackSeconds: 600 })).toBe(4400);
    expect(steamUpdateTimeFor(undefined)).toBe(0);
  });
});

describe("checkForUpdates(): a new PanelBridge version is reported like any other mod update", () => {
  let tempRoot;
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "modchecker-bridge-"));
    getTrackedMods.mockReset().mockResolvedValue([
      { workshop_id: BRIDGE_ID, name: "Zomboid Control Panel Bridge" },
      { workshop_id: OTHER_ID, name: "Other mod" },
    ]);
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function checkerWithLocalCopy(bridgeLocalTime) {
    const acfPath = path.join(tempRoot, "appworkshop_108600.acf");
    const entry = (id, time) => `\t\t"${id}"\n\t\t{\n\t\t\t"size"\t\t"1234"\n\t\t\t"timeupdated"\t\t"${time}"\n\t\t}`;
    fs.writeFileSync(
      acfPath,
      `"AppWorkshop"\n{\n\t"appid"\t\t"108600"\n\t"WorkshopItemsInstalled"\n\t{\n${entry(BRIDGE_ID, bridgeLocalTime)}\n${entry(OTHER_ID, 1700000000)}\n\t}\n}\n`,
    );
    const checker = new ModChecker();
    checker.workshopAcfPath = acfPath;
    return checker;
  }

  it("reports the bridge when its latest note is newer than the copy the server has", async () => {
    stubSteam();
    // 1.7.74's time: the server never restarted to pick up 1.7.75.
    const result = await checkerWithLocalCopy(1791481624).checkForUpdates();

    expect(result.mods.map((m) => m.workshopId)).toEqual([BRIDGE_ID]);
    expect(result.mods[0].latestTimestamp.getTime()).toBe(NOTE_TIME * 1000);
  });

  it("does not report it once the server has the new copy, although the note is stamped 34 s after the content", async () => {
    stubSteam();
    const result = await checkerWithLocalCopy(1791766320).checkForUpdates();
    expect(result.mods).toEqual([]);
  });

  it("does not report it when the local copy is within the slack of the note, and does beyond it", async () => {
    stubSteam();
    expect((await checkerWithLocalCopy(NOTE_TIME - BRIDGE_NOTE_SLACK_SECONDS + 5).checkForUpdates()).mods).toEqual([]);
    const beyond = await checkerWithLocalCopy(NOTE_TIME - BRIDGE_NOTE_SLACK_SECONDS - 5).checkForUpdates();
    expect(beyond.mods.map((m) => m.workshopId)).toEqual([BRIDGE_ID]);
  });

  it("marks the bridge as checked now that it has a time", async () => {
    stubSteam();
    const { markModsChecked } = await import("../database/init.js");
    await checkerWithLocalCopy(1791481624).checkForUpdates();
    const checked = vi.mocked(markModsChecked).mock.calls.at(-1)[0];
    expect(checked.has(BRIDGE_ID)).toBe(true);
  });
});
