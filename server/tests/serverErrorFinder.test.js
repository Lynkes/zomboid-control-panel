import { describe, expect, it } from "vitest";
import {
  findServerErrors,
  findingId,
  modByPath,
  buildModIndex,
  nextMemoryGb,
  normaliseMessage,
  parseEntry,
  redactLine,
} from "../utils/serverErrorFinder.js";

// The Diagnostics error finder reads the game's own log wording (42.21 jar
// constant pools and a real 42 DebugLog; see the module header). These
// fixtures copy that wording line for line.

const T = 1774895897563;
const at = (offset) => `f:0, t:${T + offset}, st:0`;

const MODS = [
  { id: "SpongiesClothing", name: "Spongie's Clothing", workshopId: "2833500000", folder: "SpongiesClothing", dir: "/srv/pz/steamapps/workshop/content/108600/2833500000/mods/SpongiesClothing", source: "workshop" },
  { id: "OrganizedCategories", name: "Organized Categories: Core", workshopId: "2900000001", folder: "OrgCat", dir: "/srv/pz/steamapps/workshop/content/108600/2900000001/mods/OrgCat", source: "workshop" },
  { id: "ZCPB", name: "Zomboid Control Panel Bridge", workshopId: "3712345678", folder: "PanelBridge", dir: "/srv/pz/steamapps/workshop/content/108600/3712345678/mods/PanelBridge", source: "workshop" },
  { id: "LocalThing", name: "Local Thing", workshopId: null, folder: "LocalThing", dir: "/home/pz/Zomboid/mods/LocalThing", source: "local" },
];
const ENABLED = ["SpongiesClothing", "OrganizedCategories", "ZCPB", "LocalThing"];
const SERVER = { id: 7, running: true, isRemote: false, memoryManaged: true, maxMemoryGb: 6, hostMemoryGb: 32, defaultPort: 16261 };

function luaBlock(offset, { message = null, frames, exception, cause = null }) {
  const lines = [];
  if (message) lines.push(`ERROR: General      ${at(offset)}> KahluaThread.flushErrorMessage      > ${message}`);
  lines.push(`ERROR: General      ${at(offset)}> KahluaThread.flushErrorMessage      > dumping Lua stack trace`);
  lines.push("-----------------------------------------", "STACK TRACE", "-----------------------------------------");
  lines.push(...frames);
  lines.push(`ERROR: General      ${at(offset + 1)}> ExceptionLogger.logException> Exception thrown`);
  lines.push(`\t${exception}`, "\tStack trace:", "\t\tse.krka.kahlua.vm.KahluaUtil.fail(KahluaUtil.java:99)");
  if (cause) lines.push(`\tCaused by: ${cause}`, "\t\t... 45 more.");
  return lines;
}

function scan(text, extra = {}) {
  return findServerErrors({
    logs: [{ text: Array.isArray(text) ? text.join("\r\n") : text }],
    logMtime: new Date(T + 60_000),
    mods: MODS,
    enabledModIds: ENABLED,
    workshopItems: ["2833500000", "2900000001"],
    server: SERVER,
    ...extra,
  });
}

const byKind = (result, kind) => result.findings.filter((f) => f.kind === kind);

describe("parseEntry", () => {
  it("reads the level, the origin and the time of a 42 DebugLog line, with or without the date prefix", () => {
    const a = parseEntry(`[30-03-26 14:38:26.380] ERROR: General      ${at(0)}> ExceptionLogger.logException> Exception thrown`);
    expect(a).toMatchObject({ level: "ERROR", category: "General", origin: "ExceptionLogger.logException", text: "Exception thrown", time: T });
    const b = parseEntry("ERROR: General      f:0 at AngelCodeFont.parseFnt              > AngelCodeFont failed to load page 0 texture media/mainfont_0.png");
    expect(b).toMatchObject({ level: "ERROR", origin: null, text: "AngelCodeFont failed to load page 0 texture media/mainfont_0.png" });
    expect(parseEntry("\tjava.lang.RuntimeException: boom")).toBeNull();
  });
});

