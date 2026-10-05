import { describe, expect, it, vi } from "vitest";

// #193 gated GET /api/panel/update-apply-log behind panel.settings because
// the helper log quotes host paths. The same log (lastApplyResult.helperLog),
// the panel folder and the staged binary's path also reached every role
// through GET /api/panel/update-status (left login-only because Layout and
// Dashboard poll it) and the panel:updateApplyFailed broadcast. Both now
// drop them for anyone without panel.settings.
const { getRoleByNameMock, settings } = vi.hoisted(() => ({
  getRoleByNameMock: vi.fn(),
  settings: new Map(),
}));

vi.mock("../database/init.js", () => ({
  getRoleByName: getRoleByNameMock,
  getDb: vi.fn(async () => ({ data: {} })),
  peekServerDisplayName: vi.fn(() => null),
  getSetting: vi.fn(async (key) => settings.get(key) ?? null),
  setSetting: vi.fn(async (key, value) => {
    settings.set(key, value);
  }),
}));

const { app } = await import("../index.js");
const { DEFAULT_ROLE_CAPABILITIES } = await import("../services/permissions.js");
const { PanelUpdateChecker, redactUpdateStatus } = await import(
  "../services/panelUpdateChecker.js"
);

getRoleByNameMock.mockImplementation(async (name) =>
  DEFAULT_ROLE_CAPABILITIES[name]
    ? { name, capabilities: [...DEFAULT_ROLE_CAPABILITIES[name]] }
    : null,
);

const HELPER_LOG = "Copying C:\\ZomboidPanel\\app\\panel.exe ... Access is denied.";
const STATUS = {
  currentVersion: "1.4.3",
  updateAvailable: true,
  latestVersion: "1.4.4",
  stagedUpdate: { version: "1.4.4", path: "C:\\ZomboidPanel\\data\\updates\\panel-1.4.4.exe" },
  lastApplyResult: {
    status: "failed",
    pendingVersion: "1.4.4",
    currentVersion: "1.4.3",
    stagedStillPresent: true,
    canRetryApply: true,
    likelyCause: "av_quarantine",
    helperLog: HELPER_LOG,
    panelFolder: "C:\\ZomboidPanel\\app",
  },
};

function statusHandler() {
  const layer = app.router.stack.find(
    (l) => l.route?.path === "/api/panel/update-status" && l.route.methods.get,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function getStatusAs(role) {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  const checker = { getStatus: () => structuredClone(STATUS) };
  await statusHandler()(
    {
      user: role ? { username: role, role } : undefined,
      app: { get: (key) => (key === "panelUpdateChecker" ? checker : undefined) },
    },
    res,
  );
  return res;
}

describe("GET /api/panel/update-status keeps host details for panel.settings holders", () => {
  it("admin (panel.settings) gets the helper log, panel folder and staged path", async () => {
    const res = await getStatusAs("admin");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(STATUS);
  });

  for (const role of ["technician", "moderator"]) {
    it(`${role} gets the status without them`, async () => {
      expect(DEFAULT_ROLE_CAPABILITIES[role]).not.toContain("panel.settings");
      const res = await getStatusAs(role);
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain("ZomboidPanel");
      // What the badges and the failure banner read is still there.
      expect(res.body.stagedUpdate).toEqual({ version: "1.4.4" });
      expect(res.body.lastApplyResult).toMatchObject({
        status: "failed",
        pendingVersion: "1.4.4",
        canRetryApply: true,
        likelyCause: "av_quarantine",
      });
      expect(res.body.updateAvailable).toBe(true);
    });
  }

  it("an unresolvable role gets the redacted view (fail closed)", async () => {
    const res = await getStatusAs("ghost-role");
    expect(JSON.stringify(res.body)).not.toContain("ZomboidPanel");
  });

  it("redactUpdateStatus() does not mutate the checker's own status", () => {
    const status = structuredClone(STATUS);
    redactUpdateStatus(status);
    expect(status).toEqual(STATUS);
  });
});

describe("panel:updateApplyFailed broadcast", () => {
  it("goes to every socket without the helper log or panel folder", async () => {
    const emit = vi.fn();
    const checker = new PanelUpdateChecker({ emit });
    checker.currentVersion = "1.4.3";
    checker.readMostRecentApplyLog = () => HELPER_LOG;
    checker.getStagedUpdate = () => ({ version: "1.4.4", stagedPath: "C:\\ZomboidPanel\\data\\x.exe" });
    settings.set("pendingPanelUpdate", "1.4.4");

    await checker.reconcilePendingUpdate();

    const call = emit.mock.calls.find(([event]) => event === "panel:updateApplyFailed");
    expect(call).toBeTruthy();
    expect(call[1]).toMatchObject({ status: "failed", pendingVersion: "1.4.4" });
    expect(JSON.stringify(call[1])).not.toContain("ZomboidPanel");
    // The checker keeps the full record for panel.settings holders.
    expect(checker.lastApplyResult.helperLog).toBe(HELPER_LOG);
  });
});
