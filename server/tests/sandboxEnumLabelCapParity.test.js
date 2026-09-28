import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// getAllSandboxOptions (PanelBridge.lua) reads at most `cap` labels per enum,
// and Mod Settings (client/src/pages/ServerConfig.tsx, BRIDGE_ENUM_LABEL_CAP)
// uses the same number to tell a current bridge from an old one: fewer labels
// than min(max, cap) means the old Lua is still running, and the enum's last
// value is held back. If the Lua cap dropped below the client's, every current
// bridge with more values than the new cap would look old and lose its last
// value in the panel. Nothing compiles one against the other, so pin them.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const LUA = path.join(repoRoot, "pz-mod", "PanelBridge", "media", "lua", "server", "PanelBridge.lua");
const TSX = path.join(repoRoot, "client", "src", "pages", "ServerConfig.tsx");

function luaEnumLabelCaps(source) {
  const start = source.indexOf("handlers.getAllSandboxOptions = function");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\nhandlers.", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);
  return [...body.matchAll(/math\.min\(\s*numVals\s*,\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
}

describe("enum label cap: PanelBridge.lua and Mod Settings agree", () => {
  it("uses the same cap on both sides", () => {
    const luaCaps = luaEnumLabelCaps(fs.readFileSync(LUA, "utf8"));
    const clientCaps = [...fs.readFileSync(TSX, "utf8").matchAll(/const BRIDGE_ENUM_LABEL_CAP = (\d+)\b/g)]
      .map((m) => Number(m[1]));

    // One declaration each, or the parse would be checking the wrong thing.
    expect(luaCaps).toHaveLength(1);
    expect(clientCaps).toHaveLength(1);
    expect(clientCaps[0]).toBe(luaCaps[0]);
  });
});
