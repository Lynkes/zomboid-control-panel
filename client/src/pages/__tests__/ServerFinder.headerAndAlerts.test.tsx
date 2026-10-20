import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerFinder from '../ServerFinder'
import en from '../../locales/en/serverFinder.json'
import enServers from '../../locales/en/servers.json'

// UX restructure (slice B): Public Servers is a child of Servers (breadcrumb),
// has ONE Refresh with "Reload from Steam" in its menu (it used to be two
// buttons and a help tip), and a missing Steam API key links straight to
// where the key is entered (Settings › Mods) instead of a bare /settings.

function listResponse(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      servers: [{ name: 'Alpha Server', ip: '10.0.0.1', port: 16261, gamePort: 16261, players: 1, maxPlayers: 16, map: 'Muldraugh, KY', version: '42.1.0', vac: false, isPrivate: false, os: 'l' }],
      count: 1,
      source: 'master_server',
      cached: false,
      apiKeyConfigured: true,
      totalPlayers: 1,
      activeServers: 1,
      totalCapacity: 16,
      ...extra,
    }),
  } as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderServerFinder() {
  return render(
    <TooltipProvider>
      <MemoryRouter>
        <ServerFinder />
      </MemoryRouter>
    </TooltipProvider>,
  )
}

const requestedUrls = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url))

describe('ServerFinder header and alerts', () => {
  it('is titled Public Servers, with a breadcrumb back to Servers', async () => {
    vi.mocked(fetch).mockResolvedValue(listResponse())
    renderServerFinder()
    expect(screen.getByRole('heading', { level: 1, name: en.pageHeader.title })).toBeInTheDocument()
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i })
    expect(within(crumbs).getByRole('link', { name: enServers.pageHeader.title })).toHaveAttribute('href', '/servers')
    await screen.findByText('Alpha Server')
  })

  it('has one Refresh; "Reload from Steam" sits in its menu and asks Steam directly', async () => {
    vi.mocked(fetch).mockResolvedValue(listResponse())
    renderServerFinder()
    await screen.findByText('Alpha Server')
    expect(screen.queryByRole('button', { name: en.pageHeader.reloadFromSteam })).not.toBeInTheDocument()

    const more = screen.getByRole('button', { name: en.pageHeader.refreshMenuAria })
    fireEvent.pointerDown(more, { button: 0, pointerId: 1 })
    fireEvent.click(more)
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(en.pageHeader.reloadFromSteam) }))
    await waitFor(() => expect(requestedUrls().some((url) => url.includes('refresh=true'))).toBe(true))
  })

  it('a missing Steam API key is one warning that links to Settings › Mods, not a second error', async () => {
    vi.mocked(fetch).mockResolvedValue(listResponse({ servers: [], count: 0, apiKeyConfigured: false }))
    renderServerFinder()
    const warning = await screen.findByText(en.apiKeyWarning.title)
    const alert = warning.closest('[role="status"]') as HTMLElement
    expect(within(alert).getByRole('link', { name: en.apiKeyWarning.action })).toHaveAttribute('href', '/settings?tab=mods')
    expect(screen.queryByText(en.error.title)).not.toBeInTheDocument()
  })
})

// Bug pass before the UX release: the redesign's sort buttons dropped the old
// "Max players" sort (v1.4.17's Sort by select had it).
describe('ServerFinder sorting', () => {
  it('sorts by max players, largest first', async () => {
    vi.mocked(fetch).mockResolvedValue(listResponse({
      servers: [
        { name: 'Busy Small', ip: '10.0.0.1', port: 16261, gamePort: 16261, players: 9, maxPlayers: 10, map: 'Muldraugh, KY', version: '42.1.0', vac: false, isPrivate: false, os: 'l' },
        { name: 'Quiet Big', ip: '10.0.0.2', port: 16261, gamePort: 16261, players: 1, maxPlayers: 64, map: 'Muldraugh, KY', version: '42.1.0', vac: false, isPrivate: false, os: 'l' },
      ],
      count: 2,
    }))
    renderServerFinder()
    await screen.findByText('Quiet Big')
    const order = () => {
      const text = document.body.textContent ?? ''
      return text.indexOf('Quiet Big') < text.indexOf('Busy Small') ? 'big-first' : 'small-first'
    }
    expect(order()).toBe('small-first')

    fireEvent.click(screen.getByRole('button', { name: `Sort by ${en.searchFilters.sortMaxPlayers}` }))
    await waitFor(() => expect(order()).toBe('big-first'))
  })
})
