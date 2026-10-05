import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";

// PR #193 review leftover (security sweep 2026-10-04): GET
// /api/config/app-settings has no capability gate -- the pages every role
// opens read a setting or two from it -- and returned the whole settings
// store to every role: host paths (HTTPS certificate and key, the legacy
// server folders, the pre-update data backup), the SFTP host, account and
// folders, the Steam account name, Discord and OIDC configuration. A role
// without panel.settings now gets the app-behaviour keys, the keys of the
// capabilities it holds, and a placeholder for each secret Settings edits.
//
// Full stack through the real config router and the real, unmocked
// database/init.js, so the seeded admin / technician / moderator roles
// decide.
const db = await import("../database/init.js");
const { default: configRouter } = await import("../routes/config.js");

const STORED = {
  // App behaviour every role's pages read.
  autoStartServer: true,
  autoExportOnLogin: true,
  chatPresets: ["Restart in 5 minutes"],
  panelPort: 3001,
  lanIpAddress: "192.168.1.20",
  // Host paths and accounts behind panel.settings.
  httpsKeyPath: "/etc/zcp/private/key.pem",
  httpsCertPath: "/etc/zcp/private/cert.pem",
  corsAllowedOrigins: "https://panel.internal.example",
  // Behind a capability technician holds.
  serverPath: "/srv/pz/install",
  zomboidDataPath: "/srv/pz/Zomboid",
  serverConfigPath: "/srv/pz/Zomboid/Server",
  steamcmdPath: "/opt/steamcmd",
  steamUpdateAccount: "steam-login-name",
  panelBridgeSftpHost: "pz.internal.example",
  panelBridgeSftpUsername: "pzuser",
  panelBridgeSftpBridgePath: "/home/pzuser/Zomboid/Lua/panelbridge/Main",
  discordGuildId: "123456789012345678",
  // Secrets Settings edits: a placeholder for every role.
  steamApiKey: "steam-api-key-ABCD",
  panelBridgeSftpPassword: "sftp-pass-EFGH",
  // Settings other routes keep for themselves.
  preUpdateDataBackupPath: "/srv/zcp/backups/pre-update",
  oidcClientId: "panel-client",
  oidcIssuerUrl: "https://sso.internal.example",
  discordBotToken: "discord-token-IJKL",
};

const PANEL_ONLY = ["httpsKeyPath", "httpsCertPath", "corsAllowedOrigins"];
const TECHNICIAN_CAPABILITY_KEYS = [
  "serverPath",
  "zomboidDataPath",
  "serverConfigPath",
  "steamcmdPath",
  "steamUpdateAccount",
  "panelBridgeSftpHost",
  "panelBridgeSftpUsername",
  "panelBridgeSftpBridgePath",
];
// discordGuildId is /api/discord's (integrations.manage reads it there), not
// an app setting any more -- see VALID_SETTINGS_KEYS in routes/config.js.
const INTERNAL = [
  "preUpdateDataBackupPath",
  "oidcClientId",
  "oidcIssuerUrl",
  "discordBotToken",
  "discordGuildId",
];

let baseUrl;
let httpServer;
let currentRole = "moderator";

async function getAppSettings(role) {
  currentRole = role;
  const res = await fetch(`${baseUrl}/api/config/app-settings`);
  expect(res.status).toBe(200);
  return (await res.json()).settings;
}

beforeAll(async () => {
  await db.initDatabase();
  for (const [key, value] of Object.entries(STORED)) await db.setSetting(key, value);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: `u-${currentRole}`, username: currentRole, role: currentRole };
    next();
  });
  app.use("/api/config", configRouter);
  await new Promise((resolve) => {
    httpServer = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => httpServer?.close(r));
});

describe("GET /api/config/app-settings by role", () => {
  it("moderator: app behaviour and secret placeholders, no paths, hosts or accounts", async () => {
    const settings = await getAppSettings("moderator");
    expect(settings).toMatchObject({
      autoStartServer: true,
      autoExportOnLogin: true,
      chatPresets: ["Restart in 5 minutes"],
      panelPort: 3001,
      lanIpAddress: "192.168.1.20",
      steamApiKey: "••••••••",
      panelBridgeSftpPassword: "••••••••",
    });
    for (const key of [...PANEL_ONLY, ...TECHNICIAN_CAPABILITY_KEYS, ...INTERNAL]) {
      expect(settings).not.toHaveProperty(key);
    }
  });

  it("technician: also what its capabilities edit, still no panel-only paths or internal settings", async () => {
    const settings = await getAppSettings("technician");
    for (const key of TECHNICIAN_CAPABILITY_KEYS) expect(settings[key]).toBe(STORED[key]);
    for (const key of [...PANEL_ONLY, ...INTERNAL]) expect(settings).not.toHaveProperty(key);
    expect(settings.steamApiKey).toBe("••••••••");
  });

  it("admin (panel.settings): everything, secrets masked", async () => {
    const settings = await getAppSettings("admin");
    for (const key of [...PANEL_ONLY, ...TECHNICIAN_CAPABILITY_KEYS, "preUpdateDataBackupPath", "oidcClientId"]) {
      expect(settings[key]).toEqual(STORED[key]);
    }
    expect(settings.discordBotToken).toBe("••••••••");
    expect(settings.steamApiKey).toBe("••••••••");
  });

  it("a role that no longer resolves gets the any-role keys alone", async () => {
    const settings = await getAppSettings("deleted-role");
    expect(settings.autoStartServer).toBe(true);
    for (const key of [...PANEL_ONLY, ...TECHNICIAN_CAPABILITY_KEYS, ...INTERNAL]) {
      expect(settings).not.toHaveProperty(key);
    }
  });
});
