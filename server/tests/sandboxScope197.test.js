import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runServerFilesRoute } from "./helpers/serverFilesRoute.js";

// #197: a SandboxVars.lua with a numeric "Explosives = 1.0" inside one table
// and a separate top-level mod table "Explosives = { ... }". The panel kept
// turning the table's opening line into "Explosives = 1", which the game
// refuses to load ("'}' expected (to close '{' at line 1) near
// 'VanillaBallisticsEnabled'").
//
// The chain: parseSandboxVars() reported the nested numeric as a top-level
// setting, the Server Config page sent its whole parse result back on every
// save, and the top-level writer's regex matched "Explosives = {" with "{" as
// the old value. Every writer and reader now goes through one scope-aware
// editor (utils/sandboxLua.js); this file drives each entry point with the
// exact #197 shape, in both orders, with LF and CRLF line endings.

const getActiveServer = vi.fn();
const getAllSettings = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings,
}));

vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(),
  beginRemoteConfigSession: vi.fn(),
  getMirrorPath: vi.fn(),
  isRemoteConfigConfigured: vi.fn(() => false),
  pushRemoteConfigFiles: vi.fn(),
  validateRemoteConfigTransport: vi.fn(),
}));

const {
  default: router,
  parseSandboxVars,
  applySandboxChanges,
  modifySandboxValue,
  findUnpersistedSandboxKeys,
  persistSandboxValues,
  repairSandboxSyntax,
} = await import("../routes/serverFiles.js");
const { readSandboxValue, mergeSandboxSections } = await import("../utils/templateFiles.js");
const { validateSandboxLua } = await import("../utils/sandboxLua.js");

const LOOT_TABLE = [
  "    LootTweaks = {",
  "        -- Explosives loot multiplier",
  "        Explosives = 1.0,",
  "        Guns = 2,",
  "    },",
];
const MOD_TABLE = [
  "    Explosives = {",
  "        VanillaBallisticsEnabled = false,",
  "        LootMultiplier = 1.0,",
  "    },",
];

function issue197File({ nestedFirst, eol }) {
  return [
    "SandboxVars = {",
    "    VERSION = 6,",
    "    Zombies = 4,",
    ...(nestedFirst ? [...LOOT_TABLE, ...MOD_TABLE] : [...MOD_TABLE, ...LOOT_TABLE]),
    "}",
    "",
  ].join(eol);
}

// The corruption the issue reports, as the game finds it on disk.
const corrupt = (content) => content.replace("    Explosives = {", "    Explosives = 1");

// FILES-2/PATHS-2: Server Files uses a config folder only inside its
// server's <data folder>/Server, so each test's config folder is the Server
// folder of a data folder of its own, as the panel's own setups make it.
function makeConfigDir(prefix) {
  const configDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "Server");
  fs.mkdirSync(configDir);
  return configDir;
}

function serverRecord(configDir) {
  return { zomboidDataPath: path.dirname(configDir), serverConfigPath: configDir, serverName: "TestServer" };
}

