import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildSandboxVarsCheck } from "../routes/debug.js";

// #197: Debug > Checks & Fixes counted braces only. A file the game can't
// load with balanced braces (a missing comma, an empty file, "SandboxVars =
// nil") showed as "SandboxVars present", while the dedicated server exits on
// boot when it reads it. The check now asks the same question as GET
// /sandbox/validate: does the file parse, and does it have a SandboxVars
// table?
describe("buildSandboxVarsCheck() (server.sandboxCorrupt / server.sandboxVars)", () => {
  let dir;
  let sbxPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sandbox-diag-"));
    sbxPath = path.join(dir, "MyServer_SandboxVars.lua");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes a file the game loads", async () => {
    fs.writeFileSync(sbxPath, "SandboxVars = {\n    VERSION = 6,\n    Zombies = 4,\n}\n");
    const check = await buildSandboxVarsCheck("MyServer", sbxPath);
    expect(check).toEqual(
      expect.objectContaining({ id: "server.sandboxVars", status: "ok", params: { serverName: "MyServer" } }),
    );
  });

  it("warns when the file is missing", async () => {
    const check = await buildSandboxVarsCheck("MyServer", sbxPath);
    expect(check).toEqual(expect.objectContaining({ id: "server.sandboxVars", status: "warn" }));
  });

  it("fails the #197 corruption, with the parser's reason", async () => {
    fs.writeFileSync(
      sbxPath,
      ["SandboxVars = {", "    Explosives = 1", "        LootMultiplier = 1.0,", "    },", "}", ""].join("\n"),
    );
    const check = await buildSandboxVarsCheck("MyServer", sbxPath);
    expect(check).toEqual(
      expect.objectContaining({
        id: "server.sandboxCorrupt",
        status: "fail",
        params: { serverName: "MyServer", detail: expect.stringMatching(/^line 3: '}' expected/) },
      }),
    );
    expect(check.message).toContain(check.params.detail);
  });

  it.each([
    ["a missing comma (balanced braces)", "SandboxVars = {\n    A = 1\n    B = 2,\n}\n", /^line 3: '}' expected/],
    ["an empty file", "", /^no 'SandboxVars = \{ \.\.\. \}' table found$/],
    ["SandboxVars = nil", "SandboxVars = nil\n", /^no 'SandboxVars = \{ \.\.\. \}' table found$/],
  ])("fails %s, which the game can't load either", async (_label, content, detail) => {
    fs.writeFileSync(sbxPath, content);
    const check = await buildSandboxVarsCheck("MyServer", sbxPath);
    expect(check).toEqual(
      expect.objectContaining({
        id: "server.sandboxCorrupt",
        status: "fail",
        params: { serverName: "MyServer", detail: expect.stringMatching(detail) },
      }),
    );
  });
});
