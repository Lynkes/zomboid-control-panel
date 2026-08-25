import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args) => mockExecFile(...args),
}));

const {
  buildBundleDiagnostics,
  buildSystemInfo,
  buildServerConfigSummary,
  buildOidcStatus,
  buildRolesAndPermissions,
  checkCurlAvailable,
  buildWorldMapDiagnostics,
  buildDbWriteHealth,
  buildBackupsSummary,
  buildDiscordBotStatus,
} = await import("../routes/debug.js");

function fakeReq(services = {}, headers = {}) {
  return { app: { get: (key) => services[key] }, headers };
}

describe("support bundle: curl availability (World Map's runtime dependency)", () => {
  afterEach(() => mockExecFile.mockReset());

  it("reports available with a version string when curl is on PATH", async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      cb(null, "curl 8.4.0 (x86_64-pc-win32)\nRelease-Date: 2023-10-11", "");
    });
    const result = await checkCurlAvailable();
    expect(result.available).toBe(true);
    expect(result.version).toContain("curl 8.4.0");
  });

  it("reports unavailable with a clear reason when curl is missing (ENOENT)", async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      const err = new Error("spawn curl ENOENT");
      err.code = "ENOENT";
      cb(err);
    });
    const result = await checkCurlAvailable();
    expect(result).toEqual({ available: false, reason: "curl is not on PATH" });
  });

  it("buildWorldMapDiagnostics combines curl status with the B42 resolution contract shape", async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "curl 8.4.0", ""));
    const result = await buildWorldMapDiagnostics();
    expect(result.curl.available).toBe(true);
    // Contract fixed in conv-mapbuild: { source, directory, reason }.
    expect(result.b42Resolution).toHaveProperty("source");
    expect(result.b42Resolution).toHaveProperty("directory");
    expect(result.b42Resolution).toHaveProperty("reason");
  });
});

describe("support bundle: OIDC status never leaks the client secret value", () => {
  it("reports configuration only -- clientSecretSet is a boolean, the actual secret never appears anywhere in the output", async () => {
    const result = await buildOidcStatus();
    expect(result).not.toHaveProperty("_error");
    expect(typeof result.clientSecretSet).toBe("boolean");
    expect(JSON.stringify(result)).not.toMatch(/clientSecret"\s*:\s*"(?!.*Set)/);
    // The literal key "clientSecret" (the value) must never appear -- only
    // "clientSecretSet" (the boolean).
    expect(result).not.toHaveProperty("clientSecret");
    expect(result).toHaveProperty("envOverrides");
  });
});

describe("support bundle: roles and permissions", () => {
  it("returns an array of roles and an array of local users with no unexpected shape", async () => {
    const result = await buildRolesAndPermissions();
    expect(result).not.toHaveProperty("_error");
    expect(Array.isArray(result.roles)).toBe(true);
    expect(Array.isArray(result.users)).toBe(true);
    // Every role entry must carry what a support reader needs to answer
    // "what does this role grant".
    for (const role of result.roles) {
      expect(role).toHaveProperty("name");
      expect(Array.isArray(role.capabilities)).toBe(true);
      expect(typeof role.memberCount).toBe("number");
    }
    for (const user of result.users) {
      expect(user).toHaveProperty("username");
      expect(user).toHaveProperty("role");
      // No password/hash field of any kind should ever reach this collector.
      expect(user).not.toHaveProperty("password");
    }
  });
});

describe("support bundle: db write health", () => {
  it("surfaces db.json's circuit breaker state read-only, closed by default", async () => {
    const result = buildDbWriteHealth();
    expect(result).not.toHaveProperty("_error");
    expect(result).toHaveProperty("open");
    expect(result).toHaveProperty("failCount");
    expect(result).toHaveProperty("cooldownEndsAt");
  });
});