function removeConfigDir(configDir) {
  fs.rmSync(path.dirname(configDir), { recursive: true, force: true });
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// Every test here expects its route to run, so a gate refusal fails it
// (helpers/serverFilesRoute.js).
function runHandler(routePath, method, req) {
  return runServerFilesRoute(router, routePath, method, req, createResponse());
}

const cases = [
  ["nested numeric before the table, LF", { nestedFirst: true, eol: "\n" }],
  ["nested numeric after the table, LF", { nestedFirst: false, eol: "\n" }],
  ["nested numeric before the table, CRLF", { nestedFirst: true, eol: "\r\n" }],
  ["nested numeric after the table, CRLF", { nestedFirst: false, eol: "\r\n" }],
];

describe.each(cases)("#197 shape (%s)", (_label, shape) => {
  const content = issue197File(shape);
  let tmpDir;
  let sandboxPath;

  beforeEach(() => {
    tmpDir = makeConfigDir("zcp-sandbox-197-");
    sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
    fs.writeFileSync(sandboxPath, content);
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue(serverRecord(tmpDir));
  });

  afterEach(() => {
    removeConfigDir(tmpDir);
  });

  it("parseSandboxVars reports each Explosives under the table it lives in", () => {
    const parsed = parseSandboxVars(content);
    expect(parsed.settings).toEqual({ Zombies: 4 });
    expect(parsed.LootTweaks).toEqual({ Explosives: 1, Guns: 2 });
    expect(parsed.Explosives).toEqual({ VanillaBallisticsEnabled: false, LootMultiplier: 1 });
    expect(parsed.VERSION).toBe(6);
  });

  it("saving back exactly what was parsed leaves the file byte-for-byte unchanged", () => {
    expect(applySandboxChanges(content, parseSandboxVars(content))).toBe(content);
  });

  it("a stale page still sending Explosives as a top-level value is refused and reported", () => {
    const stale = { settings: { Zombies: 4, Explosives: 1 } };
    const written = applySandboxChanges(content, stale);
    expect(written).toBe(content);
    expect(findUnpersistedSandboxKeys(stale, parseSandboxVars(written))).toEqual(["Explosives"]);
  });

  it("modifySandboxValue never writes a value over the top-level table", () => {
    expect(modifySandboxValue(content, "Explosives", 1, null)).toBe(content);
  });

  it("modifySandboxValue edits each Explosives at its own path, keeping the 1.0 number style", () => {
    const nested = modifySandboxValue(content, "Explosives", 3, "LootTweaks");
    expect(nested).toBe(content.replace("Explosives = 1.0,", "Explosives = 3.0,"));
    const inTable = modifySandboxValue(content, "LootMultiplier", 2, "Explosives");
    expect(inTable).toBe(content.replace("LootMultiplier = 1.0,", "LootMultiplier = 2.0,"));
  });

  it("GET /sandbox then PUT /sandbox with that payload changes nothing", async () => {
    const got = await runHandler("/sandbox", "get", { body: {} });
    const { sandbox } = got.json.mock.calls[0][0];
    expect(sandbox.settings.Explosives).toBeUndefined();

    const res = await runHandler("/sandbox", "put", { body: { sandbox } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(res.json.mock.calls[0][0].unpersistedKeys).toBeUndefined();
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(content);
  });

  it("PUT /sandbox writes each section at its own path and reports a refused top-level value", async () => {
    const res = await runHandler("/sandbox", "put", {
      body: {
        sandbox: {
          settings: { Explosives: 1, Zombies: 2 },
          LootTweaks: { Explosives: 5 },
          Explosives: { LootMultiplier: 3 },
        },
      },
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].unpersistedKeys).toEqual(["Explosives"]);
    const onDisk = fs.readFileSync(sandboxPath, "utf-8");
    expect(onDisk).toBe(
      content
        .replace("Zombies = 4,", "Zombies = 2,")
        .replace("Explosives = 1.0,", "Explosives = 5.0,")
        .replace("LootMultiplier = 1.0,", "LootMultiplier = 3.0,"),
    );
  });

  it("PUT /sandbox-option writes Block.Key in its own block and refuses a value over the table", async () => {
    let res = await runHandler("/sandbox-option", "put", {
      body: { name: "Explosives.LootMultiplier", value: 2 },
    });
    expect(res.json.mock.calls[0][0].persisted).toBe(true);
    res = await runHandler("/sandbox-option", "put", {
      body: { name: "LootTweaks.Explosives", value: 4 },
    });
    expect(res.json.mock.calls[0][0].persisted).toBe(true);
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(
      content
        .replace("LootMultiplier = 1.0,", "LootMultiplier = 2.0,")
        .replace("Explosives = 1.0,", "Explosives = 4.0,"),
    );

    const before = fs.readFileSync(sandboxPath, "utf-8");
    res = await runHandler("/sandbox-option", "put", { body: { name: "Explosives", value: 1 } });
    expect(res.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({ persisted: false, reason: expect.stringMatching(/table/) }),
    );
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(before);
  });

  it("persistSandboxValues (PanelBridge live changes) refuses a value over the table", async () => {
    const result = await persistSandboxValues({ Explosives: 1 });
    expect(result.persisted).toBe(false);
    expect(result.reason).toMatch(/Explosives: is a table/);
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(content);
  });

  it("template apply (templateFiles) reads and writes by section", () => {
    expect(readSandboxValue(content, "settings", "Explosives")).toBeUndefined();
    expect(readSandboxValue(content, "LootTweaks", "Explosives")).toBe(1);
    const merged = mergeSandboxSections(content, {
      settings: { Explosives: 1 },
      LootTweaks: { Explosives: 2 },
    });
    expect(merged.skipped).toEqual([{ section: "settings", key: "Explosives" }]);
    expect(merged.applied).toEqual([{ section: "LootTweaks", key: "Explosives" }]);
    expect(merged.content).toBe(content.replace("Explosives = 1.0,", "Explosives = 2.0,"));
  });

  it("an already-corrupted file is never edited further; PUT /sandbox refuses with a code", async () => {
    const broken = corrupt(content);
    fs.writeFileSync(sandboxPath, broken);
    expect(applySandboxChanges(broken, { settings: { Zombies: 2 } })).toBe(broken);

    const res = await runHandler("/sandbox", "put", { body: { sandbox: { settings: { Zombies: 2 } } } });
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SANDBOX_FILE_UNPARSEABLE" }),
    );
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(broken);
  });

  it("GET /sandbox on a corrupted file returns empty sections plus the game's own error", async () => {
    fs.writeFileSync(sandboxPath, corrupt(content));
    const res = await runHandler("/sandbox", "get", { body: {} });
    const payload = res.json.mock.calls[0][0];
    expect(payload.sandbox.settings).toEqual({});
    expect(payload.parseError.message).toMatch(/'}' expected \(to close '\{' at line 1\) near 'VanillaBallisticsEnabled'/);
  });

  it("POST /templates/:id/apply refuses a template whose saved SandboxVars.lua is corrupt, before writing anything", async () => {
    const iniPath = path.join(tmpDir, "TestServer.ini");
    fs.writeFileSync(iniPath, "PublicName=Live\n");
    fs.mkdirSync(path.join(tmpDir, "templates"));
    fs.writeFileSync(
      path.join(tmpDir, "templates", "saved_while_broken.json"),
      JSON.stringify({ name: "Saved while broken", iniRaw: "PublicName=Template\n", sandboxRaw: corrupt(content) }),
    );

    const res = await runHandler("/templates/:id/apply", "post", {
      params: { id: "saved_while_broken" },
      body: {},
    });
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TEMPLATE_SANDBOX_UNPARSEABLE" }),
    );
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(content);
    expect(fs.readFileSync(iniPath, "utf-8")).toBe("PublicName=Live\n");
  });
});

describe("persistSandboxValues only writes real top-level keys", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeConfigDir("zcp-sandbox-197-persist-");
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue(serverRecord(tmpDir));
  });

  afterEach(() => {
    removeConfigDir(tmpDir);
  });

  // The old missing-key check was a file-wide regex, so a key that only
  // exists inside a mod block counted as present, and the top-level writer
  // then rewrote the mod's value.
  it("a key that only exists inside a mod block is reported missing, not rewritten", async () => {
    const content = [
      "SandboxVars = {",
      "    WaterShut = 2,",
      "    SomeMod = {",
      "        ElecShut = 5,",
      "    },",
      "}",
      "",
    ].join("\n");
    const filePath = path.join(tmpDir, "TestServer_SandboxVars.lua");
    fs.writeFileSync(filePath, content);

    const result = await persistSandboxValues({ ElecShut: 9, WaterShut: 9 });
    expect(result.persisted).toBe(false);
    expect(result.reason).toMatch(/ElecShut: not present in SandboxVars\.lua/);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(content);
  });

  // As Server Files' remote middleware does: a fresh pull into the panel's
  // own mirror, the edit there, a push back. The local folder rule is for
  // this computer's folders, and a remote record's never are.
  it("writes a remote server's values in the mirror and pushes them, never in a local folder the record names", async () => {
    const remoteConfig = await import("../services/remoteConfigFiles.js");
    const transport = { host: "sftp.test", configPath: "/home/pz/Zomboid/Server" };
    const mirrorDir = makeConfigDir("zcp-sandbox-197-mirror-");
    const content = "SandboxVars = {\n    VERSION = 6,\n    WaterShut = 2,\n}\n";
    const session = { mirrorDir };
    fs.writeFileSync(path.join(mirrorDir, "TestServer_SandboxVars.lua"), content);
    // No data folder: Server Files would refuse this one for a local server.
    fs.writeFileSync(path.join(tmpDir, "TestServer_SandboxVars.lua"), content);
    getActiveServer.mockResolvedValue({ serverName: "TestServer", serverConfigPath: tmpDir, zomboidDataPath: null, isRemote: true });
    getAllSettings.mockResolvedValue({ panelBridgeSftpHost: "sftp.test", panelBridgeSftpConfigPath: transport.configPath });
    vi.mocked(remoteConfig.isRemoteConfigConfigured).mockReturnValue(true);
    vi.mocked(remoteConfig.validateRemoteConfigTransport).mockReturnValue(transport);
    vi.mocked(remoteConfig.acquireMirrorLock).mockResolvedValue(() => {});
    vi.mocked(remoteConfig.beginRemoteConfigSession).mockResolvedValue(session);
    try {
      const result = await persistSandboxValues({ WaterShut: 9 });

      expect(result.persisted).toBe(true);
      expect(remoteConfig.beginRemoteConfigSession).toHaveBeenCalledWith(transport, "TestServer", { fresh: true });
      expect(fs.readFileSync(path.join(mirrorDir, "TestServer_SandboxVars.lua"), "utf-8")).toBe(
        content.replace("WaterShut = 2", "WaterShut = 9"),
      );
      expect(remoteConfig.pushRemoteConfigFiles).toHaveBeenCalledWith(transport, "TestServer", session);
      expect(fs.readFileSync(path.join(tmpDir, "TestServer_SandboxVars.lua"), "utf-8")).toBe(content);
      expect(fs.existsSync(path.join(tmpDir, "backups"))).toBe(false);
    } finally {
      vi.mocked(remoteConfig.isRemoteConfigConfigured).mockReset().mockReturnValue(false);
      for (const mocked of ["validateRemoteConfigTransport", "acquireMirrorLock", "beginRemoteConfigSession", "pushRemoteConfigFiles"]) {
        vi.mocked(remoteConfig[mocked]).mockReset();
      }
      removeConfigDir(mirrorDir);
    }
  });
});

