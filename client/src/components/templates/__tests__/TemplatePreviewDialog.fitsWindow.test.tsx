import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { TemplatePreviewDialog } from '../TemplatePreviewDialog'
import { serverApi, serversApi, templatesApi, type ServerInstance, type SimTemplate } from '@/lib/api'

// 2026-09 community report (Discord, with screenshots): the Templates
// preview "doesn't appear in full". Two causes, both measured in Chromium:
//  1. each diff row's value column was `flex shrink-0` with no width limit,
//     so a captured Mods=/WorkshopItems= list (34 ids) made the row -- and
//     with it DialogContent's one grid column -- about 4000px wide; the
//     dialog scrolled sideways and showed the labels or the values, never
//     both (a 70-char welcome message was enough on a phone);
//  2. the dialog capped itself at 85vh and scrolled as a whole, so Cancel /
//     Apply Template sat below the fold on every tested window, even for a
//     four-row diff. (Pinning the running warning and the scope checkboxes
//     under the diff as well was tried and left a landscape phone a 43px
//     strip of diff, so those two scroll with it, at either end.)
// jsdom does no layout, so this pins the structure and classes that produce
// the fixed behavior, and checks Tailwind really compiles the new ones.

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn(), getComposedStatus: vi.fn() },
    templatesApi: { ...actual.templatesApi, preview: vi.fn(), apply: vi.fn() },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const MODS = Array.from({ length: 34 }, (_, i) => `\\SAKUPrecisionSVE_Module${i}`).join(';')
const WELCOME = 'Welcome to DoomerZ PvE. Read the rules on our Discord before you build.'
const LONG_MOD_ID = 'SAKUPrecisionSVE_B42_Unstable_CompatibilityPatch_Extended'

const server = {
  id: 1, name: 'Local', serverName: 'servertest', isRemote: false, isActive: true,
} as unknown as ServerInstance

const template: SimTemplate = {
  schemaVersion: 1,
  meta: { id: 'tpl-1', name: 'Community_PvE_Brita_Arsenal_SAKU_weekly_wipe_B42', description: 'Captured from the main server.', tags: [], pzBuild: '42' },
  sandboxVars: {},
  serverIni: {},
  iniExclusions: [],
  mods: [{ workshopId: '3401394862', modId: LONG_MOD_ID }],
  map: { mapId: 'Muldraugh, KY' },
  difficulty: {},
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openPreview({ canManage = true, running = true } = {}) {
  vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server })
  vi.mocked(serverApi.getStatus).mockResolvedValue({ running } as Awaited<ReturnType<typeof serverApi.getStatus>>)
  vi.mocked(serversApi.getComposedStatus).mockRejectedValue(new Error('not composed'))
  vi.mocked(templatesApi.preview).mockResolvedValue({
    success: true,
    diff: {
      serverIni: [
        { key: 'Mods', from: '\\Brita', to: MODS },
        { key: 'ServerWelcomeMessage', from: 'Welcome!', to: WELCOME },
      ],
      sandboxVars: [{ section: 'ZombieLore', key: 'Speed', from: 2, to: 1 }],
      summary: { iniChanges: 2, sandboxChanges: 1, totalChanges: 3 },
    },
  })
  render(
    <ConfirmProvider>
      <TemplatePreviewDialog template={template} canManage={canManage} onClose={vi.fn()} onApplied={vi.fn()} />
    </ConfirmProvider>,
  )
  await screen.findByText(WELCOME)
  return screen.getByRole('dialog')
}

