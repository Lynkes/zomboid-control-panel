import { beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();
const saveTemplate = vi.fn();
const applyTemplate = vi.fn();

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({ getActiveServer, getRoleByName: mockGetRoleByName }));
vi.mock("../services/templateService.js", () => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  saveTemplate,
  deleteTemplate: vi.fn(),
  exportTemplate: vi.fn(),
  importTemplate: vi.fn(),
  previewTemplate: vi.fn(),
  applyTemplate,
}));

const { default: router } = await import("../routes/templates.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runRoute(routePath, method, request, response) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  let index = -1;
  const next = async (error) => {
    index += 1;
    if (error) throw error;
    if (index < handlers.length) {
      await handlers[index](request, response, next);
    }
  };
  await next();
}

describe("template mutation routes", () => {
  beforeEach(() => {
    getActiveServer.mockReset();
    saveTemplate.mockReset();
    applyTemplate.mockReset();
  });

  it("rejects template creation by a non-admin user", async () => {
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      { body: {}, user: { role: "viewer" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(saveTemplate).not.toHaveBeenCalled();
  });

  it("rejects applying a template while the active server is running", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: {
          get: () => ({
            getServerProcessDetails: vi.fn(async () => ({ running: true, scanFailed: false })),
          }),
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  it("fails closed when active-server state cannot be checked (the scan itself throws)", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: {
          get: () => ({
            getServerProcessDetails: vi.fn(async () => {
              throw new Error("scan failed");
            }),
          }),
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  // Previously this route asked serverManager.checkServerRunning(), which
  // discards the scan's own scanFailed flag and returns a plain boolean --
  // so a scan that completed but couldn't determine the server's state
  // (timeout, PowerShell/exec error) came back as `false`, indistinguishable
  // from a confirmed-stopped server, and the apply proceeded. Same fail-open
  // class already fixed at /wipe, /delete-files, chunks.js's
  // delete-chunks/delete-region, and backup.js's restore.
  it("fails closed when the scan completed but could not determine the server's state (scanFailed:true)", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: {
          get: () => ({
            // Old method the route used to call directly -- collapses the
            // failed scan into a plain `false`, which is exactly the bug:
            // present alongside getServerProcessDetails so unfixed code
            // (which calls checkServerRunning) proceeds instead of refusing.
            checkServerRunning: vi.fn(async () => false),
            getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: true })),
          }),
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  // 2026-08-24 conv-template-privesc: the running-state guard above only
  // ever ran inside the "target IS the active server" branch, so applying a
  // template to any OTHER configured server skipped it entirely -- no
  // check ran at all, and the apply proceeded unconditionally. serverManager
  // can only probe the active server's process, so there's no check to run
  // for a non-active target; the fix is to fail closed (refuse) rather than
  // silently treat "can't check" as "must be fine."
  it("refuses to apply a template to a server that isn't the active one -- the panel can't check its running state", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-2" },
        user: { role: "admin" },
        app: {
          get: () => ({
            getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
          }),
        },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  it("still applies normally when no server is active at all and the request targets a specific server -- refused, not silently allowed", async () => {
    getActiveServer.mockResolvedValue(null);
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: { get: () => ({}) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(applyTemplate).not.toHaveBeenCalled();
  });

  it("proceeds when the scan confirms the server is stopped (running:false, scanFailed:false)", async () => {
    getActiveServer.mockResolvedValue({ id: "server-1" });
    applyTemplate.mockResolvedValue({ success: true });
    const response = createResponse();

    await runRoute(
      "/:id/apply",
      "post",
      {
        params: { id: "template-1" },
        body: { serverId: "server-1" },
        user: { role: "admin" },
        app: {
          get: () => ({
            getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
          }),
        },
      },
      response,
    );

    expect(applyTemplate).toHaveBeenCalledWith("template-1", "server-1", {});
    expect(response.status).not.toHaveBeenCalledWith(409);
    expect(response.status).not.toHaveBeenCalledWith(503);
  });
});