describe("GET /sandbox/validate checks what the game checks", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeConfigDir("zcp-sandbox-197-validate-");
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue(serverRecord(tmpDir));
  });

  afterEach(() => {
    removeConfigDir(tmpDir);
  });

  async function validate(content) {
    fs.writeFileSync(path.join(tmpDir, "TestServer_SandboxVars.lua"), content);
    const res = await runHandler("/sandbox/validate", "get", {});
    return res.json.mock.calls[0][0];
  }

  it("a brace inside a string or a comment is not corruption", async () => {
    const body = await validate(
      ["SandboxVars = {", "    -- e.g. {fast}", '    Banner = "}",', "}", ""].join("\n"),
    );
    expect(body).toEqual({ valid: true, braceDepth: 0 });
  });

  it("balanced braces with a syntax error are still invalid", async () => {
    const body = await validate(["SandboxVars = {", "    A = 1", "    B = 2,", "}", ""].join("\n"));
    expect(body.valid).toBe(false);
    expect(body.parseError).toMatch(/line 3: '}' expected/);
  });
});

describe("POST /sandbox/repair never writes a file that does not parse", () => {
  it("rejects a repair that balances the braces but still is not valid Lua", () => {
    const broken = [
      "SandboxVars = {",
      "    Explosives = 1",
      "        VanillaBallisticsEnabled = false",
      "        LootMultiplier = 1.0,",
      "    },",
      "}",
      "",
    ].join("\n");
    expect(repairSandboxSyntax(broken).fixed).toBe(false);
  });

});

