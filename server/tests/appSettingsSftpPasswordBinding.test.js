import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// SECURITY (2026-10-20): the saved PanelBridge SFTP password belongs to the
// saved host, port and username. PUT /app-settings is the other door to
// those three settings: a save that moved the host while the password field
// still held the mask kept the saved password for the new host, and the
// bridge, Files and the config mirror would then log in there with it. Such
// a save now has to bring a password, like the SFTP routes themselves.
const getAllSettings = vi.fn();
const setSetting = vi.fn();

vi.mock("../database/init.js", () => ({
  getAllSettings,
  setSetting,
  getSetting: vi.fn(async () => null),
  getRoleByName: mockGetRoleByName,
}));

vi.mock("../services/steamSessionCredentials.js", () => ({
  setSteamSessionCredentials: vi.fn(),
}));

const { default: router } = await import("../routes/config.js");
const { ErrorCode } = await import("../utils/errorCodes.js");

async function put(settings) {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/app-settings" && entry.route.methods.put,
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx]({ body: { settings }, user: { role: "admin" }, app: { get: () => null } }, res, next);
  };
  await next();
  return res;
}

const MASK = "••••••••";
const STORED = {
  panelBridgeSftpEnabled: true,
  panelBridgeSftpHost: "game-host.internal",
  panelBridgeSftpPort: 22,
  panelBridgeSftpUsername: "pz",
  panelBridgeSftpPassword: "REAL-STORED-SFTP-PASSWORD",
  darkMode: false,
};

const refused = (res) =>
  res.status.mock.calls.some(([code]) => code === 400) &&
  res.json.mock.calls[0]?.[0]?.code === ErrorCode.SFTP_PASSWORD_REQUIRED;

beforeEach(() => {
  getAllSettings.mockReset();
  getAllSettings.mockResolvedValue({ ...STORED });
  setSetting.mockReset();
});

describe("app-settings keeps the saved SFTP password with the saved target", () => {
  it.each([
    ["a new host", { panelBridgeSftpHost: "evil.example" }],
    ["a look-alike host", { panelBridgeSftpHost: "game-host.internal.evil.example" }],
    ["a new port", { panelBridgeSftpPort: 2222 }],
    ["a new username", { panelBridgeSftpUsername: "root" }],
  ])("refuses %s with the mask in the password field, and writes nothing", async (_label, change) => {
    const res = await put({ ...STORED, panelBridgeSftpPassword: MASK, ...change });
    expect(refused(res)).toBe(true);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("refuses a new host sent without the password field at all", async () => {
    const res = await put({ panelBridgeSftpHost: "evil.example" });
    expect(refused(res)).toBe(true);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("accepts a new host with a new password", async () => {
    const res = await put({ ...STORED, panelBridgeSftpHost: "new-host.example", panelBridgeSftpPassword: "typed" });
    expect(refused(res)).toBe(false);
    expect(setSetting).toHaveBeenCalledWith("panelBridgeSftpHost", "new-host.example");
    expect(setSetting).toHaveBeenCalledWith("panelBridgeSftpPassword", "typed");
  });

  it("accepts a new host when the password is cleared, and clearing the host", async () => {
    expect(refused(await put({ panelBridgeSftpHost: "evil.example", panelBridgeSftpPassword: "" }))).toBe(false);
    expect(refused(await put({ panelBridgeSftpHost: "", panelBridgeSftpPassword: MASK }))).toBe(false);
  });

  it("does not stop an unrelated save that resends the form as the page holds it", async () => {
    const res = await put({
      ...STORED,
      panelBridgeSftpHost: " Game-Host.internal ",
      panelBridgeSftpPort: "22",
      panelBridgeSftpPassword: MASK,
      darkMode: true,
    });
    expect(refused(res)).toBe(false);
    expect(setSetting).toHaveBeenCalledWith("darkMode", true);
  });

  it("does not ask for a password when none is saved", async () => {
    getAllSettings.mockResolvedValue({ ...STORED, panelBridgeSftpPassword: "" });
    expect(refused(await put({ panelBridgeSftpHost: "other.example" }))).toBe(false);
  });

  it("refuses a host moved away from an empty saved host while a password is saved", async () => {
    getAllSettings.mockResolvedValue({ ...STORED, panelBridgeSftpHost: "" });
    expect(refused(await put({ panelBridgeSftpHost: "evil.example", panelBridgeSftpPassword: MASK }))).toBe(true);
  });
});
