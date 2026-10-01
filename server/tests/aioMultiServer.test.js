import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { handlePanelUpdateDownload } from "../index.js";
import {
  formatEphemeralContainerPathError,
  resolveZomboidPaths,
} from "../routes/server.js";
import {
  attributeOtherRunningServers,
  findOtherRunningServers,
  ServerManager,
} from "../services/serverManager.js";
import { parseMountInfo } from "../utils/containerMountInfo.js";
import { ErrorCode } from "../utils/errorCodes.js";

// A second Project Zomboid server in the all-in-one container: where it may
// live, which data folder it gets, which running servers the panel can tell
// apart, and that a Docker update never kills one it didn't save.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "..", "client", "src", "locales");

// The all-in-one container's mounts: overlay root, then the named volumes.
const AIO_MOUNTS = parseMountInfo(`
525 382 0:101 / / rw,relatime - overlay overlay rw,lowerdir=/a:/b,upperdir=/c,workdir=/c
619 595 8:48 /data/docker/volumes/pz-server/_data /pz-server rw,relatime - ext4 /dev/sdd rw
620 595 8:48 /data/docker/volumes/zomboid-data/_data /zomboid rw,relatime - ext4 /dev/sdd rw
621 595 8:48 /data/docker/volumes/pz-servers/_data /pz-servers rw,relatime - ext4 /dev/sdd rw
`);
const OLD_AIO_MOUNTS = AIO_MOUNTS.filter((mount) => mount.mountPoint !== "/pz-servers");
const AIO_LAYOUT = {
  serversRoot: "/pz-servers",
  publishedGamePorts: { start: 16261, end: 16270 },
};

function interpolate(template, params) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    expect(Object.prototype.hasOwnProperty.call(params, name)).toBe(true);
    return String(params[name]);
  });
}

describe("formatEphemeralContainerPathError", () => {
  it("refuses /pz-server1 in the all-in-one image and points at the extra-servers volume", () => {
    const error = formatEphemeralContainerPathError("/pz-server1", {
      containerized: true,
      mounts: AIO_MOUNTS,
      layout: AIO_LAYOUT,
    });
    expect(error.code).toBe(ErrorCode.CONTAINER_PATH_NOT_PERSISTENT_AIO);
    expect(error.params).toEqual({ path: "/pz-server1", root: "/pz-servers" });
    expect(error.message).toContain("Use a folder inside /pz-servers.");
  });

  it("accepts a folder on a volume", () => {
    for (const folder of ["/pz-servers/second", "/pz-servers/second_Data", "/pz-server", "/zomboid"]) {
      expect(
        formatEphemeralContainerPathError(folder, { containerized: true, mounts: AIO_MOUNTS, layout: AIO_LAYOUT }),
      ).toBeNull();
    }
  });

  it("asks for bootstrap.sh when an older compose file has no extra-servers volume", () => {
    const error = formatEphemeralContainerPathError("/pz-servers/second", {
      containerized: true,
      mounts: OLD_AIO_MOUNTS,
      layout: AIO_LAYOUT,
    });
    expect(error.code).toBe(ErrorCode.CONTAINER_PATH_NOT_PERSISTENT_AIO_NO_VOLUME);
    expect(error.message).toContain("bootstrap.sh");
  });

  it("gives the generic advice in any other container", () => {
    const error = formatEphemeralContainerPathError("/srv/pz", {
      containerized: true,
      mounts: AIO_MOUNTS,
      layout: null,
    });
    expect(error.code).toBe(ErrorCode.CONTAINER_PATH_NOT_PERSISTENT);
    expect(error.params).toEqual({ path: "/srv/pz" });
  });

  it("says nothing outside a container, or when mountinfo can't be read", () => {
    expect(
      formatEphemeralContainerPathError("/pz-server1", { containerized: false, mounts: AIO_MOUNTS, layout: AIO_LAYOUT }),
    ).toBeNull();
    expect(
      formatEphemeralContainerPathError("/pz-server1", { containerized: true, mounts: null, layout: AIO_LAYOUT }),
    ).toBeNull();
  });

  it("has every param each locale's sentence needs", () => {
    const cases = [
      formatEphemeralContainerPathError("/pz-server1", { containerized: true, mounts: AIO_MOUNTS, layout: AIO_LAYOUT }),
      formatEphemeralContainerPathError("/pz-servers/x", { containerized: true, mounts: OLD_AIO_MOUNTS, layout: AIO_LAYOUT }),
      formatEphemeralContainerPathError("/srv/pz", { containerized: true, mounts: AIO_MOUNTS, layout: null }),
    ];
    for (const locale of fs.readdirSync(LOCALES_DIR)) {
      const file = path.join(LOCALES_DIR, locale, "errors.json");
      if (!fs.existsSync(file)) continue;
      const errors = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const error of cases) {
        expect(errors[error.code], `${locale} ${error.code}`).toBeTruthy();
        expect(interpolate(errors[error.code], error.params)).toContain(error.params.path);
      }
    }
  });
});

