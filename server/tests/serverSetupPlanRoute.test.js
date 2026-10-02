import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// GET /api/server/setup-plan: what Server Setup reads before creating
// another server on this host. Gated like the rest of setup
// (server.install). In the all-in-one image it offers the extra-servers
// folder only when that folder really is a volume; elsewhere it offers the
// active install's parent folder, in a container only on a volume.

const state = vi.hoisted(() => ({ servers: [], mountinfo: null, containerized: false }));

vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(async () => state.servers.map((server) => ({ ...server }))),
}));

vi.mock("../utils/dockerDetect.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isContainerized: () => state.containerized,
}));

// The route asks about this container's own /proc/self/mountinfo; the test
// hands it a fixture instead.
vi.mock("../utils/containerMountInfo.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isOnContainerRootLayer: (targetPath, mounts) =>
      actual.isOnContainerRootLayer(
        targetPath,
        mounts !== undefined
          ? mounts
          : state.mountinfo === null
            ? null
            : actual.parseMountInfo(state.mountinfo),
      ),
  };
});

const { default: router } = await import("../routes/server.js");

const ROOT_ONLY = `
525 382 0:101 / / rw,relatime - overlay overlay rw,lowerdir=/a:/b,upperdir=/c,workdir=/c
619 595 8:48 /data/docker/volumes/pz-server/_data /pz-server rw,relatime - ext4 /dev/sdd rw
620 595 8:48 /data/docker/volumes/zomboid-data/_data /zomboid rw,relatime - ext4 /dev/sdd rw
`;
const WITH_SERVERS_VOLUME = `${ROOT_ONLY}621 595 8:48 /data/docker/volumes/pz-servers/_data /pz-servers rw,relatime - ext4 /dev/sdd rw
`;

const MAIN = {
  id: "main",
  name: "Main",
  serverName: "servertest",
  installPath: "/pz-server",
  serverPort: 16261,
  rconPort: 27015,
};
const REMOTE = {
  id: "remote",
  name: "Elsewhere",
  serverName: "elsewhere",
  isRemote: true,
  serverPort: 16263,
  rconPort: 27016,
};

const AIO_ENV = {
  PANEL_ALL_IN_ONE: "true",
  PZ_EXTRA_SERVERS_PATH: "/pz-servers",
  PZ_PUBLISHED_GAME_PORTS: "16261-16270",
};
const ENV_KEYS = [...Object.keys(AIO_ENV), "PZ_SERVER_PATH", "PZ_SAVE_PATH"];
const savedEnv = {};

function setEnv(values) {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

// A native install in this OS's own path shape.
const NATIVE_INSTALL = path.resolve("/srv/games/pz-main");
const NATIVE = {
  id: "native",
  name: "Native",
  serverName: "servertest",
  installPath: NATIVE_INSTALL,
  zomboidDataPath: `${NATIVE_INSTALL}_Data`,
  isActive: true,
};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  setEnv({});
  state.servers = [MAIN, REMOTE];
  state.mountinfo = null;
  state.containerized = false;
});

afterEach(() => {
  setEnv(savedEnv);
});

function createResponse() {
  const response = { statusCode: 200, body: undefined };
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
}

// The gate, then the handler when the gate lets the request through, as
// Express would run them.
async function getSetupPlan(user) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/setup-plan" && entry.route.methods.get,
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const req = { user, query: {} };
  const res = createResponse();
  for (const handler of handlers) {
    let next = false;
    await handler(req, res, () => {
      next = true;
    });
    if (!next) break;
  }
  return res;
}