// The repair used to wrap the damaged line in "_RepairedBlock1 = { ... }".
// The file loaded, but the game found no Explosives table, so the mod's
// options went back to their defaults; with a damaged root line the game
// found no SandboxVars at all. It now puts the "{" back.
describe("POST /sandbox/repair puts back the '{' the #197 bug overwrote", () => {
  it.each(cases)("gives back the file as it was before the damage (%s)", (_label, shape) => {
    const original = issue197File(shape);
    const repaired = repairSandboxSyntax(corrupt(original));
    expect(repaired.fixed).toBe(true);
    expect(repaired.content).toBe(original);
    expect(repaired.changes).toEqual([expect.stringMatching(/^Line \d+: 'Explosives = 1'/)]);
  });

  it.each([
    [
      "a vanilla block",
      ["SandboxVars = {", "    VERSION = 6,", "    ZombieLore = 2", "        Speed = 2,", "    },", "}", ""],
      2,
    ],
    [
      "the root line",
      ["SandboxVars = 1", "    VERSION = 6,", "    ZombieLore = {", "        Speed = 2,", "    },", "}", ""],
      0,
    ],
    [
      "a line with a comment, keeping the comment",
      ["SandboxVars = {", "    VERSION = 6,", '    ZombieLore = "x" -- zombies', "        Speed = 2,", "    },", "}", ""],
      2,
    ],
  ])("restores %s", (_label, lines, at) => {
    const original = [...lines];
    original[at] = original[at].replace(/= (\d+|"x")/, "= {");
    const repaired = repairSandboxSyntax(lines.join("\n"));
    expect(repaired.fixed).toBe(true);
    expect(repaired.content).toBe(original.join("\n"));
    expect(parseSandboxVars(repaired.content)).toEqual(
      expect.objectContaining({ VERSION: 6, ZombieLore: { Speed: 2 } }),
    );
  });

  it("writes the restored file through the route, after a backup", async () => {
    const tmpDir = makeConfigDir("zcp-sandbox-197-restore-");
    try {
      const sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
      const original = issue197File({ nestedFirst: false, eol: "\r\n" });
      fs.writeFileSync(sandboxPath, corrupt(original));
      getActiveServer.mockResolvedValue(serverRecord(tmpDir));
      getAllSettings.mockResolvedValue({});

      const res = await runHandler("/sandbox/repair", "post", {});
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, repaired: true }));
      expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(original);
      expect(fs.readdirSync(path.join(tmpDir, "backups"))).toHaveLength(1);
    } finally {
      removeConfigDir(tmpDir);
    }
  });
});

