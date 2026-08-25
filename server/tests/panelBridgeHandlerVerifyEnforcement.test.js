import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Enforcement test for the verify/gate convention this file's 2026-08-23
// handler-verification audit established (see PanelBridge.verifiedResult's
// own comment in the Lua file for the full rationale). A convention that
// lives only in a helper function is a convention the next handler can
// quietly skip -- this test is what makes skipping it visible on the first
// CI run, instead of thirteen commits later.
//
// HOW THIS WORKS: it does NOT call every handler with a fake game
// environment -- building a realistic stub for all ~100 handlers would be
// an enormous, constantly-stale surface, and calling a handler tells you
// nothing about whether IT claims to verify its own result. Instead it
// enumerates PanelBridgeModule.handlers live (via Lua's own `pairs`, so a
// handler added next year is picked up automatically -- no hardcoded name
// list to fall out of date) and uses debug.getinfo(fn, "S") to get each
// handler's exact source line range, then checks whether that function's
// OWN body contains the literal token "verified". This is a textual
// heuristic, not a behavioral one -- see the HONEST LIMIT below.
//
// Every handler not exempted below must satisfy one of:
//   (a) it's a pure getter/read-only handler (GETTERS) -- the "did this
//       verifiably happen" question doesn't apply to a handler that
//       doesn't change anything.
//   (b) it's in CANNOT_VERIFY_OR_EQUIVALENT with a written reason -- either
//       a real "no read-back exists" finding (verified against the real
//       B42 jar, not assumed), or a real "verifies via an equivalent
//       mechanism under a different name" finding (a `matched` field, a
//       real per-item count, gating `ok` on the read-back directly, etc.).
//   (c) its own function body contains the literal word "verified".
//
// HONEST LIMIT: a textual "contains the word verified" check cannot tell
// the difference between a real tri-state gate and someone writing the word
// "verified" in a comment that does nothing. It is not a substitute for the
// same jar-verification rigor this audit used to build the CANNOT_VERIFY
// list -- it is a tripwire for the far more common failure mode this audit
// actually found all night: a handler that never engages with the question
// at all. A new handler that trips this test should get the same treatment
// as the ones already fixed: read the real API, decide verified/matched/
// documented-reason, don't just add a word to make the test pass.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'pz-mod',
  'PanelBridge',
  'media',
  'lua',
  'server',
  'PanelBridge.lua',
);

// Pure read-only handlers. They report whether they could READ something,
// not whether an action they took actually happened -- a different
// question this audit was never about, and one these already handle
// honestly (pcall-wrapped, missing data reported as missing).
const GETTERS = new Set([
  'checkAPI', 'debugItemScript', 'exportPlayerData', 'getAllPlayerDetails',
  'getAllSandboxOptions', 'getAvailableHandlers', 'getChatInfo',
  'getClimateFloats', 'getDebugLog', 'getFactions', 'getGameTime',
  'getInfrastructureSnapshot', 'getItemCatalog', 'getPlayerDetails',
  'getSafehouses', 'getSandboxOptions', 'getServerInfo', 'getStats',
  'getTimeSpeed', 'getUtilitiesStatus', 'getVehicleCatalog',
  'getVehiclesDetailed', 'getWeather', 'getWorldStats', 'getZombieCount',
  'ping',
  // Mutate PURELY INTERNAL PanelBridge/Lua state (a debug flag, an error
  // log) -- no external game system to be wrong about.
  'setDebugMode', 'clearErrors',
]);