describe("GET /api/server/setup-plan permissions", () => {
  it("asks for a login without a session", async () => {
    const res = await getSetupPlan(undefined);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("refuses a role without server.install", async () => {
    const res = await getSetupPlan({ role: "moderator" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("answers a technician", async () => {
    const res = await getSetupPlan({ role: "technician" });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /api/server/setup-plan response", () => {
  it("lists the local profiles' ports and the next free ones, with no all-in-one section elsewhere", async () => {
    const res = await getSetupPlan({ role: "admin" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      usedPorts: [
        {
          id: "main",
          name: "Main",
          serverName: "servertest",
          installPath: "/pz-server",
          // MAIN names no data folder: the game's default.
          dataPath: path.join(os.homedir(), "Zomboid"),
          gamePort: 16261,
          udpPort: 16262,
          rconPort: 27015,
        },
      ],
      suggestedPorts: { gamePort: 16263, rconPort: 27016, withinPublishedRange: null },
      allInOne: null,
      hostLayout: { serversRoot: path.dirname(path.normalize("/pz-server")), separator: path.sep },
      environmentDataPath: null,
    });
  });

  it("offers the active install's parent folder outside the all-in-one image", async () => {
    state.servers = [MAIN, NATIVE, REMOTE];

    const res = await getSetupPlan({ role: "admin" });

    expect(res.body.hostLayout).toEqual({ serversRoot: path.dirname(NATIVE_INSTALL), separator: path.sep });
    expect(res.body.usedPorts.find((entry) => entry.id === "native").dataPath).toBe(`${NATIVE_INSTALL}_Data`);
  });

  it("passes on the PZ_SAVE_PATH rule resolveZomboidPaths() applies", async () => {
    setEnv({ PZ_SERVER_PATH: "/pz-server", PZ_SAVE_PATH: "/zomboid" });

    const res = await getSetupPlan({ role: "admin" });

    expect(res.body.environmentDataPath).toEqual({ installPath: "/pz-server", dataPath: "/zomboid" });
  });

  // The container check reads POSIX mountinfo and never runs on Windows.
  it.skipIf(process.platform === "win32")(
    "in a container, offers the parent folder only when it is on a volume",
    async () => {
      state.containerized = true;
      state.servers = [{ ...MAIN, installPath: "/pz-servers/main", isActive: true }];

      state.mountinfo = WITH_SERVERS_VOLUME;
      expect((await getSetupPlan({ role: "admin" })).body.hostLayout.serversRoot).toBe("/pz-servers");
      state.mountinfo = ROOT_ONLY;
      expect((await getSetupPlan({ role: "admin" })).body.hostLayout.serversRoot).toBeNull();
      state.mountinfo = null;
      expect((await getSetupPlan({ role: "admin" })).body.hostLayout.serversRoot).toBeNull();
    },
  );

  it("offers the extra-servers folder and the published range when /pz-servers is a volume", async () => {
    setEnv(AIO_ENV);
    state.mountinfo = WITH_SERVERS_VOLUME;

    const res = await getSetupPlan({ role: "admin" });

    expect(res.statusCode).toBe(200);
    expect(res.body.allInOne).toEqual({
      serversRoot: "/pz-servers",
      publishedGamePorts: { start: 16261, end: 16270 },
    });
    expect(res.body.suggestedPorts).toEqual({
      gamePort: 16263,
      rconPort: 27016,
      withinPublishedRange: true,
    });
    // The extra-servers volume replaces the native layout.
    expect(res.body.hostLayout).toBeNull();
  });

  it("gives serversRoot null when /pz-servers isn't mounted (an older compose file)", async () => {
    setEnv(AIO_ENV);
    state.mountinfo = ROOT_ONLY;

    const res = await getSetupPlan({ role: "admin" });

    expect(res.statusCode).toBe(200);
    expect(res.body.allInOne).toEqual({
      serversRoot: null,
      publishedGamePorts: { start: 16261, end: 16270 },
    });
  });

  it("gives serversRoot null when mountinfo can't be read", async () => {
    setEnv(AIO_ENV);
    state.mountinfo = null;

    const res = await getSetupPlan({ role: "admin" });

    expect(res.body.allInOne.serversRoot).toBeNull();
  });
});
