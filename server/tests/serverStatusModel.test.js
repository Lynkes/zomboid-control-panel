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
