import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { panelBridgeApi, serverApi, serverFilesApi, serversApi } from '@/lib/api'
import en from '../../locales/en/serverconfig.json'
import { makeWorkshopStatus } from '@/components/bridge/__tests__/deliveryFixtures'

// Review of the ZCPB rename: the Debug page's mods.resolved triage called an
// undownloaded PanelBridge item a typo of any installed id within two edits
// of "ZCPB", and this banner then offered a one-click "Use" that swapped the
// bridge out of Mods=. PanelBridge's own entry now carries the panelBridge
// cause: no swap, no removal, a way to Settings › PanelBridge instead.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ServerConfig › unresolved Mods= review: PanelBridge’s own entry', () => {
  it('points at Settings › PanelBridge and offers no swap or removal', async () => {
    vi.spyOn(serversApi, 'getResolvedActive').mockResolvedValue({
      server: { id: 1, name: 'Main Server', serverName: 'servertest', isRemote: false },
    } as never)
    vi.spyOn(serversApi, 'getActive').mockResolvedValue({ server: { id: 1, isRemote: false } } as never)
    vi.spyOn(serverApi, 'getStatus').mockResolvedValue({ running: false } as never)
    vi.spyOn(serverFilesApi, 'getPaths').mockResolvedValue({
      exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
    } as never)
    vi.spyOn(serverFilesApi, 'getIni').mockResolvedValue({
      settings: { Mods: 'ZCPB;ZCP', WorkshopItems: '3712345678', DoLuaChecksum: 'false' },
      path: '/x/servertest.ini',
      serverName: 'servertest',
    } as never)
    vi.spyOn(panelBridgeApi, 'getDelivery').mockResolvedValue(makeWorkshopStatus())

    const query = new URLSearchParams([
      ['tab', 'ini'],
      ['unresolved', 'ZCPB'],
      ['unresolvedCause', 'ZCPB|panelBridge|'],
    ])
    render(
      <MemoryRouter initialEntries={[`/server-config?${query.toString()}`]}>
        <ServerConfig />
      </MemoryRouter>,
    )

    const explanation = await screen.findByText(en.unresolvedReview.causePanelBridge)
    const entry = explanation.parentElement as HTMLElement
    expect(within(entry).getByText('ZCPB').tagName).toBe('CODE')
    expect(within(entry).getByRole('link', { name: en.unresolvedReview.openBridgeSettings }))
      .toHaveAttribute('href', '/settings?tab=bridge')
    expect(within(entry).queryByRole('button')).toBeNull()
    expect(screen.queryByText(en.unresolvedReview.removeAction)).toBeNull()
  })
})
