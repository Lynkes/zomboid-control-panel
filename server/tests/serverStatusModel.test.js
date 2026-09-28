import { describe, expect, it } from "vitest";
import {
  resolveProvider,
  buildHostSignal,
  buildServerSignal,
  buildBridgeSignal,
  buildSummary,
  composeServerStatus,
} from "../utils/serverStatusModel.js";

describe("resolveProvider", () => {
  it("defaults a local server to native", () => {
    expect(resolveProvider({ isRemote: false })).toBe("native");
  });

  it("maps isRemote to remote-sftp", () => {
    expect(resolveProvider({ isRemote: true })).toBe("remote-sftp");
  });

  it("honours an explicit provider field over isRemote", () => {
    expect(resolveProvider({ isRemote: true, provider: "docker-local" })).toBe(
      "docker-local",
    );
  });

  it("infers docker-local from legacy container fields", () => {
    expect(resolveProvider({ dockerContainerName: "pz-server" })).toBe(
      "docker-local",
    );
  });
});

describe("buildHostSignal", () => {
  it("reports native process state directly", () => {
    expect(buildHostSignal("native", true)).toEqual({
      status: "running",
      label: "Process",
      detail: null,
    });
    expect(buildHostSignal("native", false)).toEqual({
      status: "stopped",
      label: "Process",
      detail: null,
    });
  });

  it("reports remote-sftp hosts as unknown — no way to verify without SFTP", () => {
    const signal = buildHostSignal("remote-sftp", true);
    expect(signal.status).toBe("unknown");
    expect(signal.label).toBe("Host");
  });

  // GH#114: the host signal for a docker provider must come from the
  // managed-container lookup, never from the local process scan -- PZ runs
  // as PID 1 of a *different* container there, so a local scan can never
  // see it and would always, confidently, wrongly say stopped. isRunning
  // here is deliberately true and ignored, to prove the docker branch does
  // not read it.
  it("reports Docker container state from the managed-container lookup, ignoring the local scan", () => {
    expect(
      buildHostSignal("docker-local", true, false, { handled: true, running: true }),
    ).toEqual({ status: "running", label: "Container", detail: null });

    expect(
      buildHostSignal("docker-local", true, false, { handled: true, running: false }),
    ).toEqual({ status: "stopped", label: "Container", detail: null });
  });

  it("reports docker host state as unknown when Docker control is disabled/unavailable, not stopped", () => {
    // {handled: false} is resolveManagedContainer()'s shape for "Docker
    // control is disabled, the socket is unreachable, or the server has no
    // container mapped" -- must never silently fall back to the local scan,
    // which is the bug again with extra steps.
    const signal = buildHostSignal("docker-local", false, false, { handled: false });
    expect(signal.status).toBe("unknown");
    expect(signal.label).toBe("Container");
  });

  it("reports docker host state as unknown when no managed-container lookup was supplied at all", () => {
    expect(buildHostSignal("docker-local", true).status).toBe("unknown");
  });

  it("reports docker host state as unknown when the mapped container can't be resolved", () => {
    const signal = buildHostSignal("docker-local", false, false, {
      handled: true,
      container: null,
      error: 'Container "pz" is mapped to this server but the panel cannot manage it.',
    });
    expect(signal.status).toBe("unknown");
    expect(signal.detail).toMatch(/cannot manage it/);
  });

  it("falls back to not-applicable for an unrecognised provider", () => {
    expect(buildHostSignal("custom", true)).toEqual({
      status: "not-applicable",
      label: "Host",
      detail: null,
    });
  });

  // Regression: a native/docker host signal had no way to represent "we
  // could not determine this" -- isRunning is a plain boolean, so a failed
  // process-detection scan (isRunning: false, forced by the caller because
  // that's all a failed scan can return) rendered identically to a
  // confirmed stop. That is the exact disagreement an operator hit: the
  // dashboard confidently said "Server stopped" while /wipe's own fresh
  // check refused because detection itself was failing. Reuses the same
  // "unknown" status the client already renders correctly for remote-sftp.
  it("reports native host state as unknown when detection itself failed, not stopped", () => {
    const signal = buildHostSignal("native", false, true);
    expect(signal.status).toBe("unknown");
    expect(signal.label).toBe("Process");
    expect(signal.detail).toBeTruthy();
  });

  it("does not report unknown for native when the scan succeeded and simply found nothing", () => {
    expect(buildHostSignal("native", false, false).status).toBe("stopped");
    expect(buildHostSignal("native", false).status).toBe("stopped");
  });

  it("does not let a stale isRunning:true smuggle a confirmed state past a failed scan", () => {
    // scanFailed must win regardless of what isRunning says -- a caller
    // should never be able to pass a truthy isRunning alongside scanFailed
    // and get a confident "running" out the other side.
    expect(buildHostSignal("native", true, true).status).toBe("unknown");
  });

  // continuous-bug-hunt round 28 (ux-proposals-need-backend-data): a native
  // crash and a deliberate stop used to look identical -- both just
  // "stopped", detail: null. stopReason (server/index.js's
  // classifyStopReason() result) now fills that in for the stopped case
  // only; a running server never shows a stale reason from its last stop.
  describe("stopReason detail (round 28)", () => {
    it("describes a deliberate operator stop", () => {
      const signal = buildHostSignal("native", false, false, null, { reason: "stop" });
      expect(signal.status).toBe("stopped");
      expect(signal.detail).toBe("Stopped by an operator");
    });

    it("describes a restart in progress", () => {
      const signal = buildHostSignal("native", false, false, null, { reason: "restart" });
      expect(signal.detail).toBe("Restarting");
    });

    it("describes a crash with its exit code", () => {
      const signal = buildHostSignal("native", false, false, null, {
        reason: "crash",
        exitCode: 1,
        signal: null,
      });
      expect(signal.detail).toBe("Crashed (exit code 1)");
    });

    it("describes a crash with only a signal when no exit code was captured", () => {
      const signal = buildHostSignal("native", false, false, null, {
        reason: "crash",
        exitCode: null,
        signal: "SIGSEGV",
      });
      expect(signal.detail).toBe("Crashed (signal SIGSEGV)");
    });

    it("gives no detail for an unknown reason or no reason recorded at all", () => {
      expect(buildHostSignal("native", false, false, null, { reason: "unknown" }).detail).toBeNull();
      expect(buildHostSignal("native", false, false, null, null).detail).toBeNull();
      expect(buildHostSignal("native", false).detail).toBeNull();
    });

    it("never shows a stop reason while the server is reported running", () => {
      const signal = buildHostSignal("native", true, false, null, { reason: "crash", exitCode: 1 });
      expect(signal.status).toBe("running");
      expect(signal.detail).toBeNull();
    });
  });
});

