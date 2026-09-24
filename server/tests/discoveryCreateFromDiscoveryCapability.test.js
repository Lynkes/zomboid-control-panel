import { beforeEach, describe, expect, it, vi } from "vitest";

// continuous-bug-hunt round 18 (panel auth audit): POST /create-from-
// discovery used to be gated on servers.discover -- a read/scan-shaped
// capability (services/permissions.js's own description: "Scan any path...
// including reading and parsing .ini config files") -- even though its
// actual effect is createServer(), the same database write servers.js's own
// POST / (create) route correctly gates on servers.manage. The two
// capabilities are independently grantable (a real custom role can hold
// one without the other -- see server/tests/helpers/mockPermissionsDb.js's
// TECHNICIAN_CAPABILITIES, which has servers.manage but not
// servers.discover). A role holding ONLY servers.discover could silently
// create a fully-configured server profile, including an RCON password
// read straight off disk. This file proves the fix with a custom role that
// splits the two capabilities apart, the same way
// backupDownloadCapability.test.js proves backups.download is checked
// distinctly from backups.manage.

const db = { data: { roles: [] } };
const createServer = vi.fn();
const discoverMounts = vi.fn();
const discoverMountIssues = vi.fn(() => []);
const scanAllCandidates = vi.fn(() => []);
const probeInstallPath = vi.fn();
const probeDataPath = vi.fn();
const readServerIniSettings = vi.fn();

vi.mock("../database/init.js", () => ({
  createServer,
  getRoleByName: async (name) =>
    db.data.roles.find((r) => r.name === name) || null,
}));
vi.mock("../services/mountDiscovery.js", () => ({
  discoverMounts,
  discoverMountIssues,
  scanAllCandidates,
  probeInstallPath,
  probeDataPath,
  readServerIniSettings,
}));

const { default: router } = await import("../routes/discovery.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// Runs the FULL middleware chain (gate + handler), not just the gate --
// this is what proves a wrong-but-present capability is refused before
// createServer() is ever reached, not just that the route is gated on
// *something*.
async function runCreate(body, user) {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/create-from-discovery" && entry.route.methods.post,
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const response = createResponse();
  let index = -1;
  const request = { body, user };
  const next = async (error) => {
    if (error) throw error;
    index += 1;
    if (index < handlers.length) await handlers[index](request, response, next);
  };
  await next();
  return response;
}

describe("POST /api/servers/create-from-discovery: checks servers.manage, not servers.discover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.data.roles = [
      { name: "scanner-only", capabilities: ["servers.discover"], isSeeded: false },
      { name: "manager-only", capabilities: ["servers.manage"], isSeeded: false },
    ];
    discoverMounts.mockReturnValue([
      { installPath: "/pz-server", dataPath: "/zomboid", serverNames: ["servertest"] },
    ]);
    probeInstallPath.mockReturnValue({ valid: true, serverNames: [] });
    probeDataPath.mockReturnValue({ valid: true, serverNames: ["servertest"] });
    readServerIniSettings.mockReturnValue({
      rconPort: 27015,
      rconPassword: "rcon-secret",
      serverPort: 16261,
      publicName: "Test Server",
    });
    createServer.mockResolvedValue({ id: "server-id", name: "Test Server" });
  });

  it("refuses a role holding ONLY servers.discover -- the bug: this used to be admitted", async () => {
    const response = await runCreate(
      { installPath: "/pz-server", dataPath: "/zomboid", serverName: "servertest" },
      { role: "scanner-only" },
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("admits a role holding servers.manage even without servers.discover", async () => {
    const response = await runCreate(
      { installPath: "/pz-server", dataPath: "/zomboid", serverName: "servertest" },
      { role: "manager-only" },
    );

    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(createServer).toHaveBeenCalled();
  });
});
