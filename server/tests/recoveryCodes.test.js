import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";

// In-memory stand-ins so the real service logic (including bcrypt) runs without
// touching the panel database.
const settings = new Map();
const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async (id) => db.data.roles.find((r) => String(r.id) === String(id)) || null,
  getRoleByName: async (name) => db.data.roles.find((r) => r.name === name) || null,
  getUsersForRole: async () => [],
}));

vi.mock("../utils/jwtSecret.js", () => ({
  loadOrCreateJwtSecret: async () => ({ secret: "recovery-codes-test-secret", source: "file" }),
  getJwtSecretPath: () => "jwt.secret",
  regenerateJwtSecretFile: () => ({ secret: "x", path: "jwt.secret" }),
}));

const { default: authService, _resetLoginThrottleForTests } = await import("../services/auth.js");

const OWNER_PASSWORD = "owner-pass-1";
const COADMIN_PASSWORD = "coadmin-pass-1";
let ownerHash;
let coadminHash;

const owner = () => db.data.users.find((u) => u.id === "u-owner");
const coadmin = () => db.data.users.find((u) => u.id === "u-coadmin");
const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

beforeAll(async () => {
  // Low cost keeps the compares fast; nothing here depends on it.
  ownerHash = await bcrypt.hash(OWNER_PASSWORD, 4);
  coadminHash = await bcrypt.hash(COADMIN_PASSWORD, 4);
});

beforeEach(() => {
  _resetLoginThrottleForTests();
  settings.clear();
  db.data.roles = [
    { id: "role-admin", name: "admin", capabilities: ["users.manage", "roles.manage"], isSeeded: true },
    { id: "role-moderator", name: "moderator", capabilities: ["players.moderate"], isSeeded: true },
  ];
  db.data.users = [
    { id: "u-owner", username: "owner", role: "admin", roleId: "role-admin", password: ownerHash, tokenGen: 0, refreshSessions: [] },
    { id: "u-coadmin", username: "coadmin", role: "admin", roleId: "role-admin", password: coadminHash, tokenGen: 0, refreshSessions: [] },
  ];
});

describe("recovery codes", () => {
  it("returns codes once and stores only hashes, on the generating account", async () => {
    const { codes } = await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 5);
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);

    const stored = JSON.stringify(owner().recoveryCodes);
    for (const code of codes) {
      expect(stored).not.toContain(code);
    }
    expect(coadmin().recoveryCodes).toBeUndefined();
    expect(settings.get("authRecoveryCodes")).toBeUndefined();
  });

  it("asks for the current password and stores nothing without it", async () => {
    await expect(
      authService.generateRecoveryCodes("u-owner", "not-the-password", 3),
    ).rejects.toMatchObject({ code: "CURRENT_PASSWORD_INCORRECT" });
    expect(owner().recoveryCodes).toBeUndefined();
  });

  it("refuses an account that isn't an admin", async () => {
    owner().role = "moderator";
    owner().roleId = "role-moderator";
    await expect(authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 3)).rejects.toThrow(
      /Only an administrator/,
    );
    expect(owner().recoveryCodes).toBeUndefined();
  });

  it("reports the caller's own remaining count", async () => {
    await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 3);
    expect(await authService.getRecoveryCodeStatus("u-owner")).toMatchObject({
      configured: true,
      remaining: 3,
      total: 3,
    });
    expect(await authService.getRecoveryCodeStatus("u-coadmin")).toMatchObject({
      configured: false,
      remaining: 0,
    });
    expect(await authService.hasUsableRecoveryCodes()).toBe(true);
  });

  it("redeems a valid code and sets the new password", async () => {
    const { codes } = await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 3);
    const result = await authService.redeemRecoveryCode(codes[1], "brand-new-pass");
    expect(result.username).toBe("owner");
    expect(result.remaining).toBe(2);
    expect(await bcrypt.compare("brand-new-pass", owner().password)).toBe(true);
  });

  it("burns a code so it cannot be reused", async () => {
    const { codes } = await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 2);
    await authService.redeemRecoveryCode(codes[0], "first-password");
    await expect(
      authService.redeemRecoveryCode(codes[0], "second-password"),
    ).rejects.toThrow(/not valid or has already been used/);
  });

  it("accepts codes case-insensitively", async () => {
    const { codes } = await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 1);
    const result = await authService.redeemRecoveryCode(
      codes[0].toLowerCase(),
      "another-password",
    );
    expect(result.username).toBe("owner");
  });

  it("rejects an unknown code without changing the password", async () => {
    await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 2);
    await expect(
      authService.redeemRecoveryCode("AAAAA-BBBBB-CCCCC", "should-not-apply"),
    ).rejects.toThrow();
    expect(owner().password).toBe(ownerHash);
  });

  it("rejects redemption when no codes exist", async () => {
    await expect(
      authService.redeemRecoveryCode("AAAAA-BBBBB-CCCCC", "irrelevant"),
    ).rejects.toThrow(/No recovery codes have been generated/);
  });

  it("invalidates the account's old codes when it generates new ones", async () => {
    const first = await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 3);
    await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 3);
    await expect(
      authService.redeemRecoveryCode(first.codes[0], "no-longer-valid"),
    ).rejects.toThrow(/not valid or has already been used/);
  });

  it("still enforces the password policy", async () => {
    const { codes } = await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 1);
    await expect(
      authService.redeemRecoveryCode(codes[0], "123"),
    ).rejects.toThrow(/at least 6 characters/);
  });
});

