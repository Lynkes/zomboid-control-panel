import { describe, it, expect } from 'vitest'
import { changesLaunchTarget, isLauncherPath, launchIsOperatorDefined } from '../launchTarget'

// RCE-STARTCMD (security sweep 2026-10-04): client mirror of
// server/routes/servers.js's changesLaunchTarget() -- used only to disable
// the start-command / install-path controls (and show why) for a role
// without files.manage, so the operator sees the reason instead of a late
// refusal. The server remains the authoritative gate; these assertions pin
// the mirror to the same decisions the server makes.
describe('launchTarget mirror', () => {
  it('isLauncherPath recognizes .bat/.sh/.exe, case-insensitively', () => {
    expect(isLauncherPath('C:\\pz\\run.bat')).toBe(true)
    expect(isLauncherPath('/opt/pz/run.SH')).toBe(true)
    expect(isLauncherPath('C:\\pz\\launch.Exe')).toBe(true)
    expect(isLauncherPath('/opt/pz')).toBe(false)
    expect(isLauncherPath(null)).toBe(false)
  })

  it('launchIsOperatorDefined is true for a start command or launcher path', () => {
    expect(launchIsOperatorDefined({ startCommand: './run.sh' })).toBe(true)
    expect(launchIsOperatorDefined({ installPath: '/opt/pz/run.sh' })).toBe(true)
    expect(launchIsOperatorDefined({ serverPath: 'C:\\pz\\run.bat' })).toBe(true)
    expect(launchIsOperatorDefined({ installPath: '/opt/pz' })).toBe(false)
    expect(launchIsOperatorDefined({})).toBe(false)
  })

  it('flags a startCommand change', () => {
    expect(
      changesLaunchTarget({ startCommand: '' }, { startCommand: '/bin/sh -c x' }),
    ).toBe(true)
    // Unchanged value is not a change.
    expect(
      changesLaunchTarget({ startCommand: './run.sh' }, { startCommand: './run.sh' }),
    ).toBe(false)
  })

  it('flags pointing installPath at a launcher script', () => {
    expect(
      changesLaunchTarget({ installPath: '/opt/pz' }, { installPath: '/opt/pz/evil.sh' }),
    ).toBe(true)
  })

  it('flags changing the install path of a server that already has a start command', () => {
    expect(
      changesLaunchTarget(
        { installPath: '/opt/pz', startCommand: './run.sh' },
        { installPath: '/opt/pz2' },
      ),
    ).toBe(true)
  })

  it('does not flag an ordinary directory install-path change on a managed server', () => {
    expect(
      changesLaunchTarget({ installPath: '/opt/pz' }, { installPath: '/opt/pz2' }),
    ).toBe(false)
  })

  it('does not flag an unrelated field edit (no launch key present)', () => {
    expect(changesLaunchTarget({ installPath: '/opt/pz' }, { serverPort: 16271 } as never)).toBe(
      false,
    )
  })
})
