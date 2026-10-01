import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { CreateTemplateDialog } from '../CreateTemplateDialog'
import { ImportTemplateDialog } from '../ImportTemplateDialog'
import { serverFilesApi, templatesApi } from '@/lib/api'

// 2026-09 dialog sweep (after the Templates preview community report): Save
// Current Config and Import scrolled as a whole, so on a short window (a
// landscape phone, 1280x620 at 125-150% zoom) Save Template / Import sat
// below the dialog's visible box -- and a failed import's error pushed the
// buttons out entirely, so the click that failed showed nothing. Both now
// scroll only a DialogBody, with the error pinned right above the buttons.
// jsdom does no layout; this pins the structure (measured in Chromium).

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    serverFilesApi: { ...actual.serverFilesApi, getIni: vi.fn(), getSandbox: vi.fn() },
    templatesApi: { ...actual.templatesApi, create: vi.fn(), import: vi.fn() },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function bodyOf(dialog: HTMLElement) {
  const body = dialog.querySelector<HTMLElement>('[data-dialog-body]')
  expect(body).not.toBeNull()
  expect(body!.parentElement).toBe(dialog)
  return body!
}

describe('ImportTemplateDialog fits a short window', () => {
  it('scrolls only the file picker and paste box; the error and Cancel/Import stay outside the body', async () => {
    render(<ImportTemplateDialog open onClose={vi.fn()} onImported={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    const body = bodyOf(dialog)
    const textarea = within(dialog).getByRole('textbox')
    expect(body.contains(textarea)).toBe(true)

    fireEvent.change(textarea, { target: { value: '{ not json' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }))

    const error = await within(dialog).findByText('Import Failed')
    expect(body.contains(error)).toBe(false)
    for (const name of ['Cancel', 'Import']) {
      expect(body.contains(within(dialog).getByRole('button', { name }))).toBe(false)
    }
    expect(error.compareDocumentPosition(within(dialog).getByRole('button', { name: 'Import' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('CreateTemplateDialog fits a short window', () => {
  it('scrolls only the form; Cancel/Save Template stay outside the body', async () => {
    vi.mocked(serverFilesApi.getIni).mockResolvedValue({ settings: { PVP: 'true', MaxPlayers: '16' } } as unknown as Awaited<ReturnType<typeof serverFilesApi.getIni>>)
    vi.mocked(serverFilesApi.getSandbox).mockResolvedValue({ sandbox: { Zombies: 3 } } as unknown as Awaited<ReturnType<typeof serverFilesApi.getSandbox>>)
    render(<CreateTemplateDialog open onClose={vi.fn()} onCreated={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    const name = await within(dialog).findByLabelText('Name')
    const body = bodyOf(dialog)
    expect(body.contains(name)).toBe(true)
    for (const label of ['Cancel', 'Save Template']) {
      expect(body.contains(within(dialog).getByRole('button', { name: label }))).toBe(false)
    }
  })
})
