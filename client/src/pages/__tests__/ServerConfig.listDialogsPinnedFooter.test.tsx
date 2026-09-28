import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import ServerConfig from '../ServerConfig'
import { serverFilesApi, serversApi } from '@/lib/api'
import en from '../../locales/en/serverconfig.json'

// 2026-09 dialog viewport sweep (review follow-up to the Edit Server fix):
// the Backups and Saved Configs dialogs are mostly a fixed h-[400px]
// ScrollArea between a pinned-looking header row and a Close footer. As
// grid rows that list never shrank to the dialog's height cap, so on a
// short or zoomed-in window the whole dialog scrolled instead, and the wheel
// over the list -- most of the dialog -- scrolled the list first, keeping
// the footer below the fold until the list ran out. Both are now flex
// columns in which the list is what shrinks (same fix as FolderBrowser.tsx,
// measured in Chromium). jsdom does no layout, so this pins the structure:
// the list's ScrollArea is a direct flex child of the dialog and the
// footer, header row and title are outside it.

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

const getResolvedActive = vi.spyOn(serversApi, 'getResolvedActive')
const getActive = vi.spyOn(serversApi, 'getActive')
const getPaths = vi.spyOn(serverFilesApi, 'getPaths')
const getIni = vi.spyOn(serverFilesApi, 'getIni')
const getBackups = vi.spyOn(serverFilesApi, 'getBackups')
const getTemplates = vi.spyOn(serverFilesApi, 'getTemplates')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

function mockLoads() {
  getResolvedActive.mockResolvedValue({
    server: { id: 1, name: 'Server A', serverName: 'servera', isRemote: false } as never,
  })
  getActive.mockResolvedValue({ server: null } as never)
  getPaths.mockResolvedValue({
    exists: { ini: true, sandbox: false, spawnpoints: false, spawnregions: false },
  } as never)
  getIni.mockResolvedValue({ settings: { PVP: 'false' }, path: '/a', serverName: 'servera' } as never)
  getBackups.mockResolvedValue({
    backups: Array.from({ length: 12 }, (_, i) => ({
      filename: `ini-backup-${i}.zip`, type: 'ini', size: 1024 * (i + 1), created: '2026-01-01T00:00:00.000Z',
    })) as never,
    path: '/backups',
  })
  getTemplates.mockResolvedValue({
    templates: Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`, name: `Template ${i}`, description: '', type: 'ini', created: '2026-01-01T00:00:00.000Z',
      hasIni: true, hasSandbox: false,
    })),
  } as never)
}

async function renderAndOpen(trigger: RegExp) {
  mockLoads()
  render(
    <MemoryRouter initialEntries={['/server-config']}>
      <TooltipProvider>
        <ServerConfig />
      </TooltipProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(getIni).toHaveBeenCalled())
  fireEvent.click(await screen.findByRole('button', { name: trigger }))
  return screen.findByRole('dialog')
}

function expectListShrinksAndFooterStaysOut(dialog: HTMLElement, rowText: string, pinned: HTMLElement[]) {
  // flex-col replaces DialogContent's grid, in which the list could not shrink.
  expect(dialog.className).toMatch(/(^|\s)flex(\s|$)/)
  expect(dialog.className).toMatch(/(^|\s)flex-col(\s|$)/)
  expect(dialog.className).not.toMatch(/(^|\s)grid(\s|$)/)

  const viewport = dialog.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!
  const listRoot = viewport.parentElement!
  expect(listRoot.parentElement).toBe(dialog)
  expect(listRoot.className).toContain('overflow-hidden')
  expect(listRoot.contains(within(dialog).getByText(rowText))).toBe(true)
  for (const el of pinned) {
    expect(dialog.contains(el)).toBe(true)
    expect(listRoot.contains(el)).toBe(false)
  }
}

describe('ServerConfig -- list dialogs keep their footer out of the shrinking list', () => {
  it('Backups: the filter row, title and Close stay outside the backup list', async () => {
    const dialog = await renderAndOpen(/^backups$/i)
    await within(dialog).findByText('ini-backup-0.zip')
    // Its own height cap is unchanged (NarrowWidthDialogHeightCap pins it).
    expect(dialog.className).toContain('max-h-[85vh]')

    const allFiles = within(dialog).getByRole('button', { name: en.backupsDialog.filterAll })
    expectListShrinksAndFooterStaysOut(dialog, 'ini-backup-11.zip', [
      within(dialog).getByRole('heading', { name: en.backupsDialog.title }),
      allFiles,
      ...within(dialog).getAllByRole('button', { name: en.backupsDialog.close }),
    ])
    // Pinned at the dialog's full width now, the five filter buttons must
    // wrap on a phone rather than squash into each other.
    expect(allFiles.parentElement!.className).toMatch(/(^|\s)flex-wrap(\s|$)/)
  })

  it('Saved Configs: the Save Current Config row, title and Close stay outside the template list', async () => {
    const dialog = await renderAndOpen(/saved configs/i)
    await within(dialog).findByText('Template 0')
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')

    expectListShrinksAndFooterStaysOut(dialog, 'Template 5', [
      within(dialog).getByRole('heading', { name: en.templatesDialog.title }),
      within(dialog).getByRole('button', { name: en.templatesDialog.saveCurrentAsTemplate }),
      ...within(dialog).getAllByRole('button', { name: en.templatesDialog.close }),
    ])
  })
})