// name -> why this handler doesn't need to say "verified" literally.
// NOTE: setSandboxOption and the three moderationBan* handlers used to be
// listed here (matched-instead-of-verified, and gate-directly-on-a-string-
// with-no-stored-flag, respectively) -- as of the 2026-08-23 string-contract
// migration all four now emit a literal `verified` field, so they no longer
// need an exemption. Left this note rather than silently deleting the
// history, since "why isn't X allowlisted anymore" is as worth answering as
// "why is X allowlisted".
const CANNOT_VERIFY_OR_EQUIVALENT = {
  // Verifies via a differently-named but equivalent mechanism.
  restoreUtilities: 'hydroPowerOn IS the real read-back (world:isHydroPowerOn()), substituted directly for the field it describes -- no separate flag needed for a single-field outcome.',
  shutOffUtilities: 'Same mechanism as restoreUtilities.',
  healPlayer: 'The one truly unverifiable path (nil bodyDamage) is gated directly to ok=false; RestoreToFullHealth has no cheap read-back the game exposes.',
  vehicleHotwire: 'No single verifiable end-state exists for a multi-step hotwire sequence -- `actions` documents what ran step by step. (Also the site of the earlier undefined-global crash fix, commit 364c56d.)',
  runEventSequence: 'Orchestrates other handlers and returns THEIR (ok,data,err) results directly -- each sub-step\'s own verification already applies; re-wrapping it here would be redundant.',
  clearZombiesNearPlayer: 'Reports a real removed-count computed via per-zombie pcall success, not a boolean -- equivalent honesty under a differently-shaped field (`removed`).',
  clearAllZombies: 'Same mechanism as clearZombiesNearPlayer; the ForceKillAllZombies branch is pcall-ceiling by nature of being a bulk fire-and-forget API, the manual fallback counts real removals.',
  removeVehiclesInArea: 'Already counts only real per-vehicle invoke-confirmed removals (fixed from this exact defect once before, per its own comment) -- `removed` is the honest count.',
  vehicleRepair: 'Counts real per-part invoke success into `parts`, fails if 0 -- honest count, not a boolean flag.',
  giveItem: 'Counts real per-item AddItem success into `count`, fails if 0 added -- honest count.',
  airdrop: 'Counts real per-item placement success into `itemCount`/`failed` -- honest count, not a boolean.',
  killPlayer: 'Already gates the returned `ok` itself on isDead() -- the read-back IS the ok value (this file\'s own gold-standard pattern), no separate field needed.',
  setGameTime: 'Already gates on setAndVerify\'s own read-back-vs-expected comparison per field, failing immediately on a real mismatch (this file\'s other gold-standard pattern).',
  saveWorld: 'Already gates ok directly on the real pcall result of world:saveWorld() -- this IS the original b376b2c fix, no separate flag needed.',

  // Genuinely no read-back exists -- confirmed against the real B42 jar,
  // not assumed. This is an API LIMIT: the method is real, it just returns
  // nothing.
  moderationKickUser: 'BanSystem.KickUser is declared void in the real B42 jar (confirmed 2026-08-23) -- no return value exists to verify, ever. This is a limit of the API, not a bug -- contrast with createFaction/removeFaction below.',

  // *** THIS IS A BUG, NOT A VERIFICATION LIMIT -- KEEP IT LOUD AND SEPARATE
  // FROM THE CATEGORY ABOVE. *** Faction.createFaction and
  // faction:removeFaction do not exist ANYWHERE in the real B42 jar (zero
  // hits scanning all 23,740 class files, confirmed 2026-08-23) -- there is
  // no read-back to add because there is no METHOD, not because the method
  // is void. Events.tsx advertises both operations to the operator (labels,
  // descriptions, an args template, listed in the bridge operations group),
  // so the panel offers two actions that cannot work on B42. The existing
  // guard/pcall already fail safely and honestly (ok=false, not a false
  // success) rather than crashing -- which is also exactly why nobody
  // noticed from the logs. Carded to Pam (owns Events.tsx) with this
  // evidence attached.
  createFaction: 'BUG, not a verification limit: Faction.createFaction does not exist ANYWHERE in the real B42 jar (zero hits across all 23,740 class files). Events.tsx advertises this operation to the operator; it cannot work on B42. Carded to Pam.',
  removeFaction: 'BUG, not a verification limit: faction:removeFaction does not exist ANYWHERE in the real B42 jar -- same finding, same Events.tsx exposure, same card as createFaction.',

  // Explicitly NOT gated by design -- gating would hide real partial data.
  importPlayerData: 'Partial success is a legitimate outcome, not a boolean gate (explicit ruling, 2026-08-23) -- see restored.perks/restored.items counts instead of a verified flag.',

  // Honest stubs: never claim success at all (ok is never true), so there
  // is nothing for a verified field to describe.
  spawnVehicleAt: 'Always returns false (RCON handles vehicle spawning on B42) -- never claims success, nothing to verify.',
  setTimeSpeed: 'Always returns false (RCON handles the dedicated server clock multiplier) -- never claims success, nothing to verify.',

  // Genuine pcall-ceiling: no observable state exists to confirm the
  // real-world effect happened (a zombie heard a sound, a message was
  // read, a helicopter is now audible).
  playWorldSound: 'No observable state confirms a zombie heard the sound -- pcall-not-throwing (via emitWorldSound) is the real ceiling.',
  playSoundNearPlayer: 'Same ceiling as playWorldSound.',
  triggerGunshot: 'Same ceiling as playWorldSound.',
  triggerAlarmSound: 'Same ceiling as playWorldSound.',
  createNoise: 'Same ceiling as playWorldSound.',
  sendToServerChat: 'No delivery receipt exists; already falls through to a useRCON routing signal when neither ChatServer nor player:Say worked -- pcall-not-throwing is the ceiling.',
  sendToAdminChat: 'Same ceiling as sendToServerChat.',
  sendToGeneralChat: 'Same ceiling as sendToServerChat.',
  triggerHelicopterEvent: 'No observable state confirms a helicopter spawned; pcall-not-throwing across multiple fallback methods is the ceiling.',

  // PROVISIONAL -- not yet re-audited against the getFinalValue()/
  // isEnableAdmin() read-back pattern that handlers.getClimateFloats
  // already uses. vehicles/safehouse/faction all turned out gateable via
  // an existing-but-unused getter once checked carefully (see commits
  // 5c7ad09, 428a87a, 6cc240f) -- these climate/weather handlers are
  // STRONG CANDIDATES for the same fix, not a confirmed ceiling. Tracked
  // as a known follow-up so this test stays green without hiding the gap.
  generateWeather: 'PROVISIONAL: not yet re-checked for a real climate read-back (see getClimateFloats\' own getFinalValue()/isEnableAdmin() usage) -- tracked as a follow-up, same pattern as the vehicle-setter fix.',
  triggerBlizzard: 'PROVISIONAL: same as generateWeather.',
  triggerTropicalStorm: 'PROVISIONAL: same as generateWeather.',
  triggerStorm: 'PROVISIONAL: same as generateWeather.',
  stopWeather: 'PROVISIONAL: same as generateWeather.',
  setSnow: 'PROVISIONAL: same as generateWeather.',
  startRain: 'PROVISIONAL: same as generateWeather.',
  stopRain: 'PROVISIONAL: same as generateWeather.',
  triggerLightning: 'PROVISIONAL: same as generateWeather.',
  setDayLight: 'PROVISIONAL: same as generateWeather -- getClimateFloats reads getFinalValue()/isEnableAdmin() for this exact float.',
  setNightStrength: 'PROVISIONAL: same as setDayLight.',
  setDesaturation: 'PROVISIONAL: same as setDayLight.',
  setViewDistance: 'PROVISIONAL: same as setDayLight.',
  setAmbient: 'PROVISIONAL: same as setDayLight.',
  setTemperature: 'PROVISIONAL: same as setDayLight.',
  setWind: 'PROVISIONAL: same as setDayLight.',
  setFog: 'PROVISIONAL: same as setDayLight.',
  setClouds: 'PROVISIONAL: same as setDayLight.',
  setClimateFloat: 'PROVISIONAL: same as setDayLight -- this handler IS the generic climate-float setter the specific ones above wrap.',
  resetClimateOverrides: 'PROVISIONAL: reports real resetCount/boolsReset in its fallback branch but the resetAdmin() fast path claims success unconditionally -- tracked as a follow-up.',
  triggerSwarmEvent: 'PROVISIONAL: same fire-and-forget horde APIs spawnHordeNearPlayer\'s fallback branches had (createHordeInAreaTo/createHordeFromTo/CreateSwarm) -- not yet given the verified/spawned-count treatment those got. Tracked as a follow-up.',
  removeVehicle: 'PROVISIONAL: pcall+invoke-checked at the call-didn\'t-throw ceiling today; the vehicle\'s subsequent absence from getVehiclesList would be a real confirmation but isn\'t wired up -- tracked as a follow-up now that vehicleSetAlarm etc. proved vehicles ARE gateable.',
};

