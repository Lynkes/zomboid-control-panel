import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useState } from 'react'
import { serverApi } from '@/lib/api'
import { useSteamBranches, STEAMCMD_PATH_DEBOUNCE_MS, type SteamBranchOperation } from '../useSteamBranches'

// The Update dialog's branch lookup runs SteamCMD (+app_info_update). It used
// to depend on the whole dialog state object, so picking a branch re-ran it,
// and on the live-typed SteamCMD path, so every keystroke started another run
// (and, server-side, saved that half-typed path as the SteamCMD setting).

vi.mock('@/lib/api', () => ({
  serverApi: {
    detectSteamCmd: vi.fn(),
    getBranches: vi.fn(),
  },
}))
vi.mock('@/lib/client-errors', () => ({ reportClientError: vi.fn() }))

const detectSteamCmd = vi.mocked(serverApi.detectSteamCmd)
const getBranches = vi.mocked(serverApi.getBranches)

const t = ((key: string) => key) as never

function useHarness(initialPath = '') {
  const [operation, setOperation] = useState<SteamBranchOperation | null>({
    server: { id: 1, branch: 'public' },
    branch: 'public',
  })
  const [steamcmdPath, setSteamcmdPath] = useState(initialPath)
  const branches = useSteamBranches({
    operation,
    setOperation,
    steamcmdPath,
    setSteamcmdPath,
    installedBranch: 'public',
    t,
  })
  return { operation, setOperation, steamcmdPath, setSteamcmdPath, ...branches }
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  detectSteamCmd.mockReset().mockResolvedValue({ found: false, message: '' })
  getBranches.mockReset().mockResolvedValue({
    branches: [
      { name: 'public', description: 'Stable' },
      { name: 'unstable', description: 'Beta' },
    ],
    source: 'steam',
    message: '',
  } as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useSteamBranches', () => {
  it('looks the branches up once when the dialog opens', async () => {
    const { result } = renderHook(() => useHarness('D:\\steamcmd'))
    await settle()

    expect(getBranches).toHaveBeenCalledTimes(1)
    expect(getBranches).toHaveBeenCalledWith('D:\\steamcmd')
    expect(result.current.availableBranches.map((b) => b.name)).toEqual(['public', 'unstable'])
    expect(result.current.loadingBranches).toBe(false)
  })

  it('does not look them up again when a branch is picked', async () => {
    const { result } = renderHook(() => useHarness('D:\\steamcmd'))
    await settle()
    expect(getBranches).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.setOperation((prev) => (prev ? { ...prev, branch: 'unstable' } : prev))
    })
    await settle(STEAMCMD_PATH_DEBOUNCE_MS * 3)

    expect(result.current.operation?.branch).toBe('unstable')
    expect(getBranches).toHaveBeenCalledTimes(1)
  })

  it('waits for typing in the path field to stop before looking up again', async () => {
    const { result } = renderHook(() => useHarness('D:\\steamcmd'))
    await settle()
    expect(getBranches).toHaveBeenCalledTimes(1)

    for (const typed of ['D:\\steamcmd2', 'D:\\steamcmd25', 'D:\\steamcmd250']) {
      act(() => result.current.setSteamcmdPath(typed))
      await settle(100)
    }
    // Nothing yet: the field was still changing less than a debounce ago.
    expect(getBranches).toHaveBeenCalledTimes(1)

    await settle(STEAMCMD_PATH_DEBOUNCE_MS)
    expect(getBranches).toHaveBeenCalledTimes(2)
    expect(getBranches).toHaveBeenLastCalledWith('D:\\steamcmd250')
  })

  it('does not run SteamCMD again when the typed path resolves to the same detected folder', async () => {
    detectSteamCmd.mockResolvedValue({ found: true, path: 'D:\\detected', message: '' })
    const { result } = renderHook(() => useHarness(''))
    await settle()
    expect(getBranches).toHaveBeenCalledTimes(1)
    expect(getBranches).toHaveBeenCalledWith('D:\\detected')

    act(() => result.current.setSteamcmdPath('D:\\something-typed'))
    await settle(STEAMCMD_PATH_DEBOUNCE_MS * 2)

    expect(getBranches).toHaveBeenCalledTimes(1)
  })

  it('tries again after a failed lookup', async () => {
    getBranches.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useHarness('D:\\steamcmd'))
    await settle()
    expect(getBranches).toHaveBeenCalledTimes(1)
    expect(result.current.loadingBranches).toBe(false)

    act(() => result.current.setSteamcmdPath('D:\\steamcmd '))
    await settle(STEAMCMD_PATH_DEBOUNCE_MS)
    act(() => result.current.setSteamcmdPath('D:\\steamcmd'))
    await settle(STEAMCMD_PATH_DEBOUNCE_MS)

    expect(getBranches.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps a branch Steam does not list pickable, and falls back to the installed one when it is unknown', async () => {
    getBranches.mockResolvedValue({
      branches: [{ name: 'public', description: 'Stable' }],
      source: 'steam',
      message: '',
    } as never)
    const { result } = renderHook(() => useHarness('D:\\steamcmd'))
    act(() => {
      result.current.setOperation((prev) => (prev ? { ...prev, branch: 'iwbums' } : prev))
    })
    await settle()

    expect(result.current.availableBranches.map((b) => b.name)).toContain('iwbums')
    expect(result.current.operation?.branch).toBe('public')
  })
})
