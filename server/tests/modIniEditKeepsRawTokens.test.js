import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// The game ignores every backslash in Mods= (it runs value.replace("\\", "")
// over the whole line before splitting), but a hand-written `Mods=\ModA;ModB`
// is the operator's file: adding a mod re-joined the normalized ids, so
// `Mods=\ModA;ModB;3519629457` + ModC became `Mods=ModA;ModB;3519629457;ModC`.
// Entries an add did not touch are now written back as they were typed.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getTrackedMods: vi.fn(async () => []),
  addTrackedMod: vi.fn(),
  removeTrackedMod: vi.fn(),
  clearModUpdates: vi.fn(),
  getModPresets: vi.fn(async () => []),
  createModPreset: vi.fn(),
  updateModPreset: vi.fn(),
  deleteModPreset: vi.fn(),
  addIgnoredMod: vi.fn(),
  getIgnoredMods: vi.fn(async () => []),
  removeIgnoredMod: vi.fn(),
  clearAllIgnoredMods: vi.fn(),
  isModIgnored: vi.fn(async () => false),
  getIgnoredModPairs: vi.fn(async () => []),
  addIgnoredModPair: vi.fn(),
  removeIgnoredModPair: vi.fn(),
}));

vi.mock("../services/workshopCollectionSync.js", () => ({
  getCollectionContents: vi.fn(),
  addItemToCollection: vi.fn(),
  removeItemFromCollection: vi.fn(),
  computeDiff: vi.fn(async () => ({ ok: true, inCollection: [], toAdd: [], toRemove: [], collectionOnly: [] })),
  syncSingleChange: vi.fn(async () => ({ skipped: true })),
  fetchPublishedFileTitles: vi.fn(async () => new Map()),
  getSteamSessionCredentials: vi.fn(async () => ({ sessionId: "", loginSecure: "" })),
  setSteamSessionCredentials: vi.fn(),
}));

const { getActiveServer, getTrackedMods } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const { addWorkshopItemToIni } = await import("../services/modIniEdit.js");
const { splitModIdList, splitModIdTokens } = await import("../utils/modIni.js");
const runRoute = createRouteRunner(router);

const WS_NEW = "4444444444";

describe("splitModIdTokens", () => {
  it("pairs the id the game reads with the token as written", () => {
    expect(splitModIdTokens("\\ModA; ModB ;3519629457;;\\;Mo\\dC")).toEqual([
      { raw: "\\ModA", id: "ModA" },
      { raw: "ModB", id: "ModB" },
      { raw: "3519629457", id: "3519629457" },
      { raw: "Mo\\dC", id: "ModC" },
    ]);
    expect(splitModIdTokens(undefined)).toEqual([]);
  });

  it("gives the same ids as splitModIdList", () => {
    const line = "\\ModA; ModB ;3519629457;;\\;Mo\\dC; \\ D ";
    expect(splitModIdTokens(line).map((entry) => entry.id)).toEqual(splitModIdList(line));
  });
});

describe("addWorkshopItemToIni keeps the Mods= entries it did not touch as they were written", () => {
  const add = (content, modIds, extra = {}) =>
    addWorkshopItemToIni(content, { workshopId: WS_NEW, modIds, ...extra });
  const modsLine = (content) => content.match(/^Mods=(.*)$/m)?.[1];

  it("keeps a backslash prefix (and a numeric entry that was already there) when a mod is added", () => {
    const result = add("Mods=\\ModA;ModB;3519629457\nWorkshopItems=\n", ["ModC"]);

    expect(modsLine(result.content)).toBe("\\ModA;ModB;3519629457;ModC");
    expect(result.addedModIds).toEqual(["ModC"]);
    expect(result.modCount).toBe(4);
  });

  it("keeps a prefix in the middle of an id, and drops only the padding", () => {
    const result = add("Mods= \\ModA ; Mo\\dB;ModC \nWorkshopItems=\n", ["ModD", "ModE"]);

    expect(modsLine(result.content)).toBe("\\ModA;Mo\\dB;ModC;ModD;ModE");
    expect(result.addedModIds).toEqual(["ModD", "ModE"]);
    expect(result.modCount).toBe(5);
  });

  it("counts an entry as there with or without its prefix: nothing is added, the line is left alone", () => {
    const content = "Mods=\\ModA;ModB\nWorkshopItems=\n";
    const result = add(content, ["ModA"]);

    expect(result.addedModIds).toEqual([]);
    // Only WorkshopItems= is written (the item itself was new).
    expect(result.content).toBe(`Mods=\\ModA;ModB\nWorkshopItems=${WS_NEW}\n`);
    expect(result.modCount).toBe(2);
  });

  it("writes only the new id plain when the line had no prefixes (unchanged behaviour)", () => {
    const result = add("Mods=ModA;ModB\nWorkshopItems=\n", ["ModC"]);

    expect(modsLine(result.content)).toBe("ModA;ModB;ModC");
  });

  it("creates the Mods= line when there is none", () => {
    const result = add("WorkshopItems=\n", ["ModC"]);

    expect(modsLine(result.content)).toBe("ModC");
    expect(result.modCount).toBe(1);
  });

  it("still refuses an added all-digit id that nothing on disk confirms, and leaves the prefixed line alone", () => {
    const content = "Mods=\\ModA\nWorkshopItems=\n";
    const result = add(content, ["3519629457"]);

    expect(result.addedModIds).toEqual([]);
    expect(modsLine(result.content)).toBe("\\ModA");
  });
});

describe("POST /add-to-ini keeps the backslash prefixes already in Mods=", () => {
  let fx;

  beforeEach(() => {
    fx = makeServerFixture({
      prefix: "mods-raw-tokens-",
      ini: "Mods=\\ModA;ModB;3519629457\nWorkshopItems=1111111111\nMap=Muldraugh, KY\n",
    });
    fx.writeMod(WS_NEW, "ModCFolder", "name=ModC\nid=ModC\n");
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
    getTrackedMods.mockReset().mockResolvedValue([]);
  });

  afterEach(() => fx.cleanup());

  it("adds the new mod after the untouched entries, prefix and all", async () => {
    const res = await runRoute("/add-to-ini", "post", { body: { workshopId: WS_NEW } });

    expect(res.getStatusCode()).toBe(200);
    expect(fx.iniValue("Mods")).toBe("\\ModA;ModB;3519629457;ModC");
    expect(fx.iniValue("WorkshopItems")).toBe(`1111111111;${WS_NEW}`);
  });
});
