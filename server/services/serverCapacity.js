import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { getActiveServer, getSetting } from "../database/init.js";
import { readIniValues } from "../utils/templateFiles.js";
import {
  activeServerConfigDir,
  serverConfigDirRefusal,
} from "../utils/serverConfigPath.js";
import { describeRefusal, logRefusalOnce } from "./zomboidDataPath.js";

const log = createLogger("ServerCapacity");

/**
 * MaxPlayers from the active server's own config INI (the folder Server Files
 * uses, `<serverName>.ini`), or null when it cannot be determined.
 *
 * Moved here from discordBot.js unchanged in behaviour: the Discord presence
 * ("3/4 online") and the dashboard's players telemetry bar both need this
 * number, and index.js could not import it from discordBot.js (circular).
 *
 * SECURITY (2026-10-05, PATHS-2): read only from the config folder Server
 * Files uses -- a configured one only while it is inside the data folder in
 * effect (utils/serverConfigPath.js) -- and never from a path built from an
 * unvalidated server name (basename-equal, no ".."). Refusals are logged at
 * warn once per folder and reason (this may run on every presence update and
 * every perf tick), then at debug.
 */
export async function readConfiguredMaxPlayers() {
  try {
    const activeServer = await getActiveServer();
    const serverName =
      activeServer?.serverName || (await getSetting("serverName"));
    const legacy = activeServer?.zomboidDataPath
      ? {}
      : {
          serverConfigPath: await getSetting("serverConfigPath"),
          zomboidDataPath: await getSetting("zomboidDataPath"),
        };
    const config = activeServerConfigDir(activeServer, legacy);
    if (config.refused) {
      logRefusalOnce(
        log,
        `MaxPlayers: not reading it (Zomboid data folder: ${config.dataPath || "not set"}): ${describeRefusal(serverConfigDirRefusal(config))}`,
      );
    }
    const configPath = config.dir;

    if (
      !configPath ||
      !serverName ||
      typeof serverName !== "string" ||
      path.basename(serverName) !== serverName ||
      serverName.includes("..")
    ) {
      return null;
    }

    const iniPath = path.join(configPath, `${serverName}.ini`);
    if (!fs.existsSync(iniPath)) return null;

    const content = fs.readFileSync(iniPath, "utf8");
    const maxPlayers = Number.parseInt(
      readIniValues(content, ["MaxPlayers"]).MaxPlayers,
      10,
    );
    return Number.isInteger(maxPlayers) && maxPlayers > 0 ? maxPlayers : null;
  } catch (error) {
    log.debug(`Could not read MaxPlayers: ${error.message}`);
    return null;
  }
}
