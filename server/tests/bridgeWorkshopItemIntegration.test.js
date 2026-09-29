import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildWorkshopItem, ITEM_FILES } from "../../scripts/workshop/build-item.mjs";
import { detectBridgeOnDisk, detectWorkshopItem, listLooseBridgeFiles } from "../services/bridgeDisk.js";
import { loadPanelBridge } from "./helpers/panelBridgeLua.js";
import { BRIDGE_MOD_ID } from "../services/bridgeDeliveryContract.js";

// The Workshop item the packaging builds (scripts/workshop/build-item.mjs),
// the panel's disk detection (bridgeDisk.js) and the bridge's own delivery
// detection (PanelBridge.detectDelivery) were each written against the spec,
// not against each other. Here the real item is built from the repo's
// sources, laid out the way Steam downloads it next to a dedicated server
// (<install>/steamapps/workshop/content/108600/<id>/ holds the item's
// Contents/), and both detectors must recognise it.

const ID = "3712345678";

let root;
let installDir;
let itemFolder;

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else fs.copyFileSync(source, target);
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-workshop-item-"));
  installDir = path.join(root, "pzserver");
  fs.mkdirSync(path.join(installDir, "steamapps", "workshop"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "steamapps", "workshop", "appworkshop_108600.acf"), '"AppWorkshop"\n{\n}\n');
  const built = buildWorkshopItem({ outDir: path.join(root, "dist-workshop") });
  expect(built.written).toBe(true);
  itemFolder = path.join(installDir, "steamapps", "workshop", "content", "108600", ID);
  copyTree(path.join(built.itemDir, "Contents"), itemFolder);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function modInfoVersion() {
  const modInfo = fs.readFileSync(path.join(root, "dist-workshop", BRIDGE_MOD_ID, ...ITEM_FILES.modInfo.split("/")), "utf8");
  return /^modversion=(.+)$/m.exec(modInfo)[1].trim();
}

describe("the built Workshop item, downloaded next to a dedicated server", () => {
  it("is found by the panel's disk detection, with the version its mod.info declares", () => {
    expect(detectWorkshopItem(installDir, ID)).toEqual({ folder: itemFolder, version: modInfoVersion(), source: "candidate" });
    expect(detectBridgeOnDisk(installDir, ID)).toEqual({ loose: false, workshopItem: true });
  });

  it("is not mistaken for loose files in the game folder", () => {
    expect(listLooseBridgeFiles(installDir)).toEqual([]);
  });

  it("is not found under a different item id", () => {
    expect(detectWorkshopItem(installDir, "999")).toBeNull();
  });

  it("reports itself as Workshop-delivered with this id when its server Lua runs from there", () => {
    const serverLua = path.join(itemFolder, ...ITEM_FILES.serverLua.split("/").slice(1));
    expect(fs.existsSync(serverLua)).toBe(true);
    const lua = loadPanelBridge(serverLua, "", {
      filenameOfClosure: serverLua,
      activatedMods: [BRIDGE_MOD_ID],
      modInfo: { [BRIDGE_MOD_ID]: { modVersion: modInfoVersion(), workshopId: ID } },
    });
    lua.run("__DELIVERY = PanelBridgeModule.detectDelivery()");
    expect(lua.getGlobal("__DELIVERY")).toMatchObject({ method: "workshop", workshopId: ID, modActive: true });
  });

  it("ships Lua whose headers the leftover detection recognises if someone copies it loose", () => {
    for (const [itemFile, target] of [
      [ITEM_FILES.serverLua, "media/lua/server/PanelBridge.lua"],
      [ITEM_FILES.clientLua, "media/lua/client/PanelBridgeClient.lua"],
    ]) {
      const source = path.join(itemFolder, ...itemFile.split("/").slice(1));
      const loose = path.join(installDir, ...target.split("/"));
      fs.mkdirSync(path.dirname(loose), { recursive: true });
      fs.copyFileSync(source, loose);
    }
    expect(listLooseBridgeFiles(installDir).map(({ kind, recognized }) => ({ kind, recognized }))).toEqual(
      expect.arrayContaining([
        { kind: "server", recognized: true },
        { kind: "client", recognized: true },
      ]),
    );
  });
});