function loadHandlerLineRanges() {
  const bridge = loadPanelBridge(LUA_PATH, '');
  bridge.run(`
    __names = {}
    __lines = {}
    for name, fn in pairs(PanelBridgeModule.handlers) do
      local info = debug.getinfo(fn, "S")
      table.insert(__names, name)
      __lines[name] = { linedefined = info.linedefined, lastlinedefined = info.lastlinedefined }
    end
  `);
  return { names: bridge.getGlobal('__names'), lines: bridge.getGlobal('__lines') };
}

describe('PanelBridge.lua -- every mutating handler must report a verify outcome or be explicitly allowlisted', () => {
  it('flags any handler that claims to act without a documented verify outcome', () => {
    const { names, lines } = loadHandlerLineRanges();
    const source = fs.readFileSync(LUA_PATH, 'utf8').split('\n');

    const unexplained = [];
    for (const name of names) {
      if (GETTERS.has(name)) continue;
      if (Object.prototype.hasOwnProperty.call(CANNOT_VERIFY_OR_EQUIVALENT, name)) continue;

      const range = lines[name];
      const body = source.slice(range.linedefined - 1, range.lastlinedefined).join('\n');
      if (!body.includes('verified')) {
        unexplained.push(name);
      }
    }

    if (unexplained.length > 0) {
      throw new Error(
        `${unexplained.length} handler(s) claim to act without a documented verify outcome: ${unexplained.join(', ')}. ` +
        'Either make the handler report a real `verified` tri-state (see PanelBridge.verifiedResult, or setGodMode for a worked example), ' +
        'or add a named, reasoned entry to CANNOT_VERIFY_OR_EQUIVALENT in this test explaining why -- verified against the real jar, not assumed.'
      );
    }
  });

  it('GETTERS and CANNOT_VERIFY_OR_EQUIVALENT only name real, currently-registered handlers (catches stale entries)', () => {
    const { names } = loadHandlerLineRanges();
    const known = new Set(names);

    for (const g of GETTERS) {
      expect(known.has(g), `GETTERS lists "${g}" but it is not a registered handler (renamed or removed?)`).toBe(true);
    }
    for (const c of Object.keys(CANNOT_VERIFY_OR_EQUIVALENT)) {
      expect(known.has(c), `CANNOT_VERIFY_OR_EQUIVALENT lists "${c}" but it is not a registered handler (renamed or removed?)`).toBe(true);
    }
  });

  it('every CANNOT_VERIFY_OR_EQUIVALENT reason is a real sentence, not a placeholder', () => {
    for (const [name, reason] of Object.entries(CANNOT_VERIFY_OR_EQUIVALENT)) {
      expect(typeof reason, `${name}'s reason must be a string`).toBe('string');
      expect(reason.length, `${name}'s reason ("${reason}") is too short to be a real explanation`).toBeGreaterThan(20);
    }
  });
});
