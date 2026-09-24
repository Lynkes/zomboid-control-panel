import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, act } from '@testing-library/react'
import { SocketContext } from '@/contexts/SocketContext'
import { TemplatePreviewDialog } from '../TemplatePreviewDialog'
import { serverApi, serversApi, templatesApi, type ServerInstance, type SimTemplate } from '@/lib/api'

// pz-bughunt round 18 (the narrower server-switch races flagged in round
// 17): `server` (and the diff/running snapshot derived from it) was
// captured once when this dialog opened, with no activeServerChanged
// listener at all -- switching the active server elsewhere while the
// dialog stayed open left it showing a diff/running verdict for a server
// that may no longer be the one active, and handleApply's own
// templatesApi.apply(..., server.id, ...) call would still fire against
// that now-stale snapshot. Fixed by closing the dialog outright on
// activeServerChanged, the same shape every other dialog this round uses.

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

const getStatus = vi.mocked(serverApi.getStatus)
const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const preview = vi.mocked(templatesApi.preview)
const apply = vi.mocked(templatesApi.apply)

const server: ServerInstance = {
  id: 1, name: 'Server A', serverName: 'servera', installPath: 'C:/servera',
  zomboidDataPath: null, serverConfigPath: null, rconHost: '127.0.0.1', rconPort: 27015,
  rconPassword: 'x', serverPort: 16261, minMemory: 2048, maxMemory: 4096,
  useNoSteam: false, useDebug: false, isRemote: false, isActive: true, startCommand: '',
  adminPassword: '', createdAt: '2026-01-01T00:00:00.000Z',
}

const template: SimTemplate = {
  schemaVersion: 1,
  meta: { id: 'tpl-1', name: 'Test Template', description: '', tags: [], pzBuild: '41' },
  sandboxVars: {},
  serverIni: {},
  iniExclusions: [],
  mods: [],
  map: { mapId: 'Muldraugh, KY' },
  difficulty: {},
}

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
      <TemplatePreviewDialog template={template} canManage={true} onClose={onClose} onApplied={vi.fn()} />
    </SocketContext.Provider>,
  )
}

describe('TemplatePreviewDialog: activeServerChanged closes the dialog before a stale Apply can fire', () => {
  it('calls onClose and never calls templatesApi.apply once the active server changed', async () => {
    getResolvedActive.mockResolvedValue({ server })
    getStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    getComposedStatus.mockRejectedValue(new Error('not exercised, non-docker fixture'))
    preview.mockResolvedValue({
      success: true,
      diff: { serverIni: [{ key: 'X', from: '1', to: '2' }], sandboxVars: [], summary: { iniChanges: 1, sandboxChanges: 0, totalChanges: 1 } },
    })

    const onClose = vi.fn()
    renderDialog(onClose)

    const applyButton = await screen.findByRole('button', { name: 'Apply Template' })
    expect(applyButton).toBeEnabled()
    expect(onClose).not.toHaveBeenCalled()

    act(() => { emitActiveServerChanged() })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
  })
})
