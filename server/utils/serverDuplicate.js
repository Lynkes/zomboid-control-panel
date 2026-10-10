// A local server is its server name inside its Zomboid data folder (the ini,
// the saves and the logs live there), so two profiles with the same name and
// the same data folder are one server listed twice. Remote servers have no
// files on this computer, and a profile with no data folder of its own is not
// judged: the default folder it falls back to is not known here.

const isWindows = process.platform === "win32";

function comparableFolder(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return isWindows ? normalized.toLowerCase() : normalized;
}

function comparableName(value) {
  const name = String(value ?? "").trim();
  return isWindows ? name.toLowerCase() : name;
}

/**
 * The profile in `servers` that `candidate` would duplicate, or null.
 * Both are plain server records ({ serverName, zomboidDataPath, isRemote }).
 */
export function findDuplicateLocalServer(servers, candidate) {
  if (!candidate || candidate.isRemote) return null;
  const name = comparableName(candidate.serverName);
  const folder = comparableFolder(candidate.zomboidDataPath);
  if (!name || !folder) return null;

  return (
    (servers || []).find(
      (existing) =>
        !existing.isRemote &&
        comparableName(existing.serverName) === name &&
        comparableFolder(existing.zomboidDataPath) === folder,
    ) || null
  );
}