// The repair used to read the file line by line, blind to strings and
// comments. A line inside a long string or a --[[ ]] comment that read like
// "Speed = 2", above a line indented deeper, got a "{" too: the file still
// loaded, with another option's text changed. Each file below was checked
// with game build 42.21's own loader: the original loads, the damaged file
// does not, and the repaired file loads with the original's values. (The
// last case's attempt loads too, but as "SandboxVars = 1": no table.)
describe("POST /sandbox/repair only touches code, never a string or a comment", () => {
  const LOOKALIKE = ["Speed = 2", "    Fast = 1"];
  const fileWith = (block, eol) =>
    ["SandboxVars = {", "    VERSION = 6,", ...block, ...MOD_TABLE, "}", ""].join(eol);

  describe.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("%s", (_eolLabel, eol) => {
    it.each([
      ["a long string", ["    Note = [[", ...LOOKALIKE, "]],"]],
      ["a long string with a level", ["    Note = [==[", ...LOOKALIKE, "    ]==],"]],
      ["a string continued over lines", ['    Note = "a\\', "Speed = 2 --\\", "    Fast = 1 --\\", 'b",']],
      ["a --[[ ]] comment", ["    --[[", ...LOOKALIKE, "    ]]"]],
      ["a --[==[ ]==] comment", ["    --[==[ old", ...LOOKALIKE, "]==]"]],
    ])("leaves %s alone and restores the real table", (_label, block) => {
      const original = fileWith(block, eol);
      const repaired = repairSandboxSyntax(corrupt(original));
      expect(repaired.fixed).toBe(true);
      expect(repaired.content).toBe(original);
      expect(repaired.changes).toEqual([expect.stringMatching(/^Line \d+: 'Explosives = 1'/)]);
    });
  });

  it("leaves a long string inside the damaged table alone", () => {
    const original = [
      "SandboxVars = {",
      "    Explosives = {",
      "        Note = [[",
      ...LOOKALIKE,
      "]],",
      "        LootMultiplier = 1.0,",
      "    },",
      "}",
      "",
    ].join("\n");
    const repaired = repairSandboxSyntax(corrupt(original));
    expect(repaired.fixed).toBe(true);
    expect(repaired.content).toBe(original);
    expect(parseSandboxVars(repaired.content).Explosives).toEqual({
      Note: "Speed = 2\n    Fast = 1\n",
      LootMultiplier: 1,
    });
  });

  it("restores a line whose trailing --[[ comment runs over the lines below it", () => {
    const original = [
      "SandboxVars = {",
      '    Explosives = { --[[ the "{" goes here',
      ...LOOKALIKE,
      "    ]]",
      "        LootMultiplier = 1.0,",
      "    },",
      "}",
      "",
    ].join("\n");
    const repaired = repairSandboxSyntax(original.replace("Explosives = {", "Explosives = 1"));
    expect(repaired.fixed).toBe(true);
    expect(repaired.content).toBe(original);
  });

  it("restores a table whose first entry has a short comment before it on its line", () => {
    const original = [
      "SandboxVars = {",
      "    ZombieLore = {",
      "        --[[ tip ]] Speed = 2,",
      "        Cognition = 3,",
      "    },",
      "}",
      "",
    ].join("\n");
    const repaired = repairSandboxSyntax(original.replace("    ZombieLore = {", "    ZombieLore = 1"));
    expect(repaired.fixed).toBe(true);
    expect(repaired.content).toBe(original);
  });

  it("changes nothing when the only line that looks damaged is inside a string", () => {
    // One "}" too many, and no damaged opener to put back.
    const broken = ["SandboxVars = {", "    Note = [[", ...LOOKALIKE, "]],", "    },", "}", ""].join("\n");
    const repaired = repairSandboxSyntax(broken);
    expect(repaired).toEqual({ content: broken, fixed: false, changes: [] });
  });

  // A damaged root line ("SandboxVars = 1") with a comment and a string
  // holding look-alike lines below it. Read line by line, the comment's
  // "Zombies = 4" hid the real entries, so the root line stayed damaged and
  // the comment and string got a "{" each.
  const ROOT_ORIGINAL = [
    "SandboxVars = {",
    "    --[[ Zombies = 4 was the old default",
    "Zombies = 4",
    "    Speed = 2",
    "    ]]",
    "    Note = [[",
    "Zombies = 4",
    "    Speed = 2",
    "]],",
    "    VERSION = 6,",
    "    ZombieLore = {",
    "        Speed = 2,",
    "    },",
    "}",
    "",
  ].join("\r\n");
  const ROOT_DAMAGED = ROOT_ORIGINAL.replace("SandboxVars = {", "SandboxVars = 1");

  it("restores a damaged root line below which a comment and a string hold look-alike lines", () => {
    const repaired = repairSandboxSyntax(ROOT_DAMAGED);
    expect(repaired.fixed).toBe(true);
    expect(repaired.content).toBe(ROOT_ORIGINAL);
    expect(repaired.changes).toEqual([expect.stringMatching(/^Line 1: 'SandboxVars = 1'/)]);
    expect(parseSandboxVars(repaired.content)).toEqual(
      expect.objectContaining({
        VERSION: 6,
        settings: { Note: "Zombies = 4\n    Speed = 2\n" },
        ZombieLore: { Speed: 2 },
      }),
    );
  });

  it("writes the restored root line through the route, after a backup", async () => {
    const tmpDir = makeConfigDir("zcp-sandbox-197-root-");
    try {
      const sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
      fs.writeFileSync(sandboxPath, ROOT_DAMAGED);
      getActiveServer.mockResolvedValue(serverRecord(tmpDir));
      getAllSettings.mockResolvedValue({});

      const res = await runHandler("/sandbox/repair", "post", {});
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, repaired: true, changes: [expect.stringMatching(/^Line 1: /)] }),
      );
      expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(ROOT_ORIGINAL);
      expect(fs.readdirSync(path.join(tmpDir, "backups"))).toHaveLength(1);

      // Now valid, so a second repair is the "already valid" answer.
      const again = await runHandler("/sandbox/repair", "post", {});
      expect(again.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, alreadyValid: true }));
      expect(fs.readdirSync(path.join(tmpDir, "backups"))).toHaveLength(1);
    } finally {
      removeConfigDir(tmpDir);
    }
  });

  it("refuses a damaged root line it cannot restore, and writes nothing", async () => {
    // No entry is indented under the root line, so it is left as it is. Its
    // "ZombieLore" line below does get its "{" back, and the result parses,
    // but "SandboxVars = 1" is no table: the game would find nothing to load.
    const broken = ["SandboxVars = 1", "ZombieLore = 1", "    Speed = 2,", "}", ""].join("\n");
    const attempt = repairSandboxSyntax(broken);
    expect(attempt.changes).toEqual([expect.stringMatching(/^Line 2: 'ZombieLore = 1'/)]);
    expect(validateSandboxLua(attempt.content)).toEqual(
      expect.objectContaining({ parses: true, valid: false }),
    );
    expect(attempt.fixed).toBe(false);

    const tmpDir = makeConfigDir("zcp-sandbox-197-root-");
    try {
      const sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
      fs.writeFileSync(sandboxPath, broken);
      getActiveServer.mockResolvedValue(serverRecord(tmpDir));
      getAllSettings.mockResolvedValue({});

      const res = await runHandler("/sandbox/repair", "post", {});
      expect(res.status).toHaveBeenCalledWith(422);
      expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(broken);
      expect(fs.existsSync(path.join(tmpDir, "backups"))).toBe(false);
    } finally {
      removeConfigDir(tmpDir);
    }
  });
});

