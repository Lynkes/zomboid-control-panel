import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNPUBLISHED_WORKSHOP_RELEASE } from "./helpers/workshopRelease.js";

// The 42.21 live test: Steam's public GetPublishedFileDetails answered
// result 9 ("not found") for the PanelBridge Workshop item before and after a
// dedicated server downloaded it anonymously and started with it -- Steam's
// content check still held the new upload back. fetchSteamTimestamps() tags
// result 9 as "removed", and the Mods page lists every tracked "removed" id
// under "no longer exists on the Steam Workshop" with a remove button (the
// bridge's own id is tracked: the Mods page auto-tracks every WorkshopItems=
// entry). The bridge item is reported on Settings › PanelBridge instead, so
// the Mods page lists must leave it out -- while lastUnavailableWorkshopIds
// keeps it for that page to read.

const BRIDGE_ID = "3809901056";
const OTHER_ID = "2222222222";

const { warnCalls, mockLogger, activeServer } = vi.hoisted(() => {
  const warnCalls = [];
  return {
    warnCalls,
    mockLogger: { info: () => {}, warn: (msg) => warnCalls.push(msg), error: () => {}, debug: () => {} },
    activeServer: { value: null },
  };
});

vi.mock("../utils/logger.js", () => ({ createLogger: () => mockLogger }));
vi.mock("../database/init.js", () => ({
  getTrackedMods: vi.fn(async () => []),
  updateModTimestamp: vi.fn(),
  logServerEvent: vi.fn(),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(),
  addTrackedMod: vi.fn(),
  getActiveServer: vi.fn(async () => activeServer.value),
  isModIgnored: vi.fn(async () => false),
  markModsChecked: vi.fn(),
}));

const { ModChecker } = await import("../services/modChecker.js");
const { getTrackedMods } = await import("../database/init.js");
const { _resetWorkshopReleaseCacheForTests } = await import("../services/bridgeWorkshopRelease.js");

function steamAnswers(details) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ response: { publishedfiledetails: details } }),
  }));
}

function useRelease(id) {
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", id || "");
  _resetWorkshopReleaseCacheForTests();
}

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
  warnCalls.length = 0;
  activeServer.value = null;
  vi.stubGlobal("PANEL_BRIDGE_WORKSHOP_JSON", UNPUBLISHED_WORKSHOP_RELEASE);
  useRelease(BRIDGE_ID);
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetWorkshopReleaseCacheForTests();
});

describe("modChecker: PanelBridge's own Workshop item is never a removed mod", () => {
  it("leaves the bridge item off the Mods page's removed list, and keeps it for Settings › PanelBridge", async () => {
    steamAnswers([
      { publishedfileid: BRIDGE_ID, result: 9 },
      { publishedfileid: OTHER_ID, result: 9 },
    ]);
    const checker = new ModChecker();
    await checker.fetchSteamTimestamps([BRIDGE_ID, OTHER_ID]);
    getTrackedMods.mockResolvedValueOnce([{ workshop_id: BRIDGE_ID }, { workshop_id: OTHER_ID }]);

    const status = await checker.getStatus();
    expect(status.removedWorkshopIds).toEqual([OTHER_ID]);
    expect(checker.lastUnavailableWorkshopIds.get(BRIDGE_ID)).toEqual({ resultCode: 9, reason: "removed" });
  });

  it("doesn't name the bridge item in the \"no longer exist\" warning", async () => {
    steamAnswers([
      { publishedfileid: BRIDGE_ID, result: 9 },
      { publishedfileid: OTHER_ID, result: 9 },
    ]);
    await new ModChecker().fetchSteamTimestamps([BRIDGE_ID, OTHER_ID]);
    const removedWarnings = warnCalls.filter((msg) => /no longer exist/.test(msg));
    expect(removedWarnings).toHaveLength(1);
    expect(removedWarnings[0]).toContain(OTHER_ID);
    expect(removedWarnings[0]).not.toContain(BRIDGE_ID);

    warnCalls.length = 0;
    steamAnswers([{ publishedfileid: BRIDGE_ID, result: 9 }]);
    await new ModChecker().fetchSteamTimestamps([BRIDGE_ID]);
    expect(warnCalls.filter((msg) => /no longer exist/.test(msg))).toEqual([]);
  });

  it("leaves it off the unclassified list too", async () => {
    steamAnswers([{ publishedfileid: BRIDGE_ID, result: 15 }]);
    const checker = new ModChecker();
    await checker.fetchSteamTimestamps([BRIDGE_ID]);
    getTrackedMods.mockResolvedValueOnce([{ workshop_id: BRIDGE_ID }]);
    expect((await checker.getStatus()).unknownWorkshopIds).toEqual([]);
  });

  // A panel build that knows no item id keeps the one the server switched
  // with (bridgeDelivery.resolveEffectiveWorkshopId).
  it("also knows the item by the id the active server switched with", async () => {
    useRelease(null);
    activeServer.value = { id: "s1", bridgeDeliverySwitch: { to: "workshop", workshopId: BRIDGE_ID } };
    steamAnswers([{ publishedfileid: BRIDGE_ID, result: 9 }]);
    const checker = new ModChecker();
    await checker.fetchSteamTimestamps([BRIDGE_ID]);
    getTrackedMods.mockResolvedValueOnce([{ workshop_id: BRIDGE_ID }]);
    expect((await checker.getStatus()).removedWorkshopIds).toEqual([]);

    activeServer.value = null;
    getTrackedMods.mockResolvedValueOnce([{ workshop_id: BRIDGE_ID }]);
    expect((await checker.getStatus()).removedWorkshopIds).toEqual([BRIDGE_ID]);
  });
});
