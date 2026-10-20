import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, tokenWithCapabilities } from "./helpers/authzHarness.js";

// FUNCTIONAL (2026-10-20, access-control audit): Panel Users reads GET
// /api/permissions/roles for its role picker, but the route was
// roles.manage-only, so a users.manage-only role got a 403 and an empty
// page. Reading the role list now takes either capability; the capability
// catalogue and every role write stay roles.manage's.

const { default: permRoutes } = await import("../routes/permissions.js");

let app;
let usersManager;
let neither;

beforeAll(async () => {
  usersManager = await tokenWithCapabilities(["users.manage"]);
  neither = await tokenWithCapabilities(["players.view"]);
  app = await startApp([["/api/permissions", permRoutes]]);
});

afterAll(async () => {
  await app?.close();
});

describe("GET /api/permissions/roles", () => {
  it("answers users.manage alone with ids, names, the built-in flag and capabilities", async () => {
    const res = await app.call("GET", "/api/permissions/roles", usersManager);
    expect(res.status).toBe(200);
    const admin = res.body.roles.find((role) => role.name === "admin");
    expect(admin).toMatchObject({ id: expect.any(String), isSeeded: true });
    expect(Array.isArray(admin.capabilities)).toBe(true);
  });

  it("is still refused to a role with neither capability", async () => {
    expect((await app.call("GET", "/api/permissions/roles", neither)).status).toBe(403);
  });
});

describe("the rest of the matrix stays roles.manage's", () => {
  it("refuses users.manage the capability catalogue and every role write", async () => {
    expect((await app.call("GET", "/api/permissions/capabilities", usersManager)).status).toBe(403);
    expect((await app.call("POST", "/api/permissions/roles", usersManager, { name: "x", capabilities: [] })).status).toBe(403);
    expect((await app.call("PUT", "/api/permissions/roles/role-admin", usersManager, { name: "y" })).status).toBe(403);
    expect((await app.call("DELETE", "/api/permissions/roles/role-admin", usersManager)).status).toBe(403);
  });
});
