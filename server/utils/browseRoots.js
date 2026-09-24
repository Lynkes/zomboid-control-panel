import fs from "fs";
import path from "path";

// Best-effort realpath: resolves every symlink component along `target`'s
// chain, or returns null when the path doesn't exist (nothing to resolve)
// or realpath itself fails for any other reason (permissions, a broken
// link). Never throws -- confineToRoots below falls back to the lexical
// path in that case, same as before this fix existed.
function tryRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Check whether `target` is equal to or inside one of `allowedRoots`.
 * Returns the resolved target if allowed, or null if it escapes all roots.
 *
 * Shared by every filesystem browse endpoint (server-files file browser,
 * chunks save browser) so "confine this path to a known-safe root" is one
 * audited implementation instead of one per route file.
 *
 * continuous-bug-hunt, 2026-09-18 (file-manager path-truth round):
 * path.resolve() is pure string normalization -- it never touches the
 * filesystem, so it has no way to know a path component is a symlink. A
 * symlink placed ANYWHERE inside an allowed root (a workshop mod's own
 * files, anything writable by a serverfiles.manage-only operator) that
 * points outside every allowed root passed this check by NAME alone, while
 * every actual fs.readdir/fs.createReadStream that followed it landed
 * wherever the symlink really points -- routes/serverFiles.js's GET
 * /image-preview in particular streams the target's raw bytes back over
 * HTTP with no further check, keyed only on the symlink's OWN extension
 * (a "definitely-not-actually-a-.png" file still passes, since the
 * extension check runs against the symlink's name, not its real target),
 * making this a genuine arbitrary-file-read primitive for anything under
 * 5MB. fs.realpathSync() resolves the WHOLE chain (every symlink
 * component, not just a trailing one), so it's used for the containment
 * DECISION here; the function still returns the lexical (non-realpath'd)
 * resolved path on success, unchanged from before, since every caller's
 * subsequent read already re-resolves that same symlink through the OS --
 * once containment has confirmed it points somewhere safe, following it
 * again is exactly the intended, ordinary behavior.
 * Falls back to the lexical path (both for the target and for a root)
 * whenever realpath can't run -- most commonly a target that doesn't exist
 * yet, which every caller here already checks for separately right after
 * this call, so pure lexical containment is still the correct, and only
 * possible, check for that case.
 */
export function confineToRoots(target, allowedRoots) {
  const resolved = path.resolve(target);
  const realTarget = tryRealpath(resolved) || resolved;
  for (const root of allowedRoots) {
    const realRoot = tryRealpath(root) || root;
    if (realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)) {
      return resolved;
    }
  }
  return null;
}
