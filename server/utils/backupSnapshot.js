import fs from "fs";
import path from "path";
import { readIniValues, readSandboxValue } from "./templateFiles.js";
import { serverConfigDirOf } from "./serverConfigPath.js";

const INI_KEYS = [
  "MaxPlayers",
  "PVP",
  "Map",
  "Public",
  "PublicName",
  "PauseEmpty",
  "Faction",
  "PlayerSafehouse",
  "GlobalChat",
  "SleepAllowed",
  "SleepNeeded",
];

const SANDBOX_KEYS = [
  "Zombies",
  "DayLength",
  "XpMultiplier",
  "FoodLootNew",
  "WeaponLootNew",
  "OtherLootNew",
  "HoursForLootRespawn",
];

// SECURITY (2026-10-05, PATHS-2): a configured config folder is read only
// while it is inside the server's own data folder (utils/serverConfigPath.js);
// refused, the snapshot just has no ini/sandbox values, as with no folder.
function getConfigPath(server) {
  return serverConfigDirOf(server).dir;
}

function readFileIfPresent(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

export function captureBackupSnapshot(server) {
  const serverName = server?.serverName || "server";
  const configPath = getConfigPath(server);
  const iniContent = configPath
    ? readFileIfPresent(path.join(configPath, `${serverName}.ini`))
    : null;
  const sandboxContent = configPath
    ? readFileIfPresent(path.join(configPath, `${serverName}_SandboxVars.lua`))
    : null;
  const sandbox = {};

  for (const key of SANDBOX_KEYS) {
    const value = sandboxContent
      ? readSandboxValue(sandboxContent, "settings", key)
      : undefined;
    if (value !== undefined) sandbox[key] = value;
  }

  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    server: {
      id: server?.id ?? null,
      name: serverName,
      provider: server?.provider ?? (server?.isRemote ? "remote-sftp" : "native"),
    },
    serverIni: iniContent ? readIniValues(iniContent, INI_KEYS) : {},
    sandboxVars: sandbox,
  };
}