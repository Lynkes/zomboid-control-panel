import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { debugApi, modsApi, serverApi, serversApi, type ServerProblemsResult } from '@/lib/api'
import { getDemoProblems } from '@/lib/demo'
import { ProblemsFound } from '../ProblemsFound'

// "Problems found" is the first thing on Diagnostics: the findings of GET
// /debug/problems by category with their fixes, "Fix all safe issues" with
// one preview, a run that stops at the first error, and Undo.

let capabilities = new Set(['diagnostics.manage', 'mods.manage', 'servers.manage', 'server.control'])
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ can: (cap: string) => capabilities.has(cap) }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    debugApi: { ...actual.debugApi, getProblems: vi.fn() },
    modsApi: {
      ...actual.modsApi,
      getModHealth: vi.fn(),
      applyModHealthFix: vi.fn(),
      autofixSnapshot: vi.fn(),
      autofixRestore: vi.fn(),
      toggleModId: vi.fn(),
    },
    serversApi: { ...actual.serversApi, update: vi.fn() },
    serverApi: { ...actual.serverApi, restart: vi.fn(), start: vi.fn() },
  }
})

const HEALTH = {
  checkedAt: '',
  counts: { critical: 1, warning: 0, info: 0 },
  issues: [{
    id: 'requiredNotInstalled-aaaaaaaaaaaaaaaa',
    kind: 'requiredNotInstalled',
    severity: 'critical',
    modIds: ['Brita'],
    workshopIds: ['2169435993'],
    params: { missing: 'Arsenal(26)GunFighter', requiredBy: ['Brita'] },
    fixes: [{ action: 'addWorkshopItems', params: { workshopIds: ['2297098490'] }, label: 'Add Workshop item 2297098490' }],
  }],
}

function renderIt(result: ServerProblemsResult = getDemoProblems(Date.parse('2026-10-20T12:00:00Z'))) {
  vi.mocked(debugApi.getProblems).mockResolvedValue(result)
  vi.mocked(modsApi.getModHealth).mockResolvedValue(HEALTH as never)
  vi.mocked(modsApi.autofixSnapshot).mockResolvedValue({ snapshotId: 'snap-1' })
  vi.mocked(modsApi.autofixRestore).mockResolvedValue({ restored: true })
  vi.mocked(modsApi.applyModHealthFix).mockResolvedValue({ applied: true } as never)
  vi.mocked(modsApi.toggleModId).mockResolvedValue({ success: true } as never)
  vi.mocked(serversApi.update).mockResolvedValue({} as never)
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <ProblemsFound />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capabilities = new Set(['diagnostics.manage', 'mods.manage', 'servers.manage', 'server.control'])
})