// A file that parses but has no SandboxVars table is not one the game loads:
// it finds nothing to read and exits on boot ("Exiting due to errors
// loading"). The repair used to stop at "parses".
describe("POST /sandbox/repair only reports success for a file the game loads", () => {
  let tmpDir;
  let sandboxPath;

  beforeEach(() => {
    tmpDir = makeConfigDir("zcp-sandbox-197-repair-");
    sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue(serverRecord(tmpDir));
  });

  afterEach(() => {
    removeConfigDir(tmpDir);
  });

  const backups = () =>
    fs.existsSync(path.join(tmpDir, "backups")) ? fs.readdirSync(path.join(tmpDir, "backups")) : [];

  it("refuses a repair that parses but leaves no SandboxVars table, and writes nothing", async () => {
    const broken = ["Settings = 1", "    Zombies = 4,", "}", ""].join("\n");
    fs.writeFileSync(sandboxPath, broken);
    expect(repairSandboxSyntax(broken).fixed).toBe(false);

    const res = await runHandler("/sandbox/repair", "post", {});
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({ success: false, code: "SANDBOX_REPAIR_PATTERN_UNKNOWN" }),
    );
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(broken);
    expect(backups()).toEqual([]);
  });

  it.each([
    ["an empty file", ""],
    ["SandboxVars = nil", "SandboxVars = nil\n"],
    ["only other globals", "Other = { Zombies = 4 }\n"],
  ])("does not call %s already valid", async (_label, content) => {
    fs.writeFileSync(sandboxPath, content);
    const res = await runHandler("/sandbox/repair", "post", {});
    expect(res.json.mock.calls[0][0].alreadyValid).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(422);
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(content);
  });
});