describe("buildServerSignal", () => {
  it("reports connected with host:port detail", () => {
    expect(
      buildServerSignal({ connected: true, host: "127.0.0.1", port: 27015 }),
    ).toEqual({ status: "connected", label: "RCON", detail: "127.0.0.1:27015" });
  });

  it("reports connecting when a connection attempt is in flight", () => {
    expect(buildServerSignal({ connected: false, connecting: true }).status).toBe(
      "connecting",
    );
  });

  it("defaults to disconnected", () => {
    expect(buildServerSignal({}).status).toBe("disconnected");
  });
});

describe("buildBridgeSignal", () => {
  it("reports not-installed when never configured", () => {
    expect(buildBridgeSignal({ configured: false }).status).toBe("not-installed");
  });

  it("reports active only when running and the mod is responding", () => {
    expect(
      buildBridgeSignal({ configured: true, running: true, modConnected: true })
        .status,
    ).toBe("active");
  });

  it("reports offline when configured but not fully connected", () => {
    expect(
      buildBridgeSignal({ configured: true, running: true, modConnected: false })
        .status,
    ).toBe("offline");
    expect(
      buildBridgeSignal({ configured: true, running: false, modConnected: false })
        .status,
    ).toBe("offline");
  });
});

describe("buildSummary", () => {
  it("reads as a plain-English one-liner", () => {
    const host = { status: "running", label: "Process" };
    const server = { status: "disconnected", label: "RCON" };
    expect(buildSummary(host, server)).toBe("Process running, RCON disconnected");
  });
});

