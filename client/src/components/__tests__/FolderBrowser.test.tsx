import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FolderBrowser } from '../FolderBrowser'
import { serverApi } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serverApi: { ...actual.serverApi, listDirectory: vi.fn() },
  }
})

const listDirectory = vi.mocked(serverApi.listDirectory)

beforeEach(() => {
  listDirectory.mockReset()
})

const root = {
  entries: [
    { name: 'Zomboid Données', path: '/srv/Zomboid Données', label: undefined, isDrive: false },
    { name: 'backups', path: '/srv/backups', label: undefined, isDrive: false },
  ],
  currentPath: '/srv',
  parentPath: '/',
}

describe('FolderBrowser', () => {
  it('loads the initial directory when opened', async () => {
    listDirectory.mockResolvedValue(root)
    render(<FolderBrowser open onOpenChange={vi.fn()} onSelect={vi.fn()} initialPath="/srv" />)

    expect(await screen.findByText('Zomboid Données')).toBeInTheDocument()
    expect(listDirectory).toHaveBeenCalledWith('/srv')
  })

  it('Select Folder is disabled until something is known, then confirms the real accented path -- not a mangled one', async () => {
    listDirectory.mockResolvedValue(root)
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()
    render(<FolderBrowser open onOpenChange={onOpenChange} onSelect={onSelect} initialPath="/srv" />)
    await screen.findByText('Zomboid Données')

    fireEvent.click(screen.getByText('Zomboid Données'))
    fireEvent.click(screen.getByRole('button', { name: 'Select Folder' }))

    expect(onSelect).toHaveBeenCalledWith('/srv/Zomboid Données')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('double-clicking a folder navigates into it instead of selecting it', async () => {
    listDirectory.mockResolvedValueOnce(root).mockResolvedValueOnce({
      entries: [{ name: 'nested', path: '/srv/Zomboid Données/nested', isDrive: false }],
      currentPath: '/srv/Zomboid Données',
      parentPath: '/srv',
    })
    render(<FolderBrowser open onOpenChange={vi.fn()} onSelect={vi.fn()} initialPath="/srv" />)
    await screen.findByText('Zomboid Données')

    fireEvent.doubleClick(screen.getByText('Zomboid Données'))

    expect(await screen.findByText('nested')).toBeInTheDocument()
    expect(listDirectory).toHaveBeenCalledWith('/srv/Zomboid Données')
  })

  it('Select Folder with nothing explicitly picked confirms the current directory, not a stale prior selection', async () => {
    listDirectory.mockResolvedValueOnce(root).mockResolvedValueOnce({
      entries: [{ name: 'nested', path: '/srv/Zomboid Données/nested', isDrive: false }],
      currentPath: '/srv/Zomboid Données',
      parentPath: '/srv',
    })
    const onSelect = vi.fn()
    render(<FolderBrowser open onOpenChange={vi.fn()} onSelect={onSelect} initialPath="/srv" />)
    await screen.findByText('Zomboid Données')

    fireEvent.click(screen.getByText('Zomboid Données')) // select it
    fireEvent.doubleClick(screen.getByText('Zomboid Données')) // then navigate into it
    await screen.findByText('nested')

    fireEvent.click(screen.getByRole('button', { name: 'Select Folder' }))
    expect(onSelect).toHaveBeenCalledWith('/srv/Zomboid Données')
  })

  it('shows a real error and lets the operator recover to the drive list, rather than a dead dialog', async () => {
    listDirectory.mockResolvedValueOnce(root).mockRejectedValueOnce(new Error('Permission denied'))
    render(<FolderBrowser open onOpenChange={vi.fn()} onSelect={vi.fn()} initialPath="/srv" />)
    await screen.findByText('Zomboid Données')

    fireEvent.submit(screen.getByRole('button', { name: 'Go' }).closest('form')!)

    expect(await screen.findByText('Permission denied')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to drives' })).toBeInTheDocument()
  })

  it('Cancel closes without ever calling onSelect', async () => {
    listDirectory.mockResolvedValue(root)
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()
    render(<FolderBrowser open onOpenChange={onOpenChange} onSelect={onSelect} initialPath="/srv" />)
    await screen.findByText('Zomboid Données')

    fireEvent.click(screen.getByText('Zomboid Données'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onSelect).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // 2026-09 dialog viewport sweep: this picker is ~500px tall (header, path
  // bar, a fixed 340px list, footer) -- taller than a 1366x768 laptop window
  // at 150% zoom. It used to pass overflow-hidden, which under DialogContent's
  // viewport bound would crop Select Folder off the bottom. Scrolling the
  // whole dialog instead wasn't enough either: the list is most of the
  // dialog, so the wheel over it scrolled the list first and Select Folder
  // stayed below the fold until every folder had gone by. The dialog is a
  // flex column so the list is what shrinks, and the footer sits outside
  // it. The list has a min-h-32 floor, below which the whole dialog scrolls
  // again: its root is overflow-hidden, so without one a short enough
  // window would squeeze every folder out of view. jsdom can't measure that
  // (Chromium did); this pins the structure.
  it('keeps Select Folder out of the shrinking folder list, so it stays on screen on a short window', async () => {
    listDirectory.mockResolvedValue(root)
    render(<FolderBrowser open onOpenChange={vi.fn()} onSelect={vi.fn()} initialPath="/srv" />)
    await screen.findByText('Zomboid Données')

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog.className).toContain('overflow-y-auto')
    expect(dialog.className).not.toContain('overflow-hidden')
    // flex-col replaces DialogContent's grid, in which the list could not shrink.
    expect(dialog.className).toMatch(/(^|\s)flex(\s|$)/)
    expect(dialog.className).toMatch(/(^|\s)flex-col(\s|$)/)
    expect(dialog.className).not.toMatch(/(^|\s)grid(\s|$)/)

    // The list's ScrollArea root is the flex item that gives up height: a
    // direct child of the dialog, holding the folders and nothing else.
    const viewport = dialog.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!
    const listRoot = viewport.parentElement!
    expect(listRoot.parentElement).toBe(dialog)
    expect(listRoot.className).toContain('overflow-hidden')
    expect(listRoot.className).toMatch(/(^|\s)min-h-32(\s|$)/)
    expect(listRoot.contains(screen.getByText('Zomboid Données'))).toBe(true)
    for (const name of ['Select Folder', 'Cancel', 'Go']) {
      const button = screen.getByRole('button', { name })
      expect(dialog.contains(button)).toBe(true)
      expect(listRoot.contains(button)).toBe(false)
    }
  })
})