// These parse, but the game loads nothing from them and exits on boot. The
// page used to show an empty form with no error, and a save "succeeded"
// while every value was reported as not saved.
describe.each([
  ["an empty file", ""],
  ["SandboxVars = nil", "SandboxVars = nil\n"],
  ["only other globals", "Other = { Zombies = 4 }\n"],
])("a file with no SandboxVars table (%s)", (_label, content) => {
  let tmpDir;
  let sandboxPath;

  beforeEach(() => {
    tmpDir = makeConfigDir("zcp-sandbox-197-notable-");
    sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
    fs.writeFileSync(sandboxPath, content);
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue(serverRecord(tmpDir));
  });

  afterEach(() => {
    removeConfigDir(tmpDir);
  });

  it("GET /sandbox reports it as parseError", async () => {
    const res = await runHandler("/sandbox", "get", { body: {} });
    expect(res.json.mock.calls[0][0].parseError).toEqual({
      message: "no 'SandboxVars = { ... }' table found",
      line: 1,
      column: 1,
    });
  });

  it("PUT /sandbox refuses it with 422 and writes nothing", async () => {
    const res = await runHandler("/sandbox", "put", { body: { sandbox: { settings: { Zombies: 2 } } } });
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        code: "SANDBOX_FILE_UNPARSEABLE",
        params: { detail: "no 'SandboxVars = { ... }' table found" },
      }),
    );
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(content);
    expect(fs.existsSync(path.join(tmpDir, "backups"))).toBe(false);
  });

  it("PUT /sandbox-option says why nothing was saved", async () => {
    const res = await runHandler("/sandbox-option", "put", { body: { name: "Zombies", value: 2 } });
    expect(res.json.mock.calls[0][0]).toEqual(
      expect.objectContaining({ persisted: false, reason: expect.stringContaining("no 'SandboxVars = { ... }' table found") }),
    );
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(content);
  });
});

