import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// The timezone picker's search icon sat at the start of the field but its
// chevron at the physical right, so in a right-to-left language the two
// landed on the same side and overlapped. Both now use logical offsets.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'technician', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    schedulerApi: {
      ...actual.schedulerApi,
      getTasks: vi.fn(),
      getCronPresets: vi.fn(),
      getStatus: vi.fn(),
      getHistory: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Scheduler timezone picker icons', () => {
  it('place the search icon and the chevron by reading direction, on opposite sides', async () => {
    vi.mocked(schedulerApi.getTasks).mockResolvedValue({ tasks: [] })
    vi.mocked(schedulerApi.getCronPresets).mockResolvedValue({ presets: [] })
    vi.mocked(schedulerApi.getHistory).mockResolvedValue({ history: [] })
    vi.mocked(schedulerApi.getStatus).mockResolvedValue({
      activeTasks: 0,
      autoRestartEnabled: false,
      modUpdateRestartPending: false,
      timezone: 'UTC',
      configuredTimezone: 'UTC',
      timezoneFallback: null,
    })
    vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [] })
    vi.mocked(serverApi.getStatus).mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)

    render(
      <MemoryRouter>
        <TooltipProvider>
          <Scheduler />
        </TooltipProvider>
      </MemoryRouter>,
    )

    const input = await screen.findByLabelText('IANA timezone name')
    const icons = [...input.parentElement!.querySelectorAll('svg')]
    expect(icons).toHaveLength(2)
    const [search, chevron] = icons
    expect(search).toHaveClass('start-2.5')
    expect(chevron).toHaveClass('end-2.5')
    for (const icon of icons) {
      expect(icon).not.toHaveClass('left-2.5')
      expect(icon).not.toHaveClass('right-2.5')
    }
  })
})
