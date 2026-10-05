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
// those coordinates within DEDUPE_WINDOW_MS is not delivered again.
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export function createPlayerDeathRouter({ bridge, onDeath, now = () => Date.now() }) {
  const delivered = new Map();

  function deliver(death) {
    const at = now();
    for (const [key, when] of delivered) {
      if (at - when > DEDUPE_WINDOW_MS) delivered.delete(key);
    }
    const key = `${death.player}\u0000${death.x},${death.y},${death.z}`;
    if (delivered.has(key)) return;
    delivered.set(key, at);
    Promise.resolve()
      .then(() => onDeath(death))
      .catch(() => {});
  }

  return {
    fromBridge: deliver,
    fromUserLog(death) {
      if (bridge?.reportsPlayerDeaths?.()) return;
      deliver(death);
    },
  };
}
