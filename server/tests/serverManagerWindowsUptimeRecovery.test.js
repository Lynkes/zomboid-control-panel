import { describe, expect, it, vi, beforeEach } from 'vitest';

// continuous-bug-hunt round 20 (performance and status numbers the panel
// shows wrong): getServerStatus()'s own `isRunning && !this.startTime`
// recovery branch exists specifically so a PANEL restart (this.startTime is
// an in-memory field, wiped by construction whenever the Node process
// restarts) doesn't lose a REAL, still-running game server's uptime -- it
// asks the OS for the process's actual start time and backdates
// this.startTime to match. getProcessUptimeSeconds(pid) is the one function
// that answers "how long has this pid actually been running" -- before this
// fix it unconditionally returned null on Windows (`if (isWindows || ...)
// return null;`), so the whole recovery branch was silently a no-op there:
// on a platform this codebase otherwise treats as fully first-class (its
// own PowerShell/Win32_Process process scan sits right above this function),
// every panel restart while the game server kept running showed uptime
// reset to 0 -- indistinguishable from the server having just started.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => execFileMock(...args) };
});

const { ServerManager } = await import('../services/serverManager.js');

describe('ServerManager.getProcessUptimeSeconds on Windows', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it.runIf(process.platform === 'win32')(
    'returns the real elapsed seconds from Win32_Process.CreationDate, not null',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        // [math]::Floor(...) in the real script always yields a plain
        // integer string on stdout -- no decimal point, no thousands
        // separator to misparse.
        callback(null, '54321\r\n', '');
      });

      const manager = new ServerManager();
      const seconds = await manager.getProcessUptimeSeconds('9999');

      expect(seconds).toBe(54321);
      expect(execFileMock).toHaveBeenCalledWith(
        expect.stringMatching(/powershell\.exe$/i),
        expect.arrayContaining([
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          expect.stringContaining('ProcessId=9999'),
        ]),
        expect.objectContaining({ timeout: expect.any(Number) }),
        expect.any(Function),
      );
    },
  );

  it.runIf(process.platform === 'win32')(
    'resolves null (never throws) when the shell-out fails -- e.g. the pid no longer exists',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(new Error('Cannot bind argument'), '', 'error');
      });

      const manager = new ServerManager();
      const seconds = await manager.getProcessUptimeSeconds('9999');

      expect(seconds).toBeNull();
    },
  );

  it.runIf(process.platform === 'win32')(
    'resolves null on unparseable output instead of NaN',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(null, '', '');
      });

      const manager = new ServerManager();
      const seconds = await manager.getProcessUptimeSeconds('9999');

      expect(seconds).toBeNull();
    },
  );

  it('rejects a non-numeric pid outright, on every platform, without shelling out at all', async () => {
    const manager = new ServerManager();
    const seconds = await manager.getProcessUptimeSeconds('not-a-pid; rm -rf /');

    expect(seconds).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
