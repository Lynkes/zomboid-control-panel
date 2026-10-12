import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The panel keeps the RCON password in its own settings AND writes it to
// RCONPassword= in the server .ini; the panel's RCON login only works while
// the game reads back the same text. Two things broke that:
//   1. setIniKeyLine() passed `${key}=${value}` to String.replace() as the
//      replacement, which reads "$$", "$&", "$'" and "$`" as a template:
//      "Pa$$w0rd" went to the file as "Pa$w0rd", "a$&b" as
//      "aRCONPassword=oldb". ensureRconConfigured() then judged the file
//      wrong at every start and rewrote the same wrong value again.
//   2. sanitizeIniValue() stripped "=" and ";" from the .ini copy only, so a
//      password with either was written as a different password than the
//      panel kept.
// The game itself (zombie.config.ConfigFile.read, run from the 42.21 jar)
// reads a value up to the first "=" and nothing else is special in it: ";" and
// "#" come back as written (see utils/rconPassword.js). So "=" and line
// breaks are refused where the password is saved, and everything else is
// written exactly as typed.

const loggers = vi.hoisted(() => new Map());
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createLogger: (source) => {
      if (!loggers.has(source)) {
        const fns = {};
        for (const level of ["error", "warn", "info", "http", "verbose", "debug", "silly", "log"]) fns[level] = vi.fn();
        loggers.set(source, fns);
      }
      return loggers.get(source);
    },
  };
});

const getActiveServer = vi.fn();
const setSetting = vi.fn(async () => {});
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: (...args) => setSetting(...args),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { default: router, ensureRconConfigured } = await import("../routes/server.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

let root;
let zomboidDataPath;
let iniPath;

function warnLines() {
  return loggers.get("API:Server").warn.mock.calls.map((call) => String(call[0]));
}

function server(rconPassword) {
  return { serverName: "servertest", rconPassword, rconPort: 27015, zomboidDataPath };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rcon-pw-"));
  zomboidDataPath = path.join(root, "Zomboid");
  fs.mkdirSync(path.join(zomboidDataPath, "Server"), { recursive: true });
  iniPath = path.join(zomboidDataPath, "Server", "servertest.ini");
  loggers.get("API:Server")?.warn.mockClear();
  setSetting.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  getActiveServer.mockReset();
});

describe("ensureRconConfigured() writes the RCON password exactly as it is", () => {
  const welcome = "ServerWelcomeMessage=hello";

  it.each([
    ["Pa$$w0rd"],
    ["a$&b"],
    ["A$'B"],
    ["A$`B"],
    ["with;semicolon#and-hash"],
    ['quote"and\'apostrophe\\backslash'],
    ["  inner spaces  kept"],
  ])("patches an existing RCONPassword line with %s", async (password) => {
    fs.writeFileSync(iniPath, `PVP=false\n${welcome}\nRCONPassword=old\nRCONPort=27015\n`, "utf-8");
    getActiveServer.mockResolvedValue(server(password));

    expect(await ensureRconConfigured()).toBe(true);

    // Exact file text: nothing duplicated, nothing from the old line left.
    expect(fs.readFileSync(iniPath, "utf-8")).toBe(
      `PVP=false\n${welcome}\nRCONPassword=${password}\nRCONPort=27015\n`,
    );
  });

  it("does not rewrite the file again once the password is right (no loop of wrong writes at every start)", async () => {
    fs.writeFileSync(iniPath, "RCONPassword=old\nRCONPort=27015\n", "utf-8");
    getActiveServer.mockResolvedValue(server("Pa$$w0rd"));
    await ensureRconConfigured();
    const first = fs.readFileSync(iniPath, "utf-8");
    expect(first).toBe("RCONPassword=Pa$$w0rd\nRCONPort=27015\n");

    fs.utimesSync(iniPath, new Date(1_000_000), new Date(1_000_000));
    expect(await ensureRconConfigured()).toBe(true);

    expect(fs.readFileSync(iniPath, "utf-8")).toBe(first);
    // Untouched: the fast path returned before writing.
    expect(fs.statSync(iniPath).mtimeMs).toBe(1_000_000);
  });

  it("pre-creates the ini with the password as it is", async () => {
    getActiveServer.mockResolvedValue(server("Pa$$w0rd;x"));

    expect(await ensureRconConfigured()).toBe(true);

    expect(fs.readFileSync(iniPath, "utf-8")).toContain("\nRCONPassword=Pa$$w0rd;x\n");
  });

  it("puts a password that used to be stored without its ';' back as the panel keeps it", async () => {
    // What the old code left in the ini for the panel's "ab;cd".
    fs.writeFileSync(iniPath, "RCONPassword=abcd\nRCONPort=27015\n", "utf-8");
    getActiveServer.mockResolvedValue(server("ab;cd"));

    expect(await ensureRconConfigured()).toBe(true);

    expect(fs.readFileSync(iniPath, "utf-8")).toBe("RCONPassword=ab;cd\nRCONPort=27015\n");
  });
});

