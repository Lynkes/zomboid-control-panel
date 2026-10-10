import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CharacterImportExportDialog } from '../CharacterImportExportDialog'
import { panelBridgeApi, playersApi, configApi } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    playersApi: { ...actual.playersApi, getExport: vi.fn(), deleteExport: vi.fn() },
    panelBridgeApi: { ...actual.panelBridgeApi, exportCharacter: vi.fn(), importCharacter: vi.fn() },
    configApi: { ...actual.configApi, updateAppSettings: vi.fn() },
  }
})

const exportCharacter = vi.mocked(panelBridgeApi.exportCharacter)
const importCharacter = vi.mocked(panelBridgeApi.importCharacter)

type Props = Partial<React.ComponentProps<typeof CharacterImportExportDialog>>

function dialog(props: Props = {}) {
  return (
    <MemoryRouter>
      <CharacterImportExportDialog
        open
        onOpenChange={vi.fn()}
        player="Alice"
        bridgeConnected
        bridgeStatusLoading={false}
        autoExportEnabled={false}
        onAutoExportEnabledChange={vi.fn()}
        savedExports={[]}
        onSavedExportsChange={vi.fn()}
        {...props}
      />
    </MemoryRouter>
  )
}

const characterJson = (name: string) => ({ data: { username: name, perks: { Woodwork: 3 }, inventory: [] } })

let downloads: string[] = []

beforeEach(() => {
  downloads = []
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:fake') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('CharacterImportExportDialog', () => {
  it('exports the character of the player it is given and shows the JSON', async () => {
    exportCharacter.mockResolvedValue(characterJson('Alice') as never)
    render(dialog())

    fireEvent.click(screen.getByRole('button', { name: /^Export Alice/ }))

    await waitFor(() => expect(screen.getByLabelText('Copy character data')).toBeInTheDocument())
    expect(exportCharacter).toHaveBeenCalledWith('Alice')
    expect((screen.getByDisplayValue(/"username": "Alice"/) as HTMLTextAreaElement).readOnly).toBe(true)
  })

  it('downloads the export as <player>_character.json', async () => {
    exportCharacter.mockResolvedValue(characterJson('Alice') as never)
    render(dialog())

    fireEvent.click(screen.getByRole('button', { name: /^Export Alice/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download File' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Download File' }))

    expect(downloads).toEqual(['Alice_character.json'])
  })

  it('asks which player gets overwritten before importing, then imports into that player', async () => {
    importCharacter.mockResolvedValue({ success: true, data: { restored: { perks: 1, items: 0 } } } as never)
    render(dialog())

    fireEvent.change(screen.getByPlaceholderText('Paste character JSON here...'), {
      target: { value: '{"perks":{"Woodwork":3}}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(await screen.findByText("Overwrite Alice's character?")).toBeInTheDocument()
    expect(importCharacter).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Overwrite Character' }))

    await waitFor(() => expect(importCharacter).toHaveBeenCalledWith('Alice', { perks: { Woodwork: 3 } }))
  })

  it('refuses invalid JSON without opening the confirmation', () => {
    render(dialog())

    fireEvent.change(screen.getByPlaceholderText('Paste character JSON here...'), { target: { value: '{nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(screen.queryByText("Overwrite Alice's character?")).not.toBeInTheDocument()
    expect(importCharacter).not.toHaveBeenCalled()
  })

  it('shows the offline notice and no Export target when the bridge is down', () => {
    render(dialog({ bridgeConnected: false, player: '' }))

    expect(screen.getByText('Bridge Offline')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Export Player/ })).toBeDisabled()
  })

  it('reports the auto-export switch to its owner and saves it', async () => {
    const onAutoExportEnabledChange = vi.fn()
    vi.mocked(configApi.updateAppSettings).mockResolvedValue({} as never)
    render(dialog({ onAutoExportEnabledChange }))

    fireEvent.click(screen.getByRole('checkbox'))

    await waitFor(() => expect(configApi.updateAppSettings).toHaveBeenCalledWith({ autoExportOnLogin: true }))
    expect(onAutoExportEnabledChange).toHaveBeenCalledWith(true)
  })

  it('lists saved exports and removes one from the list after deleting it', async () => {
    const onSavedExportsChange = vi.fn()
    vi.mocked(playersApi.deleteExport).mockResolvedValue({} as never)
    render(
      dialog({
        onSavedExportsChange,
        savedExports: [{ username: 'Bob', filename: 'Bob_1.json', size: 2048, timestamp: '2026-10-01T10:00:00.000Z' }],
      }),
    )

    expect(screen.getByText('Saved Exports (1)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: "Delete Bob's saved export" }))

    await waitFor(() => expect(playersApi.deleteExport).toHaveBeenCalledWith('Bob', 'Bob_1.json'))
    expect(onSavedExportsChange).toHaveBeenCalled()
  })
})
