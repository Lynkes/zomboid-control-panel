// Shared classification for PanelBridge's per-command `verified` field
// (server/services/panelBridge.js resolves `{ success, data }`; `data.verified`
// is the mod's own read-back confirmation, added across select mutating
// handlers 2026-08-23 -- see server/tests/panelBridge*VerifyGating.test.js).
//
// Three states, not a boolean, because "we didn't get a confirmation" has two
// structurally different causes that need different words to the operator:
//   'confirmed'    -- a real read-back was compared against the request and matched.
//   'unverifiable' -- the call succeeded; no read-back exists to compare (a void
//                     game API, or the change too small to distinguish from a
//                     no-op). NOT a failure -- a genuine mismatch is reported as
//                     ok:false with a real error instead, never verified:false.
//   'old-bridge'   -- the `verified` key is missing entirely. The bridge mod runs
//                     on the OPERATOR'S game server and can be older than the
//                     panel (operators update the panel and forget the mod), so a
//                     missing key means the connected mod predates this contract
//                     and never sends the field -- not "unconfirmed", an outright
//                     different, actionable fact (the mod itself is out of date).
export type BridgeVerifiedState = "confirmed" | "unverifiable" | "old-bridge";

// The exact set of PanelBridge Lua handler action names (server/services/
// panelBridge.js's `action` string, matching pz-mod/PanelBridge/media/lua/
// server/PanelBridge.lua's `handlers.<name>`) that report a `verified` state
// today. NOT every mutating handler has this -- derived by scanning the Lua
// source for every `handlers.X` body that sets `verified =` (last verified
// 2026-08-23 against commit f7e5901, Angela's full matched->verified
// migration -- 22 handlers, up from the 19 found before that commit; the 3
// moderationBan* handlers gained an explicit verified in that same pass):
// healPlayer, vehicleRepair, vehicleHotwire, removeVehicle, moderationKickUser,
// and every weather/climate/rain/time/sound handler were never given a
// read-back check, so a missing `verified` key on THOSE actions doesn't mean
// an old bridge -- it means nothing, on any mod version, past or future.
// Only an action in this set can be meaningfully classified as "old bridge"
// when the key is absent; getBridgeVerifiedState() returns null for
// anything else, telling the caller "this isn't a verify-gated action,
// don't show any of the three states, render your normal success toast."
// Keep in sync with the Lua source: a handler added there without being
// added here fails safe (silently renders as always-confirmed, undersells
// uncertainty) rather than crying wolf on an action that was never gated.
export const VERIFY_GATED_ACTIONS: ReadonlySet<string> = new Set([
  "teleportPlayer",
  "setSandboxOption",
  "setGodMode",
  "setInvisible",
  "setNoclip",
  "spawnHordeNearPlayer",
  "spawnHordeBehindPlayer",
  "safehouseAddPlayer",
  "safehouseRemovePlayer",
  "safehouseSetOwner",
  "safehouseSetRespawn",
  "factionAddPlayer",
  "factionRemovePlayer",
  "factionSetTag",
  "vehicleSetAlarm",
  "vehicleSetSiren",
  "vehicleSetTrunkLocked",
  "vehicleSetFuel",
  "vehicleSetBattery",
  "moderationBanUser",
  "moderationBanIP",
  "moderationBanSteamID",
]);

export function getBridgeVerifiedState(
  action: string,
  data: { verified?: unknown } | null | undefined,
): BridgeVerifiedState | null {
  if (!VERIFY_GATED_ACTIONS.has(action)) return null;
  if (data?.verified === "confirmed") return "confirmed";
  if (data?.verified === "unverifiable") return "unverifiable";
  return "old-bridge";
}
