import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { autoExportPlayer } from "../index.js";
import { getDataPaths } from "../utils/paths.js";
import { setSetting } from "../database/init.js";
import panelBridge from "../services/panelBridge.js";
import playersRouter from "../routes/players.js";
import {
  decodeExportFolderName,
  encodeExportFolderName,
  legacyExportFolderName,
} from "../utils/exportFolderName.js";

// BRIDGE-3 (security sweep): character export folders were named by
// squashing every character outside [a-zA-Z0-9_-] to "_", so "Bob 1" and
// "Bob_1" -- two valid, distinct Project Zomboid accounts -- shared
// exports/Bob_1/. The login auto-export keeps only the newest N files in
// its folder, so the repro's three logins as "Bob 1" deleted every one of
// "Bob_1"'s auto-exports and left "Bob 1"'s own files in their place,
// named Bob_1_<time>.json. Folders are now keyed by an injective encoding
// of the exact name (utils/exportFolderName.js).

describe("encodeExportFolderName() / decodeExportFolderName()", () => {
  it("gives every distinct name its own folder, letter case included", () => {
    const names = ["Bob 1", "Bob_1", "Bob!1", "bob_1", "BOB_1", "Bob\n1", "Élodie", "名前"];
    const folders = names.map(encodeExportFolderName);
    expect(new Set(folders).size).toBe(names.length);
    // Distinct even on a filesystem that ignores letter case.
    expect(new Set(folders.map((f) => f.toLowerCase())).size).toBe(names.length);
    for (const [i, folder] of folders.entries()) {
      expect(folder).toMatch(/^@[0-9a-f]+$/);
      expect(decodeExportFolderName(folder)).toBe(names[i]);
    }
  });

  it("has no folder for a name that can't be encoded faithfully", () => {
    expect(encodeExportFolderName("")).toBeNull();
    expect(encodeExportFolderName(undefined)).toBeNull();
    expect(encodeExportFolderName("a\uD800")).toBeNull(); // lone surrogate: same bytes as U+FFFD
    expect(encodeExportFolderName("x".repeat(121))).toBeNull();
    expect(encodeExportFolderName("x".repeat(120))).toHaveLength(241);
  });

  it("reads an old folder, or a non-canonical one, as nobody's", () => {
    expect(decodeExportFolderName("Bob_1")).toBeNull();
    expect(decodeExportFolderName("@426F62")).toBeNull(); // upper case
    expect(decodeExportFolderName("@ff")).toBeNull(); // not UTF-8
    expect(decodeExportFolderName("@")).toBeNull();
  });
});

function getHandler(method, routePath) {
  const layer = playersRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function runRoute(method, routePath, req) {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  await getHandler(method, routePath)({ query: {}, params: {}, ...req }, res);
  return res;
}

describe("auto-export folders: one player can't rotate out another's exports", () => {
  const exportsRoot = () => path.join(getDataPaths().dataDir, "exports");
  let clock;

  beforeEach(async () => {
    fs.rmSync(exportsRoot(), { recursive: true, force: true });
    await setSetting("autoExportMaxPerPlayer", 3);
    panelBridge.isRunning = true;
    vi.spyOn(panelBridge, "isModConnected").mockReturnValue(true);
    vi.spyOn(panelBridge, "sendCommand").mockImplementation(async (_cmd, { username }) => ({
      success: true,
      data: { username, owner: username === "Bob_1" ? "victim" : "attacker" },
    }));
    clock = Date.parse("2026-10-04T10:00:00.000Z");
    const realToISOString = Date.prototype.toISOString;
    vi.spyOn(Date.prototype, "toISOString").mockImplementation(function () {
      return realToISOString.call(new Date((clock += 60_000)));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    panelBridge.isRunning = false;
  });

  it("keeps every one of 'Bob_1''s auto-exports through three logins as 'Bob 1'", async () => {
    for (let i = 0; i < 3; i++) await autoExportPlayer("Bob_1");
    for (let i = 0; i < 3; i++) await autoExportPlayer("Bob 1");

    // Every export on disk, wherever it was written.
    const owners = { victim: 0, attacker: 0 };
    for (const folder of fs.readdirSync(exportsRoot())) {
      for (const file of fs.readdirSync(path.join(exportsRoot(), folder))) {
        owners[JSON.parse(fs.readFileSync(path.join(exportsRoot(), folder, file), "utf8")).owner] += 1;
      }
    }
    expect(owners).toEqual({ victim: 3, attacker: 3 });
    // Each in its own folder, and nothing under the old shared name.
    expect(fs.readdirSync(exportsRoot()).sort()).toEqual(
      [encodeExportFolderName("Bob 1"), encodeExportFolderName("Bob_1")].sort(),
    );
  });

  it("lists, downloads and deletes each player's exports by their exact name", async () => {
    await autoExportPlayer("Bob_1");
    await autoExportPlayer("Bob 1");
    // An export folder from before this change, under the old name.
    const legacyDir = path.join(exportsRoot(), legacyExportFolderName("Old One"));
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "Old_One_2026-01-01T00-00-00-000Z.json"), JSON.stringify({ owner: "legacy" }));

    const list = await runRoute("get", "/exports", {});
    const byUser = Object.fromEntries(list.body.exports.map((e) => [e.username, e.filename]));
    expect(Object.keys(byUser).sort()).toEqual(["Bob 1", "Bob_1", "Old_One"]);

    const victim = await runRoute("get", "/exports/:username/:filename", {
      params: { username: "Bob_1", filename: byUser.Bob_1 },
    });
    expect(victim.body.owner).toBe("victim");
    const attacker = await runRoute("get", "/exports/:username/:filename", {
      params: { username: "Bob 1", filename: byUser["Bob 1"] },
    });
    expect(attacker.body.owner).toBe("attacker");
    const legacy = await runRoute("get", "/exports/:username/:filename", {
      params: { username: "Old_One", filename: byUser.Old_One },
    });
    expect(legacy.body.owner).toBe("legacy");

    // "Bob 1" can't reach "Bob_1"'s file through the shared old name.
    const crossed = await runRoute("delete", "/exports/:username/:filename", {
      params: { username: "Bob 1", filename: byUser.Bob_1 },
    });
    expect(crossed.statusCode).toBe(404);
    const filtered = await runRoute("get", "/exports", { query: { username: "Bob 1" } });
    expect(filtered.body.exports.map((e) => e.username)).toEqual(["Bob 1"]);

    const deleted = await runRoute("delete", "/exports/:username/:filename", {
      params: { username: "Bob 1", filename: byUser["Bob 1"] },
    });
    expect(deleted.body).toEqual({ success: true });
    const after = await runRoute("get", "/exports", {});
    expect(after.body.exports.map((e) => e.username).sort()).toEqual(["Bob_1", "Old_One"]);
  });

  it("refuses a file name that could leave the folder", async () => {
    const res = await runRoute("get", "/exports/:username/:filename", {
      params: { username: "Bob 1", filename: "../../db.json" },
    });
    expect(res.statusCode).toBe(400);
  });
});