describe("support bundle: backups summary", () => {
  it("combines backup settings and recent run history, masking a credential-shaped field if one were ever present", async () => {
    const req = fakeReq({
      backupService: {
        getSettings: async () => ({
          enabled: true,
          schedule: "0 */6 * * *",
          maxBackups: 10,
          includeDb: true,
          // Deliberately injected to prove sanitizeForBundle is really
          // applied here, not just declared in a comment.
          apiKey: "sk-live-should-never-appear",
        }),
      },
    });
    const result = await buildBackupsSummary(req);
    expect(result).not.toHaveProperty("_error");
    expect(result.settings.schedule).toBe("0 */6 * * *");
    expect(result.settings.apiKey).toBe("••••");
    expect(Array.isArray(result.recentRuns)).toBe(true);
  });

  it("degrades to _error, not a thrown exception, when backupService itself throws", async () => {
    const req = fakeReq({});
    req.app.get = (key) => {
      if (key === "backupService") throw new Error("boom-backup-service");
      return null;
    };
    const result = await buildBackupsSummary(req);
    expect(result._error).toContain("boom-backup-service");
  });
});

describe("support bundle: Discord bot status", () => {
  it("passes through connection/guild/channel info and masks a token-shaped field", async () => {
    const req = fakeReq({
      discordBot: {
        getStatus: () => ({
          running: true,
          configured: true,
          username: "PZBot#1234",
          guildId: "111",
          channelId: "222",
          modRoleId: null,
          lastStartError: null,
          // getStatus() never actually returns this in real code, but if a
          // future change accidentally added it, sanitizeForBundle must
          // still catch it -- defense in depth, proven rather than assumed.
          token: "should-never-survive",
        }),
      },
    });
    const result = await buildDiscordBotStatus(req);
    expect(result.running).toBe(true);
    expect(result.guildId).toBe("111");
    expect(result.token).toBe("••••");
  });

  it("reports unavailable rather than throwing when no Discord bot is registered", async () => {
    const req = fakeReq({});
    const result = await buildDiscordBotStatus(req);
    expect(result).toEqual({ available: false });
  });
});

describe("support bundle: system info reports whether the server process was running", () => {
  it("reports running:true, scanFailed:false when the process check succeeds", async () => {
    const serverManager = {
      getServerProcessDetails: async () => ({ running: true, scanFailed: false }),
    };
    const result = await buildSystemInfo(null, serverManager);
    expect(result.serverProcess).toEqual({ checked: true, running: true, scanFailed: false });
  });

  it("reports scanFailed:true rather than a false 'not running' when detection itself fails", async () => {
    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: true }),
    };
    const result = await buildSystemInfo(null, serverManager);
    expect(result.serverProcess.scanFailed).toBe(true);
  });

  it("reports checked:false rather than throwing when no serverManager is available", async () => {
    const result = await buildSystemInfo(null, null);
    expect(result.serverProcess).toEqual({ checked: false });
  });

  it("defaults uiLanguage to 'not reported' when the caller doesn't supply one", async () => {
    const result = await buildSystemInfo(null, null);
    expect(result.uiLanguage).toBe("not reported");
  });
});

