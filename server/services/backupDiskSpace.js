import fs from "fs";
import path from "path";
import { getDiskFree } from "../utils/diskSpace.js";
import { ErrorCode } from "../utils/errorCodes.js";

// Free-space checks for backups and restores. A backup is written under
// <data folder>/backups, on the same volume as the live world, so a backup (or
// a restore's staging copy plus its safety backup) that does not fit fills the
// disk the running game saves to. Everything here treats an unknown size or an
// unknown free-space figure as "do not block": the check exists to refuse a
// clear shortfall early, with a message, not to turn an unreadable disk into
// a refused backup.

// What a zip of a PZ world weighs against its files: usually a third to a
// half, so a first backup (nothing to compare with) is estimated at half. The
// previous backup of the same server is a better figure when there is one; the
// floor keeps a tiny early archive from standing in for a world that has since
// grown a lot.
const FIRST_BACKUP_RATIO = 0.5;
const LATER_BACKUP_RATIO_FLOOR = 0.25;
// Worlds grow between backups, and the archive adds its own headers (a percent
// so the arithmetic below stays in whole numbers).
const GROWTH_MARGIN_PERCENT = 110;

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/**
 * About how many bytes the zip of `sourceBytes` of files will take, or null
 * when the size of the files is unknown.
 */
export function estimateArchiveBytes(sourceBytes, previousArchiveBytes = null) {
  if (!Number.isFinite(sourceBytes) || sourceBytes <= 0) return null;
  const previous =
    Number.isFinite(previousArchiveBytes) && previousArchiveBytes > 0
      ? previousArchiveBytes
      : 0;
  const fromFiles = sourceBytes * (previous ? LATER_BACKUP_RATIO_FLOOR : FIRST_BACKUP_RATIO);
  return Math.ceil((Math.max(previous, fromFiles) * GROWTH_MARGIN_PERCENT) / 100);
}

// The folder to ask the OS about: `target` itself, or the nearest folder above
// it that exists (a restore's saves folder may not have been created yet).
export function nearestExistingPath(target) {
  let current = path.resolve(target);
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Free bytes on the volume holding `target`, or null when that cannot be read. */
export async function freeBytesAt(target) {
  const existing = nearestExistingPath(target);
  if (!existing) return null;
  const disk = await getDiskFree(existing);
  return disk && Number.isFinite(disk.free) ? disk.free : null;
}

// Whether two paths are on one volume (so their needs add up). When that
// cannot be told, assume they are: the cautious answer for a space check.
export function onSameVolume(a, b) {
  try {
    const first = nearestExistingPath(a);
    const second = nearestExistingPath(b);
    if (!first || !second) return true;
    return fs.statSync(first).dev === fs.statSync(second).dev;
  } catch {
    return true;
  }
}

/** The refusal createBackup()/restoreBackup() throw; translated through `code`. */
export function insufficientSpaceError(neededBytes, freeBytes) {
  const needed = formatBytes(neededBytes);
  const free = formatBytes(freeBytes);
  const error = new Error(
    `Not enough free disk space: about ${needed} is needed and ${free} is free. Free up disk space, or lower "Maximum Backups to Keep", and try again.`,
  );
  error.errorCode = ErrorCode.BACKUP_INSUFFICIENT_DISK_SPACE;
  error.errorParams = { needed, free };
  return error;
}
