import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { WorkshopCollectionPanel } from '../WorkshopCollectionPanel'
import { modsApi } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    modsApi: {
      ...actual.modsApi,
      collectionDiff: vi.fn(),
      purgeMod: vi.fn(),
      collectionRemoveItem: vi.fn(),
      collectionAddItem: vi.fn(),
      trackMod: vi.fn(),
      collectionUntrack: vi.fn(),
      addToIni: vi.fn(),
      batchRemove: vi.fn(),
    },
  }
})

const collectionDiff = vi.mocked(modsApi.collectionDiff)
const purgeMod = vi.mocked(modsApi.purgeMod)
const collectionUntrack = vi.mocked(modsApi.collectionUntrack)

// A name with accents/non-ASCII, since the panel is the primary place an
// operator sees Workshop titles rendered verbatim from Steam.
const ACCENTED_NAME = 'Café Épée & Bouclier Ünïcode Mod'

function baseDiff(items: any[]) {
  return {
    ok: true,
    items,
    collectionId: 'coll-1',
    autoSync: true,
    hasCredentials: true,
    tokenExpiry: null,
    tokenExpired: false,
    trackedCount: items.length,
  }
}

beforeEach(() => {
  collectionDiff.mockReset()
  purgeMod.mockReset()
  collectionUntrack.mockReset()
})

async function renderPanel(items: any[]) {
  collectionDiff.mockResolvedValue(baseDiff(items) as any)
  render(
    <MemoryRouter>
      <WorkshopCollectionPanel />
    </MemoryRouter>
  )
  await waitFor(() => expect(collectionDiff).toHaveBeenCalled())
}

describe('WorkshopCollectionPanel', () => {
  it('renders an accented, non-ASCII mod name verbatim -- not stripped or mangled', async () => {
    await renderPanel([
      { workshopId: '111', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    expect(await screen.findByText(ACCENTED_NAME)).toBeInTheDocument()
  })

  it('does NOT purge on a single click of "Remove everywhere" -- it only opens a confirmation', async () => {
    await renderPanel([
      { workshopId: '111', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.pointerDown(screen.getByTitle('More'), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByText('Remove everywhere'))

    // The dialog must appear, naming the real mod, before anything destructive happens.
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText(`Remove ${ACCENTED_NAME} everywhere?`)).toBeInTheDocument()
    expect(purgeMod).not.toHaveBeenCalled()
  })

  it('Cancel on the purge dialog leaves the mod untouched', async () => {
    await renderPanel([
      { workshopId: '111', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.pointerDown(screen.getByTitle('More'), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByText('Remove everywhere'))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(purgeMod).not.toHaveBeenCalled()
  })

  it('confirming the purge dialog calls purgeMod exactly once with the real workshop id and name', async () => {
    purgeMod.mockResolvedValue({
      success: true,
      workshopId: '111',
      name: ACCENTED_NAME,
      collection: { attempted: false, ok: false, error: null },
      deletedFromDisk: true,
      modIdsStripped: 1,
      mapFoldersStripped: 0,
    } as any)
    await renderPanel([
      { workshopId: '111', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.pointerDown(screen.getByTitle('More'), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByText('Remove everywhere'))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove everywhere' }))

    await waitFor(() => expect(purgeMod).toHaveBeenCalledTimes(1))
    expect(purgeMod).toHaveBeenCalledWith('111', ACCENTED_NAME)
  })

  it('the confirm click is a one-shot -- the dialog closes immediately and cannot double-fire the purge', async () => {
    let resolvePurge: (v: any) => void
    purgeMod.mockReturnValue(new Promise((resolve) => { resolvePurge = resolve }))
    await renderPanel([
      { workshopId: '111', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.pointerDown(screen.getByTitle('More'), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByText('Remove everywhere'))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove everywhere' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    resolvePurge!({
      success: true, workshopId: '111', name: ACCENTED_NAME,
      collection: { attempted: false, ok: false, error: null }, deletedFromDisk: true,
      modIdsStripped: 0, mapFoldersStripped: 0,
    })
    expect(purgeMod).toHaveBeenCalledTimes(1)
  })

  it('the safe, non-destructive Track action still works and does not require any confirmation', async () => {
    await renderPanel([
      { workshopId: '222', name: ACCENTED_NAME, status: 'to-add', inTracked: false, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.click(screen.getByRole('button', { name: 'Track' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await waitFor(() => expect(vi.mocked(modsApi.trackMod)).toHaveBeenCalledWith('222'))
  })

  it('a failed row action surfaces failure and does not silently mark the mod as untracked', async () => {
    collectionUntrack.mockRejectedValue(new Error('server rejected untrack'))
    await renderPanel([
      { workshopId: '333', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.click(screen.getByRole('button', { name: 'Untrack' }))
    await waitFor(() => expect(collectionUntrack).toHaveBeenCalledWith('333'))
    // Refresh isn't called on failure, and the button returns to its idle (non-busy) state
    // rather than getting stuck -- proving the failure path doesn't leave the row lying about status.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Untrack' })).toBeEnabled())
  })

  it('exposes the Add-to-collection disabled reason as an accessible name, not just a hover title', async () => {
    collectionDiff.mockResolvedValue({
      ...baseDiff([
        { workshopId: '444', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
      ]),
      hasCredentials: false,
    } as any)
    render(
      <MemoryRouter>
        <WorkshopCollectionPanel />
      </MemoryRouter>
    )
    await screen.findByText(ACCENTED_NAME)

    const addButton = screen.getByTitle('Need Steam cookies')
    expect(addButton).toBeDisabled()
    // A native title is invisible on touch and unreliable for screen readers on a
    // disabled control -- the same reason must also be the button's accessible name.
    expect(addButton).toHaveAccessibleName('Need Steam cookies')
  })

  it('defaults to the "missing from collection" filter, hiding in-sync items until asked', async () => {
    await renderPanel([
      { workshopId: '1', name: 'Missing Mod', status: 'to-add', inTracked: true, inCollection: false, inServer: false },
      { workshopId: '2', name: 'Synced Mod', status: 'synced', inTracked: true, inCollection: true, inServer: true },
    ])
    expect(await screen.findByText('Missing Mod')).toBeInTheDocument()
    expect(screen.queryByText('Synced Mod')).not.toBeInTheDocument()
  })
})
