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

  it("reports Docker container state directly", () => {
    expect(buildHostSignal("docker-local", true)).toEqual({
      status: "running",
      label: "Container",
      detail: null,
    });
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

  it("reports docker host state as unknown when detection itself failed", () => {
    const signal = buildHostSignal("docker-local", false, true);
    expect(signal.status).toBe("unknown");
    expect(signal.label).toBe("Container");
  });

  it("does not report unknown for native/docker when the scan succeeded and simply found nothing", () => {
    expect(buildHostSignal("native", false, false).status).toBe("stopped");
    expect(buildHostSignal("native", false).status).toBe("stopped");
  });

  it("does not let a stale isRunning:true smuggle a confirmed state past a failed scan", () => {
    // scanFailed must win regardless of what isRunning says -- a caller
    // should never be able to pass a truthy isRunning alongside scanFailed
    // and get a confident "running" out the other side.
    expect(buildHostSignal("native", true, true).status).toBe("unknown");
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
});
