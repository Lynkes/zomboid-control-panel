// What a live sandbox change through PanelBridge left in the world's
// map_sand.bin (#197), from the response's worldSandboxSnapshot. The game
// loads that file over SandboxVars.lua on every start, so on a world that
// has one the change lasts only if the bridge rewrote it:
//   'kept'   -- it did: the change is kept in the world's saved settings
//   'undone' -- the world has one the bridge didn't rewrite (an older
//               PanelBridge after power/water changes, a failed save): the
//               next start undoes the change
//   null     -- the world has none; SandboxVars.lua decides, as on a vanilla
//               dedicated server
// Anything but an explicit refreshed: true reads as 'undone'.
export type LiveWorldSandboxOutcome = 'kept' | 'undone' | null

export function liveWorldSandboxOutcome(
  result: { worldSandboxSnapshot?: { refreshed?: unknown } | null } | null | undefined,
): LiveWorldSandboxOutcome {
  const snapshot = result?.worldSandboxSnapshot
  if (!snapshot || typeof snapshot !== 'object') return null
  return snapshot.refreshed === true ? 'kept' : 'undone'
}