describe("a string continued over a CRLF line break is not corruption", () => {
  // "\" + CRLF continues a string in the game (A = "a\nb"). The brace count
  // used to end the string at the LF, miss the "{" after it, and call the
  // file corrupt: Checks & Fixes flagged it and template apply refused it.
  const continued = [
    "SandboxVars = {",
    "    VERSION = 6,",
    '    A = "a\\',
    'b", B = {',
    "        C = 1,",
    "    },",
    "    Zombies = 4,",
    "}",
    "",
  ].join("\r\n");
  let tmpDir;
  let sandboxPath;

  beforeEach(() => {
    tmpDir = makeConfigDir("zcp-sandbox-197-continued-");
    sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue(serverRecord(tmpDir));
  });

  afterEach(() => {
    removeConfigDir(tmpDir);
  });

  it("GET /sandbox/validate calls it valid", async () => {
    fs.writeFileSync(sandboxPath, continued);
    const res = await runHandler("/sandbox/validate", "get", {});
    expect(res.json.mock.calls[0][0]).toEqual({ valid: true, braceDepth: 0 });
  });

  it("POST /templates/:id/apply applies a template saved from it", async () => {
    fs.writeFileSync(sandboxPath, "SandboxVars = {\n    Zombies = 2,\n}\n");
    fs.mkdirSync(path.join(tmpDir, "templates"));
    fs.writeFileSync(
      path.join(tmpDir, "templates", "continued.json"),
      JSON.stringify({ name: "Continued", sandboxRaw: continued }),
    );
    const res = await runHandler("/templates/:id/apply", "post", {
      params: { id: "continued" },
      body: {},
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, applied: ["Sandbox"] }));
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(continued);
  });
});

describe("PUT /sandbox with nothing to change writes nothing", () => {
  let tmpDir;
  let sandboxPath;

  beforeEach(() => {
    tmpDir = makeConfigDir("zcp-sandbox-197-noop-");
    sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue(serverRecord(tmpDir));
  });

  afterEach(() => {
    removeConfigDir(tmpDir);
  });

  const backups = () =>
    fs.existsSync(path.join(tmpDir, "backups")) ? fs.readdirSync(path.join(tmpDir, "backups")) : [];

  // A file saved from a cp1252 editor: "café" with a lone 0xE9 byte. Reading
  // it as UTF-8 turns that byte into U+FFFD, so a rewrite used to change it
  // on every save, and every save also took a backup.
  it("takes no backup and keeps the bytes, even ones that are not valid UTF-8", async () => {
    const bytes = Buffer.concat([
      Buffer.from('SandboxVars = {\n    VERSION = 6,\n    ServerWelcome = "caf'),
      Buffer.from([0xe9]),
      Buffer.from('",\n    Zombies = 4,\n}\n'),
    ]);
    fs.writeFileSync(sandboxPath, bytes);

    const got = await runHandler("/sandbox", "get", { body: {} });
    const res = await runHandler("/sandbox", "put", { body: { sandbox: got.json.mock.calls[0][0].sandbox } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(res.json.mock.calls[0][0].unpersistedKeys).toBeUndefined();
    expect(fs.readFileSync(sandboxPath).equals(bytes)).toBe(true);
    expect(backups()).toEqual([]);
  });

  it("still backs up and writes when a value changes", async () => {
    const content = "SandboxVars = {\n    VERSION = 6,\n    Zombies = 4,\n}\n";
    fs.writeFileSync(sandboxPath, content);
    const res = await runHandler("/sandbox", "put", { body: { sandbox: { settings: { Zombies: 2 } } } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(content.replace("Zombies = 4", "Zombies = 2"));
    expect(backups()).toHaveLength(1);
  });
});
