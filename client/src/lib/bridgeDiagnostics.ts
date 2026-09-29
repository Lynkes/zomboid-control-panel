import { formatElapsed } from '@/lib/durationText'

// One PanelBridge connection diagnostic from the server's
// getConnectionDiagnostics(): translated via
// t(`bridge.diagnostics.${key}`, {ns: 'settings', ...params, defaultValue:
// text}), the same key+defaultValue convention as capabilities.<key>.label.
export interface BridgeDiagnostic {
  key: string
  params?: Record<string, string | number>
  text: string
}

// The params to translate a diagnostic with. The server words an age in
// English compact units ("12m", "2h") for its own `text`; where it also
// sends that age as a number (ageSeconds), `age` is re-worded in the UI
// language's units, the Dashboard uptime's own -- "há 12 min", not "há
// 12m", which reads as metres in pt-BR. A server too old to send ageSeconds
// keeps its `age` as sent.
export function bridgeDiagnosticParams(
  params: BridgeDiagnostic['params'],
): Record<string, string | number> {
  const out = { ...(params ?? {}) }
  if (typeof out.ageSeconds === 'number') out.age = formatElapsed(out.ageSeconds)
  return out
}