describe("Lua errors", () => {
  it("attributes a Lua error to the mod its stack names and offers to disable that mod", () => {
    const result = scan([
      `LOG  : Lua          ${at(-5)}> organizedCategories is autosorting items.`,
      ...luaBlock(0, {
        frames: [
          "function: autoSort -- file: organizedCategories_autoSort.lua line # 72 | MOD: Organized Categories: Core",
          "function: OnGameBoot -- file: organizedCategories_autoSort.lua line # 271 | MOD: Organized Categories: Core.",
        ],
        exception: "java.lang.RuntimeException: Object tried to call nil in autoSort at KahluaUtil.fail(KahluaUtil.java:99).",
      }),
    ]);
    const [lua] = byKind(result, "luaError");
    expect(lua).toBeDefined();
    expect(lua.modId).toBe("OrganizedCategories");
    expect(lua.workshopId).toBe("2900000001");
    expect(lua.category).toBe("mods");
    expect(lua.message).toBe("Object tried to call nil in autoSort");
    expect(lua.params).toMatchObject({ modName: "Organized Categories: Core", file: "organizedCategories_autoSort.lua", line: 72 });
    expect(lua.firstSeen).toBe(new Date(T).toISOString());
    expect(lua.fixes.map((f) => f.id)).toEqual(["disableMod", "openMods"]);
    expect(lua.fixes[0]).toMatchObject({ action: "disableMod", params: { modId: "OrganizedCategories" }, capability: "mods.manage", safe: false, confirm: true });
    // The exception after the stack is part of this error, not a second finding.
    expect(byKind(result, "javaException")).toHaveLength(0);
    expect(byKind(result, "other")).toHaveLength(0);
  });

  it("counts the same Lua error once with its count, and keeps the message line before the stack", () => {
    const one = (offset) => luaBlock(offset, {
      message: "expected 2 arguments, got 1.",
      frames: ["function: customGetVal -- file: SpongieCopy_BodyLocationsTweaker.lua line # 12 | MOD: Spongie's Clothing"],
      exception: "java.lang.reflect.InvocationTargetException at DirectMethodHandleAccessor.invoke(null:-1).",
      cause: "java.lang.IllegalStateException: Not in debug",
    });
    const result = scan([...one(0), ...one(5000), ...one(9000)]);
    const lua = byKind(result, "luaError");
    expect(lua).toHaveLength(1);
    expect(lua[0].count).toBe(3);
    expect(lua[0].message).toBe("expected 2 arguments, got 1");
    expect(lua[0].lastSeen).toBe(new Date(T + 9000).toISOString());
    expect(lua[0].samples.length).toBeLessThanOrEqual(3);
    expect(lua[0].samples[0]).toContain("| MOD: Spongie's Clothing");
    expect(byKind(result, "other")).toHaveLength(0);
  });

  it("falls back to the Caused by: line when the exception itself says nothing", () => {
    const result = scan(luaBlock(0, {
      frames: ["function: x -- file: X.lua line # 2 | MOD: Spongie's Clothing."],
      exception: "java.lang.reflect.InvocationTargetException at DirectMethodHandleAccessor.invoke(null:-1).",
      cause: "java.lang.IllegalStateException: Not in debug",
    }));
    expect(byKind(result, "luaError")[0].message).toBe("IllegalStateException: Not in debug");
  });

  it("gives the same id on every scan for the same error (stable)", () => {
    const lines = luaBlock(0, {
      frames: ["function: autoSort -- file: organizedCategories_autoSort.lua line # 72 | MOD: Organized Categories: Core"],
      exception: "java.lang.RuntimeException: Object tried to call nil in autoSort at KahluaUtil.fail(KahluaUtil.java:99).",
    });
    expect(byKind(scan(lines), "luaError")[0].id).toBe(byKind(scan(lines.map((l) => l.replace(String(T), String(T + 99)))), "luaError")[0].id);
  });

  it("does not offer to disable a mod Mods= no longer lists", () => {
    const result = scan(luaBlock(0, {
      frames: ["function: autoSort -- file: organizedCategories_autoSort.lua line # 72 | MOD: Organized Categories: Core"],
      exception: "java.lang.RuntimeException: Object tried to call nil in autoSort at KahluaUtil.fail(KahluaUtil.java:99).",
    }), { enabledModIds: ["SpongiesClothing"] });
    expect(byKind(result, "luaError")[0].fixes.map((f) => f.id)).toEqual(["openMods"]);
  });

  it("files a Lua error in vanilla code under the server, with no mod", () => {
    const result = scan(luaBlock(0, {
      frames: ["function: getItemInfo -- file: ISToolTipInv.lua line # 72 | Vanilla"],
      exception: "java.lang.RuntimeException: attempted index: getModData of non-table: null at KahluaThread.tableget(KahluaThread.java:1540).",
    }));
    const [lua] = byKind(result, "luaError");
    expect(lua.modId).toBeNull();
    expect(lua.category).toBe("server");
    expect(lua.params.vanilla).toBe(true);
    expect(lua.fixes.map((f) => f.id)).toEqual(["openLogs"]);
  });

  it("reports a PanelBridge Lua error as a PanelBridge problem", () => {
    const result = scan(luaBlock(0, {
      frames: ["function: tick -- file: PanelBridge.lua line # 900 | MOD: Zomboid Control Panel Bridge"],
      exception: "java.lang.RuntimeException: attempted index: getClass of non-table: null at KahluaThread.tableget(KahluaThread.java:1540).",
    }));
    expect(byKind(result, "luaError")).toHaveLength(0);
    const [bridge] = byKind(result, "panelBridge");
    expect(bridge.category).toBe("panel");
    expect(bridge.fixes.map((f) => f.to)).toContain("/settings?tab=bridge");
  });
});

