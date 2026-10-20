import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Scheduler from '../Scheduler'
import { schedulerApi, serverApi, serversApi } from '@/lib/api'
import { TooltipProvider } from '@/components/ui/tooltip'

// pz-scheduler-ux-pass (2026-09-18): the Scheduled Tasks row's three
// icon-only buttons (Run Now, Edit, Delete) are otherwise identical in
// shape, but only Run Now and Edit had a hover `title` alongside their
// aria-label -- Delete had aria-label only. Inconsistent tooltip coverage
// across three visually-identical icon buttons in the same row reads as
// unfinished (irritant #3 in the brief), not intentional.
//
// Scheduler redesign: Run now, Duplicate and Delete moved into the row's
// RowActions menu, whose "..." button carries the same title as its label;
// Delete still asks first and names the task.

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

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

const getTasks = vi.mocked(schedulerApi.getTasks)
const getCronPresets = vi.mocked(schedulerApi.getCronPresets)
const getStatus = vi.mocked(schedulerApi.getStatus)
const getHistory = vi.mocked(schedulerApi.getHistory)
const serversGetAll = vi.mocked(serversApi.getAll)
const serverGetStatus = vi.mocked(serverApi.getStatus)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderScheduler() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Scheduler />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Scheduler.tsx: a task row keeps Delete in its labelled actions menu', () => {
  it('names the menu button after the task, lists Delete task last, and confirms naming the task', async () => {
    getTasks.mockResolvedValue({
      tasks: [
        {
          id: 5,
          name: 'Broadcast Reminder',
          cron_expression: '0 * * * *',
          command: 'servermsg Reminder',
          server_id: null,
          enabled: 1,
          last_run: null,
          created_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    })
    getCronPresets.mockResolvedValue({ presets: [] })
    getStatus.mockResolvedValue({ activeTasks: 1, autoRestartEnabled: false, modUpdateRestartPending: false })
    getHistory.mockResolvedValue({ history: [] })
    serversGetAll.mockResolvedValue({ servers: [] })
    serverGetStatus.mockResolvedValue({ running: true } as Awaited<ReturnType<typeof serverApi.getStatus>>)

    renderScheduler()

    const menuButton = await screen.findByRole('button', { name: 'More actions for Broadcast Reminder' })
    expect(menuButton).toHaveAttribute('title', 'More actions for Broadcast Reminder')
    expect(screen.getByRole('button', { name: 'Edit Broadcast Reminder' })).toHaveAttribute('title', 'Edit task')

    fireEvent.pointerDown(menuButton, { button: 0, ctrlKey: false })
    const items = within(await screen.findByRole('menu')).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Run task now', 'Duplicate', 'Delete task'])

    fireEvent.click(items[2])
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('"Broadcast Reminder"')
  })
})
