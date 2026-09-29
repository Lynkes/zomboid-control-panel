/**
 * Readers for the Workshop lines PZ writes to <zomboidDataPath>/server-console.txt.
 *
 * PZ rewrites that file at every server start (42.20 GameServer.main opens
 * it through LimitSizeFileOutputStream, whose constructor passes
 * append=false to FileOutputStream), so the whole file describes the latest
 * run only -- which is exactly the question every caller here asks ("did
 * THIS start fail to get its Workshop items?"). A failed start ends in its
 * last lines, so the failure readers look at the last 256 KB. The lines a
 * start that went on writes before the world loads (Steam start-up, every
 * Workshop item's state and folder) are at the top of the file instead, and
 * a 42.21 console passes 256 KB around SERVER STARTED: the readers of those
 * lines read the head of the file too.
 *
 * scanWorkshopFailures() moved here from routes/debug.js (which
 * re-exports it) so services/bridgeDelivery.js can reuse the same log
 * reading without a service importing a route module.
 */
import fs from "fs";
import path from "path";

const MAX_TAIL_BYTES = 256 * 1024;
// The live 42.21 test's console had PanelBridge's "installed to" line at
// byte ~11 KB of ~273 KB by SERVER STARTED. 1 MB leaves room for the
// download lines of a server fetching hundreds of items at its first start
// (a line every ~130 ms per item while it downloads), and bounds the read
// on a console that has grown for days.
const MAX_HEAD_BYTES = 1024 * 1024;
// Steam's start-up lines come before the Workshop phase (~9 KB in on 42.21).
const STEAM_HEAD_BYTES = 64 * 1024;
const MAX_LINE_CHARS = 300;

// Both tail readers open the log first and stat the open handle, never the
// path: PZ truncates and rewrites this file at every server start -- the
// moment these readers are asked about -- so a path stat followed by a
// separate open could size the read from a file that no longer matches the
// one read. The text is cut at the bytes actually read for the same reason.
// O_NONBLOCK (POSIX only; Windows has no FIFOs on disk) keeps the open from
// hanging on a FIFO at this path now that the isFile() check comes after it.
const LOG_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

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

  // Only the tail matters — the relevant lines come from the most recent
  // server start. Cap at 256 KB to keep this cheap on huge log files.
  const MAX_TAIL = 256 * 1024;
  let stat;
  let text = "";
  let fd;
  try {
    fd = await fs.promises.open(logPath, LOG_OPEN_FLAGS);
    stat = await fd.stat();
    if (!stat.isFile() || stat.size === 0) return null;
    const start = Math.max(0, stat.size - MAX_TAIL);
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buf, 0, length, start);
    text = buf.toString("utf-8", 0, bytesRead);
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
// synchronous status computation (bridgeDelivery's start-failure check).
// 256 KB is small enough that blocking on it is not a concern; so is the
// 1 MB head readConsoleHeadAndTailSync() adds for the pre-world-load lines.
function readConsoleTailSync(zPath) {
  if (!zPath) return null;
  const logPath = path.join(zPath, "server-console.txt");
  let fd;
  try {
    fd = fs.openSync(logPath, LOG_OPEN_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return null;
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, start);
    return { text: buf.toString("utf-8", 0, bytesRead), mtime: stat.mtime };
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

// The first `headBytes` and the last `tailBytes` of the log, in file order,
// for the readers of lines a start writes before the world loads. The head
// ends at its last whole line: a folder path cut in the middle would read as
// another folder. A file that fits in both windows is read once, whole.
function readConsoleHeadAndTailSync(zPath, headBytes, tailBytes) {
  if (!zPath) return null;
  const logPath = path.join(zPath, "server-console.txt");
  let fd;
  try {
    fd = fs.openSync(logPath, LOG_OPEN_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return null;
    const readAt = (start, length) => {
      const buf = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, start);
      return buf.toString("utf-8", 0, bytesRead);
    };
    if (stat.size <= headBytes + tailBytes) {
      return { chunks: [readAt(0, stat.size)], mtime: stat.mtime };
    }
    const head = readAt(0, headBytes);
    const chunks = [head.slice(0, head.lastIndexOf("\n") + 1)];
    if (tailBytes > 0) chunks.push(readAt(stat.size - tailBytes, tailBytes));
    return { chunks, mtime: stat.mtime };
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
 * It is written before the world loads, so on a server that has finished
 * starting it is in the head of the log, not the tail.
 */
export function scanWorkshopInstallFolder(zPath, workshopId) {
  if (!workshopId) return null;
  const log = readConsoleHeadAndTailSync(zPath, MAX_HEAD_BYTES, MAX_TAIL_BYTES);
  if (!log) return null;
  let folder = null;
  for (const text of log.chunks) {
    const re = /Workshop:\s+(\d+)\s+installed to\s+(.+)$/gm;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[1] === String(workshopId)) folder = match[2].trim();
    }
  }
  return folder || null;
}

/**
 * Whether the latest start ran with Steam, from the line SteamUtils logs:
 * { steam: false, line } for "SteamUtils started without Steam",
 * { steam: true, line } for "SteamUtils initialised successfully" (42.21's
 * wording for both), or null when the log has neither (no log yet, another
 * build's wording) or is older than `notBefore` (as for
 * scanBridgeStartFailure()). Steam is opt-in for the game: 42.21's
 * SteamUtils.init turns it on only when the java system property
 * zomboid.steam is "1" (-Dzomboid.steam=1, which the panel's own launch
 * scripts and the dedicated server's StartServer64.bat pass, and the client
 * install's ProjectZomboidServer.bat doesn't). Without it the game logs the
 * first line and carries on: the server starts with no Workshop item at all
 * and no error (the missing mod is only a WARN). Either line comes before
 * the Workshop phase, near the top.
 */
export function scanSteamStartup(zPath, { notBefore = null } = {}) {
  const log = readConsoleHeadAndTailSync(zPath, STEAM_HEAD_BYTES, 0);
  if (!log) return null;
  const threshold = toTimestamp(notBefore);
  if (threshold !== null && log.mtime.getTime() < threshold) return null;
  const text = log.chunks[0];
  const off = /SteamUtils started without Steam/.exec(text);
  if (off) return { steam: false, line: lineAround(text, off.index) };
  const on = /SteamUtils initialised successfully/.exec(text);
  return on ? { steam: true, line: lineAround(text, on.index) } : null;
}