describe("one-line signatures", () => {
  it("required mod not found: critical, with the Mods health fix that matches", () => {
    const result = scan([`ERROR: General      ${at(0)}> ZomboidFileSystem.loadMod> required mod "tsarslib" not found`]);
    const [f] = byKind(result, "modRequiredMissing");
    expect(f).toMatchObject({ severity: "critical", category: "mods", params: { missingModId: "tsarslib" } });
    expect(f.fixes[0]).toMatchObject({ action: "modsHealthFix", safe: true, params: { kinds: ["requiredNotInstalled", "requiredLoadedImplicitly"], modId: "tsarslib" } });
  });

  it("mod.info missing: maps the folder to its Workshop item", () => {
    const result = scan([`WARN : Mod          ${at(0)}> ChooseGameInfo.getModDetails> can't find mod.info in mod dir: "/srv/pz/steamapps/workshop/content/108600/2833500000/mods/SpongiesClothing"`]);
    const [f] = byKind(result, "modInfoMissing");
    expect(f.modId).toBe("SpongiesClothing");
    expect(f.workshopId).toBe("2833500000");
  });

  it("maps a Windows path of a Workshop item it has no folder record of", () => {
    const index = buildModIndex(MODS, ENABLED);
    expect(modByPath(index, "C:\\steam\\steamapps\\workshop\\content\\108600\\999\\mods\\Other\\media\\lua\\x.lua")).toMatchObject({ mod: null, workshopId: "999", folder: "other" });
    expect(modByPath(index, "/home/pz/Zomboid/mods/LocalThing/42/media/lua/client/a.lua").mod.id).toBe("LocalThing");
  });

  it("Workshop download failure: one finding per item, the mods it ships, restart and Mods health", () => {
    const result = scan([
      `LOG  : General      ${at(0)}> Workshop: onItemNotDownloaded itemID=2833500000 result=9`,
      `LOG  : General      ${at(1)}> Workshop: GetItemInstallFolder() failed ID=2833500000`,
    ]);
    const list = byKind(result, "workshopDownload");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ severity: "critical", workshopId: "2833500000", count: 2 });
    expect(list[0].params.modNames).toEqual(["Spongie's Clothing"]);
    expect(list[0].fixes.map((f) => f.id)).toEqual(["modsHealth", "restartServer", "openMods"]);
  });

  it("network: Steam unreachable, RakNet start failure (port in use), RCON socket and password", () => {
    const result = scan([
      `LOG  : General      ${at(0)}> Failed to connect to Steam servers`,
      `LOG  : Network      ${at(1)}> RakNet.Startup() return code: 5 (0 means success)`,
      `ERROR: Network      ${at(2)}> RCONServer> RCON: error creating socket on port 27015`,
      `LOG  : Network      ${at(3)}> RCON: password doesn't match`,
    ]);
    expect(byKind(result, "steamUnreachable")[0].category).toBe("network");
    expect(byKind(result, "portInUse")[0].params).toEqual({ code: 5, port: 16261 });
    expect(byKind(result, "rconPortInUse")[0].params.port).toBe(27015);
    expect(byKind(result, "rconAuth")).toHaveLength(1);
  });

  it("ignores a RakNet start that succeeded and a no-Steam start with no Workshop items", () => {
    const result = scan([
      `LOG  : Network      ${at(0)}> RakNet.Startup() return code: 0 (0 means success)`,
      `LOG  : General      ${at(1)}> SteamUtils started without Steam`,
    ], { workshopItems: [] });
    expect(result.findings).toHaveLength(0);
  });

  it("out of memory: offers +2 GB with the current and new value, capped by the host", () => {
    const result = scan(["Exception in thread \"Thread-12\" java.lang.OutOfMemoryError: Java heap space"]);
    const [f] = byKind(result, "outOfMemory");
    expect(f.severity).toBe("critical");
    expect(f.params.detail).toBe("Java heap space");
    expect(f.fixes[0]).toMatchObject({ action: "raiseMemory", safe: true, params: { serverId: 7, currentGb: 6, nextGb: 8 } });
    expect(nextMemoryGb(14, 16)).toBeNull();
    expect(nextMemoryGb(12, 16)).toBe(14);
    const remote = scan(["java.lang.OutOfMemoryError: GC overhead limit exceeded"], { server: { ...SERVER, memoryManaged: false } });
    expect(byKind(remote, "outOfMemory")[0].fixes.some((x) => x.id === "raiseMemory")).toBe(false);
  });

  it("chunk load errors: one finding listing the chunks", () => {
    const result = scan([
      `ERROR: General      ${at(0)}> IsoChunk.load> Error loading chunk 1200,950`,
      `ERROR: General      ${at(1)}> IsoChunk.load> Error loading chunk 1201,950`,
    ]);
    const [f] = byKind(result, "chunkLoad");
    expect(f.count).toBe(2);
    expect(f.params.chunks).toEqual(["1200,950", "1201,950"]);
  });

  it("Workshop item updated while running and PanelBridge print errors", () => {
    const result = scan([
      `LOG  : General      ${at(0)}> CheckModsNeedUpdate: Mods need update`,
      `LOG  : Lua          ${at(1)}> [PanelBridge][ERROR] Could not write status.json`,
    ]);
    expect(byKind(result, "workshopOutdated")[0].fixes[0].id).toBe("restartServer");
    expect(byKind(result, "panelBridge")).toHaveLength(1);
  });
});

