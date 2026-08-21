import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();
const getAllSettings = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings,
}));

const { getServerName, parseIni, toIni } = await import("../routes/serverFiles.js");

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

  it("falls back to servertest when nothing is configured", async () => {
    getActiveServer.mockResolvedValue(null);
    getAllSettings.mockResolvedValue({});
    await expect(getServerName()).resolves.toBe("servertest");
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
