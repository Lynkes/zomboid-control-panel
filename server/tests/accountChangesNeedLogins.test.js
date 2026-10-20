import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authService, init, setupAuth, startApp } from "./helpers/authzHarness.js";

// SECURITY (2026-10-20, access-control audit): with logins off
// (authEnabled: false) every request is handed an admin identity, and the
// account and role routes stayed writable -- an unauthenticated caller
// could add an admin that still signed in once the operator turned logins
// back on. Those writes now wait for logins (ACCOUNT_CHANGES_NEED_LOGINS);
// reads stay available.

const { default: authRoutes } = await import("../routes/auth.js");
const { default: permRoutes } = await import("../routes/permissions.js");

let app;
let rootId;
let roleId;

beforeAll(async () => {
  rootId = await setupAuth();
  const perms = await import("../services/permissions.js");
  roleId = (await perms.createRole({ name: "spare-role", capabilities: ["players.view"] }, { actingUser: { role: "admin" } })).id;
  await init.setSetting("authEnabled", false);
  app = await startApp([
    ["/api/auth", authRoutes],
    ["/api/permissions", permRoutes],
  ]);
});

afterAll(async () => {
  await init.setSetting("authEnabled", true);
  await app?.close();
});

function expectRefused(res) {
  expect(res.status).toBe(403);
  expect(res.body.code).toBe("ACCOUNT_CHANGES_NEED_LOGINS");
}

describe("while panel logins are off", () => {
  it("refuses creating an account, and nothing is created", async () => {
    const res = await app.call("POST", "/api/auth/users", null, {
      username: "backdoor",
      password: "Backdoor-pass-1234",
      role: "admin",
    });
    expectRefused(res);
    expect((await init.getDb()).data.users.some((u) => u.username === "backdoor")).toBe(false);
  });

  it("refuses changing a role, deleting or signing out an account", async () => {
    expectRefused(await app.call("PATCH", `/api/auth/users/${rootId}/role`, null, { role: "moderator" }));
    expectRefused(await app.call("DELETE", `/api/auth/users/${rootId}`, null));
    expectRefused(await app.call("POST", `/api/auth/users/${rootId}/sessions/revoke`, null, {}));
  });

  it("refuses the signing-key and recovery-code routes", async () => {
    expectRefused(await app.call("POST", "/api/auth/regenerate-jwt-secret", null, {}));
    expectRefused(await app.call("GET", "/api/auth/recovery-codes", null));
    expectRefused(await app.call("POST", "/api/auth/recovery-codes", null, { currentPassword: "x" }));
  });

  it("refuses role writes", async () => {
    expectRefused(await app.call("POST", "/api/permissions/roles", null, { name: "planted", capabilities: ["users.manage"] }));
    expectRefused(await app.call("PUT", `/api/permissions/roles/${roleId}`, null, { capabilities: ["users.manage", "roles.manage"] }));
    expectRefused(await app.call("DELETE", `/api/permissions/roles/${roleId}`, null));
  });

  it("still answers the account and role lists", async () => {
    expect((await app.call("GET", "/api/auth/users", null)).status).toBe(200);
    expect((await app.call("GET", "/api/permissions/roles", null)).status).toBe(200);
  });

  it("leaves nothing that signs in once logins are back on", async () => {
    await init.setSetting("authEnabled", true);
    try {
      await expect(authService.login("backdoor", "Backdoor-pass-1234", false, { clientKey: "x" })).rejects.toThrow();
    } finally {
      await init.setSetting("authEnabled", false);
    }
  });
});
