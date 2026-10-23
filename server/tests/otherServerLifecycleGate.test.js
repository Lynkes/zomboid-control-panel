import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// Start, Stop and Restart from the Dashboard's list of servers need what the
// Dashboard's own Start, Stop and Restart need: server.control. The handler
// tests call the last handler of each route and so skip this gate (see
// serversManageGateCoverage.test.js), so it is proven here, both ways.

vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
}));

function createResponse() {
  let statusCode = 200;
  let body = null;
  const response = {
    status(code) {
      statusCode = code;
      return response;
    },
    json(payload) {
      body = payload;
      return response;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
  return response;
}

async function runGate(routePath, role) {
  const { default: router } = await import("../routes/servers.js");
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods.post,
  );
  if (!layer) throw new Error(`No POST ${routePath} route registered`);
  const res = createResponse();
  let calledNext = false;
  await layer.route.stack[0].handle({ user: { role } }, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

const ROUTES = ["/:id/start", "/:id/stop", "/:id/restart"];

describe("servers.js: POST /:id/start, /:id/stop and /:id/restart require server.control", () => {
  it.each(ROUTES)("refuses a moderator (no server.control) on %s", async (routePath) => {
    const { res, calledNext } = await runGate(routePath, "moderator");
    expect(res.getStatusCode()).toBe(403);
    expect(res.getBody()).toEqual({ error: "Insufficient permissions", code: "PERMISSION_DENIED" });
    expect(calledNext).toBe(false);
  });

  it.each(ROUTES)("lets a technician (server.control) through on %s", async (routePath) => {
    const { calledNext } = await runGate(routePath, "technician");
    expect(calledNext).toBe(true);
  });
});