describe("resolveZomboidPaths with the all-in-one environment", () => {
  const original = { server: process.env.PZ_SERVER_PATH, save: process.env.PZ_SAVE_PATH };
  afterEach(() => {
    for (const [key, value] of [["PZ_SERVER_PATH", original.server], ["PZ_SAVE_PATH", original.save]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("keeps /zomboid for the install it belongs to, and gives another install its own _Data folder", () => {
    process.env.PZ_SERVER_PATH = path.resolve("/pz-server");
    process.env.PZ_SAVE_PATH = path.resolve("/zomboid");

    const first = resolveZomboidPaths(path.resolve("/pz-server"), null);
    expect(first.zomboidPath).toBe(path.resolve("/zomboid"));
    expect(first.usesEnvironmentDataPath).toBe(true);

    const second = resolveZomboidPaths(path.resolve("/pz-servers/second"), null);
    expect(second.zomboidPath).toBe(path.resolve("/pz-servers/second") + "_Data");
    expect(second.usesEnvironmentDataPath).toBe(false);
  });

  it("still applies PZ_SAVE_PATH everywhere when PZ_SERVER_PATH isn't set", () => {
    delete process.env.PZ_SERVER_PATH;
    process.env.PZ_SAVE_PATH = path.resolve("/zomboid");
    expect(resolveZomboidPaths(path.resolve("/anywhere"), null).zomboidPath).toBe(path.resolve("/zomboid"));
  });
});

const MAIN = {
  id: "main",
  name: "Main",
  serverName: "servertest",
  installPath: "/pz-server",
  zomboidDataPath: "/zomboid",
};
const SECOND = {
  id: "second",
  name: "Second",
  serverName: "second",
  installPath: "/pz-servers/second",
  zomboidDataPath: "/pz-servers/second_Data",
};
const process_ = (serverName, cachedir, pid) => ({
  pid,
  cmd: `/pz-server/jre64/bin/java -Djava.awt.headless=true zombie.network.GameServer -servername ${serverName} -cachedir=${cachedir}`,
});

describe("attributeOtherRunningServers", () => {
  it("names the other profile whose process is running and skips the excluded server's", () => {
    const result = attributeOtherRunningServers(
      [process_("servertest", "/zomboid", 10), process_("second", "/pz-servers/second_Data", 11)],
      [MAIN, SECOND],
      MAIN,
    );
    expect(result.servers.map((server) => server.id)).toEqual(["second"]);
    expect(result.unattributed).toEqual([]);
  });

  it("reports a process no profile owns", () => {
    const result = attributeOtherRunningServers(
      [process_("stranger", "/elsewhere", 12)],
      [MAIN, SECOND],
      MAIN,
    );
    expect(result.servers).toEqual([]);
    expect(result.unattributed.map((entry) => entry.pid)).toEqual([12]);
  });

  it("leaves an argument-less stock launch to the excluded server when it has no process of its own", () => {
    // No -servername, no -cachedir and no install path: it names nobody.
    const stock = { pid: 13, cmd: "./jre64/bin/java zombie.network.GameServer" };
    expect(attributeOtherRunningServers([stock], [MAIN, SECOND], MAIN)).toEqual({
      servers: [],
      unattributed: [],
    });
  });
});

describe("findOtherRunningServers", () => {
  it("passes a failed scan through instead of guessing", async () => {
    const scanner = { scanHostForServerProcesses: async () => ({ matched: [], scanFailed: true }) };
    await expect(findOtherRunningServers(MAIN, { servers: [MAIN, SECOND], scanner })).resolves.toEqual({
      scanFailed: true,
      servers: [],
      unattributed: [],
    });
  });
});

describe("Docker update with another server running", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses before saving or stopping the active server", async () => {
    vi.spyOn(ServerManager.prototype, "scanHostForServerProcesses").mockResolvedValue({
      matched: [process_("someone_else", "/pz-servers/someone_else_Data", 21)],
      scanFailed: false,
    });
    const getServerProcessDetails = vi.spyOn(ServerManager.prototype, "getServerProcessDetails");
    const downloadUpdate = vi.fn();
    const rconService = { connected: true, save: vi.fn(), quit: vi.fn() };
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);

    await handlePanelUpdateDownload(
      {
        body: { confirm: true },
        app: {
          get: (key) => {
            if (key === "panelUpdateChecker") return { dockerUpdateProxy: { enabled: true }, downloadUpdate };
            if (key === "rconService") return rconService;
            return undefined;
          },
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "OTHER_SERVERS_RUNNING", params: { names: "PID 21" } }),
    );
    expect(rconService.save).not.toHaveBeenCalled();
    expect(getServerProcessDetails).not.toHaveBeenCalled();
    expect(downloadUpdate).not.toHaveBeenCalled();
  });
});
