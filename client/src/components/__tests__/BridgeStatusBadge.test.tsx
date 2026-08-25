import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BridgeStatusBadge } from '../BridgeStatusBadge'
import en from '@/locales/en/bridgeStatusBadge.json'

describe('BridgeStatusBadge', () => {
  it('reports connected when the bridge is connected', () => {
    render(<BridgeStatusBadge connected running />)
    expect(screen.getByText(en.connected.label)).toBeInTheDocument()
  })

  it('does not claim connected just because the server is running', () => {
    render(<BridgeStatusBadge connected={false} running />)
    expect(screen.getByText(en.waiting.label)).toBeInTheDocument()
    expect(screen.queryByText(en.connected.label)).not.toBeInTheDocument()
  })

  it('reports offline when neither connected nor running', () => {
    render(<BridgeStatusBadge connected={false} running={false} />)
    expect(screen.getByText(en.offline.label)).toBeInTheDocument()
  })

  it('loading overrides a stale connected flag rather than asserting it', () => {
    render(<BridgeStatusBadge connected loading />)
    expect(screen.getByText(en.loading.label)).toBeInTheDocument()
    expect(screen.queryByText(en.connected.label)).not.toBeInTheDocument()
  })

  it('surfaces the bridge path in the tooltip so operators can verify it', () => {
    render(<BridgeStatusBadge connected bridgePath="/opt/pz/mods/bridge" />)
    expect(screen.getByRole('status')).toHaveAttribute('title', expect.stringContaining('/opt/pz/mods/bridge'))
  })

  it('surfaces the offline hint pointing at Settings when disconnected', () => {
    render(<BridgeStatusBadge connected={false} running={false} />)
    expect(screen.getByRole('status')).toHaveAttribute(
      'title',
      expect.stringContaining(en.offline.hint)
    )
  })

  it('prefers an explicit summary over the generic hint', () => {
    render(<BridgeStatusBadge connected={false} running={false} summary="Custom detail from server" />)
    const el = screen.getByRole('status')
    expect(el.getAttribute('title')).toContain('Custom detail from server')
    expect(el.getAttribute('title')).not.toContain(en.offline.hint)
  })

  it('the accessible name leads with the visible state word and still includes the hint/path detail -- role="status" does not derive a name from visible text, so without an explicit aria-label the state word alone is silently dropped from what a screen reader announces', () => {
    render(<BridgeStatusBadge connected={false} running={false} bridgePath="/opt/pz/mods/bridge" />)
    const el = screen.getByRole('status')
    expect(el).toHaveAccessibleName(`${en.offline.label}\n${en.offline.hint}\nPath: /opt/pz/mods/bridge`)
  })

  it('still has a real accessible name when there is no hint or path to add (loading has neither) -- previously this was a completely silent live region', () => {
    render(<BridgeStatusBadge connected loading />)
    const el = screen.getByRole('status')
    expect(el).toHaveAccessibleName(en.loading.label)
  })
})
