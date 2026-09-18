import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act, waitFor } from '@testing-library/react'
import { SocketContext } from '@/contexts/SocketContext'
import { CreateTemplateDialog } from '../CreateTemplateDialog'
import { serverFilesApi, templatesApi } from '@/lib/api'

// pz-bughunt: this dialog reads the active server's live INI/Sandbox once
// on open with no activeServerChanged listener, unlike
// TemplatePreviewDialog.tsx (round 18) -- switching the active server
// elsewhere while it stayed open let "Save as new template" silently save
// the OLD server's config. Fixed by closing outright on activeServerChanged,
// the same shape TemplatePreviewDialog.tsx already uses.

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    serverFilesApi: { ...actual.serverFilesApi, getIni: vi.fn(), getSandbox: vi.fn() },
    templatesApi: { ...actual.templatesApi, create: vi.fn() },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const getIni = vi.mocked(serverFilesApi.getIni)
const getSandbox = vi.mocked(serverFilesApi.getSandbox)
const create = vi.mocked(templatesApi.create)

const socketHandlers = new Map<string, Set<(...args: unknown[]) => void>>()
const fakeSocket = {
  connected: true,
  on: (event: string, handler: (...args: unknown[]) => void) => {
    if (!socketHandlers.has(event)) socketHandlers.set(event, new Set())
    socketHandlers.get(event)!.add(handler)
  },
  off: (event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.get(event)?.delete(handler)
  },
} as unknown as Parameters<typeof SocketContext.Provider>[0]['value']
function emitActiveServerChanged() {
  socketHandlers.get('activeServerChanged')?.forEach((h) => h())
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  socketHandlers.clear()
})

function renderDialog(onClose: () => void) {
  return render(
    <SocketContext.Provider value={fakeSocket}>
      <CreateTemplateDialog open={true} onClose={onClose} onCreated={vi.fn()} />
    </SocketContext.Provider>,
  )
}

describe('CreateTemplateDialog: activeServerChanged closes the dialog before a stale save can fire', () => {
  it('calls onClose and never calls templatesApi.create once the active server changed', async () => {
    getIni.mockResolvedValue({ settings: { Foo: 'bar' } } as Awaited<ReturnType<typeof serverFilesApi.getIni>>)
    getSandbox.mockResolvedValue({ sandbox: { Zombies: '1' } } as Awaited<ReturnType<typeof serverFilesApi.getSandbox>>)

    const onClose = vi.fn()
    renderDialog(onClose)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Template' })).toBeEnabled)
    expect(onClose).not.toHaveBeenCalled()

    act(() => { emitActiveServerChanged() })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })
})
