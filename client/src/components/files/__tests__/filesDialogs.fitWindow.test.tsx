import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { filesApi } from '@/lib/filesApi'
import type { FileEntry, ProfileFiles, RootDescriptor } from '@/types/files'
import { FileEditorDialog } from '../FileEditorDialog'
import { MoveDialog } from '../MoveDialog'
import { NameDialog } from '../NameDialog'
import { RemoteRootsDialog } from '../RemoteRootsDialog'
import { UploadReplaceDialog } from '../UploadQueue'

// 2026-09 dialog sweep (after the Templates preview community report), each
// case measured in Chromium with realistic long names at 375x667 / 853x413 /
// 1280x620. jsdom does no layout, so these pin the structure and classes
// that produce the fixed behavior.

vi.mock('@/lib/filesApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/filesApi')>()
  return {
    ...actual,
    filesApi: { ...actual.filesApi, list: vi.fn(), getText: vi.fn(), setRemoteRoots: vi.fn() },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const root = {
  id: 'data', backend: 'local', displayPath: '/home/steam/Zomboid', available: true, writable: true,
  freeBytes: null, totalBytes: null, warnings: [], trashItemCount: 0,
} as unknown as RootDescriptor

const MOVING = ['a.txt']
const LONG = 'steamapps/workshop/content/108600/2392709985/mods/Brita_2/media/lua/client/BWO_ContextMenu.lua'

function bodyOf(dialog: HTMLElement) {
  const body = dialog.querySelector<HTMLElement>(':scope > [data-dialog-body]')
  expect(body).not.toBeNull()
  return body!
}

describe('UploadReplaceDialog', () => {
  it('wraps each existing name instead of truncating it (a folder upload keeps long sub-paths)', () => {
    render(<UploadReplaceDialog open folder="Zomboid folder" names={[LONG, `${LONG}.bak`]} onChoose={vi.fn()} />)
    const li = screen.getByText(LONG).closest('li')!
    expect(li.className).not.toContain('truncate')
    expect(li.className).toContain('[overflow-wrap:anywhere]')
  })
})

describe('NameDialog', () => {
  it('lets the shared title wrap a long unbroken file name', () => {
    const name = 'DoomerZ_PvE_Survival_Server_SandboxVars.lua'
    render(
      <NameDialog
        open
        title={`Rename ${name}`}
        label="New name"
        initialValue={name}
        submitLabel="Rename"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const title = screen.getByRole('heading', { name: `Rename ${name}` })
    expect(title.className).toContain('[overflow-wrap:anywhere]')
    expect(title.className).not.toContain('break-words')
  })
})

describe('RemoteRootsDialog', () => {
  it('scrolls only the fields; Save reaches the form by id from a footer outside the body', () => {
    const profile = { id: 'p1', remoteRoots: { installPath: '/', dataPath: '', derivedDataPath: '/home/steam/Zomboid' } } as unknown as ProfileFiles
    render(<RemoteRootsDialog open profile={profile} canEdit onClose={vi.fn()} onSaved={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    const body = bodyOf(dialog)
    const form = body.querySelector('form')!
    expect(form.id).toBe('files-remote-roots-form')
    expect(body.contains(within(dialog).getByLabelText('Game install folder'))).toBe(true)

    const save = within(dialog).getByRole('button', { name: 'Save' })
    expect(body.contains(save)).toBe(false)
    expect(save).toHaveAttribute('type', 'submit')
    expect(save).toHaveAttribute('form', 'files-remote-roots-form')
  })

  it('shows a failed save outside the scrolling fields, right above the buttons', async () => {
    vi.mocked(filesApi.setRemoteRoots).mockRejectedValue(new Error('The SFTP server refused the path'))
    const profile = { id: 'p1', remoteRoots: { installPath: '/opt/pz', dataPath: '', derivedDataPath: '' } } as unknown as ProfileFiles
    render(<RemoteRootsDialog open profile={profile} canEdit onClose={vi.fn()} onSaved={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    const error = await within(dialog).findByRole('alert')
    expect(bodyOf(dialog).contains(error)).toBe(false)
    expect(error.compareDocumentPosition(within(dialog).getByRole('button', { name: 'Save' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('MoveDialog', () => {
  it('has one scroller: the folder list shrinks inside a flex-column body, the destination row stays above it', async () => {
    vi.mocked(filesApi.list).mockResolvedValue({
      entries: Array.from({ length: 20 }, (_, i) => ({
        name: `Nested_${i}`, path: `Nested_${i}`, type: 'dir', protection: null, flags: { unsupportedName: false },
      })),
    } as unknown as Awaited<ReturnType<typeof filesApi.list>>)
    render(
      <MoveDialog open profileId="p1" root={root} rootLabel="Zomboid folder" paths={MOVING} startDir="" onCancel={vi.fn()} onMove={vi.fn()} />,
    )
    const dialog = screen.getByRole('dialog')
    const body = bodyOf(dialog)
    expect(body.className).toMatch(/(^|\s)flex(\s|$)/)
    expect(body.className).toContain('flex-col')

    const first = await within(dialog).findByText('Nested_0')
    expect(first).toHaveAttribute('title', 'Nested_0')
    const list = first.closest('ul')!
    expect(list.className).toContain('min-h-0')
    expect(list.className).toContain('overflow-y-auto')
    const box = list.parentElement!
    expect(box.className).toMatch(/(^|\s)flex(\s|$)/)
    expect(box.className).toContain('flex-col')
    expect(box.className).toContain('min-h-24')
    for (const name of ['Cancel', 'Move']) {
      expect(body.contains(within(dialog).getByRole('button', { name }))).toBe(false)
    }
  })
})

describe('FileEditorDialog', () => {
  it('caps the notes above the text at 40% and scrolls them, and keeps the text a floor', async () => {
    vi.mocked(filesApi.getText).mockResolvedValue({
      etag: 'h:1', bom: false, eol: 'lf', masked: true, readOnly: false, readOnlyReason: null,
      hints: ['restartToApply', 'panelRewritesKeys', 'bridgeWorkshopEntries'], content: 'PVP=true\n',
    } as unknown as Awaited<ReturnType<typeof filesApi.getText>>)
    const entry = {
      name: 'servertest.ini', path: 'Server/servertest.ini', type: 'file', size: 10, modifiedAt: null, mode: null,
      etag: 'h:1', protection: null,
      flags: { editable: true, binaryHint: false, secretBearing: true, executable: false, worldState: false, unsupportedName: false },
    } as unknown as FileEntry
    render(
      <ConfirmProvider>
        <FileEditorDialog
          open
          profileId="p1"
          root={root}
          entry={entry}
          closeSignal={0}
          runConfirmed={vi.fn()}
          onClose={vi.fn()}
          onCloseCancelled={vi.fn()}
          onSaved={vi.fn()}
          onTooLarge={vi.fn()}
        />
      </ConfirmProvider>,
    )
    const masked = await screen.findByTestId('files-editor-masked')
    const notes = masked.parentElement!
    expect(notes.className).toContain('max-h-[40%]')
    expect(notes.className).toContain('min-h-0')
    expect(notes.className).toContain('overflow-y-auto')

    const textarea = await screen.findByRole('textbox', { name: 'servertest.ini' })
    await waitFor(() => expect(textarea).toHaveValue('PVP=true\n'))
    const textRegion = notes.nextElementSibling as HTMLElement
    expect(textRegion.contains(textarea)).toBe(true)
    expect(textRegion.className).toContain('min-h-[7.5rem]')
    expect(textRegion.className).toContain('flex-1')
  })
})
