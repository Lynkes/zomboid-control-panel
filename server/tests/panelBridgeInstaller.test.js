import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  canAutoInstall,
  checkBridgeInstalled,
  installBridge,
  resolveSourcePath,
} from '../services/panelBridgeInstaller.js';

// These tests exercise the real pz-mod/PanelBridge/media/lua/server/PanelBridge.lua
// source shipped with the repo (never modified — only ever copied) against a
// throwaway server install directory under the OS temp dir.
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelbridge-installer-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const localServer = () => ({ id: 's1', installPath: tmpDir, isRemote: false });

describe('canAutoInstall', () => {
  it('is true for a local server with a writable install path', () => {
    expect(canAutoInstall(localServer())).toBe(true);
  });

  it('is false for a remote/SFTP server', () => {
    expect(canAutoInstall({ ...localServer(), isRemote: true })).toBe(false);
  });

  it('is false when installPath is missing', () => {
    expect(canAutoInstall({ id: 's1', isRemote: false })).toBe(false);
  });

  it('is false when installPath points to a regular file', () => {
    const filePath = path.join(tmpDir, 'server-install.txt');
    fs.writeFileSync(filePath, 'not a directory');
    expect(canAutoInstall({ installPath: filePath, isRemote: false })).toBe(false);
  });

  it('is false when installPath does not exist on disk', () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    expect(canAutoInstall({ installPath: missing, isRemote: false })).toBe(false);
  });

  it('resolves a launch-script installPath (.sh) to its parent directory', () => {
    const scriptPath = path.join(tmpDir, 'start-server.sh');
    expect(canAutoInstall({ installPath: scriptPath, isRemote: false })).toBe(true);
  });

  it('is false when the install directory is not writable', () => {
    if (process.platform === 'win32') return; // chmod does not enforce POSIX mode bits
    if (process.getuid && process.getuid() === 0) return; // root bypasses permission bits
    fs.chmodSync(tmpDir, 0o555);
    try {
      expect(canAutoInstall(localServer())).toBe(false);
    } finally {
      fs.chmodSync(tmpDir, 0o755);
    }
  });
});

describe('checkBridgeInstalled', () => {
  it('reports not installed when the mod file is absent', () => {
    const status = checkBridgeInstalled(localServer());
    expect(status.installed).toBe(false);
    expect(status.needsUpdate).toBe(false);
    expect(status.sourcePath).toBe(resolveSourcePath());
    expect(status.targetPath).toBe(
      path.join(tmpDir, 'media', 'lua', 'server', 'PanelBridge.lua'),
    );
  });

  it('reports installed with no update needed once freshly installed', () => {
    installBridge(localServer());
    const status = checkBridgeInstalled(localServer());
    expect(status.installed).toBe(true);
    expect(status.needsUpdate).toBe(false);
    expect(status.version).toBeTruthy();
  });

  it('flags an update when the installed version is older than the source', () => {
    const targetDir = path.join(tmpDir, 'media', 'lua', 'server');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'PanelBridge.lua'),
      'local VERSION = "0.0.1"\n',
    );

    const status = checkBridgeInstalled(localServer());
    expect(status.installed).toBe(true);
    expect(status.needsUpdate).toBe(true);
  });

  it('flags an update when the installed version cannot be read', () => {
    const targetDir = path.join(tmpDir, 'media', 'lua', 'server');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'PanelBridge.lua'), 'invalid lua');

    const status = checkBridgeInstalled(localServer());
    expect(status.installed).toBe(true);
    expect(status.needsUpdate).toBe(true);
  });
});

describe('installBridge', () => {
  it('copies the mod file to the target path unchanged', () => {
    const sourceContent = fs.readFileSync(resolveSourcePath(), 'utf8');
    const result = installBridge(localServer());

    expect(result.success).toBe(true);
    expect(fs.existsSync(result.targetPath)).toBe(true);
    expect(fs.readFileSync(result.targetPath, 'utf8')).toBe(sourceContent);
    expect(result.version).toBeTruthy();
  });

  it('creates the media/lua/server directory tree if missing', () => {
    const target = path.join(tmpDir, 'media', 'lua', 'server', 'PanelBridge.lua');
    expect(fs.existsSync(target)).toBe(false);
    installBridge(localServer());
    expect(fs.existsSync(target)).toBe(true);
  });

  it('fails cleanly when the install path is not configured', () => {
    const result = installBridge({ id: 's1', isRemote: false });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/install path/i);
  });

  it('fails cleanly instead of throwing when the target cannot be created', () => {
    // Make "media" a plain file so mkdirSync('media/lua/server') fails with ENOTDIR.
    fs.writeFileSync(path.join(tmpDir, 'media'), 'not a directory');
    const result = installBridge(localServer());
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('does not downgrade a newer installed bridge', () => {
    const targetDir = path.join(tmpDir, 'media', 'lua', 'server');
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, 'PanelBridge.lua');
    fs.writeFileSync(targetPath, 'local VERSION = "99.0.0"\n');

    const result = installBridge(localServer());

    expect(result.success).toBe(true);
    expect(result.updated).toBe(false);
    expect(fs.readFileSync(targetPath, 'utf8')).toContain('99.0.0');
  });
});