describe("support bundle: UI language reported by the bundle-download request", () => {
  // buildBundleDiagnostics also runs buildWorldMapDiagnostics, which shells
  // out to curl -- give the mock a working implementation so that Promise.all
  // resolves instead of hanging on an unconfigured child_process mock.
  beforeEach(() => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "curl 8.4.0", ""));
  });
  afterEach(() => mockExecFile.mockReset());

  it("threads a plausible BCP-47-shaped header value straight through system-info.json", async () => {
    const req = fakeReq({}, { "x-ui-language": "zh-CN" });
    const files = await buildBundleDiagnostics(null, req);
    const systemInfo = JSON.parse(files.find((f) => f.name === "system-info.json").content);
    expect(systemInfo.uiLanguage).toBe("zh-CN");
  });

  it("degrades to 'not reported' rather than guessing 'en' when the header is absent", async () => {
    const req = fakeReq({});
    const files = await buildBundleDiagnostics(null, req);
    const systemInfo = JSON.parse(files.find((f) => f.name === "system-info.json").content);
    expect(systemInfo.uiLanguage).toBe("not reported");
  });

  it("degrades to 'not reported' for a garbage or oversized header rather than writing it through unvalidated", async () => {
    const tooLong = fakeReq({}, { "x-ui-language": "a".repeat(200) });
    const notALocale = fakeReq({}, { "x-ui-language": "<script>alert(1)</script>" });

    const tooLongResult = await buildBundleDiagnostics(null, tooLong);
    const notALocaleResult = await buildBundleDiagnostics(null, notALocale);

    expect(
      JSON.parse(tooLongResult.find((f) => f.name === "system-info.json").content).uiLanguage,
    ).toBe("not reported");
    expect(
      JSON.parse(notALocaleResult.find((f) => f.name === "system-info.json").content).uiLanguage,
    ).toBe("not reported");
  });

  it("README describes the new field and no longer carries the stale 'not included' exclusion", async () => {
    const req = fakeReq({});
    const files = await buildBundleDiagnostics(null, req);
    const readme = files.find((f) => f.name === "README.md").content;
    expect(readme).toContain("uiLanguage");
    expect(readme).not.toContain("Which UI language the reporting user had selected");
  });
});

describe("support bundle: server config summary flags a Mods/WorkshopItems length mismatch", () => {
  let configDir;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-bundle-config-"));
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  function writeIni(mods, workshopItems) {
    fs.writeFileSync(
      path.join(configDir, "servertest.ini"),
      `Mods=${mods}\nWorkshopItems=${workshopItems}\n`,
    );
  }

  it("flags true when the two lists have different lengths", async () => {
    writeIni("ModA;ModB", "111111");
    const result = await buildServerConfigSummary({
      serverConfigPath: configDir,
      serverName: "servertest",
    });
    // Also pins a real, pre-existing bug found while adding this field:
    // debug.js called crypto.createHash() with no `import crypto` anywhere
    // in the file. Node's ESM-global `crypto` is the Web Crypto API only
    // (no createHash), so this threw on every real request and was silently
    // swallowed by the collector's own try/catch -- ini.sha256/settings/
    // mods/workshopItems/map (and this new field) were ALWAYS missing in
    // practice, masked as a generic ini.error. Fixed alongside this task
    // since it directly blocked the new field from ever being reachable.
    expect(result.ini.error).toBeUndefined();
    expect(result.ini.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ini.modsWorkshopCountMismatch).toBe(true);
  });

  it("flags false when the two lists are the same length", async () => {
    writeIni("ModA;ModB", "111111;222222");
    const result = await buildServerConfigSummary({
      serverConfigPath: configDir,
      serverName: "servertest",
    });
    expect(result.ini.modsWorkshopCountMismatch).toBe(false);
  });
});

describe("support bundle assembly: one collector throwing never breaks the rest", () => {
  it("degrades exactly the failing file to _error and leaves every other file intact", async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "curl 8.4.0", ""));
    const req = fakeReq({});
    req.app.get = (key) => {
      if (key === "backupService") throw new Error("boom-backup-service");
      return null;
    };

    const files = await buildBundleDiagnostics(null, req);
    const byName = Object.fromEntries(files.map((f) => [f.name, f.content]));

    expect(JSON.parse(byName["backups-summary.json"])._error).toContain(
      "boom-backup-service",
    );
    // Every other new collector still produced a real result, not an error.
    for (const name of [
      "oidc-status.json",
      "roles-and-permissions.json",
      "world-map-diagnostics.json",
      "db-write-health.json",
      "discord-bot-status.json",
      "system-info.json",
    ]) {
      expect(byName[name]).toBeDefined();
      expect(JSON.parse(byName[name])._error).toBeUndefined();
    }
    // README.md was updated to describe every file actually produced.
    expect(byName["README.md"]).toContain("roles-and-permissions.json");
    expect(byName["README.md"]).toContain("oidc-status.json");
  });
});
