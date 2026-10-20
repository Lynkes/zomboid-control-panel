import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerFinder from '../ServerFinder'

// The version filter used to survive "Clear all filters" (the button reset
// the search and the checkboxes but not the version Select), and a refresh
// that dropped the filtered version left the list empty with a Select showing
// nothing and the filter panel collapsed.
//
// Radix <Select> can't be driven in jsdom (see Backups.customScheduleAndRestartOverlap
// .test.tsx) -- swapped for a native <select> labelled by the values it offers,
// which leaves ServerFinder's own filter logic untouched.
vi.mock('@/components/ui/select', () => {
  function collectItems(children: React.ReactNode): Array<{ value: string; label: React.ReactNode }> {
    const items: Array<{ value: string; label: React.ReactNode }> = []
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const nested = (child.props as { children?: React.ReactNode }).children
      React.Children.forEach(nested, (item) => {
        if (React.isValidElement(item) && (item.props as { value?: string }).value !== undefined) {
          items.push({ value: (item.props as { value: string }).value, label: (item.props as { children?: React.ReactNode }).children })
        }
      })
    })
    return items
  }
  function Select({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) {
    const items = collectItems(children)
    const values = items.map((i) => i.value)
    const label = values.includes('all') ? 'Version filter' : values.includes('players') ? 'Sort field' : 'Sort direction'
    return (
      <select aria-label={label} value={value} onChange={(e) => onValueChange(e.target.value)}>
        {items.map((it) => (
          <option key={it.value} value={it.value}>{it.label}</option>
        ))}
      </select>
    )
  }
  return {
    Select,
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

function makeServer(name: string, version: string, port: number) {
  return {
    name,
    ip: '10.0.0.1',
    port,
    gamePort: port,
    players: 1,
    maxPlayers: 16,
    map: 'Muldraugh, KY',
    version,
    vac: false,
    isPrivate: false,
    os: 'l',
  }
}

function listResponse(servers: ReturnType<typeof makeServer>[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      servers,
      count: servers.length,
      source: 'master_server',
      cached: false,
      apiKeyConfigured: true,
      totalPlayers: servers.length,
      activeServers: servers.length,
      totalCapacity: servers.length * 16,
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

describe('ServerFinder.tsx version filter', () => {
  it('"Clear all filters" also resets the version filter', async () => {
    vi.mocked(fetch).mockResolvedValue(listResponse([
      makeServer('Alpha Server', '42.1.0', 16261),
      makeServer('Bravo Server', '42.0.0', 16271),
    ]))

    renderServerFinder()
    expect(await screen.findByText('Alpha Server')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show Filters' }))
    fireEvent.change(screen.getByLabelText('Version filter'), { target: { value: '42.0.0' } })
    await waitFor(() => expect(screen.queryByText('Alpha Server')).not.toBeInTheDocument())

    // A search that matches nothing on top of the version filter empties the list.
    fireEvent.change(screen.getByRole('searchbox', { name: /search/i }), { target: { value: 'zzz-no-such-server' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Clear all filters' }))

    expect(await screen.findByText('Alpha Server')).toBeInTheDocument()
    expect(screen.getByText('Bravo Server')).toBeInTheDocument()
    expect((screen.getByLabelText('Version filter') as HTMLSelectElement).value).toBe('all')
  })

  it('falls back to all versions when a refresh drops the filtered version', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(listResponse([
      makeServer('Alpha Server', '42.1.0', 16261),
      makeServer('Bravo Server', '42.0.0', 16271),
    ]))
    vi.mocked(fetch).mockResolvedValue(listResponse([
      makeServer('Bravo Server', '42.0.0', 16271),
    ]))

    renderServerFinder()
    expect(await screen.findByText('Alpha Server')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show Filters' }))
    fireEvent.change(screen.getByLabelText('Version filter'), { target: { value: '42.1.0' } })
    await waitFor(() => expect(screen.queryByText('Bravo Server')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /Refresh List/ }))

    // Nobody runs 42.1.0 any more: the list must not stay empty behind a
    // filter value that is no longer even an option.
    expect(await screen.findByText('Bravo Server')).toBeInTheDocument()
    expect((screen.getByLabelText('Version filter') as HTMLSelectElement).value).toBe('all')
  })
})
