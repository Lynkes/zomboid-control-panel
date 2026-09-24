import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ServerStatusBadge } from '../ServerStatusBadge'

// UX deep-pass finding (Servers page): Servers.tsx builds a specific,
// actionable `detail` string for the RCON signal it hands to
// ServerStatusBadge -- "Not configured" for an unconfigured RCON password,
// "Authentication failed" for a wrong one, "Unavailable" for a dropped
// connection (see its inline status-badge builder around the `rconStatus`
// switch). Before this fix, ServerStatusBadge computed a `title` tooltip and
// rendered visible text from `signal.label` + the status word only --
// `signal.detail` was read nowhere, so all three of those distinct,
// operator-relevant reasons collapsed into the exact same wordless grey/red
// dot ("RCON Down" / "RCON Unknown"). This is the operator's #1 stated
// irritant ("cannot tell what state something is in") reproduced inside the
// one shared component both the compact server-card badge and the full
// badge render through.
describe('ServerStatusBadge: signal detail is surfaced, not silently dropped', () => {
  it('compact mode shows the detail sentence next to the short status word', () => {
    render(
      <ServerStatusBadge
        compact
        host={{ status: 'running', label: 'Process' }}
        server={{ status: 'disconnected', label: 'RCON', detail: 'Authentication failed' }}
      />,
    )
    expect(screen.getByText('(Authentication failed)')).toBeInTheDocument()
  })

  it('compact mode puts the detail in the per-signal tooltip title too', () => {
    render(
      <ServerStatusBadge
        compact
        host={{ status: 'unknown', label: 'RCON', detail: 'Not configured' }}
      />,
    )
    const signalSpan = screen.getByText('(Not configured)').closest('span[title]')
    expect(signalSpan).toHaveAttribute('title', 'RCON: Unknown — Not configured')
  })

  it('full (non-compact) mode renders the detail inline after the status word', () => {
    render(
      <ServerStatusBadge
        server={{ status: 'disconnected', label: 'RCON', detail: 'Authentication failed' }}
      />,
    )
    expect(screen.getByText('— Authentication failed')).toBeInTheDocument()
  })

  it('renders no extra text at all when a signal has no detail (unchanged default case)', () => {
    render(<ServerStatusBadge compact host={{ status: 'running', label: 'Process' }} />)
    expect(screen.queryByText(/\(.*\)/)).not.toBeInTheDocument()
  })
})
