import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// PanelBridge delivery rests on ONE loose-file writer: installBridge() in
// services/panelBridgeInstaller.js, called only from services/bridgeDelivery.js,
// which checks the game folder's delivery method first. Before this there
// were six independent writers (boot, activation, start/restart routes,
// auto-configure, two install routes, the setup wizard and quick setup),
// three version-compare rules between them, and none of them knew a server
// could get PanelBridge from the Steam Workshop -- any one of them writing a
// loose copy into a Workshop folder breaks every join once DoLuaChecksum is
// on. This scan fails the moment a seventh writer appears.
//
// "Near PanelBridge" means a CODE line (comments stripped) within 3 lines
// mentions PanelBridge: a real bridge writer always names the file in code
// (a "PanelBridge.lua" path segment), while an unrelated writer that merely
// has a comment about PanelBridge nearby (serverFiles.js's SandboxVars
// write, whose caller is the bridge) is not one.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, "..");

const LUA_WRITERS = new Set(["services/panelBridgeInstaller.js", "utils/embeddedLua.js"]);
const FILE_WRITERS = new Set(["services/panelBridgeInstaller.js", "utils/embeddedLua.js", "services/bridgeDisk.js"]);
const INSTALL_CALLERS = new Set(["services/panelBridgeInstaller.js", "services/bridgeDelivery.js"]);
const WRITE_CALL_RE = /\b(copyFileSync|writeFileSync|writeFileAtomic|writeAtomicText)\(/;

function listServerSources() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        if (name === "tests" || name === "node_modules") continue;
        walk(full);
      } else if (name.endsWith(".js")) {
        out.push(full);
      }
    }
  };
  walk(SERVER_DIR);
  return out;
}

// Drops /* */ blocks and // line comments. Deliberately simple: it only has
// to keep comment text from counting as a mention, and a "//" inside a
// string (a URL) cutting a line short can only hide text, never invent it.
function codeLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"));
}

const sources = listServerSources().map((file) => {
  const relative = path.relative(SERVER_DIR, file).split(path.sep).join("/");
  return { relative, lines: codeLines(fs.readFileSync(file, "utf8")) };
});

describe("PanelBridge single-writer gate", () => {
  it("scans the real server tree (sanity check)", () => {
    expect(sources.some((s) => s.relative === "services/panelBridgeInstaller.js")).toBe(true);
    expect(sources.some((s) => s.relative === "services/bridgeDelivery.js")).toBe(true);
    expect(sources.some((s) => s.relative.startsWith("tests/"))).toBe(false);
  });

  it("writeLuaAtomic( appears only in the installer and its own module", () => {
    const offenders = sources
      .filter((s) => !LUA_WRITERS.has(s.relative))
      .flatMap((s) => s.lines.map((line, i) => (/\bwriteLuaAtomic\(/.test(line) ? `${s.relative}:${i + 1}` : null)))
      .filter(Boolean);
    expect(offenders, `writeLuaAtomic called outside the installer: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no file write sits within 3 lines of PanelBridge outside the installer, embeddedLua and bridgeDisk", () => {
    const offenders = [];
    for (const source of sources) {
      if (FILE_WRITERS.has(source.relative)) continue;
      source.lines.forEach((line, index) => {
        if (!WRITE_CALL_RE.test(line)) return;
        const window = source.lines.slice(Math.max(0, index - 3), index + 4).join("\n");
        if (/PanelBridge/.test(window)) offenders.push(`${source.relative}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `possible PanelBridge file writers: \n${offenders.join("\n")}`).toEqual([]);
  });

  it("installBridge is used only by bridgeDelivery.js", () => {
    const offenders = sources
      .filter((s) => !INSTALL_CALLERS.has(s.relative))
      .filter((s) => s.lines.some((line) => /\binstallBridge\b/.test(line)))
      .map((s) => s.relative);
    expect(offenders, `installBridge referenced outside bridgeDelivery.js: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the gate itself catches a writer (positive control)", () => {
    const fake = codeLines('const target = path.join(dir, "PanelBridge.lua");\nfs.copyFileSync(src, target);');
    const hit = fake.some(
      (line, i) => WRITE_CALL_RE.test(line) && /PanelBridge/.test(fake.slice(Math.max(0, i - 3), i + 4).join("\n")),
    );
    expect(hit).toBe(true);
    const commentOnly = codeLines("// the caller (PanelBridge) needs this\nfs.writeFileSync(p, x);");
    expect(commentOnly.join("\n")).not.toMatch(/PanelBridge/);
  });
});