describe('TemplatePreviewDialog fits the window', () => {
  it('scrolls only the diff, in a DialogBody, under the shared viewport bound', async () => {
    const dialog = await openPreview()
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog.className).not.toContain('max-h-[85vh]')
    expect(dialog.className).toContain('max-w-2xl')

    const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')
    expect(body).not.toBeNull()
    expect(body!.parentElement).toBe(dialog)
    expect(body!.contains(screen.getByText(WELCOME))).toBe(true)
  })

  it('keeps the title and Cancel/Apply Template outside the scrolling body', async () => {
    const dialog = await openPreview()
    const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')!

    const title = within(dialog).getByRole('heading', { name: template.meta.name })
    expect(body.contains(title)).toBe(false)
    // A user-named template can fill the first line: keep it clear of the X.
    expect(title.parentElement!.className).toContain('pe-8')

    const apply = within(dialog).getByRole('button', { name: 'Apply Template' })
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    for (const el of [apply, cancel]) {
      expect(dialog.contains(el)).toBe(true)
      expect(body.contains(el)).toBe(false)
    }
    expect(apply.parentElement!.parentElement).toBe(dialog)
  })

  it('opens the body with why Apply is disabled and ends it with what Apply writes', async () => {
    const dialog = await openPreview()
    const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')!
    const warning = await within(body).findByText('Server is running')
    const scope = within(body).getByRole('checkbox', { name: 'Apply sandbox changes' })
    const firstRow = within(body).getByText('Zombie Speed')

    expect(warning.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(firstRow.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("pins a failed Apply's error right above the buttons, where the click that caused it is", async () => {
    vi.mocked(templatesApi.apply).mockRejectedValue(new Error('SandboxVars.lua is locked by another process'))
    const dialog = await openPreview({ running: false })
    const apply = within(dialog).getByRole('button', { name: 'Apply Template' })
    await waitFor(() => expect(apply).toBeEnabled())
    fireEvent.click(apply)
    // The shared confirm dialog asks first.
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Apply Template' }))

    const error = await within(dialog).findByText('SandboxVars.lua is locked by another process')
    const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')!
    expect(body.contains(error)).toBe(false)
    expect(error.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows a viewer only the diff: no pinned apply block, no buttons', async () => {
    const dialog = await openPreview({ canManage: false })
    expect(within(dialog).queryByRole('button', { name: 'Apply Template' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(dialog.querySelector('[data-dialog-body]')).not.toBeNull()
  })

  it("caps a long value's width and wraps it anywhere instead of widening the row", async () => {
    await openPreview()
    const to = screen.getByText(MODS)
    const valueColumn = to.parentElement!
    const row = valueColumn.parentElement!
    const labelColumn = row.firstElementChild as HTMLElement

    // The old `shrink-0` let the value set the row's width.
    expect(valueColumn.className).not.toMatch(/(^|\s)shrink-0(\s|$)/)
    expect(valueColumn.className).toContain('min-w-0')
    expect(valueColumn.className).toContain('flex-wrap')
    expect(valueColumn.className).toContain('[overflow-wrap:anywhere]')
    expect(valueColumn.className).toContain('sm:max-w-[60%]')
    expect(to.className).toContain('min-w-0')

    // Side by side from sm: up, value under its label on a phone.
    expect(row.className).toMatch(/(^|\s)flex-col(\s|$)/)
    expect(row.className).toContain('sm:flex-row')
    expect(labelColumn.className).toContain('min-w-0')
    expect(labelColumn.className).toContain('sm:flex-1')
    // The label may still truncate; its full text is one hover away.
    const label = within(labelColumn).getByText('Mods')
    expect(label.className).toContain('truncate')
    expect(label).toHaveAttribute('title', 'Mods')
  })

  it("wraps a failed preview's error, which often quotes a path as one token", async () => {
    // Visual verify (2026-09-30): at 375px this error ran 221px past the
    // dialog and scrolled it sideways; the Apply error already wrapped.
    const error = "EACCES: permission denied, scandir '/srv/docker/volumes/pz-doomerz-main-b42-data/_data/Zomboid/Saves/Multiplayer/DoomerZ_PvE_Main_B42/map_backup_2026-09-28T18-00-00Z'"
    vi.mocked(serversApi.getResolvedActive).mockResolvedValue({ server })
    vi.mocked(serverApi.getStatus).mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    vi.mocked(serversApi.getComposedStatus).mockRejectedValue(new Error('not composed'))
    vi.mocked(templatesApi.preview).mockResolvedValue({ success: false, error })
    render(
      <ConfirmProvider>
        <TemplatePreviewDialog template={template} canManage onClose={vi.fn()} onApplied={vi.fn()} />
      </ConfirmProvider>,
    )
    const message = await screen.findByText(error)
    expect(within(screen.getByRole('dialog')).getByText('Preview Failed')).toBeInTheDocument()
    expect(message.className).toContain('[overflow-wrap:anywhere]')
  })

  it('wraps an unspaced mod id in the mods list', async () => {
    await openPreview()
    expect(screen.getByText(LONG_MOD_ID).className).toContain('[overflow-wrap:anywhere]')
  })

  it('compiles the new row classes to real CSS', async () => {
    await openPreview()
    const valueColumn = screen.getByText(MODS).parentElement!
    const row = valueColumn.parentElement!
    const labelColumn = row.firstElementChild as HTMLElement
    const { css } = await postcss([
      tailwindcss({
        content: [{ raw: `${row.className} ${labelColumn.className} ${valueColumn.className}` }],
        corePlugins: { preflight: false },
      }),
    ]).process('@tailwind utilities;', { from: undefined })
    const compact = css.replace(/\s+/g, ' ')
    expect(compact).toMatch(/\{ overflow-wrap: anywhere/)
    expect(compact).toContain('max-width: 60%')
    expect(compact).toMatch(/\{ flex-direction: row/)
    expect(compact).toMatch(/\{ flex: 1 1 0%/)
  })
})
