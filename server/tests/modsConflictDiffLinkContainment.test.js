import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRouteRunner, makeServerFixture } from "./helpers/modsRouteHarness.js";

// Security audit 2026-10-20: GET /api/mods/conflicts/diff checked the
// requested path lexically (resolved inside the mod's media/ folder) and then
// read it, following any symlink or junction on the way, while the scan's own
// walkDir() refuses a link that leaves the media tree. The diff now applies
// the same rule: the real file must be inside the real media folder.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");
const runRoute = createRouteRunner(router);

function writeMedia(modDir, relFile, content) {
  const target = path.join(modDir, "media", relFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe("conflict diff follows no link out of a mod's media folder", () => {
  let fx;
  let modA;
  let modB;
  let outside;

  beforeEach(() => {
    fx = makeServerFixture({
      prefix: "mods-diff-links-",
      ini: "Mods=ModOne;ModTwo\nWorkshopItems=1111111111;2222222222\n",
    });
    modA = fx.writeMod("1111111111", "ModOne", "name=Mod One\nid=ModOne\n");
    modB = fx.writeMod("2222222222", "ModTwo", "name=Mod Two\nid=ModTwo\n");
    writeMedia(modA, "lua/shared/a.lua", "print('one')\n");
    writeMedia(modB, "lua/shared/a.lua", "print('two')\n");
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "mods-diff-outside-"));
    fs.mkdirSync(path.join(outside, "shared"), { recursive: true });
    fs.writeFileSync(path.join(outside, "shared", "secret.lua"), "TOP-SECRET = 1\n");
    getActiveServer.mockReset().mockResolvedValue(fx.activeServer);
  });

  afterEach(() => {
    fx.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const diff = (file) => runRoute("/conflicts/diff", "get", { query: { file, modA: "ModOne", modB: "ModTwo" } });

  it("still diffs two real files", async () => {
    const res = await diff("lua/shared/a.lua");
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({ type: "text" });
  });

  it("refuses a file reached through a junction to a folder outside the media tree", async () => {
    // Mod One's lua/ is a junction to a folder outside; Mod Two has a real
    // file at the same relative path.
    fs.rmSync(path.join(modA, "media", "lua"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(modA, "media", "lua"), "junction");
    writeMedia(modB, "lua/shared/secret.lua", "harmless = 1\n");

    const res = await diff("lua/shared/secret.lua");
    expect(res.getStatusCode()).toBe(404);
    expect(JSON.stringify(res.getBody())).not.toContain("TOP-SECRET");
  });

  it("refuses a symbolic link to a file outside", async (ctx) => {
    const link = path.join(modA, "media", "lua", "shared", "linked.lua");
    try {
      fs.symlinkSync(path.join(outside, "shared", "secret.lua"), link, "file");
    } catch (error) {
      if (error.code === "EPERM") return ctx.skip(); // Windows without Developer Mode
      throw error;
    }
    writeMedia(modB, "lua/shared/linked.lua", "harmless = 1\n");
    const res = await diff("lua/shared/linked.lua");
    expect(res.getStatusCode()).toBe(404);
    expect(JSON.stringify(res.getBody())).not.toContain("TOP-SECRET");
  });

  it("allows a link that stays inside the media tree, as the scan does", async () => {
    fs.mkdirSync(path.join(modA, "media", "lua", "client"), { recursive: true });
    fs.symlinkSync(path.join(modA, "media", "lua", "shared"), path.join(modA, "media", "lua", "client", "alias"), "junction");
    writeMedia(modB, "lua/client/alias/a.lua", "print('two')\n");
    const res = await diff("lua/client/alias/a.lua");
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({ type: "text" });
  });

  it("refuses a folder named like a file", async () => {
    writeMedia(modA, "lua/shared/dir.lua/x.txt", "x");
    writeMedia(modB, "lua/shared/dir.lua/x.txt", "x");
    const res = await diff("lua/shared/dir.lua");
    expect(res.getStatusCode()).toBe(404);
  });
});
