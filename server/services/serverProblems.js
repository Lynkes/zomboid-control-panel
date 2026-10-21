// What GET /api/debug/problems reads before utils/serverErrorFinder.js turns
// it into findings: the active server's latest game log, its mod setup and
// the facts the fixes need (its id, whether it runs, its memory and port).
//
// Only the server's own data folder is read, and only the folder the
// data-folder rule allows (the caller passes getActiveServerPaths()'s
// zomboidDataPath, which is null when that rule refused it): its
// server-console.txt, else the newest Logs/*DebugLog-server.txt at the top of
// Logs/. Both within utils/workshopLogScan.js's head and tail bounds.

import fs from "fs";
import os from "os";
import path from "path";
import { CONSOLE_HEAD_BYTES, CONSOLE_TAIL_BYTES, readConsoleHeadAndTailSync } from "../utils/workshopLogScan.js";
import { findServerErrors } from "../utils/serverErrorFinder.js";
import { normalizeMemoryGb } from "../utils/memory.js";
import { readTextFile } from "../utils/modIni.js";
import { loadModSmartContext } from "./modSmartContext.js";
import { BRIDGE_MOD_ID } from "./bridgeDeliveryContract.js";

const SERVER_DEBUG_LOG_RE = /DebugLog-server\.txt$/i;
const MAX_LOG_DIR_ENTRIES = 2000;

// The newest *DebugLog-server.txt directly in <data>/Logs (older runs are
// moved into logs_<date>/ subfolders by the game).
function newestServerDebugLog(zomboidDataPath) {
  const dir = path.join(zomboidDataPath, "Logs");
  let entries;
  try {
    // codeql[js/path-injection] zomboidDataPath passed the data-folder rule (getActiveServerPaths).
    entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, MAX_LOG_DIR_ENTRIES);
  } catch {
    return null;
  }
  let best = null;
  for (const entry of entries) {
    if (!entry.isFile() || !SERVER_DEBUG_LOG_RE.test(entry.name)) continue;
    try {
      const stat = fs.statSync(path.join(dir, entry.name));
      if (!best || stat.mtimeMs > best.mtimeMs) best = { name: entry.name, mtimeMs: stat.mtimeMs };
    } catch {
      /* gone meanwhile */
    }
  }
  return best ? { dir, name: best.name } : null;
}

/** The latest game log of a data folder, as finder input, or null. */
export function readLatestGameLog(zomboidDataPath) {
  if (typeof zomboidDataPath !== "string" || !zomboidDataPath) return null;
  let file = "server-console.txt";
  let read = readConsoleHeadAndTailSync(zomboidDataPath, CONSOLE_HEAD_BYTES, CONSOLE_TAIL_BYTES);
  if (!read) {
    const alt = newestServerDebugLog(zomboidDataPath);
    if (alt) {
      file = `Logs/${alt.name}`;
      read = readConsoleHeadAndTailSync(alt.dir, CONSOLE_HEAD_BYTES, CONSOLE_TAIL_BYTES, alt.name);
    }
  }
  if (!read) return null;
  const logs = read.chunks.map((text, i) => ({ text, partialStart: i > 0, gapBefore: i > 0 }));
  return {
    file,
    mtime: read.mtime,
    logs,
    partial: read.chunks.length > 1,
    bytes: read.chunks.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  };
}

function iniNumber(content, key) {
  const m = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(\\d{1,5})[ \\t]*$`, "m").exec(content || "");
  return m ? Number(m[1]) : null;
}

/**
 * @param {object} input
 * @param {object|null} input.activeServer  the active server record
 * @param {string|null} input.zomboidDataPath  held to the data-folder rule
 * @param {string|null} input.serverPath  the install folder (Workshop content)
 * @param {string|null} input.iniPath  the active server's <name>.ini
 * @param {boolean|null} input.running  null when the process scan failed
 * @param {object[]} input.panelLog  routes/debug.js's in-memory log buffer
 * @param {(text: string) => string} [input.redact]
 */
export async function scanServerProblems({
  activeServer = null,
  zomboidDataPath = null,
  serverPath = null,
  iniPath = null,
  running = null,
  panelLog = [],
  redact = null,
  hostMemoryGb = os.totalmem() / 1024 ** 3,
  now = Date.now(),
} = {}) {
  const gameLog = readLatestGameLog(zomboidDataPath);

  let content = null;
  try {
    // codeql[js/path-injection] iniPath comes from getSanitizedIniPath() over the rule-checked config folder.
    if (iniPath && fs.existsSync(iniPath)) content = readTextFile(iniPath);
  } catch {
    content = null;
  }

  let mods = [];
  let enabledModIds = [];
  let workshopItems = [];
  if (content !== null) {
    try {
      const ctx = await loadModSmartContext({ content, serverPath, zomboidDataPath, catalogOnly: true });
      const legacy = [...ctx.legacyMods].map(([id, mod]) => ({ id, name: mod.name, workshopId: mod.workshopId, source: mod.source }));
      mods = [...ctx.catalog, ...legacy];
      enabledModIds = ctx.modsLine;
      workshopItems = ctx.workshopItems;
    } catch {
      /* the log is still worth reading without the mod list */
    }
  }

  const managedLaunch = Boolean(activeServer) && !activeServer.isRemote && !activeServer.dockerContainerName && !activeServer.dockerContainerId;
  const server = activeServer
    ? {
        id: activeServer.id ?? null,
        running,
        isRemote: Boolean(activeServer.isRemote),
        // Only the panel's own start script passes maxMemory to Java.
        memoryManaged: managedLaunch,
        maxMemoryGb: normalizeMemoryGb(activeServer.maxMemory, 8),
        hostMemoryGb,
        defaultPort: Number(activeServer.serverPort) || iniNumber(content, "DefaultPort") || null,
      }
    : null;

  const result = findServerErrors({
    logs: gameLog?.logs ?? [],
    logMtime: gameLog?.mtime ?? null,
    panelLog,
    mods,
    enabledModIds,
    workshopItems,
    server,
    bridgeModId: BRIDGE_MOD_ID,
    redact,
  });

  return {
    scannedAt: new Date(now).toISOString(),
    server: activeServer ? { id: activeServer.id ?? null, name: activeServer.name || activeServer.serverName || null, running } : null,
    counts: result.counts,
    findings: result.findings,
    checked: {
      ...result.checked,
      gameLog: gameLog
        ? { found: true, file: gameLog.file, modified: gameLog.mtime.toISOString(), partial: gameLog.partial, bytes: gameLog.bytes }
        : { found: false, file: null, modified: null, partial: false, bytes: 0, reason: zomboidDataPath ? "missing" : "noDataFolder" },
      modList: content !== null,
    },
  };
}
