import { describe, expect, it } from 'vitest'
import type { ListResponse, ProfileResponse, ProfilesResponse, TextResponse } from '@/types/files'
import { getDemoFilesResponse } from '../demo'

// The GitHub Pages demo (spec §A14.6): one local profile, its Zomboid
// folder's top level, the Server folder and one .ini, and every change
// refused the way the real server refuses a protected path.

function call(path: string, method = 'GET') {
  return getDemoFilesResponse(new URL(`https://demo.example/api/files${path}`), method)
}

describe('demo Server Files fixtures', () => {
  it('lists one active local profile, and its detail carries a server state', async () => {
    const list = (await call('/profiles').json()) as ProfilesResponse
    expect(list.profiles).toHaveLength(1)
    expect(list.profiles[0]).toMatchObject({ id: 'demo-server', isActive: true, remote: null })
    expect(list.profiles[0].serverState).toBeUndefined()

    const detail = (await call('/profiles/demo-server').json()) as ProfileResponse
    expect(detail.profile.serverState).toBe('stopped')
    expect(detail.profile.roots.map((root) => root.id)).toEqual(['install', 'data'])
  })

  it('lists the Zomboid folder and its Server folder', async () => {
    const top = (await call('/profiles/demo-server/list?root=data&path=').json()) as ListResponse
    expect(top.entries.map((entry) => entry.name)).toContain('Server')
    expect(top.entries.find((entry) => entry.name === 'backups')?.protection).toEqual({ level: 'listOnly', area: 'panelBackups' })

    const server = (await call('/profiles/demo-server/list?root=data&path=Server').json()) as ListResponse
    expect(server.entries.map((entry) => entry.path)).toContain('Server/DoomerZDemo.ini')
    expect(server.total).toBe(server.entries.length)
  })

  it('serves the .ini with its passwords masked', async () => {
    const text = (await call('/profiles/demo-server/text?root=data&path=Server%2FDoomerZDemo.ini&mode=edit').json()) as TextResponse
    expect(text.masked).toBe(true)
    expect(text.content).toContain('RCONPassword=•••')
    expect(text.hints).toContain('secretsMasked')
  })

  it('refuses every change with FM_PATH_PROTECTED', async () => {
    for (const [path, method] of [['/profiles/demo-server/mkdir', 'POST'], ['/profiles/demo-server/text', 'PUT'], ['/profiles/demo-server/delete/preview', 'POST']]) {
      const response = call(path, method)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'FM_PATH_PROTECTED' })
    }
  })

  it('answers an unknown file with FM_NOT_FOUND', async () => {
    const response = call('/profiles/demo-server/stat?root=data&path=nope.txt')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'FM_NOT_FOUND' })
  })
})
