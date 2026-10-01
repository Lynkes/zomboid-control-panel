import { ApiError } from './api'

// How Settings › Updates words a failed "Download update" click.
//
// A Docker panel update first saves the world and stops the game server
// (server/index.js handlePanelUpdateDownload). When that step fails, nothing
// was downloaded and the server is still running -- titling it "Download
// Failed" sent the operator hunting for a network problem (2026-10-01: a
// 42.21 server whose game thread had died kept refusing the save with "RCON
// connection closed"). These refusals get an accurate title instead, and the
// ones a stuck server causes also offer the Dashboard, where Force stop is.
// The panel never force-stops on its own: that can lose everything since the
// last successful save, which only the operator can decide to accept.
export type PanelUpdateFailureKind =
  // The save or the stop failed, RCON is down, or the server hasn't exited
  // after its shutdown: the next step is the Dashboard's Force stop if the
  // server is stuck.
  | 'serverNotStopped'
  // The panel's process scan failed: update not applied, but there is no
  // single next step to point at.
  | 'serverStateUnknown'
  | 'downloadFailed'

// Wire codes, as POST /api/panel/update-download sends them (save_failed and
// stop_failed are frozen lower_snake_case legacy values, see
// server/utils/errorCodes.js).
const SERVER_NOT_STOPPED_CODES: ReadonlySet<string> = new Set([
  'save_failed',
  'stop_failed',
  'SERVER_RUNNING_RCON_UNAVAILABLE',
  'SERVER_STOP_NOT_CONFIRMED',
])
const SERVER_STATE_UNKNOWN_CODES: ReadonlySet<string> = new Set(['SERVER_STATE_UNKNOWN'])

export function classifyPanelUpdateFailure(error: unknown): PanelUpdateFailureKind {
  const code = error instanceof ApiError ? error.code : undefined
  if (typeof code === 'string' && SERVER_NOT_STOPPED_CODES.has(code)) return 'serverNotStopped'
  if (typeof code === 'string' && SERVER_STATE_UNKNOWN_CODES.has(code)) return 'serverStateUnknown'
  return 'downloadFailed'
}