// Auth audit 2026-10-08 (#1): codes used to be ONE global set aimed at the
// first admin, whoever generated it, and nothing ever cleared them. A co-admin
// (or a stolen admin token) minted a set -- silently replacing the owner's --
// and after being deleted or demoted reset the owner's password from the login
// screen, signed in as the owner and locked them out.
describe("#1: a code set belongs to the admin who generated it", () => {
  it("another admin's code resets that admin, not the owner", async () => {
    await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 2);
    const { codes } = await authService.generateRecoveryCodes("u-coadmin", COADMIN_PASSWORD, 2);

    const result = await authService.redeemRecoveryCode(codes[0], "coadmin-new-pass");

    expect(result.username).toBe("coadmin");
    expect(owner().password).toBe(ownerHash);
    expect(await bcrypt.compare("coadmin-new-pass", coadmin().password)).toBe(true);
    // ...and generating it left the owner's own set alone.
    expect(await authService.getRecoveryCodeStatus("u-owner")).toMatchObject({ remaining: 2 });
  });

  it("once the owner deletes that admin, the admin's codes redeem nothing", async () => {
    const { codes } = await authService.generateRecoveryCodes("u-coadmin", COADMIN_PASSWORD, 2);
    await authService.deleteUser("u-coadmin", { actingUserId: "u-owner" });

    await expect(authService.redeemRecoveryCode(codes[0], "attacker-pass-1")).rejects.toThrow();
    expect(owner().password).toBe(ownerHash);
    expect(owner().tokenGen).toBe(0);
  });

  it("once the owner demotes that admin, the admin's codes redeem nothing and are gone", async () => {
    const { codes } = await authService.generateRecoveryCodes("u-coadmin", COADMIN_PASSWORD, 2);
    await authService.changeUserRoleById("u-coadmin", "role-moderator", { actingUserId: "u-owner" });

    await expect(authService.redeemRecoveryCode(codes[0], "attacker-pass-1")).rejects.toThrow();
    expect(owner().password).toBe(ownerHash);
    expect(coadmin().password).toBe(coadminHash);
    expect(coadmin().recoveryCodes).toBeUndefined();
    expect(await authService.hasUsableRecoveryCodes()).toBe(false);
  });

  it("a code from the old global set is refused", async () => {
    const legacyCode = "LEGAC-YCODE-12345";
    settings.set("authRecoveryCodes", JSON.stringify([{ hash: sha256(legacyCode), usedAt: null }]));
    settings.set("authRecoveryCodesCreatedAt", "2026-01-01T00:00:00.000Z");

    await expect(authService.redeemRecoveryCode(legacyCode, "attacker-pass-1")).rejects.toThrow();
    expect(owner().password).toBe(ownerHash);
    expect(await authService.hasUsableRecoveryCodes()).toBe(false);

    // Alongside a current set of the owner's own, it is just a wrong code.
    await authService.generateRecoveryCodes("u-owner", OWNER_PASSWORD, 1);
    await expect(authService.redeemRecoveryCode(legacyCode, "attacker-pass-1")).rejects.toThrow(
      /not valid or has already been used/,
    );
    expect(owner().password).toBe(ownerHash);
  });

  it("starting the panel retires the old global set", async () => {
    settings.set("authRecoveryCodes", JSON.stringify([{ hash: sha256("LEGAC-YCODE-12345"), usedAt: null }]));
    settings.set("authRecoveryCodesCreatedAt", "2026-01-01T00:00:00.000Z");

    await authService.init();

    expect(settings.get("authRecoveryCodes")).toBeNull();
    expect(settings.get("authRecoveryCodesCreatedAt")).toBeNull();
  });
});

describe("POST /api/auth/recovery-codes: the signed-in admin's own codes, behind the current password", () => {
  async function postRecoveryCodes(userId, body) {
    const { default: router } = await import("../routes/auth.js");
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/recovery-codes" && entry.route.methods.post,
    );
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    authService.jwtSecret = "recovery-codes-route-secret";
    const user = db.data.users.find((u) => u.id === userId);
    const res = { statusCode: 200, body: null };
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (payload) => {
      res.body = payload;
      return res;
    };
    await handler(
      {
        headers: { authorization: `Bearer ${authService.generateAccessToken(user)}` },
        body,
        user: { userId, role: user.role },
      },
      res,
    );
    return res;
  }

  it("refuses a request without the current password", async () => {
    const res = await postRecoveryCodes("u-coadmin", {});
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("RECOVERY_CODES_PASSWORD_REQUIRED");
    expect(coadmin().recoveryCodes).toBeUndefined();
  });

  it("refuses a wrong current password", async () => {
    const res = await postRecoveryCodes("u-coadmin", { currentPassword: OWNER_PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("CURRENT_PASSWORD_INCORRECT");
    expect(coadmin().recoveryCodes).toBeUndefined();
  });

  it("stores the codes on the caller's account, not the first admin's", async () => {
    const res = await postRecoveryCodes("u-coadmin", { currentPassword: COADMIN_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.body.codes).toHaveLength(10);
    expect(coadmin().recoveryCodes.codes).toHaveLength(10);
    expect(owner().recoveryCodes).toBeUndefined();
  });
});
