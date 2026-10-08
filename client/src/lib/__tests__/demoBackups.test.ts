import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getDemoBackupList, getDemoBackupStatus, installDemoFetchShim } from '../demo'
import type { BackupStatus, CapabilityGroup, ManagedUserAccount, RoleInfo, ServerBackupArchive } from '../api'

// The public demo has no backend: its catch-all reply to GET /backup/status
// had no schedule, and the Backups page crashed on it. Settings > Users and
// Roles & Permissions crashed the same way on their lists.
describe('demo World Backups', () => {
  it('is a complete backup status: a preset schedule, and the latest of its backups', () => {
    const status: BackupStatus = getDemoBackupStatus()
    const { backups }: { backups: ServerBackupArchive[] } = getDemoBackupList()
    expect(status).toMatchObject({ enabled: true, schedule: '0 */6 * * *', maxBackups: 10, savesExists: true })
    expect(status.backupCount).toBe(backups.length)
    expect(status.lastBackup).toEqual(backups[0])
    // Newest first, as backupService.listBackups() sorts them.
    const created = backups.map((backup) => backup.created)
    expect(created).toEqual([...created].sort().reverse())
    // The next run is on the schedule, and still to come.
    expect(status.backupNextRun).toMatch(/T(00|06|12|18):00:00\.000Z$/)
    expect(Date.parse(status.backupNextRun!)).toBeGreaterThan(Date.now())
  })
})

describe('demo fetch shim', () => {
  const originalFetch = window.fetch

  beforeAll(() => {
    vi.stubEnv('VITE_DEMO_MODE', 'true')
    installDemoFetchShim()
  })
  afterAll(() => {
    window.fetch = originalFetch
    vi.unstubAllEnvs()
  })

  const get = async (path: string) => (await window.fetch(path)).json()
  const post = async (path: string, body: unknown) =>
    (await window.fetch(path, { method: 'POST', body: JSON.stringify(body) })).json()

  it('serves the backup status, list and history the Backups page reads', async () => {
    expect(await get('/api/backup/status')).toMatchObject({ schedule: '0 */6 * * *', backupCount: 5 })
    expect((await get('/api/backup/list')).backups).toHaveLength(5)
    expect((await get('/api/backup/history?serverId=demo-server')).records).toHaveLength(5)
  })

  it('previews a schedule like the server does, and refuses one that is not a cron', async () => {
    expect(await post('/api/backup/validate-schedule', { schedule: '30 3 * * *' })).toMatchObject({
      valid: true,
      timezone: 'UTC',
      nextRun: expect.stringMatching(/T03:30:00\.000Z$/),
    })
    expect(await post('/api/backup/validate-schedule', { schedule: 'every day' })).toMatchObject({
      valid: false,
      code: 'SCHEDULER_INVALID_CRON_EXPRESSION',
    })
  })

  it("serves a backup's snapshot without passwords", async () => {
    const { backups } = getDemoBackupList()
    const reply = await get(`/api/backup/${encodeURIComponent(backups[0].name)}/snapshot`)
    expect(reply.snapshot.serverIni).toMatchObject({ PublicName: 'Demo Server' })
    expect(Object.keys(reply.snapshot.serverIni).filter((key) => /password/i.test(key))).toEqual([])
  })

  it('serves accounts, the seeded roles and the capability catalogue', async () => {
    const { users }: { users: ManagedUserAccount[] } = await get('/api/auth/users')
    const { roles }: { roles: RoleInfo[] } = await get('/api/permissions/roles')
    const { groups }: { groups: CapabilityGroup[] } = await get('/api/permissions/capabilities')
    expect(roles.map((role) => role.id)).toEqual(['role-admin', 'role-technician', 'role-moderator'])
    // Every account holds one of them, and the member counts add up.
    expect(users.every((user) => roles.some((role) => role.id === user.roleId))).toBe(true)
    expect(roles.reduce((sum, role) => sum + role.memberCount, 0)).toBe(users.length)
    // admin holds the whole catalogue; no role holds a capability outside it.
    const catalogue = groups.flatMap((group) => group.capabilities.map((capability) => capability.key))
    expect(roles[0].capabilities).toEqual(catalogue)
    expect(roles.flatMap((role) => role.capabilities).every((key) => catalogue.includes(key))).toBe(true)
  })
})
