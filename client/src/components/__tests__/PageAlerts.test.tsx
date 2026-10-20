import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PageAlerts, type PageAlert } from '../PageAlerts'

// One alert stack under the page header (UX plan §2.4.5): ServerConfig
// showed up to 13 alerts around its header. Now errors come first, two show,
// and the rest wait behind "Show N more".

afterEach(() => cleanup())

const ALERTS: PageAlert[] = [
  { id: 'tip', tone: 'info', title: 'Tip: use templates' },
  { id: 'restart', tone: 'warning', title: 'Restart required' },
  { id: 'rcon', tone: 'error', title: 'RCON is not configured', action: { label: 'Edit server', to: '/servers' } },
  { id: 'mods', tone: 'warning', title: 'Two mods are missing' },
]

function renderAlerts(alerts = ALERTS, max?: number) {
  return render(<MemoryRouter><PageAlerts alerts={alerts} max={max} /></MemoryRouter>)
}

describe('PageAlerts', () => {
  it('renders nothing without alerts', () => {
    const { container } = renderAlerts([])
    expect(container).toBeEmptyDOMElement()
  })

  it('puts errors first and shows two, the rest behind "Show N more"', () => {
    renderAlerts()
    const shown = screen.getAllByText(/./, { selector: 'p.font-medium' }).map((el) => el.textContent)
    expect(shown).toEqual(['RCON is not configured', 'Restart required'])
    expect(screen.getByRole('alert')).toHaveTextContent('RCON is not configured')

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }))
    const all = screen.getAllByText(/./, { selector: 'p.font-medium' }).map((el) => el.textContent)
    expect(all).toEqual(['RCON is not configured', 'Restart required', 'Two mods are missing', 'Tip: use templates'])
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('links an alert to its fix and lets it be dismissed', () => {
    const onDismiss = vi.fn()
    renderAlerts([{ id: 'bridge', tone: 'warning', title: 'Bridge offline', action: { label: 'Open bridge settings', to: '/settings?tab=bridge' }, onDismiss }])
    expect(screen.getByRole('link', { name: 'Open bridge settings' })).toHaveAttribute('href', '/settings?tab=bridge')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('runs a button action', () => {
    const onClick = vi.fn()
    renderAlerts([{ id: 'retry', tone: 'error', title: 'Could not load', action: { label: 'Retry', onClick } }])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
