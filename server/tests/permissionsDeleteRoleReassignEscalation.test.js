import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";

// security sweep 2026-10-04 (AUTHZ-1): DELETE /api/permissions/roles/:id
// with ?reassignTo= moves every member of the deleted role onto the target
// -- a role ASSIGNMENT -- but deleteRole() only ever ran the recovery
// lockout check on it, never a "can the caller grant this" check. A user
// holding nothing but roles.manage deleted their own custom role with
// reassignTo=<admin role id> and their very next request carried role
// "admin" (authenticateAccessToken re-reads user.role from the DB on every
// call). updateRole()/createRole() and PATCH /users/:id/role already
// refused the same escalation through their own doors.
//
// Real database/init.js (per-file temp data root, vitest.perFileDataDir
// .setup.mjs), real services/auth.js middleware and JWTs, real
// routes/permissions.js over real HTTP: the escalation lived in the hand-off
// between reassignRoleMembers()'s write and the next request's role lookup,
// so a mocked data layer could only restate the assumption under test.
//
// PRE-FIX BREAK-VERIFY: against the old deleteRole(), the first test gets a
// 200, the delegate's record reads role "admin", and the users.manage probe
// answers 200; the reassign-onto-itself test gets a 200 and orphans the
// member on a role that no longer exists.

const { getDb } = await import("../database/init.js");
const { default: authService } = await import("../services/auth.js");
const { default: permissionsRouter } = await import("../routes/permissions.js");
const { CAPABILITIES, requirePermission } = await import("../services/permissions.js");

const ALL_CAPABILITIES = CAPABILITIES.map((c) => c.key);

let db;
let server;
let baseUrl;

function tokenFor(userId) {
  const user = db.data.users.find((u) => u.id === userId);
  return authService.generateAccessToken(user);
}

async function call(method, path, userId) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(userId)}` },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // no body
  }
  return { status: response.status, body };
}

function userRecord(id) {
  return db.data.users.find((u) => u.id === id);
}

beforeAll(async () => {
  db = await getDb();
  authService.jwtSecret = "permissions-delete-role-escalation-test-secret";

  const app = express();
  app.use(express.json());
  app.use(authService.middleware());
  app.use("/api/permissions", permissionsRouter);
  // Stands in for every users.manage-gated route (PATCH /users/:id/role,
  // POST /users, ...): the question is only whether the gate opens.
  app.get("/api/probe/users-manage", requirePermission("users.manage"), (req, res) => {
    res.json({ ok: true });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  const now = new Date().toISOString();
  db.data.roles = [
    { id: "role-admin", name: "admin", capabilities: ALL_CAPABILITIES, isSeeded: true, createdAt: now },
    { id: "role-rolemgr", name: "role-manager", capabilities: ["roles.manage"], isSeeded: false, createdAt: now },
    { id: "role-helpers", name: "helpers", capabilities: ["players.view"], isSeeded: false, createdAt: now },
  ];
  db.data.users = [
    { id: "u-admin", username: "owner", role: "admin", roleId: "role-admin", tokenGen: 0 },
    { id: "u-delegate", username: "delegate", role: "role-manager", roleId: "role-rolemgr", tokenGen: 0 },
    { id: "u-helper", username: "helper", role: "helpers", roleId: "role-helpers", tokenGen: 0 },
  ];
});

describe("DELETE /api/permissions/roles/:id?reassignTo= -- the target must be within the caller's own reach", () => {
  it("refuses a roles.manage-only delegate deleting their OWN role with reassignTo=admin, and they stay unprivileged", async () => {
    // Control: the sibling door was already shut.
    const probeBefore = await call("GET", "/api/probe/users-manage", "u-delegate");
    expect(probeBefore.status).toBe(403);

    const res = await call("DELETE", "/api/permissions/roles/role-rolemgr?reassignTo=role-admin", "u-delegate");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES");
    // Refused before any write, not rolled back after one.
    expect(userRecord("u-delegate")).toEqual(
      expect.objectContaining({ role: "role-manager", roleId: "role-rolemgr" }),
    );
    expect(db.data.roles.some((r) => r.id === "role-rolemgr")).toBe(true);

    const probeAfter = await call("GET", "/api/probe/users-manage", "u-delegate");
    expect(probeAfter.status).toBe(403);
  });

  it("refuses promoting a DIFFERENT role's members to admin too -- not a self-only check", async () => {
    const res = await call("DELETE", "/api/permissions/roles/role-helpers?reassignTo=role-admin", "u-delegate");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_GRANT_EXCEEDS_CALLER_CAPABILITIES");
    expect(userRecord("u-helper")).toEqual(
      expect.objectContaining({ role: "helpers", roleId: "role-helpers" }),
    );
  });

  it("refuses reassigning members onto the very role being deleted instead of orphaning them", async () => {
    const res = await call("DELETE", "/api/permissions/roles/role-helpers?reassignTo=role-helpers", "u-admin");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ROLE_NOT_FOUND");
    expect(db.data.roles.some((r) => r.id === "role-helpers")).toBe(true);
    expect(userRecord("u-helper")).toEqual(
      expect.objectContaining({ role: "helpers", roleId: "role-helpers" }),
    );
  });

  it("still lets a delegate reassign into a role whose capabilities they all hold", async () => {
    db.data.roles.find((r) => r.id === "role-rolemgr").capabilities = ["roles.manage", "players.view"];
    db.data.roles.push({
      id: "role-viewers",
      name: "viewers",
      capabilities: ["players.view"],
      isSeeded: false,
      createdAt: new Date().toISOString(),
    });

    const res = await call("DELETE", "/api/permissions/roles/role-helpers?reassignTo=role-viewers", "u-delegate");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ deleted: true, reassigned: 1, reassignedTo: "role-viewers" }),
    );
    expect(userRecord("u-helper")).toEqual(
      expect.objectContaining({ role: "viewers", roleId: "role-viewers" }),
    );
  });

  it("does not get in an admin's way: reassigning to admin still works for someone who holds everything", async () => {
    const res = await call("DELETE", "/api/permissions/roles/role-helpers?reassignTo=role-admin", "u-admin");

    expect(res.status).toBe(200);
    expect(userRecord("u-helper")).toEqual(
      expect.objectContaining({ role: "admin", roleId: "role-admin" }),
    );
  });
});
