/**
 * Readers for the Workshop lines PZ writes to <zomboidDataPath>/server-console.txt.
 *
 * PZ rewrites that file at every server start (42.20 GameServer.main opens
 * it through LimitSizeFileOutputStream, whose constructor passes
 * append=false to FileOutputStream), so its tail describes the latest run
 * only -- which is exactly the question every caller here asks ("did THIS
 * start fail to get its Workshop items?"), and why each reader only ever
 * looks at the last 256 KB.
 *
 * scanWorkshopFailures() moved here verbatim from routes/debug.js (which
 * re-exports it) so services/bridgeDelivery.js can reuse the same log
 * reading without a service importing a route module.
 */
import fs from "fs";
import path from "path";

const MAX_TAIL_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 300;

// Tail-read `server-console.txt` and look for failed Workshop downloads.
// PZ's GameServerWorkshopItems.Install() crashes with a NullPointerException
// the moment a subscribed mod cannot be installed (delisted, private, region
// blocked, etc). We detect both the failure lines and whether the install
// step actually crashed.
//
// Returns null if no log; otherwise { ids, results, crashed, logMtime }.
// Exported for direct testing (same reason routes/debug.js exports
// getServerProcessState) -- GET /diagnostics' full handler has enough of its own
// dependency surface (req.app-injected services, several other database/
// init.js lookups) that reaching this one check through a real route
// invocation is its own, much larger undertaking; testing the function
// directly proves its own behavior without needing that.
export async function scanWorkshopFailures(zPath) {
  if (!zPath) return null;
  const logPath = path.join(zPath, "server-console.txt");
  let stat;
  try {
    stat = await fs.promises.stat(logPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  // Only the tail matters — the relevant lines come from the most recent
  // server start. Cap at 256 KB to keep this cheap on huge log files.
  const MAX_TAIL = 256 * 1024;
  const start = Math.max(0, stat.size - MAX_TAIL);
  const length = stat.size - start;
  let text = "";
  let fd;
  try {
    fd = await fs.promises.open(logPath, "r");
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, start);
    text = buf.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd) {
      try {
        await fd.close();
      } catch {
        /* ignore */
      }
    }
  }

  // Pattern: `Workshop: onItemNotDownloaded itemID=<ID> result=<N>`
  // result=9 is the common "item unavailable" / delisted case, but any
  // non-zero result lands here — we surface them all.
  const failedIds = [];
  const resultByFailedId = {};
  const re = /Workshop:\s+onItemNotDownloaded\s+itemID=(\d+)\s+result=(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!resultByFailedId[m[1]]) {
      failedIds.push(m[1]);
      resultByFailedId[m[1]] = parseInt(m[2], 10);
    }
  }

  // Crash chain: `GameServerWorkshopItems.Install` appears in the stack
  // when the install step actually aborted the server boot.
  const crashed =
    /GameServerWorkshopItems\.Install/.test(text) ||
    /Workshop:\s+item state DownloadPending\s+->\s+Fail/.test(text);

  return {
    ids: failedIds,
    results: resultByFailedId,
    crashed,
    logPath,
    logMtime: stat.mtime,
  };
}

// Synchronous twin of the tail read above, for callers that sit inside a
// synchronous status computation (bridgeDisk.detectWorkshopItem). 256 KB is
// small enough that blocking on it is not a concern.
function readConsoleTailSync(zPath) {
  if (!zPath) return null;
  const logPath = path.join(zPath, "server-console.txt");
  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;
  const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
  const length = stat.size - start;
  let fd;
  try {
    fd = fs.openSync(logPath, "r");
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return { text: buf.toString("utf-8"), mtime: stat.mtime };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function lastMatch(text, regex) {
  let found = null;
  let match;
  while ((match = regex.exec(text)) !== null) found = match;
  return found;
}

function lineAround(text, index) {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  let lineEnd = text.indexOf("\n", index);
  if (lineEnd === -1) lineEnd = text.length;
  return text.slice(lineStart, lineEnd).trim().slice(0, MAX_LINE_CHARS);
}

/**
 * Why the latest server start aborted while fetching the PanelBridge
 * Workshop item, or null. A download failure is attributed only when the
 * line names `workshopId` -- another item failing is the Mods page's
 * problem, not a reason to tell the operator to switch PanelBridge back.
 * "Failed to connect to Steam servers" names no item but aborts startup
 * before ANY item downloads, so it counts too -- as its own kind: 42.20's
 * GameServer.main runs that check for every dedicated server in Steam mode,
 * whether or not WorkshopItems= lists anything (offsets 1664-1962, before
 * GameServerWorkshopItems.Install at 1989), so a panel-installed server
 * stops the same way and the page doesn't offer switching back for it.
 *
 * `notBefore`: a log older than this (the switch time) describes a run
 * from before the switch and is ignored.
 */
export function scanBridgeStartFailure(zPath, workshopId, { notBefore = null } = {}) {
  if (!workshopId) return null;
  const tail = readConsoleTailSync(zPath);
  if (!tail) return null;
  const threshold = toTimestamp(notBefore);
  if (threshold !== null && tail.mtime.getTime() < threshold) return null;

  const id = String(workshopId).replace(/[^0-9]/g, "");
  if (!id) return null;
  const logMtime = tail.mtime.toISOString();

  const notDownloaded = lastMatch(
    tail.text,
    new RegExp(`Workshop:\\s+onItemNotDownloaded\\s+itemID=${id}\\s+result=(\\d+)`, "g"),
  );
  if (notDownloaded) {
    return {
      kind: "itemDownload",
      line: lineAround(tail.text, notDownloaded.index),
      result: parseInt(notDownloaded[1], 10),
      logMtime,
    };
  }

  const noFolder = lastMatch(
    tail.text,
    new RegExp(`Workshop:\\s+GetItemInstallFolder\\(\\) failed ID=${id}(?!\\d)`, "g"),
  );
  if (noFolder) {
    return { kind: "itemDownload", line: lineAround(tail.text, noFolder.index), result: null, logMtime };
  }

  const steamDown = lastMatch(tail.text, /Failed to connect to Steam servers/g);
  if (steamDown) {
    return {
      kind: "steamUnreachable",
      line: lineAround(tail.text, steamDown.index),
      result: null,
      logMtime,
    };
  }
  return null;
}

/**
 * The folder PZ reported installing `workshopId` into on its latest start,
 * or null (bridgeDisk then falls back to the SteamCMD candidate folders).
 * The line is "Workshop: <id> installed to <folder>", id first: 42.20's
 * GameServerWorkshopItems.Install builds it from the long item id and then
 * the folder (bytecode offsets 476-485: lload 6, aload 8, then the concat
 * recipe "\u0001 installed to \u0001"), and noise() prefixes "Workshop: ".
 */
export function scanWorkshopInstallFolder(zPath, workshopId) {
  if (!workshopId) return null;
  const tail = readConsoleTailSync(zPath);
  if (!tail) return null;
  const re = /Workshop:\s+(\d+)\s+installed to\s+(.+)$/gm;
  let folder = null;
  let match;
  while ((match = re.exec(tail.text)) !== null) {
    if (match[1] === String(workshopId)) folder = match[2].trim();
  }
  return folder || null;
}