describe("unknown errors and crashes", () => {
  it("groups unknown ERROR lines by their normalised text", () => {
    const result = scan([
      "ERROR: General      f:0 at AngelCodeFont.parseFnt              > AngelCodeFont failed to load page 0 texture D:/Games/PZ/media/mainfont_0.png",
      "ERROR: General      f:0 at AngelCodeFont.parseFnt              > AngelCodeFont failed to load page 0 texture D:/Games/PZ/media/mainfont2_0.png",
      `ERROR: General      ${at(3)}> EditVehicleState.fromLua1> Exception thrown`,
      "\tjava.nio.file.NoSuchFileException: ..\\src\\main\\java\\generation\\VehicleScriptGenerator.java at WindowsException.translateToIOException(null:-1).",
      "\tStack trace:",
    ]);
    const other = byKind(result, "other");
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({ count: 2, severity: "info" });
    expect(byKind(result, "javaException")[0].params.exception).toBe("NoSuchFileException");
  });

  it("a server that stopped before SERVER STARTED with an error at the end crashed while starting", () => {
    const lines = [
      `LOG  : General      ${at(0)}> versionNumber=42.21.0 demo=false`,
      `ERROR: General      ${at(1)}> GameServer.main> Exception thrown`,
      "\tjava.lang.IllegalStateException: world dictionary is broken at WorldDictionary.init(WorldDictionary.java:200).",
    ];
    const stopped = scan(lines, { server: { ...SERVER, running: false } });
    const [crash] = byKind(stopped, "startupCrash");
    expect(crash.severity).toBe("critical");
    expect(crash.samples[0]).toContain("world dictionary is broken");
    expect(crash.fixes.map((f) => f.id)).toEqual(["startServer", "openConsole"]);
    expect(byKind(scan([...lines, `LOG  : General      ${at(2)}> *** SERVER STARTED ****`], { server: { ...SERVER, running: false } }), "startupCrash")).toHaveLength(0);
    expect(byKind(scan(lines), "startupCrash")).toHaveLength(0);
    expect(byKind(scan(lines, { server: { ...SERVER, running: null } }), "startupCrash")).toHaveLength(0);
  });

  it("reads the panel's own errors and RCON authentication failures from its log", () => {
    const result = scan([], {
      panelLog: [
        { level: "error", message: "Backup failed: ENOSPC: no space left on device", timestamp: "2026-10-20T10:00:00.000Z", source: "Backup" },
        { level: "error", message: "Backup failed: ENOSPC: no space left on device", timestamp: "2026-10-20T11:00:00.000Z", source: "Backup" },
        { level: "error", message: "Authentication failed. Check RCON password in server settings.", timestamp: "2026-10-20T11:30:00.000Z", source: "RCON" },
        { level: "info", message: "Started", timestamp: "2026-10-20T09:00:00.000Z", source: "Server" },
      ],
    });
    const [panel] = byKind(result, "panelError");
    expect(panel).toMatchObject({ count: 2, source: "panel", firstSeen: "2026-10-20T10:00:00.000Z", lastSeen: "2026-10-20T11:00:00.000Z" });
    expect(byKind(result, "rconAuth")[0].params.from).toBe("panel");
    expect(result.checked.panelErrors).toBe(3);
  });

  it("sorts critical first and counts by severity", () => {
    const result = scan([
      "ERROR: General      f:0> Something odd happened",
      `LOG  : General      ${at(0)}> Failed to connect to Steam servers`,
    ]);
    expect(result.findings[0].kind).toBe("steamUnreachable");
    expect(result.counts).toMatchObject({ critical: 1, info: 1, total: 2 });
  });

  it("drops the first partial line of a tail chunk", () => {
    const result = findServerErrors({
      logs: [{ text: "LOG  : General      f:0> start\n" }, { text: "ld to Steam servers\nLOG  : General      f:0> ok\n", partialStart: true, gapBefore: true }],
    });
    expect(result.findings).toHaveLength(0);
  });
});

describe("redaction", () => {
  it("removes IP addresses, Steam IDs and password= values from sample lines, then runs the route's scrubber", () => {
    const result = scan([
      `ERROR: Network      ${at(0)}> Connection from 203.0.113.9:16261 steamid 76561198000000001 rejected, password=hunter2`,
    ], { redact: (t) => t.replace("rejected", "[scrubbed]") });
    const [f] = byKind(result, "other");
    const text = `${f.message}\n${f.samples.join("\n")}`;
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("76561198000000001");
    expect(text).not.toContain("hunter2");
    expect(f.samples[0]).toContain("[scrubbed]");
    expect(redactLine("RCON: password doesn't match")).toBe("RCON: password doesn't match");
  });

  it("normalises numbers and paths for grouping only", () => {
    expect(normaliseMessage("chunk 12,34 at C:\\x\\y.lua and /a/b/c")).toBe("chunk #,# at <path> and <path>");
    expect(findingId("other", "a")).toMatch(/^other-[0-9a-f]{16}$/);
  });
});
