import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

// Security regression (EXEC-2): POST /api/server/browse-folder's Windows
// branch used to build its PowerShell -Command from the request's
// `initialPath`, escaping only the ASCII single quote ('' -> ''). A
// typographic single quote (U+2018-U+201B), which the PowerShell parser
// treats like an ASCII ', broke out of the single-quoted `Test-Path '...'`
// literal and ran as PowerShell -- arbitrary code as the panel account, from
// a non-admin role holding only server.install.
//
// Two independent guarantees are asserted here, each of which FAILS on the
// pre-fix code:
//   1. Root fix -- the request value is passed OUT-OF-BAND via an
//      environment variable ($env:ZCP_INITIAL_PATH) and never appears in the
//      -Command source at all, so nothing in it can be parsed as PowerShell.
//   2. Defense-in-depth -- an `initialPath` carrying a control character, a
//      quote (ASCII or the typographic family), a backtick or `$` is refused
//      outright with 400 BROWSE_FOLDER_INVALID_PATH before anything spawns.
//
// Same win32-override + spawn-mock convention as browseFolderWindowsTimeout.test.js.

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", {
  value: "win32",
  configurable: true,
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kill = vi.fn(() => {
      this.emit("close", null);
    });
  }
}

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

const { getSettingMock, setSettingMock } = vi.hoisted(() => ({
  getSettingMock: vi.fn(async () => null),
  setSettingMock: vi.fn(async () => {}),
}));
vi.mock("../database/init.js", () => ({
  getSetting: (...args) => getSettingMock(...args),
  setSetting: (...args) => setSettingMock(...args),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

afterAll(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
});

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getBrowseFolderHandler(router) {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/browse-folder" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function freshRouter() {
  vi.resetModules();
  const { default: router } = await import("../routes/server.js");
  return router;
}

// Pulls the string handed to `powershell -Command` and the env passed to
// spawn() out of the last spawn() call.
function lastSpawn() {
  const call = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
  const args = call[1];
  const opts = call[2] || {};
  return { script: args[args.length - 1], env: opts.env || {} };
}

describe("POST /api/server/browse-folder (Windows): PowerShell injection via initialPath", () => {
  it("passes a legitimate initialPath out-of-band (env var), never interpolated into the -Command source", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    vi.useFakeTimers();
    const handler = getBrowseFolderHandler(await freshRouter());
    const response = createResponse();
    // No forbidden characters: this path is accepted, so the only thing that
    // can keep it out of the script is the out-of-band env-var fix itself.
    // isValidPath() follows the host's own path rules, so on a Linux CI
    // runner a C:\ path is "not absolute" and is (correctly) dropped. Use a
    // path that is valid where the test runs; the route's Windows branch is
    // what's under test either way.
    const initialPath =
      process.platform === "win32" ? "C:\\Servers\\MyPZ_InjectionMarker" : "/srv/servers/MyPZ_InjectionMarker";
    await handler({ body: { initialPath, description: "Select a folder" } }, response);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const { script, env } = lastSpawn();

    // Root cause: the path must not appear in the PowerShell source at all.
    expect(script).not.toContain("MyPZ_InjectionMarker");
    expect(script).toContain("$env:ZCP_INITIAL_PATH");
    // It travels as data instead.
    expect(env.ZCP_INITIAL_PATH).toBe(initialPath);
    // The dialog title is handed over the same way.
    expect(script).toContain("$env:ZCP_FOLDER_DIALOG_DESC");
    expect(env.ZCP_FOLDER_DIALOG_DESC).toBe("Select a folder");

    // Behaviour unchanged: a normal selection still resolves success.
    fakeChild.stdout.emit("data", Buffer.from(initialPath + "\n"));
    fakeChild.emit("close", 0);
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      path: initialPath,
      cancelled: false,
    });
  });

  it("refuses an initialPath with a typographic single quote (U+2019) that used to break out of the PS literal", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const handler = getBrowseFolderHandler(await freshRouter());
    const response = createResponse();
    // The verifier's working exploit: U+2019 closes the ASCII '...' literal,
    // then the rest runs as PowerShell. Must be refused before any spawn.
    const initialPath =
      "C:\\Temp\u2019) { } Set-Content -LiteralPath \"C:\\pwned.txt\" -Value x #";
    await handler({ body: { initialPath, description: "Select a folder" } }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "BROWSE_FOLDER_INVALID_PATH" }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ["ASCII single quote", "C:\\Temp'; calc; '"],
    ["backtick", "C:\\Temp`whoami`"],
    ["dollar sign", "C:\\Temp$(calc)"],
    ["carriage return / line feed", "C:\\Temp\r\nSet-Content x"],
  ])("refuses an initialPath containing a %s", async (_label, initialPath) => {
    spawnMock.mockReturnValue(new FakeChild());

    const handler = getBrowseFolderHandler(await freshRouter());
    const response = createResponse();
    await handler({ body: { initialPath, description: "Select a folder" } }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "BROWSE_FOLDER_INVALID_PATH" }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