describe("composeServerStatus", () => {
  it("composes the full docker-container-running-but-rcon-down scenario", () => {
    const result = composeServerStatus({
      server: { isRemote: false },
      isRunning: true,
      rcon: { connected: false, host: "host.docker.internal", port: 27015 },
      bridge: { configured: true, running: false, modConnected: false },
    });

    expect(result).toEqual({
      provider: "native",
      selected: true,
      host: { status: "running", label: "Process", detail: null },
      server: {
        status: "disconnected",
        label: "RCON",
        detail: "host.docker.internal:27015",
      },
      bridge: { status: "offline", label: "PanelBridge", detail: null },
      summary: "Process running, RCON disconnected",
    });
  });

  it("composes a fully healthy native server", () => {
    const result = composeServerStatus({
      server: { isRemote: false },
      isRunning: true,
      rcon: { connected: true, host: "127.0.0.1", port: 27015 },
      bridge: { configured: true, running: true, modConnected: true },
    });

    expect(result.host.status).toBe("running");
    expect(result.server.status).toBe("connected");
    expect(result.bridge.status).toBe("active");
    expect(result.selected).toBe(true);
  });

  it("composes a native server whose host state can't be verified because detection failed", () => {
    const result = composeServerStatus({
      server: { isRemote: false },
      isRunning: false,
      scanFailed: true,
      rcon: { connected: false },
      bridge: { configured: false },
    });

    expect(result.provider).toBe("native");
    expect(result.host.status).toBe("unknown");
  });

  it("composes a remote server whose host state can't be verified", () => {
    const result = composeServerStatus({
      server: { isRemote: true },
      isRunning: false,
      rcon: { connected: true, host: "1.2.3.4", port: 27015 },
      bridge: { configured: true, running: true, modConnected: true },
    });

    expect(result.provider).toBe("remote-sftp");
    expect(result.host.status).toBe("unknown");
    expect(result.server.status).toBe("connected");
  });

  // GH#114: PZ in its own container, panel in another. The local process
  // scan correctly finds nothing (isRunning: false) because it can never see
  // a process outside its own container -- that must not become a confident
  // "stopped" now that the managed container itself reports Running: true.
  it("reports a mapped container as running from the Docker lookup, even though the local process scan found nothing", () => {
    const result = composeServerStatus({
      server: { dockerContainerName: "pz-server" },
      isRunning: false,
      scanFailed: false,
      dockerContainer: { handled: true, ref: "pz-server", running: true },
      rcon: { connected: true, host: "pz-server", port: 27015 },
      bridge: { configured: true, running: true, modConnected: true },
    });

    expect(result.provider).toBe("docker-local");
    expect(result.host).toEqual({ status: "running", label: "Container", detail: null });
  });

  it("reports a mapped container as unknown, not stopped, when Docker control is disabled", () => {
    const result = composeServerStatus({
      server: { dockerContainerName: "pz-server" },
      isRunning: false,
      dockerContainer: { handled: false },
      rcon: { connected: false },
      bridge: { configured: false },
    });

    expect(result.provider).toBe("docker-local");
    expect(result.host.status).toBe("unknown");
  });
});

// The dashboard's uptime and the Managed Servers card compute a live
// duration from host.startedAt, so it may only ever be a start time the
// same status confirmed: present for a running native process (the OS's
// answer) or a running container (Docker's own State.StartedAt), absent --
// "unknown" -- for everything else, never a placeholder.
describe("composeServerStatus host.startedAt", () => {
  const base = { rcon: { connected: true }, bridge: { configured: false } };

  it("carries a running native process's start time as an ISO string", () => {
    const result = composeServerStatus({
      ...base,
      server: { isRemote: false },
      isRunning: true,
      startedAt: new Date("2026-09-27T07:00:00.000Z"),
    });

    expect(result.host).toMatchObject({ status: "running", startedAt: "2026-09-27T07:00:00.000Z" });
  });

  it("leaves it out when the native start time isn't known", () => {
    const result = composeServerStatus({ ...base, server: { isRemote: false }, isRunning: true, startedAt: null });

    expect(result.host.status).toBe("running");
    expect(result.host).not.toHaveProperty("startedAt");
  });

  it("drops a start time for a host that isn't confirmed running (stopped or detection failed)", () => {
    const startedAt = new Date("2026-09-27T07:00:00.000Z");
    const stopped = composeServerStatus({ ...base, server: { isRemote: false }, isRunning: false, startedAt });
    const unknown = composeServerStatus({
      ...base, server: { isRemote: false }, isRunning: false, scanFailed: true, startedAt,
    });

    expect(stopped.host).not.toHaveProperty("startedAt");
    expect(unknown.host).not.toHaveProperty("startedAt");
  });

  it("never gives a remote SFTP host a start time, even if one is passed", () => {
    const result = composeServerStatus({
      ...base,
      server: { isRemote: true },
      isRunning: true,
      startedAt: new Date("2026-09-27T07:00:00.000Z"),
    });

    expect(result.host.status).toBe("unknown");
    expect(result.host).not.toHaveProperty("startedAt");
  });

  it("uses a running container's own State.StartedAt, not the native start time", () => {
    const result = composeServerStatus({
      ...base,
      server: { dockerContainerName: "pz-server" },
      isRunning: false,
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      dockerContainer: { handled: true, running: true, startedAt: "2026-09-26T21:15:03.123456789Z" },
    });

    expect(result.host).toMatchObject({ status: "running", startedAt: "2026-09-26T21:15:03.123Z" });
  });

  it("rejects Docker's zero time for a container that has never started", () => {
    const result = composeServerStatus({
      ...base,
      server: { dockerContainerName: "pz-server" },
      isRunning: false,
      dockerContainer: { handled: true, running: true, startedAt: "0001-01-01T00:00:00Z" },
    });

    expect(result.host).not.toHaveProperty("startedAt");
  });

  it("rejects a container start time in this host's future (a Docker VM clock drifted ahead) instead of counting from it", () => {
    const result = composeServerStatus({
      ...base,
      server: { dockerContainerName: "pz-server" },
      isRunning: false,
      dockerContainer: {
        handled: true,
        running: true,
        startedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    });

    expect(result.host.status).toBe("running");
    expect(result.host).not.toHaveProperty("startedAt");
  });
});
