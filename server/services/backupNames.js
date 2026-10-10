import { escapeRegExp } from "../utils/regex.js";

// File names of the backups in a server's backups/ folder: how
// backupService.js builds them, sorts them, attributes them to a server and
// tells the ones it must not prune automatically.
//
// Sort key for listBackups(): panel-created backups encode their own
// creation timestamp (down to the millisecond) plus a numeric collision
// suffix directly in the filename -- see the timestamp/collision-suffix
// construction in _doCreateBackup(). Parsing that out and sorting on it,
// the same fix already applied to configBackup.js's listBackupsFor() (see
// its own comment), avoids relying on fs.stat().birthtime: several backups
// created in quick succession (a fast/near-empty world backs up in well
// under a second) can land with an IDENTICAL birthtime on real
// filesystems, at which point Array.prototype.sort's stability falls back
// to readdir()'s order -- unrelated to creation order -- and the brand-new
// backup can be mistaken for the oldest and pruned instead of a genuinely
// older one. Falls back to birthtime only for names the panel didn't
// create this way (uploaded-*.zip, hand-copied files) -- there is no
// better signal for those, and they're already exempt from automatic
// pruning regardless.
// The exact shape _doCreateBackup() writes (see its own timestamp/
// collision-suffix construction): `new Date().toISOString()` with `:`/`.`
// swapped for `-` and sliced to 23 chars (drops the trailing "Z"), plus an
// optional `-N` collision suffix. Kept as one shared string so
// BACKUP_TIMESTAMP_RE below and round 18b's per-server ownership pattern
// (backupFilenameOwnerPattern()) can never drift apart on what a real
// panel-written timestamp looks like.
export const BACKUP_TIMESTAMP_PATTERN =
  "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}";
const BACKUP_TIMESTAMP_RE = new RegExp(
  `(${BACKUP_TIMESTAMP_PATTERN})(?:-(\\d+))?\\.zip$`,
);
export function backupSortKey(fileName, stats) {
  const match = fileName.match(BACKUP_TIMESTAMP_RE);
  if (match) {
    return { key: match[1], suffix: match[2] ? parseInt(match[2], 10) : 1 };
  }
  return {
    key: stats.birthtime.toISOString().replace(/[:.]/g, "-").slice(0, 23),
    suffix: 1,
  };
}

// The safety copies the panel takes immediately before it replaces or deletes
// a world: restoreBackup()'s pre-restore backup and /wipe's pre-wipe backup.
// They are named `pre-restore-<server>_<timestamp>.zip` and
// `pre-wipe-<server>_<timestamp>.zip`, the ordinary shape behind a prefix, so
// everything keyed on the timestamp (sorting) or anchored on the server name
// (attribution, below) keeps working, and the automatic prune can tell them
// from routine backups. Before this change they were named like any other backup
// and the next scheduled backup with backupMaxCount=1 deleted the copy of the
// world that had just been wiped; those old ones stay what they were, an
// ordinary backup.
const SAFETY_BACKUP_PREFIXES = Object.freeze({
  preRestore: "pre-restore-",
  preWipe: "pre-wipe-",
});
const SAFETY_PREFIX_PATTERN = "(?:pre-restore-|pre-wipe-)";

// How many safety copies the automatic prune keeps (the newest ones). They are
// not counted toward backupMaxCount and never pushed out by routine backups,
// but a restore or wipe every day should not grow the folder without bound.
export const MAX_SAFETY_BACKUPS = 3;

// The name prefix for a backup created with these createBackup() options.
export function safetyBackupPrefix({ isPreRestore, isPreWipe } = {}) {
  if (isPreRestore) return SAFETY_BACKUP_PREFIXES.preRestore;
  if (isPreWipe) return SAFETY_BACKUP_PREFIXES.preWipe;
  return "";
}

// round 18b (god-caught follow-up): a plain name.startsWith(`${name}_`)
// substring check is not enough to attribute a backup's filename to a
// server -- SERVER_NAME_REGEX allows underscores, so two configured
// servers "my" and "my_server" sharing a backups folder both look like
// they "start with" my_server's own file (my_server_2026-...zip starts
// with "my_" too), misattributing my_server's own backup as belonging to
// "my" and hiding/refusing it as foreign. Anchoring the WHOLE filename --
// `${name}_` immediately followed by the exact BACKUP_TIMESTAMP_PATTERN
// shape and nothing else -- closes that: "my_server_2026-...zip" only
// matches candidate "my_server" (nothing valid follows "my_" except
// "server_2026...", which is not a 4-digit year), never candidate "my".
//
// A safety copy's pre-restore-/pre-wipe- prefix is allowed in front. (A server
// literally named "pre-wipe-x" is then also a candidate for the safety copy of
// a server "x" sharing its folder; the longer name wins, as for any prefix.)
export function backupFilenameOwnerPattern(serverName, { allowSafetyPrefix = true } = {}) {
  return new RegExp(
    `^${allowSafetyPrefix ? `${SAFETY_PREFIX_PATTERN}?` : ""}${escapeRegExp(serverName)}_${BACKUP_TIMESTAMP_PATTERN}(?:-\\d+)?\\.zip$`,
  );
}

// Attributes `fileName` to exactly one of `candidateNames`: whichever
// candidate's anchored pattern matches AND is the LONGEST such match wins,
// so a longer, more specific name (e.g. "my_server") is never shadowed by
// a shorter one that happens to be a literal prefix of it (e.g. "my").
// Callers put the ACTIVE server's own name in `candidateNames` alongside
// any colliding others, so ties always resolve in favor of a real name
// (two different currently-configured servers can never share the exact
// same name) and the active server's own file is never misattributed to
// someone else as a side effect of this length comparison. Returns null
// when NO candidate's pattern matches at all -- a legacy backup predating
// multi-server support, an uploaded archive, or simply a name matching no
// known server -- callers treat "no clear owner" as "assume mine, don't
// hide or refuse it", the same conservative default the rest of this
// round's fix already uses.
export function attributeBackupFilename(fileName, candidateNames) {
  let winner = null;
  for (const name of candidateNames) {
    if (backupFilenameOwnerPattern(name).test(fileName)) {
      if (!winner || name.length > winner.length) winner = name;
    }
  }
  return winner;
}

const SAFETY_BACKUP_NAME_RE = new RegExp(
  `^${SAFETY_PREFIX_PATTERN}.+_${BACKUP_TIMESTAMP_PATTERN}(?:-\\d+)?\\.zip$`,
);

// Whether `fileName` is one of the safety copies above. `ownServerName` is the
// server whose list this is: a server literally named "pre-wipe-x" writes
// ordinary backups that look the same behind that prefix, so a name that is
// that server's plain shape is not a safety copy.
export function isSafetyBackupName(fileName, ownServerName = null) {
  if (!SAFETY_BACKUP_NAME_RE.test(fileName)) return false;
  if (
    typeof ownServerName === "string" &&
    ownServerName &&
    backupFilenameOwnerPattern(ownServerName, { allowSafetyPrefix: false }).test(fileName)
  ) {
    return false;
  }
  return true;
}
