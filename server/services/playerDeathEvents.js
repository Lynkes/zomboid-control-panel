// Where the panel's player deaths come from (security sweep 2026-10-04,
// BRIDGE-1 adversary pass).
//
// The game's *_user.txt death lines can be forged: a co-op (split-screen)
// player's name never goes through the server's username check, so it can
// carry line breaks and whole "[timestamp] user X died at (...)" lines, each
// one byte-for-byte what the game writes for a real death of X. No parsing of
// that file can tell them apart. PanelBridge reports deaths from the dead
// character itself (status.json `deaths`, see services/panelBridge.js
// trackPlayerDeaths()), so while a live bridge does that, the log's deaths
// are ignored and the bridge's are used. Without one (not installed, an
// older version, or not answering) the log is the only source left.
//
// The same death can reach both sources when the bridge stops answering
// for a moment around it, so a death already delivered for that player at
// those coordinates within DEDUPE_WINDOW_MS is not delivered again, unless
// both came from the bridge: each of its deaths has its own number (the panel
// already drops one it has seen), so two on the same tile are two deaths (a
// fixed spawn tile, spawn camping). A user-log delivery is matched by at most
// one bridge death; the next one on that tile is a new death.
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export function createPlayerDeathRouter({ bridge, onDeath, now = () => Date.now() }) {
  // key -> { at, source: "bridge" | "log" } of the last delivery on that key.
  const delivered = new Map();

  function deliver(death, source) {
    const at = now();
    for (const [key, entry] of delivered) {
      if (at - entry.at > DEDUPE_WINDOW_MS) delivered.delete(key);
    }
    const key = `${death.player}\u0000${death.x},${death.y},${death.z}`;
    const earlier = delivered.get(key);
    if (earlier) {
      if (source === "bridge" && earlier.source === "log") {
        // The same death, seen by the log first: spent, so a later bridge
        // death on this tile is not matched against it.
        earlier.source = "bridge";
        return;
      }
      if (source === "log") return;
    }
    delivered.set(key, { at, source });
    Promise.resolve()
      .then(() => onDeath(death))
      .catch(() => {});
  }

  return {
    fromBridge: (death) => deliver(death, "bridge"),
    fromUserLog(death) {
      if (bridge?.reportsPlayerDeaths?.()) return;
      deliver(death, "log");
    },
  };
}
