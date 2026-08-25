import { describe, expect, it, vi, beforeEach } from 'vitest';

// Regression, confirmed empirically on a real Windows host (2026-08-23):
// Get-CimInstance Win32_Process | Where-Object { <no match> } | ... |
// ConvertTo-Csv -NoTypeInformation emits NOTHING at all when its input
// pipeline is empty -- not a header row, not a blank line, the literal
// empty string -- because ConvertTo-Csv derives its header from the first
// object it receives. node's exec() then reports psError: null (the
// command ran and exited 0) with psStdout: "". The scan's condition was
// `if (psError || !psStdout)`, which cannot tell "the command genuinely
// failed" apart from "the command ran fine and correctly found zero
// processes" -- both look like an empty psStdout with no error either way
// only in the FAILURE case; here it's an empty stdout with NO error, which
// the old code treated identically to a failure anyway. The practical
// effect: on Windows, a genuinely STOPPED server (zero matching processes,
// which is the expected, correct, successful result) was indistinguishable
// from a broken scan, and every fail-closed guard (`/wipe` included)
// refused forever -- deterministically, on every restart, for every
// Windows install, the moment those guards started respecting scanFailed
// in 1.2.0. This is what a real user (reported via Discord, forwarded by
// the operator) hit.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => execFileMock(...args) };
});

const { ServerManager } = await import('../services/serverManager.js');

describe('ServerManager Windows scan: empty match set vs a genuine exec failure', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it.runIf(process.platform === 'win32')(
    'reports a confirmed stop (scanFailed: false), not scanFailed, when PowerShell runs successfully and finds nothing',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        // The real, confirmed shape: no error, exit 0, empty stdout --
        // ConvertTo-Csv on an empty pipeline.
        callback(null, '', '');
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBeFalsy();
      expect(result.running).toBe(false);
      expect(result.matched).toEqual([]);
      expect(execFileMock).toHaveBeenCalledWith(
        expect.stringMatching(/powershell\.exe$/i),
        expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']),
        { timeout: 8000 },
        expect.any(Function),
      );
    },
  );

  it.runIf(process.platform === 'win32')(
    'still reports scanFailed when the shell-out genuinely errors',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(new Error('powershell.exe is not recognized'), '', 'not recognized');
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'fails closed when PowerShell reports diagnostics despite a zero exit code',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(null, '', 'Get-CimInstance : Access is denied');
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBe(true);
    },
  );

  it.runIf(process.platform === 'win32')(
    'still reports scanFailed on empty output when psError is set (belt and suspenders)',
    async () => {
      // A command that both errors AND happens to produce no stdout --
      // must not accidentally read as a confirmed stop just because
      // stdout is empty.
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(new Error('timed out'), '', '');
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(result.scanFailed).toBe(true);
    },
  );
});