describe('Problems found', () => {
  it('shows the findings by category with what happened, why, the mod, how often and the log lines', async () => {
    renderIt()
    expect(await screen.findByRole('heading', { name: "Lua error in Brita's Weapon Pack" })).toBeInTheDocument()
    for (const name of ['Mods', 'Server', 'Network']) expect(screen.getByRole('heading', { name: new RegExp(`^${name}`) })).toBeInTheDocument()
    expect(screen.getByText('Required mod Arsenal(26)GunFighter is missing')).toBeInTheDocument()
    expect(screen.getByText('The server ran out of memory')).toBeInTheDocument()
    expect(screen.getByText(/Mod: Brita's Weapon Pack/)).toBeInTheDocument()
    expect(screen.getByText('Seen 14×')).toBeInTheDocument()

    const row = screen.getByRole('heading', { name: "Lua error in Brita's Weapon Pack" }).closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Show log lines (1)' }))
    expect(within(row).getByText(/BritaGunsTooltip\.lua line # 88/)).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Open Mods' })).toHaveAttribute('href', '/mods?view=active')
  })

  it('shows the scan in StrictMode too (an unmount/remount must not leave it scanning forever)', async () => {
    vi.mocked(debugApi.getProblems).mockResolvedValue(getDemoProblems())
    render(
      <StrictMode>
        <MemoryRouter>
          <TooltipProvider>
            <ConfirmProvider>
              <ProblemsFound />
            </ConfirmProvider>
          </TooltipProvider>
        </MemoryRouter>
      </StrictMode>,
    )
    expect(await screen.findByText('The server ran out of memory')).toBeInTheDocument()
  })

  it('says what was checked when nothing was found', async () => {
    const empty = getDemoProblems()
    renderIt({ ...empty, findings: [], counts: { critical: 0, warning: 0, info: 0, total: 0 } })
    expect(await screen.findByText('No problems found')).toBeInTheDocument()
    expect(screen.getByText(/Checked 18412 lines of server-console\.txt/)).toBeInTheDocument()
  })

  it('re-scans on demand', async () => {
    renderIt()
    await screen.findByText('The server ran out of memory')
    fireEvent.click(screen.getByRole('button', { name: 'Re-scan' }))
    await waitFor(() => expect(debugApi.getProblems).toHaveBeenCalledTimes(2))
  })

  it('Fix all safe issues: one preview, then the Mods health fix and the memory raise, and one Undo for both', async () => {
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: 'Fix all safe issues' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Raise max memory: 6 GB → 8 GB')).toBeInTheDocument()
    expect(within(dialog).getByText(/2 more problems need your decision/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 2 fixes' }))

    expect(await within(dialog).findByText('Fixes applied')).toBeInTheDocument()
    expect(modsApi.autofixSnapshot).toHaveBeenCalledTimes(1)
    expect(modsApi.applyModHealthFix).toHaveBeenCalledWith('requiredNotInstalled-aaaaaaaaaaaaaaaa', 'addWorkshopItems', { workshopIds: ['2297098490'] })
    expect(serversApi.update).toHaveBeenCalledWith('demo-server', { maxMemory: 8 })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }))
    expect(await within(dialog).findByText('Everything this run changed is back as it was.')).toBeInTheDocument()
    expect(modsApi.autofixRestore).toHaveBeenCalledWith('snap-1')
    expect(serversApi.update).toHaveBeenLastCalledWith('demo-server', { maxMemory: 6 })
  })

  it('stops at the first error and says where', async () => {
    renderIt()
    vi.mocked(serversApi.update).mockRejectedValue(new Error('disk is full'))
    fireEvent.click(await screen.findByRole('button', { name: 'Fix all safe issues' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 2 fixes' }))
    expect(await within(dialog).findByText(/^Stopped at:/)).toBeInTheDocument()
    expect(within(dialog).getByText('Stopped at: Raise max memory: 6 GB → 8 GB')).toBeInTheDocument()
    expect(modsApi.applyModHealthFix).not.toHaveBeenCalled()
  })

  it('asks before disabling a mod, then offers Undo through the mod list snapshot', async () => {
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: "Disable Brita's Weapon Pack" }))
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText(/removed from Mods=/)).toBeInTheDocument()
    fireEvent.click(within(confirm).getByRole('button', { name: "Disable Brita's Weapon Pack" }))
    await waitFor(() => expect(modsApi.toggleModId).toHaveBeenCalledWith('Brita', false))
    expect(modsApi.autofixSnapshot).toHaveBeenCalled()
    expect(await screen.findAllByText(/Fixed\. This entry leaves the log/)).not.toHaveLength(0)
  })

  it('asks before a restart', async () => {
    renderIt()
    const buttons = await screen.findAllByRole('button', { name: 'Restart server' })
    fireEvent.click(buttons[0])
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Restart server' }))
    await waitFor(() => expect(serverApi.restart).toHaveBeenCalledTimes(1))
  })

  it('hides the fixes a role cannot apply and says so', async () => {
    capabilities = new Set(['diagnostics.manage'])
    renderIt()
    await screen.findByText('The server ran out of memory')
    expect(screen.queryByRole('button', { name: /Raise max memory/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Fix all safe issues' })).toBeNull()
    expect(screen.getAllByText("Your role can see this problem but can't apply its fixes.").length).toBeGreaterThan(0)
  })
})
