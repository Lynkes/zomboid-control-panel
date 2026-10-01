import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SFTP_SERVER_REQUIRED, sftpServerSkipReason, startOpensshSftpServer } from "./helpers/opensshSftpServer.js";

// PanelBridge's SFTP sync, and the two other SFTP clients (Server Config's
// remote files and the remote log viewer), against a REAL OpenSSH
// sftp-server (helpers/opensshSftpServer.js).
//
// When a host's sftp-server exits or is killed while the SSH connection
// stays up, the SFTP channel closes and ssh2 never answers another request
// sent on it, while ssh2-sftp-client only hears of a connection that
// closes. The sync then waited forever on its next call, and with `syncing`
// stuck the bridge never synced again until the panel restarted. A request
// the server stops answering (a wedged host) did the same.

const { PanelBridgeSftpTransport, _setBridgeSftpTimeoutsForTests, listSftpLogs, testSftpBridge } = await import(
  "../services/panelBridgeSftp.js"
);
const { listRemoteConfigFiles, pullRemoteConfigFiles } = await import("../services/remoteConfigFiles.js");

const suite = sftpServerSkipReason ? describe.skip : describe;
if (sftpServerSkipReason) {
  (SFTP_SERVER_REQUIRED ? describe : describe.skip)(`PanelBridge SFTP over real OpenSSH (${sftpServerSkipReason})`, () => {
    it("needs an sftp-server binary", () => {
      throw new Error(sftpServerSkipReason);
    });
  });
}

let srv;
let cacheDir;
let transport;

const bridgeRel = "Zomboid/Lua/panelbridge/servertest";
const settle = async (promise, ms) => {
  const started = Date.now();
  let outcome;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms)),
    ]);
    outcome = "resolved";
  } catch (err) {
    outcome = err.message;
  }
  return { outcome, elapsed: Date.now() - started };
};

function transportConfig() {
  return {
    host: "127.0.0.1",
    port: srv.port,
    username: "pz",
    password: "pw",
    bridgePath: srv.remote(bridgeRel),
    pollIntervalSeconds: 10,
  };
}

beforeEach(async () => {
  if (sftpServerSkipReason) return;
  srv = await startOpensshSftpServer();
  srv.fs.writeFile(`${bridgeRel}/status.json`, '{"n":1}');
  srv.fs.writeFile("Zomboid/Server/servertest.ini", "PVP=true\n");
  srv.fs.writeFile("Zomboid/Logs/console.txt", "log\n");
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-bridge-cache-"));
});

afterEach(async () => {
  if (sftpServerSkipReason) return;
  _setBridgeSftpTimeoutsForTests?.();
  await transport?.stop();
  transport = null;
  await srv.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

suite("PanelBridge's SFTP sync over real OpenSSH", () => {
  it("syncs again after the host's sftp-server is killed under a live connection", async () => {
    transport = new PanelBridgeSftpTransport();
    await transport.start(transportConfig(), cacheDir);
    // start()'s own timer would race the syncs below.
    clearInterval(transport.timer);
    expect(fs.readFileSync(path.join(cacheDir, "status.json"), "utf8")).toBe('{"n":1}');

    srv.killSessions();
    await srv.settle();
    srv.fs.writeFile(`${bridgeRel}/status.json`, '{"n":2}');
    const first = await settle(transport.syncNow(), 8000);
    expect(first.outcome).toBe("resolved");
    expect(transport.syncing).toBe(false);
    // The next sync (or this one) reconnects and copies the new status.
    if (fs.readFileSync(path.join(cacheDir, "status.json"), "utf8") !== '{"n":2}') {
      const second = await settle(transport.syncNow(), 8000);
      expect(second.outcome).toBe("resolved");
    }
    expect(fs.readFileSync(path.join(cacheDir, "status.json"), "utf8")).toBe('{"n":2}');
    expect(transport.lastError).toBeNull();
  });

  it("a request the host stops answering fails the sync after the call limit, and the next one works", async () => {
    _setBridgeSftpTimeoutsForTests({ callMs: 1500 });
    transport = new PanelBridgeSftpTransport();
    await transport.start(transportConfig(), cacheDir);
    clearInterval(transport.timer);
    srv.stall(true);
    const stalled = await settle(transport.syncNow(), 8000);
    expect(stalled.outcome).toBe("resolved");
    expect(transport.lastError).toMatch(/timeout/i);
    expect(transport.getStatus().lastErrorCode).toBe("SFTP_UNREACHABLE");
    expect(transport.syncing).toBe(false);
    srv.stall(false);
    srv.fs.writeFile(`${bridgeRel}/status.json`, '{"n":3}');
    const next = await settle(transport.syncNow(), 8000);
    expect(next.outcome).toBe("resolved");
    expect(transport.lastError).toBeNull();
    expect(fs.readFileSync(path.join(cacheDir, "status.json"), "utf8")).toBe('{"n":3}');
  });

  it("stop() returns on a connection that no longer answers", async () => {
    transport = new PanelBridgeSftpTransport();
    await transport.start(transportConfig(), cacheDir);
    clearInterval(transport.timer);
    srv.stall(true);
    const stopped = await settle(transport.stop(), 6000);
    expect(stopped.outcome).toBe("resolved");
    srv.stall(false);
  });
});

suite("Server Config's remote files and the log viewer over real OpenSSH", () => {
  const configTransport = () => ({
    host: "127.0.0.1",
    port: srv.port,
    username: "pz",
    password: "pw",
    configPath: srv.remote("Zomboid/Server"),
  });

  it("a pull whose sftp-server dies part way fails, and leaves the mirror as it was", async () => {
    const first = await pullRemoteConfigFiles(configTransport(), "servertest");
    const mirrored = path.join(first.mirrorDir, "servertest.ini");
    expect(fs.readFileSync(mirrored, "utf8")).toBe("PVP=true\n");
    // Killed as it reads the pull's first request: that one gets no answer,
    // and every later one goes out on a closed channel. Those used to be
    // taken for files missing on the host (the mirror copies deleted, the
    // pull "done"), or never answered at all.
    srv.onRequest = (entry) => {
      if (entry.op === "STAT" || entry.op === "LSTAT") {
        srv.onRequest = null;
        srv.killSessions();
      }
    };
    const pulled = await settle(pullRemoteConfigFiles(configTransport(), "servertest"), 8000);
    expect(pulled.outcome).not.toMatch(/still waiting/);
    expect(pulled.outcome).not.toBe("resolved");
    expect(fs.readFileSync(mirrored, "utf8")).toBe("PVP=true\n");
    // And the next one works.
    const again = await pullRemoteConfigFiles(configTransport(), "servertest");
    expect(again.manifest["servertest.ini"]).toBeTruthy();
    expect(again.manifest["servertest_spawnpoints.lua"]).toBeNull();
  });

  it("a host that stops answering fails a listing after the session limit", async () => {
    _setBridgeSftpTimeoutsForTests({ sessionMs: 1500 });
    srv.stall(true);
    const configList = await settle(listRemoteConfigFiles(configTransport()), 8000);
    expect(configList.outcome).toMatch(/timeout/i);
    const logs = await settle(listSftpLogs({ ...configTransport(), logPath: srv.remote("Zomboid/Logs") }), 8000);
    expect(logs.outcome).toMatch(/timeout/i);
    const tested = await settle(testSftpBridge(transportConfig()), 8000);
    expect(tested.outcome).toMatch(/timeout/i);
    srv.stall(false);
  });
});
