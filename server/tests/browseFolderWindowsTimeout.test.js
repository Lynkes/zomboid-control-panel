import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

// platform-divergence-sweep fix (2026-09-10, god-dispatched, conversation
// platform-divergence-sweep): POST /browse-folder's Windows branch spawned
// powershell for the FolderBrowserDialog with no timeout at all, while the
// sibling Linux branch a few lines above bounds both zenity and kdialog with
// { timeout: 120000 } each. There is also no global HTTP request timeout
// anywhere in index.js (no requestTimeout/headersTimeout configured), so a
// dialog left open -- lost focus behind another window (a known WinForms/STA
// quirk) or the operator simply walking away -- hung the request forever.
//
// Proven here by mocking spawn() to return a child that never emits 'close'
// on its own (exactly that stuck-dialog shape), forcing the WINDOWS branch
// via a process.platform override (same convention as
// steamcmdDownloadConcurrency.test.js/linuxScanExcludesOwnProcess.test.js in
// this directory, not an isWindows-skip), and advancing fake timers past
// 120000ms. Without the fix this test times out waiting for a response that
// never comes; with it, kill() fires and the route resolves with the same
// { success: false, path: null, cancelled: true } shape Linux's own
// abandoned-dialog case already returns -- no new response shape to learn.

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
    // A real kill() eventually produces a close event with no stdout --
    // mirrored here so the route's own close handler still runs and
    // resolves the response, the same as it would against a real process.
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

describe("POST /api/server/browse-folder (Windows): a stuck dialog no longer hangs the request forever", () => {
  it("kills the dialog and resolves the request after 120000ms when it never closes on its own", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    vi.useFakeTimers();
    const handler = getBrowseFolderHandler(await freshRouter());
    const response = createResponse();
    const req = { body: { description: "Select a folder" } };

    await handler(req, response);

    // The dialog never emits stdout/close on its own here -- exactly a
    // FolderBrowserDialog left open behind another window.
    expect(fakeChild.kill).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120000);

    expect(fakeChild.kill).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      path: null,
      cancelled: true,
    });
  });

  it("does not kill or double-respond when the dialog closes normally well before the timeout", async () => {
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    vi.useFakeTimers();
    const handler = getBrowseFolderHandler(await freshRouter());
    const response = createResponse();
    const req = { body: { description: "Select a folder" } };

    await handler(req, response);

    fakeChild.stdout.emit("data", Buffer.from("D:\\Games\\pzserver\n"));
    fakeChild.emit("close", 0);

    expect(response.json).toHaveBeenCalledWith({
      success: true,
      path: "D:\\Games\\pzserver",
      cancelled: false,
    });

    await vi.advanceTimersByTimeAsync(120000);

    // The timeout must have been cleared on the real close -- it must not
    // fire a second, stale kill()/response after the request already
    // resolved.
    expect(fakeChild.kill).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledTimes(1);
  });

  it("reports an error, not a plain cancel, when the PowerShell script itself fails", async () => {
    // A genuine script failure (e.g. no interactive desktop session for the
    // STA COM dialog, a missing assembly, a syntax error) exits with a real
    // non-zero code and empty stdout -- output-wise INDISTINGUISHABLE from an
    // ordinary Cancel click (which also exits 0 with empty stdout... wait,
    // exits 0). The two cases only differ in `code`: a real user Cancel is
    // `$result -eq 'OK'` being false, which still reaches `Write-Output ''`
    // and a normal exit 0; only an actual script failure exits non-zero.
    const fakeChild = new FakeChild();
    spawnMock.mockReturnValue(fakeChild);

    vi.useFakeTimers();
    const handler = getBrowseFolderHandler(await freshRouter());
    const response = createResponse();
    const req = { body: { description: "Select a folder" } };

    await handler(req, response);

    fakeChild.stderr.emit(
      "data",
      Buffer.from("Exception calling \"ShowDialog\": no desktop session\n"),
    );
    fakeChild.emit("close", 1);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "BROWSE_FOLDER_OPEN_FAILED" }),
    );
    expect(response.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: true }),
    );
  });
});
