import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

// AUTHN-5 (security sweep): the manual data/reset-token.txt recovery path
// accepted any token of 8+ characters (the remote-recovery help said "any
// token at least 8 characters long"), failed guesses were only limited per
// address (3 per 15 minutes) and never used the file up. The repro: the
// operator writes "changeme", an attacker rotates addresses through a short
// dictionary against POST /api/auth/reset-password, hits it, and signs in
// as admin with a password of their choosing.
//
// The first fix (a 32-character minimum, and 5 wrong tokens from any mix of
// addresses deleting the file) left two holes (security sweep 2026-10-05,
// A2): GET /reset-status told anyone whether a token file existed, so a
// stranger could watch for one and delete it with 5 wrong guesses as soon
// as the operator created it, keeping remote recovery from ever working;
// and a long but predictable token ("changeme" typed four times) still
// passed.
//
// Now: a token must be at least 32 characters AND unpredictable; wrong
// tokens change nothing on disk; and a caller that isn't on the panel host
// is never told whether a token file exists -- not by /reset-status, and
// not by /reset-password's refusals.

const settings = new Map();
const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
  scheduleWrite: () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async (id) => db.data.roles.find((r) => String(r.id) === String(id)) || null,
  getRoleByName: async (name) => db.data.roles.find((r) => r.name === name) || null,
  getUsersForRole: async () => [],
  peekServerDisplayName: () => null,
}));

const { default: authService } = await import("../services/auth.js");
const authRoutesModule = await import("../routes/auth.js");
const { default: authRouter } = authRoutesModule;
// Spelled out rather than imported so this file still exercises the real
// behaviour against code that doesn't export it.
const RESET_TOKEN_MIN_LENGTH = 32;
const { getDataPaths } = await import("../utils/paths.js");
const { io } = await import("../index.js");

let port;
// The reset limiter allows 3 tries per address per 15 minutes; every
// request here comes from its own loopback address so only the logic under
// test decides the outcome. 127.0.0.2 and up are not this machine's own
// addresses, so to the panel they are remote callers; 127.0.0.1 is local.
let nextAddress = 20;
const freshAddress = () => `127.0.0.${nextAddress++}`;
const LOCAL = "127.0.0.1";

function request(method, path, body, fromAddress = freshAddress()) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        localAddress: fromAddress,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text || "{}") }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

// POST /reset-password's handler itself, past the per-address limiter, as a
// caller on the panel host -- so this file can ask for the host's detailed
// answers as often as it needs.
async function resetAsLocalCaller(token) {
  const layer = authRouter.stack.find(
    (entry) => entry.route?.path === "/reset-password" && entry.route.methods.post,
  );
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await handler(
    {
      socket: { remoteAddress: LOCAL },
      connection: {},
      headers: {},
      cookies: {},
      body: { token, newPassword: "attacker-pw-1" },
    },
    res,
  );
  return { status: res.status.mock.calls[0]?.[0] ?? 200, body: res.json.mock.calls[0][0] };
}

const tokenPath = () => path.join(getDataPaths().dataDir, "reset-token.txt");
function writeRaw(bytes) {
  fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
  fs.writeFileSync(tokenPath(), bytes);
}
const writeToken = (token) => writeRaw(`${token}\n`);
const reset = (token, fromAddress) =>
  request("POST", "/api/auth/reset-password", { token, newPassword: "attacker-pw-1" }, fromAddress);
const passwordIs = (password) => bcrypt.compare(password, db.data.users[0].password);

