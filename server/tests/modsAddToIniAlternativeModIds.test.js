import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// continuous-bug-hunt round 27 (mod load order / Workshop collection
// import): a single workshop item's mod.info can declare several `id=`
// lines (getModDetailsFromWorkshop's own comment/parsing -- confirmed by
// this test's own fixture). POST /add-to-ini -- the route the Mods page
// actually calls for every ordinary "add a mod by workshop ID" action
// (Mods.tsx's addToIni, called with no explicit modId) -- only ever
// auto-enabled the FIRST declared id in Mods=, via findModIdFromWorkshop's
// own documented "return the first ID found (legacy behavior)". The other
// declared ids were never reported anywhere: WorkshopItems= (content
// downloaded/tracked) and Mods= (content enabled) silently drifted out of
// step for every bundled mod beyond the first, with the operator given no
// signal any of it happened. The sibling /sync-mod-ids route already solved
// this correctly (auto-enable the default, report the rest as
// `alternativeModIds`/`alternatives`) -- this brings /add-to-ini in line
// with that same, already-established pattern.

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

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

describe("POST /add-to-ini: a multi-id workshop item reports its extra mod ids instead of discarding them", () => {
  let dataRoot;
  let installPath;
  const WORKSHOP_ID = "4444444444";

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-add-to-ini-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(path.join(configPath, "TestServer.ini"), "Mods=\nWorkshopItems=\n");

    installPath = path.join(dataRoot, "install");
    const modDir = path.join(
      installPath,
      "steamapps",
      "workshop",
      "content",
      "108600",
      WORKSHOP_ID,
      "mods",
      "BundledPack",
    );
    fs.mkdirSync(modDir, { recursive: true });
    // A single mod.info declaring THREE separate mods (a real, documented
    // authoring pattern -- see getModDetailsFromWorkshop's own comment).
    fs.writeFileSync(
      path.join(modDir, "mod.info"),
      ["name=Bundled Pack", "id=BundledCore", "id=BundledExtraOne", "id=BundledExtraTwo", ""].join("\n"),
    );

    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      installPath,
      isRemote: false,
    });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("enables the first declared id and reports the other two as alternativeModIds", async () => {
    const res = await runRoute("/add-to-ini", "post", {
      body: { workshopId: WORKSHOP_ID },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    expect(body.modId).toBe("BundledCore");
    expect(body.alternativeModIds).toEqual(["BundledExtraOne", "BundledExtraTwo"]);

    const iniContent = fs.readFileSync(
      path.join(dataRoot, "Server", "TestServer.ini"),
      "utf-8",
    );
    const modsLine = iniContent.match(/^Mods=(.*)$/m)?.[1] || "";
    expect(modsLine).toBe("BundledCore");
    expect(modsLine).not.toContain("BundledExtraOne");
    expect(modsLine).not.toContain("BundledExtraTwo");
    const workshopLine = iniContent.match(/^WorkshopItems=(.*)$/m)?.[1] || "";
    expect(workshopLine).toBe(WORKSHOP_ID);
  });

  it("reports an empty alternativeModIds array when the workshop item declares only one mod id", async () => {
    // Overwrite the fixture with a single-id mod.info.
    const modDir = path.join(
      installPath,
      "steamapps",
      "workshop",
      "content",
      "108600",
      WORKSHOP_ID,
      "mods",
      "BundledPack",
    );
    fs.writeFileSync(path.join(modDir, "mod.info"), ["name=Solo Mod", "id=SoloModId", ""].join("\n"));

    const res = await runRoute("/add-to-ini", "post", {
      body: { workshopId: WORKSHOP_ID },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.modId).toBe("SoloModId");
    expect(body.alternativeModIds).toEqual([]);
  });
});
