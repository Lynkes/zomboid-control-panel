import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import i18n from '@/i18n'
import { BackupRestartOverlapNotice } from '../BackupRestartOverlapNotice'
import type { BackupRestartOverlap } from '@/lib/api'

// The notice's advice ("schedule backups at least N min after a restart")
// comes with an example, and the example has to obey it. N is the restart
// countdown (RESTART_WARNING_MINUTES, which the operator can raise) plus a
// typical tail, so a fixed ":30" would contradict a 35-minute window --
// review finding on the 2026-09-27 restart-collision fix.
const ISOLATE_START = '\u2066'
const ISOLATE_END = '\u2069'

const overlap = (windowMinutes: number, kind: BackupRestartOverlap['kind'] = 'task'): BackupRestartOverlap => ({
  kind, name: kind === 'task' ? 'Restart every 4h' : null, cron: kind === 'task' ? '0 */4 * * *' : null,
  restartTime: '00:00', backupTime: '00:00', allBackups: true, windowMinutes,
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('BackupRestartOverlapNotice: the example fits the window it illustrates', () => {
  it('the default 10-minute window: back up at :30', () => {
    render(<BackupRestartOverlapNotice overlaps={[overlap(10)]} />)
    expect(screen.getByText(
      "Those backups wait for the restart to finish, so they run up to about 10 min late. To keep them on time, schedule backups at least 10 min after a restart's scheduled time (for example, with restarts on the hour, back up at :30).",
    )).toBeInTheDocument()
  })

  it('a 35-minute window (RESTART_WARNING_MINUTES=30): :45, never a :30 that breaks the rule', () => {
    render(<BackupRestartOverlapNotice overlaps={[overlap(35)]} />)
    expect(screen.getByText(/at least 35 min after .* back up at :45\)\.$/)).toBeInTheDocument()
    expect(screen.queryByText(/:30/)).not.toBeInTheDocument()
  })

  it('a window with no tidy minute left in the hour: the rule alone, no example', () => {
    render(<BackupRestartOverlapNotice overlaps={[overlap(65, 'autoRestart')]} />)
    expect(screen.getByText(
      "Those backups wait for the restart to finish, so they run up to about 65 min late. To keep them on time, schedule backups at least 65 min after a restart's scheduled time.",
    )).toBeInTheDocument()
  })

  it('keeps ":30" in order inside an Arabic (RTL) sentence -- isolated, like the cron values', async () => {
    await i18n.changeLanguage('ar')
    const { container } = render(<BackupRestartOverlapNotice overlaps={[overlap(10)]} />)
    expect(container.textContent).toContain(`${ISOLATE_START}:30${ISOLATE_END}`)
  })

  it('as the settings panel preview: a polite status region, marked busy while stale', () => {
    const { rerender } = render(<BackupRestartOverlapNotice overlaps={[overlap(10)]} live />)
    const region = screen.getByRole('status')
    expect(region).not.toHaveAttribute('aria-busy')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    rerender(<BackupRestartOverlapNotice overlaps={[overlap(10)]} live stale />)
    expect(screen.getByRole('status')).toBe(region)
    expect(region).toHaveAttribute('aria-busy', 'true')
  })
})
