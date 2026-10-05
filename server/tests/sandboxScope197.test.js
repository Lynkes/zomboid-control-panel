import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

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

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// Every handler reads req.activeServerContext, set by the router's own gate
// (the second non-route layer); the other middleware is covered elsewhere.
function getGateMiddleware() {
  return router.stack.filter((entry) => !entry.route)[1].handle;
}

async function runHandler(routePath, method, req) {
  const res = createResponse();
  await getGateMiddleware()(req, res, () => {});
  await getHandler(routePath, method)(req, res, () => {});
  return res;
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sandbox-197-"));
    sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
    fs.writeFileSync(sandboxPath, content);
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({ serverConfigPath: tmpDir, serverName: "TestServer" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sandbox-197-persist-"));
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({ serverConfigPath: tmpDir, serverName: "TestServer" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
});

describe("GET /sandbox/validate checks what the game checks", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sandbox-197-validate-"));
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({ serverConfigPath: tmpDir, serverName: "TestServer" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sandbox-197-restore-"));
    try {
      const sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
      const original = issue197File({ nestedFirst: false, eol: "\r\n" });
      fs.writeFileSync(sandboxPath, corrupt(original));
      getActiveServer.mockResolvedValue({ serverConfigPath: tmpDir, serverName: "TestServer" });
      getAllSettings.mockResolvedValue({});

      const res = await runHandler("/sandbox/repair", "post", {});
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, repaired: true }));
      expect(fs.readFileSync(sandboxPath, "utf-8")).toBe(original);
      expect(fs.readdirSync(path.join(tmpDir, "backups"))).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sandbox-197-repair-"));
    sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({ serverConfigPath: tmpDir, serverName: "TestServer" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sandbox-197-continued-"));
    sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({ serverConfigPath: tmpDir, serverName: "TestServer" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-sandbox-197-noop-"));
    sandboxPath = path.join(tmpDir, "TestServer_SandboxVars.lua");
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({ serverConfigPath: tmpDir, serverName: "TestServer" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
