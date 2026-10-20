import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { authService, init, setupAuth, startApp, adminToken } from "./helpers/authzHarness.js";
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  newPasswordProblem,
} from "../services/passwordPolicy.js";

// SECURITY (2026-10-20, access-control audit): new panel passwords could be
// 6 characters long, and up to 128 characters were accepted although bcrypt
// reads only the first 72 bytes. A new password (setup, account creation,
// change, reset, recovery) now needs at least 10 characters, at most 72
// bytes, and not one of the most common passwords; an existing password
// keeps signing in.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { default: authRoutes } = await import("../routes/auth.js");

let app;
let admin;
let rootId;

beforeAll(async () => {
  rootId = await setupAuth();
  admin = await adminToken();
  app = await startApp([["/api/auth", authRoutes]]);
});

afterAll(async () => {
  await app?.close();
});

describe("newPasswordProblem()", () => {
  it("refuses fewer than 10 characters, more than 72 bytes, and common passwords", () => {
    expect(newPasswordProblem("Short-9ch")?.code).toBe("PASSWORD_TOO_SHORT");
    expect(newPasswordProblem("a".repeat(5) + "B".repeat(68))?.code).toBe("PASSWORD_TOO_LONG_BYTES");
    // 37 accented letters: 37 characters but 74 bytes.
    expect(newPasswordProblem("é".repeat(37))?.code).toBe("PASSWORD_TOO_LONG_BYTES");
    expect(newPasswordProblem("Password123")?.code).toBe("PASSWORD_TOO_COMMON");
    expect(newPasswordProblem("QWERTYUIOP")?.code).toBe("PASSWORD_TOO_COMMON");
    expect(newPasswordProblem("zzzzzzzzzzzz")?.code).toBe("PASSWORD_TOO_COMMON");
  });

  it("accepts an uncommon password between the limits", () => {
    expect(newPasswordProblem("Gravel-otter-58")).toBeNull();
    expect(newPasswordProblem("é".repeat(35) + "a")).toBeNull();
    expect(newPasswordProblem("x".repeat(9) + "Y".repeat(63))).toBeNull();
  });

  it("matches the client's copy and the translated messages", () => {
    const client = fs.readFileSync(path.join(ROOT, "client/src/lib/passwordPolicy.ts"), "utf8");
    expect(client).toContain(`export const PASSWORD_MIN_LENGTH = ${PASSWORD_MIN_LENGTH}`);
    expect(client).toContain(`export const PASSWORD_MAX_BYTES = ${PASSWORD_MAX_BYTES}`);
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, "client/src/locales/en/errors.json"), "utf8"));
    expect(en.PASSWORD_TOO_SHORT).toContain(String(PASSWORD_MIN_LENGTH));
    expect(en.PASSWORD_TOO_LONG_BYTES).toContain(String(PASSWORD_MAX_BYTES));
  });
});

describe("where a new password is set", () => {
  it("POST /api/auth/users refuses a common password with its code", async () => {
    const res = await app.call("POST", "/api/auth/users", admin, { username: "weakling", password: "Password123", role: "moderator" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PASSWORD_TOO_COMMON");
  });

  it("POST /api/auth/change-password refuses a short one with its code", async () => {
    await authService.createUser("changer", "Changer-start-pass-1", "moderator", { actingUserId: rootId });
    const login = await authService.login("changer", "Changer-start-pass-1", false, { clientKey: "changer" });
    const res = await app.call("POST", "/api/auth/change-password", login.accessToken, {
      currentPassword: "Changer-start-pass-1",
      newPassword: "short-1",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PASSWORD_TOO_SHORT");
  });

  it("a recovery code is not spent on a refused password (adversary pass)", async () => {
    const { codes } = await authService.generateRecoveryCodes(rootId, "Correct-horse-battery-9", 1);
    const weak = await app.call("POST", "/api/auth/recover-with-code", null, { code: codes[0], newPassword: "password1234" });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe("PASSWORD_TOO_COMMON");
    const strong = await app.call("POST", "/api/auth/recover-with-code", null, { code: codes[0], newPassword: "Correct-horse-battery-9" });
    expect(strong.status).toBe(200);
  });

  it("the reset paths refuse too", async () => {
    await expect(authService.resetPassword("tiny")).rejects.toMatchObject({ code: "PASSWORD_TOO_SHORT" });
  });
});

describe("an existing password", () => {
  it("still signs in, whatever its length", async () => {
    await authService.createUser("oldtimer", "Oldtimer-pass-1234", "moderator", { actingUserId: rootId });
    const db = await init.getDb();
    const user = db.data.users.find((u) => u.username === "oldtimer");
    user.password = await bcrypt.hash("abc123", 4);
    await init.commitNow();
    const login = await authService.login("oldtimer", "abc123", false, { clientKey: "oldtimer" });
    expect(login.accessToken).toEqual(expect.any(String));
  });
});
