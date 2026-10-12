import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'

// loadData() only applied the INI, spawn points and spawn regions "if they
// exist" and had no else branch (the sandbox had a fallback). Switch to a
// server that has never been started and the page kept showing server A's
// values, and saving spawn points or regions would write A's data into B.

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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const socketHandlers = vi.hoisted(() => new Map<string, Set<() => void>>())
vi.mock('@/contexts/SocketContext', () => ({
  useSocket: () => ({
    on: (event: string, handler: () => void) => {
      if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
      socketHandlers.get(event)!.add(handler)
    },
    off: (event: string, handler: () => void) => {
      socketHandlers.get(event)?.delete(handler)
    },
  }),
}))
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const getSandbox = vi.spyOn(serverFilesApi, 'getSandbox')
const getSpawnPoints = vi.spyOn(serverFilesApi, 'getSpawnPoints')
const getSpawnRegions = vi.spyOn(serverFilesApi, 'getSpawnRegions')
const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

// The strip's chips read "<value> <label>"; the value is the sibling before the label.
function chipValue(label: string): string {
  return screen.getByText(label).previousElementSibling?.textContent ?? ''
}

describe('ServerConfig.tsx: files missing on the new server do not keep the previous server\'s data', () => {
  it('empties the INI, spawn points and spawn regions after a switch to a server with none of them', async () => {
    getActive.mockResolvedValue({ server: null } as never)
    getResolvedActive.mockResolvedValue({
      server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
    })
    getPaths.mockResolvedValue({
      serverName: 'servera',
      configPath: '/a',
      exists: { ini: true, sandbox: false, spawnpoints: true, spawnregions: true },
    } as never)
    getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
    getSandbox.mockResolvedValue({ sandbox: { settings: {} } } as never)
    getSpawnPoints.mockResolvedValue({
      spawnpoints: { unemployed: [{ worldX: 1, worldY: 2, posX: 3, posY: 4 }] },
      path: '/a',
    } as never)
    getSpawnRegions.mockResolvedValue({
      spawnregions: [{ name: 'Muldraugh, KY', file: 'media/maps/Muldraugh, KY/spawnpoints.lua' }],
      path: '/a',
    } as never)

    render(
      <MemoryRouter>
        <ServerConfig />
      </MemoryRouter>,
    )

    await waitFor(() => expect(chipValue('Regions')).toBe('1'))
    expect(Number(chipValue('INI'))).toBeGreaterThan(0)
    expect(screen.getByText(/^Spawns/).previousElementSibling?.textContent).toBe('1')

    // Server B has never been started: no files at all.
    getResolvedActive.mockResolvedValue({
      server: { id: 2, name: 'Server B', serverName: 'serverb', isRemote: false } as never,
    })
    getPaths.mockResolvedValue({
      serverName: 'serverb',
      configPath: '/b',
      exists: { ini: false, sandbox: false, spawnpoints: false, spawnregions: false },
    } as never)

    act(() => { emitActiveServerChanged() })

    await waitFor(() => expect(chipValue('Regions')).toBe('0'))
    expect(chipValue('INI')).toBe('0')
    expect(screen.getByText(/^Spawns/).previousElementSibling?.textContent).toBe('0')
  })
})