// Random tokens from a fixed seed: the checks refuse a random one now and
// then (about 1 UUID in 15,000), and an unseeded draw would make this
// file fail that often. Round 6 of the A2 verification.
const seededBytes = (label, size) => crypto.createHash("sha512").update(label).digest().subarray(0, size);
const seededHex = (label, size) => seededBytes(label, size).toString("hex");
function seededUuid(label) {
  const b = Buffer.from(seededBytes(label, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
let strongTokens = 0;
const strongToken = () => seededHex(`strong-token-${strongTokens++}`, 24);

beforeAll(async () => {
  authService.jwtSecret = "reset-token-test-secret-".padEnd(64, "x");
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  fs.rmSync(tokenPath(), { force: true });
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(async () => {
  fs.rmSync(tokenPath(), { force: true });
  db.data.roles = [{ id: "role-admin", name: "admin", capabilities: ["users.manage"], isSeeded: true }];
  db.data.users = [
    {
      id: "u-admin",
      username: "admin",
      role: "admin",
      roleId: "role-admin",
      password: await bcrypt.hash("original-pw-1", 4),
      tokenGen: 0,
      refreshSessions: [],
    },
  ];
});

describe("AUTHN-5 / A2: the manual reset token has to be unguessable", () => {
  it("documents its minimum length", () => {
    expect(authRoutesModule.RESET_TOKEN_MIN_LENGTH).toBe(RESET_TOKEN_MIN_LENGTH);
  });

  it("refuses a short, human-chosen token instead of resetting the admin password with it", async () => {
    writeToken("changeme");
    const res = await reset("changeme");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESET_TOKEN_INVALID");
    expect((await resetAsLocalCaller("changeme")).body.code).toBe("RESET_TOKEN_TOO_SHORT");
    expect(await passwordIs("original-pw-1")).toBe(true);
  });

  it.each([
    "changemechangemechangeme12345678",
    "a".repeat(40),
    "0123456789abcdef0123456789abcdef",
    "qwertyuiopasdfghjklzxcvbnm123456",
    // Accepted until round 1 of the A2 verification (a remote stranger reset
    // the admin password with the first one over HTTP): keyboard columns,
    // alternating case, interleaved runs, a fixed step of two.
    "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9",
    "aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpP",
    "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "acegikmoqsuwyACEGIKMOQSUWY024680",
  ])("refuses a long but predictable token (%s), even when it is typed correctly", async (weak) => {
    expect(weak.length).toBeGreaterThanOrEqual(RESET_TOKEN_MIN_LENGTH);
    writeToken(weak);
    const res = await reset(weak);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESET_TOKEN_INVALID");
    expect((await resetAsLocalCaller(weak)).body.code).toBe("RESET_TOKEN_TOO_WEAK");
    expect(await passwordIs("original-pw-1")).toBe(true);
  });

  // Round 2 of the A2 verification: the pattern check can't see meaning, so
  // phrases, number constants and symbol templates passed it, and a remote
  // stranger reset the admin password by guessing
  // "zomboid-control-panel-reset-token" from a handful of addresses. A
  // hand-made token now has to be a generator's hex output.
  it.each([
    "zomboid-control-panel-reset-token",
    "ZomboidControlPanelResetToken2026",
    "this is my reset token for the panel",
    "the-panel-password-is-gone-help-me",
    "the quick brown fox jumps over the lazy dog",
    "one two three four five six seven eight nine ten",
    "3.14159265358979323846264338327950",
    "2.71828182845904523536028747135266",
    // The digits of pi without the point: hex, but no letters.
    "31415926535897932384626433832795028841971",
    "Aa1!Bb2@Cc3#Dd4$Ee5%Ff6^Gg7&Hh8*",
    // A base64 token: random, but its alphabet holds every word too.
    "phb20kHwWx7/1dtNtaxPYs9WAnvC2tGm",
    // Hex, but hex words with a digit or two, not a generator's mix.
    "deadbeefcafebabefacadedecade1bad",
    "c0ffeedeadbeefbaddecafbeefcafefacade",
  ])("refuses %s, which isn't a generator's hex output", async (weak) => {
    expect(weak.length).toBeGreaterThanOrEqual(RESET_TOKEN_MIN_LENGTH);
    writeToken(weak);
    const res = await reset(weak);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESET_TOKEN_INVALID");
    expect((await resetAsLocalCaller(weak)).body.code).toBe("RESET_TOKEN_TOO_WEAK");
    expect(await passwordIs("original-pw-1")).toBe(true);
  });

  it.each([
    ["48 hex characters (the panel, openssl rand -hex 24, the docs' PowerShell line)", seededHex("accepts-hex48", 24)],
    ["32 hex characters (openssl rand -hex 16)", seededHex("accepts-hex32", 16)],
    ["upper-case hex", seededHex("accepts-HEX48", 24).toUpperCase()],
    ["a UUID (uuidgen, New-Guid)", seededUuid("accepts-uuid")],
  ])("accepts %s", async (_label, token) => {
    writeToken(token);
    // The host is told only that this isn't the token: the file is usable.
    expect((await resetAsLocalCaller("not-the-token")).body.code).toBe("RESET_TOKEN_INVALID");
    const res = await reset(token);
    expect(res.status).toBe(200);
    expect(await passwordIs("attacker-pw-1")).toBe(true);
  });

  it("lets the local recovery button replace a token that isn't a generator's hex", async () => {
    writeToken("zomboid-control-panel-reset-token");
    const local = await request("POST", "/api/auth/reset-token/local", undefined, LOCAL);
    expect(local.status).toBe(200);
    const replaced = fs.readFileSync(tokenPath(), "utf8").trim();
    expect(replaced).toMatch(/^[0-9a-f]{48}$/);
  });

  it("still resets with a strong token, once", async () => {
    const token = strongToken();
    expect(token.length).toBeGreaterThanOrEqual(RESET_TOKEN_MIN_LENGTH);
    writeToken(token);
    const res = await reset(token);
    expect(res.status).toBe(200);
    expect(await passwordIs("attacker-pw-1")).toBe(true);
    expect(fs.existsSync(tokenPath())).toBe(false);
    // The browser that reset it keeps a trusted-device token that counts
    // (A1; see loginTrustedDevice.test.js).
    expect(res.body.username).toBe("admin");
    expect(authService.trustedDeviceId(db.data.users[0], res.body.deviceToken)).toBeTruthy();
  });
});

describe("A2: strangers can neither find nor destroy the operator's token", () => {
  it("wrong tokens from any number of addresses leave the token file in place, and it still works", async () => {
    const token = strongToken();
    writeToken(token);
    for (let i = 0; i < 12; i++) {
      const res = await reset(`wrong-guess-${i}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("RESET_TOKEN_INVALID");
    }
    expect(fs.readFileSync(tokenPath(), "utf8").trim()).toBe(token);

    expect((await reset(token)).status).toBe(200);
    expect(await passwordIs("attacker-pw-1")).toBe(true);
  });

  it("wrong tokens don't lock out the local recovery button, which keeps the operator's token", async () => {
    const token = strongToken();
    writeToken(token);
    for (let i = 0; i < 6; i++) await reset(`wrong-guess-${i}`);
    const local = await request("POST", "/api/auth/reset-token/local", undefined, LOCAL);
    expect(local.status).toBe(200);
    expect(fs.readFileSync(tokenPath(), "utf8").trim()).toBe(token);
  });

  it("GET /reset-status tells only the panel host whether a token file exists", async () => {
    writeToken(strongToken());
    const remote = await request("GET", "/api/auth/reset-status");
    expect(remote.status).toBe(200);
    expect(remote.body).not.toHaveProperty("resetAvailable");
    expect(remote.body.localResetSupported).toBe(false);

    const local = await request("GET", "/api/auth/reset-status", undefined, LOCAL);
    expect(local.body).toMatchObject({ resetAvailable: true, localResetSupported: true });
  });

  it("POST /reset-password answers a remote caller the same whether or not a token file exists", async () => {
    const missing = await reset("some-guess-that-is-long-enough-000000");
    writeToken(strongToken());
    const present = await reset("some-guess-that-is-long-enough-000000");
    expect(missing).toEqual(present);
    expect(present.status).toBe(403);
    expect(present.body.code).toBe("RESET_TOKEN_INVALID");

    // The host itself still gets the specific reason.
    fs.rmSync(tokenPath());
    expect((await resetAsLocalCaller("anything")).body.code).toBe("RESET_TOKEN_NOT_FOUND");
  });

  // Round 1 of the A2 verification: a token file the panel can't read
  // (owned by another account, mode 0600) made /reset-password answer with
  // the filesystem error instead of the usual refusal, which said the file
  // exists.
  it("POST /reset-password answers a remote caller the same when the file exists but can't be read", async () => {
    const missing = await reset("some-guess-that-is-long-enough-000000");
    writeToken(strongToken());
    // The token file is opened once for its checks and its read (CodeQL
    // js/file-system-race), so an unreadable one fails at open.
    const openSync = fs.openSync;
    const unreadable = vi.spyOn(fs, "openSync").mockImplementation((file, ...rest) => {
      if (String(file) === tokenPath()) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${tokenPath()}'`), { code: "EACCES" });
      }
      return openSync(file, ...rest);
    });
    try {
      const present = await reset("some-guess-that-is-long-enough-000000");
      expect(present).toEqual(missing);
      // The host itself still sees what went wrong.
      const local = await resetAsLocalCaller("anything");
      expect(local.status).toBe(400);
      expect(local.body.error).toMatch(/EACCES/);
    } finally {
      unreadable.mockRestore();
    }
    expect(fs.existsSync(tokenPath())).toBe(true);
  });
});

// Round 3 of the A2 verification: hex is also what every text-to-hex tool
// writes, and some generator output comes from a handful of inputs. A
// stranger reset the admin password over HTTP with
// hex("zomboid-control-panel-reset-token") and with the same phrase in
// PowerShell's BitConverter form; the hash of bash's $RANDOM (32,768
// possible tokens), of a common word, and the UUIDs printed as examples
// passed too.
const hexOf = (text, encoding = "utf8") => Buffer.from(text, encoding).toString("hex");
const digest = (algorithm, input) => crypto.createHash(algorithm).update(input).digest("hex");
const utf32leHex = (text) =>
  Buffer.concat(
    Array.from(text, (char) => {
      const unit = Buffer.alloc(4);
      unit.writeUInt32LE(char.codePointAt(0));
      return unit;
    }),
  ).toString("hex");

describe("A2 round 3: hex a stranger can guess", () => {
  it.each([
    ["a phrase as hex (xxd -p, Python's .hex())", hexOf("zomboid-control-panel-reset-token")],
    ["a phrase as PowerShell's BitConverter writes it", hexOf("ZomboidPanelRecovery2026").toUpperCase().match(/../g).join("-")],
    ["a phrase as UTF-16LE hex", hexOf("zomboid-panel-reset", "utf16le")],
    ["a phrase as hex with a digit added", `a${hexOf("correct horse battery staple")}`],
    ["echo $RANDOM | md5sum | head -c 32", digest("md5", "12345\n")],
    ["echo $RANDOM | sha256sum | head -c 48", digest("sha256", "31337\n").slice(0, 48)],
    ["echo password | md5sum", digest("md5", "password\n")],
    ["the md5 of nothing", digest("md5", "")],
    ["Wikipedia's example UUID", "123e4567-e89b-12d3-a456-426614174000"],
    ["RFC 4122's example UUID", "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"],
    // Round 4: UTF-8 with a single character beyond ASCII, UTF-16 in
    // Arabic, and the near variants of the well-known values.
    ["a phrase with one accented letter as hex", hexOf("Passwort zurück")],
    ["a phrase with one curly apostrophe as hex", hexOf("Zomboid’s reset token")],
    ["a phrase with one emoji as hex", hexOf("Zomboid reset 🔑")],
    ["an Arabic phrase as UTF-16LE hex", hexOf("كلمة سر اللوحة", "utf16le")],
    ["an Arabic phrase as PowerShell's BitConverter of UTF-16", hexOf("إعادة تعيين كلمة المرور", "utf16le").toUpperCase().match(/../g).join("-")],
    ["cmd's echo %RANDOM% > file, hashed with certutil", digest("sha1", "12345 \r\n")],
    ["echo $RANDOM | sha384sum | head -c 32", digest("sha384", "12345\n").slice(0, 32)],
    ["echo PASSWORD | md5sum", digest("md5", "PASSWORD\n")],
    ["PostgreSQL's example UUID", "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"],
    // Round 5: UTF-16 text with an emoji, in Vietnamese, in Chinese or
    // Korean, and Cyrillic in Windows-1251. A stranger who guessed the
    // first two reset the admin password over HTTP.
    ["a phrase with one emoji as UTF-16LE hex ([Text.Encoding]::Unicode)", hexOf("Zomboid reset 🔑", "utf16le")],
    ["a Vietnamese phrase as UTF-16LE hex", hexOf("Đặt lại mật khẩu bảng điều khiển", "utf16le")],
    ["a Vietnamese phrase as PowerShell's BitConverter of UTF-16", hexOf("Khôi phục mật khẩu", "utf16le").toUpperCase().match(/../g).join("-")],
    ["a Chinese phrase as UTF-16LE hex", hexOf("重置密码面板令牌", "utf16le")],
    ["a Korean phrase as UTF-16LE hex", hexOf("비밀번호 재설정 패널", "utf16le")],
    ["a Russian phrase in Windows-1251 as hex", Buffer.from(Array.from("сброс пароля зомбоид", (c) => (c === " " ? 0x20 : 0xc0 + c.charCodeAt(0) - 0x410))).toString("hex")],
    // Round 6: UTF-32, Chinese in GBK or Big5 (Windows PowerShell 5.1's
    // [Text.Encoding]::Default on a Chinese Windows), and UTF-16 with the
    // other emoji and symbols. A stranger who guessed the first one, the
    // docs' own example of a refused phrase, reset the admin password.
    ["the docs' example phrase as UTF-32LE hex ([Text.Encoding]::UTF32)", utf32leHex("zomboid-control-panel-reset-token")],
    ["a simplified Chinese phrase in GBK as PowerShell's BitConverter writes it", "D6-D8-D6-C3-C3-DC-C2-EB-C3-E6-B0-E5-C1-EE-C5-C6"],
    ["a traditional Chinese phrase in Big5 as hex", "b3e0abcda6f8aa41beb9adabb35db14bbd58"],
    ["a phrase with stars as UTF-16LE hex", hexOf("zomboid⭐panel⭐reset", "utf16le")],
    // Round 7: the same code-page text with the line break a tool adds at
    // the end. A stranger who guessed the phrase reset the admin password
    // with the first two.
    ["a simplified Chinese phrase in GBK with Set-Content's CRLF, as BitConverter writes it", "D6-D8-D6-C3-C3-DC-C2-EB-C3-E6-B0-E5-C1-EE-C5-C6-0D-0A"],
    ["a traditional Chinese phrase in Big5 with echo's line break (iconv -t big5 | xxd -p)", "b3e0abcda6f8aa41beb9adabb35db14bbd580a"],
    ["a Russian phrase in Windows-1251 with echo's line break", `${Buffer.from(Array.from("сброс пароля зомбоид", (c) => (c === " " ? 0x20 : 0xc0 + c.charCodeAt(0) - 0x410))).toString("hex")}0a`],
  ])("refuses %s, even when it is typed correctly", async (_label, weak) => {
    expect(weak.replaceAll("-", "").length).toBeGreaterThanOrEqual(RESET_TOKEN_MIN_LENGTH);
    writeToken(weak);
    const res = await reset(weak);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESET_TOKEN_INVALID");
    expect((await resetAsLocalCaller(weak)).body.code).toBe("RESET_TOKEN_TOO_WEAK");
    expect(await passwordIs("original-pw-1")).toBe(true);
    expect(fs.existsSync(tokenPath())).toBe(true);
  });

  // Round 5: the host was told this one was ready to use.
  it("doesn't tell the host a Vietnamese phrase as UTF-16LE hex is ready", async () => {
    writeToken(hexOf("Đặt lại mật khẩu bảng điều khiển", "utf16le"));
    const status = await request("GET", "/api/auth/reset-status", undefined, LOCAL);
    expect(status.body).toMatchObject({ resetAvailable: false, localResetSupported: true });
  });

  it("doesn't tell the host such a token is ready, and the local recovery button replaces it", async () => {
    writeToken(hexOf("zomboid-control-panel-reset-token"));
    const status = await request("GET", "/api/auth/reset-status", undefined, LOCAL);
    expect(status.body).toMatchObject({ resetAvailable: false, localResetSupported: true });

    const local = await request("POST", "/api/auth/reset-token/local", undefined, LOCAL);
    expect(local.status).toBe(200);
    const replaced = fs.readFileSync(tokenPath(), "utf8").trim();
    expect(replaced).toMatch(/^[0-9a-f]{48}$/);
    expect((await reset(replaced)).status).toBe(200);
  });

  it("the local recovery button draws again rather than write a token its own checks refuse", async () => {
    // 24 random bytes that happen to be printable text, as one in five
    // million draws are.
    const textBytes = Buffer.from("ZomboidPanelRecoveryTok!");
    const randomBytes = crypto.randomBytes;
    let handedOut = false;
    const draw = vi.spyOn(crypto, "randomBytes").mockImplementation((size, ...rest) => {
      if (size === 24 && !handedOut) {
        handedOut = true;
        return Buffer.from(textBytes);
      }
      return randomBytes(size, ...rest);
    });
    try {
      const local = await request("POST", "/api/auth/reset-token/local", undefined, LOCAL);
      expect(local.status).toBe(200);
    } finally {
      draw.mockRestore();
    }
    expect(handedOut).toBe(true);
    const written = fs.readFileSync(tokenPath(), "utf8").trim();
    expect(written).not.toBe(textBytes.toString("hex"));
    expect(written).toMatch(/^[0-9a-f]{48}$/);
    expect((await reset(written)).status).toBe(200);
  });
});

// Round 3 of the A2 verification: the file is read the same whichever
// tool wrote it. Windows PowerShell 5.1's `>` (`openssl rand -hex 24 >
// data\reset-token.txt`) and Out-File write UTF-16 with a byte order mark,
// which used to be refused as "not hex".
describe("A2 round 3: the token file as each tool writes it", () => {
  const token = "3f9a0c7be15d42a8960e7d1fb4c2a95e0d63b8f1c7a24e59";
  it.each([
    ["with a line break (openssl rand -hex 24 > file)", () => Buffer.from(`${token}\n`)],
    ["with a Windows line break (Set-Content)", () => Buffer.from(`${token}\r\n`)],
    ["with no line break (Set-Content -NoNewline)", () => Buffer.from(token)],
    ["as UTF-8 with a byte order mark (Notepad, Out-File -Encoding utf8)", () =>
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${token}\r\n`)])],
    ["as UTF-16LE with a byte order mark (Windows PowerShell's >)", () =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${token}\r\n`, "utf16le")])],
    ["as UTF-16BE with a byte order mark", () =>
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${token}\r\n`, "utf16le").swap16()])],
    // Round 4: read as UTF-16, this was refused as not hex.
    ["as UTF-32LE with a byte order mark (Set-Content -Encoding utf32)", () => {
      const text = `${token}\r\n`;
      const bytes = Buffer.alloc(4 + text.length * 4);
      bytes.set([0xff, 0xfe, 0, 0]);
      for (let i = 0; i < text.length; i++) bytes.writeUInt32LE(text.charCodeAt(i), 4 + 4 * i);
      return bytes;
    }],
  ])("accepts a token written %s", async (_label, bytes) => {
    writeRaw(bytes());
    const res = await reset(token);
    expect(res.status).toBe(200);
    expect(await passwordIs("attacker-pw-1")).toBe(true);
  });
});
