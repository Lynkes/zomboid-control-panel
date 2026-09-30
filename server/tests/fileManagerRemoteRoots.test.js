import { describe, expect, it } from "vitest";
import { ErrorCode } from "../utils/errorCodes.js";
import { FmError } from "../services/fileManagerContract.js";
import {
  getRemoteRootsKey,
  resolveRemoteRoots,
  validateRemoteRootPath,
} from "../services/fileManagerRemoteRoots.js";

const LOGIN = {
  panelBridgeSftpHost: "pz.example.net",
  panelBridgeSftpPort: 2022,
  panelBridgeSftpUsername: "pz",
  panelBridgeSftpPassword: "not-used-here",
};
const KEY = "pz.example.net:2022:pz";

function roots(settings, isActive = true) {
  return resolveRemoteRoots({ profile: { id: "remote-1", provider: "remote-sftp" }, settings, isActive });
}

function byId(result) {
  return Object.fromEntries(result.roots.map((spec) => [spec.id, spec]));
}

function expectInvalid(fn, reason) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(FmError);
  expect(caught.code).toBe(ErrorCode.FM_INVALID_PATH);
  expect(caught.params).toEqual({ reason });
}

describe("resolveRemoteRoots", () => {
  it("derives data from a Server config folder and leaves config as a bookmark inside it", () => {
    const result = roots({ ...LOGIN, panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server" });
    expect(result.unavailable).toBeUndefined();
    expect(result.remote).toEqual({ host: "pz.example.net", port: 2022, username: "pz" });
    expect(result.key).toBe(KEY);
    expect(result.derivedDataPath).toBe("/home/pz/Zomboid");
    expect(result.roots).toEqual([
      { id: "install", path: null, warnings: [], unavailable: { reason: "remoteInstallNotSet" } },
      { id: "data", path: "/home/pz/Zomboid", warnings: [] },
    ]);
  });

  it("derives data from the bridge folder when the config folder isn't named Server", () => {
    const result = roots({
      ...LOGIN,
      panelBridgeSftpConfigPath: "/srv/cfg",
      panelBridgeSftpBridgePath: "/srv/pz/Zomboid/Lua/panelbridge/main",
    });
    expect(result.derivedDataPath).toBe("/srv/pz/Zomboid");
    expect(byId(result).data).toEqual({ id: "data", path: "/srv/pz/Zomboid", warnings: [] });
    // Outside data, so the config folder is its own root.
    expect(byId(result).config).toEqual({ id: "config", path: "/srv/cfg", warnings: [] });
  });

  it("matches a chrooted host's lower-case lua/panelbridge path", () => {
    const result = roots({ ...LOGIN, panelBridgeSftpBridgePath: "/server-data/lua/panelbridge/main" });
    expect(result.derivedDataPath).toBe("/server-data");
  });

  it("never derives the filesystem root", () => {
    const fromConfig = roots({ ...LOGIN, panelBridgeSftpConfigPath: "/Server" });
    expect(fromConfig.derivedDataPath).toBeNull();
    expect(byId(fromConfig).data).toEqual({ id: "data", path: null, warnings: [], unavailable: { reason: "remoteNotConfigured" } });
    const fromBridge = roots({ ...LOGIN, panelBridgeSftpBridgePath: "/Lua/panelbridge/main" });
    expect(fromBridge.derivedDataPath).toBeNull();
    const rootConfig = roots({ ...LOGIN, panelBridgeSftpConfigPath: "/" });
    expect(byId(rootConfig).config).toBeUndefined();
  });

  it("is unavailable per root when nothing gives a data folder", () => {
    const result = roots({ ...LOGIN });
    expect(result.derivedDataPath).toBeNull();
    expect(byId(result).data.unavailable).toEqual({ reason: "remoteNotConfigured" });
    expect(byId(result).install.unavailable).toEqual({ reason: "remoteInstallNotSet" });
  });

  it("lets the operator's folders win over the derived ones", () => {
    const result = roots({
      ...LOGIN,
      panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server",
      fileManagerRemoteRoots: { [KEY]: { installPath: "/home/pz/pzserver/", dataPath: "/data/zomboid" } },
    });
    expect(result.overrides).toEqual({ installPath: "/home/pz/pzserver", dataPath: "/data/zomboid" });
    expect(result.derivedDataPath).toBe("/home/pz/Zomboid");
    expect(result.roots).toEqual([
      { id: "install", path: "/home/pz/pzserver", warnings: [] },
      { id: "data", path: "/data/zomboid", warnings: [] },
      // No longer inside data, so it is offered on its own.
      { id: "config", path: "/home/pz/Zomboid/Server", warnings: [] },
    ]);
  });

  it("allows / only when the operator set it, with a warning", () => {
    const result = roots({
      ...LOGIN,
      fileManagerRemoteRoots: { [KEY]: { installPath: "/", dataPath: "/" } },
    });
    expect(byId(result).install).toEqual({ id: "install", path: "/", warnings: ["remoteFilesystemRoot"] });
    expect(byId(result).data).toEqual({ id: "data", path: "/", warnings: ["remoteFilesystemRoot"] });
  });

  it("is unavailable when the profile isn't the active one", () => {
    const result = roots({ ...LOGIN, panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server" }, false);
    expect(result.roots).toEqual([]);
    expect(result.unavailable).toEqual({ reason: "remoteNotActive" });
    // The login is still named, for the page's copy.
    expect(result.remote).toEqual({ host: "pz.example.net", port: 2022, username: "pz" });
  });

  it("is unavailable without an SFTP host or username", () => {
    for (const settings of [{}, { panelBridgeSftpHost: "  " }, { panelBridgeSftpHost: "pz.example.net" }]) {
      const result = roots({ ...settings, panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server" });
      expect(result.roots).toEqual([]);
      expect(result.unavailable).toEqual({ reason: "remoteNotConfigured" });
    }
    expect(roots({}).remote).toBeNull();
  });

  it("drops the override when the host, port or user changes", () => {
    const saved = { [KEY]: { installPath: "/home/pz/pzserver", dataPath: "/data/zomboid" } };
    for (const change of [
      { panelBridgeSftpHost: "other.example.net" },
      { panelBridgeSftpPort: 22 },
      { panelBridgeSftpUsername: "steam" },
    ]) {
      const result = roots({ ...LOGIN, ...change, panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server", fileManagerRemoteRoots: saved });
      expect(result.overrides).toEqual({ installPath: null, dataPath: null });
      expect(byId(result).install.unavailable).toEqual({ reason: "remoteInstallNotSet" });
      expect(byId(result).data.path).toBe("/home/pz/Zomboid");
    }
    // A password change keeps it: same server, new credentials.
    const samePlace = roots({ ...LOGIN, panelBridgeSftpPassword: "rotated", fileManagerRemoteRoots: saved });
    expect(samePlace.overrides.installPath).toBe("/home/pz/pzserver");
  });

  it("ignores stored overrides that fail validation", () => {
    const result = roots({
      ...LOGIN,
      panelBridgeSftpConfigPath: "/home/pz/Zomboid/Server",
      fileManagerRemoteRoots: { [KEY]: { installPath: "../etc", dataPath: "/home/pz/../../etc" } },
    });
    expect(result.overrides).toEqual({ installPath: null, dataPath: null });
    expect(byId(result).data.path).toBe("/home/pz/Zomboid");
    for (const junk of [null, "x", ["a"], { [KEY]: "not an object" }]) {
      expect(roots({ ...LOGIN, fileManagerRemoteRoots: junk }).overrides).toEqual({ installPath: null, dataPath: null });
    }
  });

  it("ignores unusable config and bridge paths", () => {
    const result = roots({
      ...LOGIN,
      panelBridgeSftpConfigPath: "relative/Server",
      panelBridgeSftpBridgePath: "/srv/pz/../../Lua/panelbridge/main",
    });
    expect(result.derivedDataPath).toBeNull();
    expect(byId(result).config).toBeUndefined();
  });
});

describe("getRemoteRootsKey", () => {
  it("keys on trimmed host, port (default 22) and user", () => {
    expect(getRemoteRootsKey(LOGIN)).toBe(KEY);
    expect(getRemoteRootsKey({ panelBridgeSftpHost: " pz.example.net ", panelBridgeSftpUsername: " pz " })).toBe("pz.example.net:22:pz");
    expect(getRemoteRootsKey({})).toBeNull();
  });
});

describe("validateRemoteRootPath", () => {
  it("normalizes absolute POSIX paths", () => {
    expect(validateRemoteRootPath("/home/pz/pzserver")).toBe("/home/pz/pzserver");
    expect(validateRemoteRootPath("/home//pz/./pzserver/")).toBe("/home/pz/pzserver");
    expect(validateRemoteRootPath("/srv/%2e%2e/x")).toBe("/srv/%2e%2e/x");
    expect(validateRemoteRootPath("/srv/..hidden")).toBe("/srv/..hidden");
  });

  it("treats empty values as not set", () => {
    expect(validateRemoteRootPath(null)).toBeNull();
    expect(validateRemoteRootPath(undefined)).toBeNull();
    expect(validateRemoteRootPath("")).toBeNull();
  });

  it("refuses unsafe paths with a reason", () => {
    expectInvalid(() => validateRemoteRootPath(42), "empty");
    expectInvalid(() => validateRemoteRootPath(`/${"a".repeat(500)}`), "tooLong");
    expectInvalid(() => validateRemoteRootPath("/srv/pz\0"), "control");
    expectInvalid(() => validateRemoteRootPath("/srv/pz\n"), "control");
    expectInvalid(() => validateRemoteRootPath("/srv/pz\r"), "control");
    expectInvalid(() => validateRemoteRootPath("/srv\\pz"), "backslash");
    expectInvalid(() => validateRemoteRootPath("srv/pz"), "notAbsolute");
    expectInvalid(() => validateRemoteRootPath("C:/pz"), "notAbsolute");
    expectInvalid(() => validateRemoteRootPath("/srv/../etc"), "dotSegment");
    expectInvalid(() => validateRemoteRootPath("/srv/pz/.."), "dotSegment");
  });

  it("accepts / only when allowed", () => {
    expectInvalid(() => validateRemoteRootPath("/"), "filesystemRoot");
    expectInvalid(() => validateRemoteRootPath("//"), "filesystemRoot");
    expect(validateRemoteRootPath("/", { allowSlash: true })).toBe("/");
    expect(validateRemoteRootPath("/./", { allowSlash: true })).toBe("/");
  });

  it("checks the length before anything else looks at the value", () => {
    expectInvalid(() => validateRemoteRootPath(`relative${"/..".repeat(300)}`), "tooLong");
  });
});
