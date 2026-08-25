import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const getActiveServer = vi.fn();
const getAllSettings = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings,
}));

const {
  getServerName,
  getServerConfigPath,
  ServerNotConfiguredError,
  parseIni,
  toIni,
} = await import("../routes/serverFiles.js");

// Finding 2: serverName is interpolated straight into filesystem paths
// (`${serverName}.ini`, `${serverName}_SandboxVars.lua`, ...) throughout
// serverFiles.js. A serverName containing "../" must never reach those
// path.join() calls.
describe("getServerName (Finding 2: path traversal via serverName)", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
  });

  it("returns the active server's serverName unchanged when it is safe", async () => {
    getActiveServer.mockResolvedValue({ serverName: "MyServer" });
    await expect(getServerName()).resolves.toBe("MyServer");
  });

  it("throws instead of returning a traversal payload from the active server", async () => {
    getActiveServer.mockResolvedValue({ serverName: "../../etc/passwd" });
    await expect(getServerName()).rejects.toThrow(/invalid path characters/i);
  });

  it("throws instead of returning a traversal payload from legacy settings", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ serverName: "../../secrets" });
    await expect(getServerName()).rejects.toThrow(/invalid path characters/i);
  });

  it("falls back to legacy settings.serverName when there is no active server", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ serverName: "LegacyServer" });
    await expect(getServerName()).resolves.toBe("LegacyServer");
  });

  it("throws ServerNotConfiguredError instead of inventing 'servertest' when nothing is configured", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({});
    await expect(getServerName()).rejects.toThrow(ServerNotConfiguredError);
  });
});

// The panel used to invent a fully-populated "servertest" server pointing at
// ~/Zomboid/Server (Project Zomboid's own default install location) whenever
// nothing had actually been configured through Server Setup / My Servers. On
// a machine that happens to have a real PZ install at that vanilla path, the
// panel presented ITS real data as the panel's own "active server" -- data
// the panel has no record of ever being told about.
describe("getServerConfigPath (no server configured must not invent one)", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    getAllSettings.mockReset();
  });

  it("throws ServerNotConfiguredError rather than defaulting to ~/Zomboid/Server when nothing is configured", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({});
    await expect(getServerConfigPath()).rejects.toThrow(ServerNotConfiguredError);
  });

  it("throws even when an active server row exists but has no path anywhere and no legacy fallback either", async () => {
    // A server that is "configured" in name only (e.g. a corrupt/partial
    // profile) is exactly as unresolvable as no server at all -- there is
    // still nothing real to point at.
    getActiveServer.mockResolvedValue({ id: "1", serverName: "Ghost" });
    getAllSettings.mockResolvedValue({});
    await expect(getServerConfigPath()).rejects.toThrow(ServerNotConfiguredError);
  });

  // The bug was the fall-through PAST "nothing configured" to a default --
  // not the legacy-settings fallback chain itself, which real upgrades from
  // older installs depend on. Every tier of that chain must keep resolving
  // exactly as before.
  it("resolves the active server's explicit serverConfigPath when set", async () => {
    getActiveServer.mockResolvedValue({ serverConfigPath: "/srv/pz/Server" });
    getAllSettings.mockResolvedValue({});
    await expect(getServerConfigPath()).resolves.toBe("/srv/pz/Server");
  });

  it("falls back to the active server's zomboidDataPath + Server when no explicit config path is set", async () => {
    getActiveServer.mockResolvedValue({ zomboidDataPath: "/data/zomboid" });
    getAllSettings.mockResolvedValue({});
    const result = await getServerConfigPath();
    expect(result).toBe(path.join("/data/zomboid", "Server"));
  });

  it("falls back to legacy settings.serverConfigPath when there is no active server", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ serverConfigPath: "/legacy/Server" });
    await expect(getServerConfigPath()).resolves.toBe("/legacy/Server");
  });

  it("falls back to legacy settings.zomboidDataPath + Server when there is no active server", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({ zomboidDataPath: "/legacy/zomboid" });
    const result = await getServerConfigPath();
    expect(result).toBe(path.join("/legacy/zomboid", "Server"));
  });
});

describe("INI round-trip helpers", () => {
  it("writes a changed value back to the same key while preserving comments", () => {
    const original = "; server config\nMinutesPerPage=2\nPublic=true\n";
    const settings = { ...parseIni(original), MinutesPerPage: "3" };
    const written = toIni(settings, original);

    expect(written).toContain("; server config");
    expect(parseIni(written).MinutesPerPage).toBe("3");
    expect(parseIni(written).Public).toBe("true");
  });

  it("does not add empty values for keys absent from a new INI", () => {
    const written = toIni({ MinutesPerPage: "", Public: "true" });

    expect(written).toBe("Public=true");
  });
});
