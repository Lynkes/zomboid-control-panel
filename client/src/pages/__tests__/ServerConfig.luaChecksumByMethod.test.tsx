import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { panelBridgeApi, serverApi, serverFilesApi, serversApi } from '@/lib/api'
import type { DeliveryStatus } from '@/lib/bridgeDeliveryTypes'
import en from '../../locales/en/serverconfig.json'
import { makeLocalStatus, makeWorkshopStatus } from '@/components/bridge/__tests__/deliveryFixtures'

// Spec §4.12: the DoLuaChecksum callout on Server Config › INI depends on
// how PanelBridge reaches the active server. Panel-installed delivery can't
// work with the check on (the old, unconditional warning); Workshop
// delivery can, once the heartbeat confirms it. A failed delivery fetch
// falls back to the panel-installed behaviour, the one that only warns.

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

const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')
const getStatus = vi.spyOn(serverApi, 'getStatus')
const getDelivery = vi.spyOn(panelBridgeApi, 'getDelivery')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const localBody = /The panel-installed PanelBridge adds server-side Lua files players don't have/

async function renderWith(delivery: DeliveryStatus | Error, doLuaChecksum: string) {
  getResolvedActive.mockResolvedValue({ server: { id: 1, name: 'Main Server', serverName: 'servertest', isRemote: false } as never })
  getActive.mockResolvedValue({ server: { id: 1, isRemote: false } } as never)
  getStatus.mockResolvedValue({ running: false } as never)
  getPaths.mockResolvedValue({ exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false } } as never)
  getIni.mockResolvedValue({ settings: { DoLuaChecksum: doLuaChecksum, PVP: 'true' }, path: '/x/servertest.ini', serverName: 'servertest' } as never)
  if (delivery instanceof Error) getDelivery.mockRejectedValue(delivery)
  else getDelivery.mockResolvedValue(delivery)
  render(
    <MemoryRouter>
      <ServerConfig />
    </MemoryRouter>,
  )
  // Ready = the INI editor is on screen AND the delivery answer has been
  // applied; asserting an absent callout any earlier would pass vacuously.
  await screen.findByRole('button', { name: en.editorToolbar.saveAndReload })
  await waitFor(() => expect(getDelivery).toHaveBeenCalled())
  await act(async () => {
    await getDelivery.mock.results[0].value.catch(() => undefined)
  })
}

function callouts() {
  return {
    localTitle: screen.queryAllByText(en.iniTab.luaChecksumTitle),
    localBody: screen.queryByText(localBody),
    note: screen.queryByText(en.iniTab.luaChecksumWorkshopNote),
    unconfirmed: screen.queryByText(en.iniTab.luaChecksumWorkshopUnconfirmed),
  }
}

describe('ServerConfig › INI: DoLuaChecksum callout per PanelBridge delivery', () => {
  it('Local + on: the blocking warning with the new body and "disable now"', async () => {
    await renderWith(makeLocalStatus(), 'true')
    await waitFor(() => expect(screen.getByText(localBody)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: en.iniTab.disableNow })).toBeInTheDocument()
    expect(callouts().note).toBeNull()
    expect(callouts().unconfirmed).toBeNull()
  })

  it('Local + off: nothing', async () => {
    await renderWith(makeLocalStatus(), 'false')
    const c = callouts()
    expect(c.localBody).toBeNull()
    expect(c.note).toBeNull()
    expect(c.unconfirmed).toBeNull()
  })

  it('Workshop confirmed + off: the neutral "you can turn this on" note', async () => {
    await renderWith(makeWorkshopStatus(), 'false')
    expect(await screen.findByText(en.iniTab.luaChecksumWorkshopNote)).toBeInTheDocument()
    expect(callouts().localBody).toBeNull()
    expect(screen.queryByRole('button', { name: en.iniTab.disableNow })).toBeNull()
  })

  it('Workshop not yet confirmed + on: a warning with "disable now", which only edits the field', async () => {
    const saveIni = vi.spyOn(serverFilesApi, 'saveIni')
    await renderWith(makeWorkshopStatus({ state: 'workshop-restart-needed' }), 'true')
    expect(await screen.findByText(en.iniTab.luaChecksumWorkshopUnconfirmed)).toBeInTheDocument()
    expect(callouts().localBody).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.iniTab.disableNow }))
    await waitFor(() => expect(screen.queryByText(en.iniTab.luaChecksumWorkshopUnconfirmed)).toBeNull())
    expect(saveIni).not.toHaveBeenCalled()
  })

  it('Workshop confirmed + on: no callout at all', async () => {
    await renderWith(makeWorkshopStatus(), 'true')
    const c = callouts()
    expect(c.localBody).toBeNull()
    expect(c.note).toBeNull()
    expect(c.unconfirmed).toBeNull()
  })

  it('falls back to the panel-installed warning when the delivery status cannot be read', async () => {
    await renderWith(new Error('403'), 'true')
    await waitFor(() => expect(screen.getByText(localBody)).toBeInTheDocument())
  })
})
