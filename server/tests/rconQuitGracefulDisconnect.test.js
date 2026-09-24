import { describe, it, expect, vi } from "vitest";
import { RconService } from "../services/rcon.js";

// quit()'s own comment says a connection error right after sending "quit" is
// the EXPECTED outcome (the server closes the socket as it shuts down), and
// used to special-case that via a try/catch around this.execute(). But
// execute() has its own catch spanning its entire body that never rethrows
// -- every failure path, including every connection-error branch, resolves
// {success:false, ...} instead of rejecting (see execute()'s own comments).
// That means quit()'s catch could never run: a graceful quit whose
// connection reset mid-shutdown reported success:false, same as a quit that
// never reached the server at all. Concretely, scheduler.js's
// performRestart() reads quit()'s .success to decide whether to fall back to
// a forced stop -- a clean auto-restart quit was always taking that
// fallback path and logging "quit command failed" for something that
// worked.
describe("RconService.quit(): connection reset during shutdown reports success", () => {
  function makeService(executeResult) {
    const service = new RconService();
    service.execute = vi.fn(async () => executeResult);
    service._cleanupClient = vi.fn();
    return service;
  }

  it("reports success when the underlying command succeeds normally", async () => {
    const service = makeService({ success: true, response: "ok" });
    const result = await service.quit();
    expect(result).toEqual({ success: true, response: "ok" });
    expect(service.execute).toHaveBeenCalledWith("quit", {
      skipLog: false,
      retryOnConnectionError: false,
    });
  });

  it("reports success when the connection resets after quit was sent (server shutting down)", async () => {
    const service = makeService({
      success: false,
      error: "Connection was reset. Server may have restarted or crashed.",
      commandSent: true,
      transportError: true,
    });
    const result = await service.quit();
    expect(result).toEqual({ success: true, response: "Server shutting down" });
  });

  it("reports success when reconnection fails right after quit (server already gone)", async () => {
    const service = makeService({
      success: false,
      error: "Could not reconnect after multiple attempts. Server may be offline.",
      commandSent: true,
      transportError: true,
    });
    const result = await service.quit();
    expect(result.success).toBe(true);
  });

  it("still reports failure when quit was never actually sent (server starting)", async () => {
    const service = makeService({
      success: false,
      error: "Server is starting, please wait...",
    });
    const result = await service.quit();
    expect(result).toEqual({
      success: false,
      error: "Server is starting, please wait...",
    });
  });

  it("still reports failure when quit was never actually sent (server not running)", async () => {
    const service = makeService({
      success: false,
      error: "Server is not running",
    });
    const result = await service.quit();
    expect(result).toEqual({ success: false, error: "Server is not running" });
  });

  it("does not turn an authentication failure into a shutdown success", async () => {
    const service = makeService({
      success: false,
      error: "Authentication failed. Check RCON password in server settings.",
      commandSent: false,
      transportError: false,
    });

    const result = await service.quit();

    expect(result).toEqual({
      success: false,
      error: "Authentication failed. Check RCON password in server settings.",
      commandSent: false,
      transportError: false,
    });
  });

  it("does not turn a command rejected by an already-dead socket into shutdown success", async () => {
    const service = new RconService();
    service.connected = true;
    service.client = {
      connected: false,
      execute: vi.fn().mockRejectedValue(new Error("RCON not connected")),
      disconnect: vi.fn(),
    };

    const result = await service.quit({ skipLog: true });

    expect(result.success).toBe(false);
    expect(result.commandSent).toBe(false);
  });

  // round-8 bug hunt: sourceRcon.js's execute() rejects for two genuinely
  // different reasons, and until now both looked identical to this file --
  // (a) the write() call itself failed (EPIPE/ECONNRESET on the OS socket
  // write callback, e.g. server/utils/sourceRcon.js's own execute()) -- the
  // command's bytes never left this process, a DEFINITE non-send; vs (b)
  // the write succeeded but the connection dropped or timed out before a
  // response came back -- genuinely ambiguous, the command may well have
  // reached and been processed by the server. quit()'s own reclassification
  // above (connection reset after quit = success) is deliberately
  // optimistic for case (b) ("the normal case", per this file's header
  // comment). Applied to case (a) it is simply wrong: quit was never
  // transmitted, yet the operator would be told the server is shutting
  // down. Fixed by having sourceRcon.js tag a write()-callback failure with
  // `.rconNeverSent = true` (the one point where the OS gives an
  // unambiguous "this specific write did not go out" answer) and having
  // execute() here treat that as commandSent:false, the same way it
  // already treats the literal "RCON not connected" string. Simulated here
  // (rather than driving a real socket into EPIPE) by attaching the marker
  // sourceRcon.js now sets, same as this file's other tests fake the
  // client's execute() rejection shape rather than a real transport.
  it("does not turn quit into a false 'shutting down' success when the write itself never left the socket (EPIPE)", async () => {
    const service = new RconService();
    service.connected = true;
    const writeError = new Error("write EPIPE");
    writeError.code = "EPIPE";
    writeError.rconNeverSent = true;
    service.client = {
      connected: true,
      execute: vi.fn().mockRejectedValue(writeError),
      disconnect: vi.fn(),
    };

    const result = await service.quit({ skipLog: true });

    expect(result.success).toBe(false);
    expect(result.commandSent).toBe(false);
  });

  it("clears the connected flag and cleans up the client either way", async () => {
    const service = makeService({ success: true, response: "ok" });
    service.connected = true;
    await service.quit();
    expect(service.connected).toBe(false);
    expect(service._cleanupClient).toHaveBeenCalled();
  });
});