describe("ensureRconConfigured() with a saved password the game can't read back from the ini", () => {
  it("leaves the ini as it is and warns, instead of writing a different password than the panel keeps", async () => {
    const before = "PVP=false\nRCONPassword=abcd\nRCONPort=27015\n";
    fs.writeFileSync(iniPath, before, "utf-8");
    getActiveServer.mockResolvedValue(server("ab=cd"));

    expect(await ensureRconConfigured()).toBe(false);

    expect(fs.readFileSync(iniPath, "utf-8")).toBe(before);
    const warnings = warnLines().filter((line) => line.includes(ErrorCode.RCON_PASSWORD_UNSUPPORTED_CHARS));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/RCON password/);
    expect(warnings[0]).toMatch(/"="/);
  });

  it.each([["abc "], ["abc\t"]])(
    "leaves the ini as it is for %j: the game trims the end of the line, so it would read a different password",
    async (password) => {
      const before = "RCONPassword=abc\nRCONPort=27015\n";
      fs.writeFileSync(iniPath, before, "utf-8");
      getActiveServer.mockResolvedValue({ ...server(password), name: `Blank End ${JSON.stringify(password)}` });

      expect(await ensureRconConfigured()).toBe(false);

      expect(fs.readFileSync(iniPath, "utf-8")).toBe(before);
    },
  );

  it("does not create an ini, or inject a second line, for a password with a line break", async () => {
    getActiveServer.mockResolvedValue(server("ab\nPublic=true"));

    expect(await ensureRconConfigured()).toBe(false);
    expect(fs.existsSync(iniPath)).toBe(false);

    fs.writeFileSync(iniPath, "RCONPassword=old\n", "utf-8");
    expect(await ensureRconConfigured()).toBe(false);
    expect(fs.readFileSync(iniPath, "utf-8")).toBe("RCONPassword=old\n");
  });

  it("warns once per server, not at every start-up poll", async () => {
    fs.writeFileSync(iniPath, "RCONPassword=abcd\n", "utf-8");
    getActiveServer.mockResolvedValue({ ...server("one=two"), name: "Warn Once Server" });

    for (let i = 0; i < 4; i++) await ensureRconConfigured();

    expect(
      warnLines().filter((line) => line.includes("Warn Once Server") && line.includes(ErrorCode.RCON_PASSWORD_UNSUPPORTED_CHARS)),
    ).toHaveLength(1);
  });
});

describe("POST /configure-rcon", () => {
  function getHandler(routePath) {
    const layer = router.stack.find(
      (entry) => entry.route?.path === routePath && entry.route.methods.post,
    );
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
  }

  function createResponse() {
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    return response;
  }

  async function configureRcon(body) {
    const response = createResponse();
    await getHandler("/configure-rcon")(
      { app: { get: () => ({ emit: vi.fn() }) }, body },
      response,
    );
    return response;
  }

  beforeEach(() => {
    getActiveServer.mockResolvedValue({
      zomboidDataPath,
      serverConfigPath: path.join(zomboidDataPath, "Server"),
      serverName: "servertest",
    });
  });

  it.each([["Pa$$w0rd"], ["a$&b"], ["A$'B"], ["semi;colon"]])(
    "writes %s to the ini and saves the same text in the panel's settings",
    async (password) => {
      fs.writeFileSync(iniPath, "PVP=false\nRCONPassword=old\nRCONPort=27015\n", "utf-8");

      const response = await configureRcon({ rconPassword: password, rconPort: 27016 });

      expect(response.status).not.toHaveBeenCalled();
      expect(fs.readFileSync(iniPath, "utf-8")).toBe(
        `PVP=false\nRCONPassword=${password}\nRCONPort=27016\n`,
      );
      expect(setSetting).toHaveBeenCalledWith("rconPassword", password);
    },
  );

  it.each([["ab=cd"], ["=lead"], ["trail="], ["line\nbreak"], ["carriage\rreturn"], ["trailing space "], ["trailing tab\t"]])(
    "refuses %j with a translated code and changes nothing",
    async (password) => {
      const before = "PVP=false\nRCONPassword=old\nRCONPort=27015\n";
      fs.writeFileSync(iniPath, before, "utf-8");

      const response = await configureRcon({ rconPassword: password, rconPort: 27016 });

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json.mock.calls[0][0].code).toBe(ErrorCode.RCON_PASSWORD_UNSUPPORTED_CHARS);
      expect(fs.readFileSync(iniPath, "utf-8")).toBe(before);
      expect(setSetting).not.toHaveBeenCalled();
    },
  );
});
