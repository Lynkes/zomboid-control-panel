import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSftpErrorGuidance, PanelBridgeSftpTransport, validateSftpBridgeConfig } from '../services/panelBridgeSftp.js';

const valid = {
  host: 'pz.example.net',
  port: 22,
  username: 'panelbridge',
  password: 'not-a-real-secret',
  bridgePath: '/home/pz/Zomboid/Lua/panelbridge/TestServer',
  pollIntervalSeconds: 3,
};

const temporaryDirectories = [];

afterEach(() => {
  for (const temporaryDirectory of temporaryDirectories.splice(0)) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

describe('PanelBridge SFTP configuration', () => {
  it('accepts a constrained bridge configuration', () => {
    expect(validateSftpBridgeConfig(valid)).toMatchObject({
      host: 'pz.example.net',
      port: 22,
      pollIntervalSeconds: 3,
    });
  });

  it.each([1, 11])('rejects poll interval %s outside 2-10 seconds', (pollIntervalSeconds) => {
    expect(() => validateSftpBridgeConfig({ ...valid, pollIntervalSeconds })).toThrow('between 2 and 10 seconds');
  });

  it('rejects remote path traversal', () => {
    expect(() => validateSftpBridgeConfig({ ...valid, bridgePath: '/home/pz/../etc' })).toThrow('without traversal');
  });

  it('rejects the filesystem root as a bridge folder', () => {
    expect(() => validateSftpBridgeConfig({ ...valid, bridgePath: '/' })).toThrow('not the filesystem root');
  });

  it('rejects control characters in a remote bridge path', () => {
    expect(() => validateSftpBridgeConfig({ ...valid, bridgePath: '/home/pz\nbridge' })).toThrow('absolute POSIX path');
  });

  it('provides a credential fix for SSH public-key authentication errors', () => {
    expect(getSftpErrorGuidance(new Error('Permission denied (publickey).'))).toMatch(/username and password/i);
  });

  it('explains chroot paths when mkdir is denied under home', () => {
    expect(getSftpErrorGuidance(new Error('mkdir: _doMkdir: Permission denied /Home'))).toMatch(/remove the \/home prefix/i);
  });

  it('keeps chroot guidance when the transport classifies the path failure', () => {
    expect(getSftpErrorGuidance(new Error('SFTP account rejected remote bridge path /home/server-data; likely chrooted account path'))).toMatch(/remove the \/home prefix/i);
  });

  it('explains how to repair a non-regular bridge file path', () => {
    expect(getSftpErrorGuidance(new Error('Expected a regular file, but found a non-regular entry'))).toMatch(/remove or rename/i);
  });
});

describe('PanelBridge SFTP sync', () => {
  it('creates the remote bridge, inbox, and outbox folders before syncing', async () => {
    const transport = new PanelBridgeSftpTransport();
    const mkdir = vi.fn();
    transport.config = validateSftpBridgeConfig(valid);
    transport.client = { mkdir };

    await transport.ensureRemoteDirectories();

    expect(mkdir).toHaveBeenNthCalledWith(1, valid.bridgePath, true);
    expect(mkdir).toHaveBeenNthCalledWith(2, `${valid.bridgePath}/inbox`, true);
    expect(mkdir).toHaveBeenNthCalledWith(3, `${valid.bridgePath}/outbox`, true);
  });

  it('classifies permission errors under /home as a chroot path problem', async () => {
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.client = { mkdir: vi.fn(async () => { throw new Error('Permission denied /home'); }) };

    await expect(transport.ensureRemoteDirectories()).rejects.toThrow(/chrooted account path/);
  });

  it('exposes bounded diagnostics without retaining the SFTP password', () => {
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);

    for (let index = 0; index < 21; index += 1) {
      transport.recordError('sync', new Error(`failure-${index}`));
    }

    const status = transport.getStatus();
    expect(status.remotePath).toBe(valid.bridgePath);
    expect(status.diagnostics.failureCount).toBe(21);
    expect(status.diagnostics.recentErrors).toHaveLength(20);
    expect(status.diagnostics.recentErrors[0].message).toBe('failure-1');
    expect(JSON.stringify(status)).not.toContain(valid.password);
  });

  it('uploads queued commands before downloading remote Bridge files', async () => {
    const transport = new PanelBridgeSftpTransport();
    const order = [];
    transport.running = true;
    transport.ensureRemoteDirectories = vi.fn(async () => order.push('directories'));
    transport.uploadInbox = vi.fn(async () => order.push('upload'));
    transport.syncModFile = vi.fn(async (name) => order.push(name));
    transport.syncOutbox = vi.fn(async () => order.push('outbox'));

    await transport.syncNow();

    expect(order).toEqual(['directories', 'upload', 'status.json', 'queue-state-lua.json', 'outbox']);
  });

  it('uploads commands to a temporary remote name before publishing them', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-sftp-test-'));
    temporaryDirectories.push(temporaryDirectory);
    const inboxDirectory = path.join(temporaryDirectory, 'inbox');
    fs.mkdirSync(inboxDirectory);
    fs.writeFileSync(path.join(inboxDirectory, 'cmd-0000000001.json'), '{"action":"ping"}');

    const fastPut = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = temporaryDirectory;
    transport.transferId = 'test-transfer';
    transport.client = { exists: vi.fn(async () => false), fastPut, rename, delete: vi.fn(async () => {}) };

    await transport.uploadInbox();

    const remotePath = `${valid.bridgePath}/inbox/cmd-0000000001.json`;
    expect(fastPut).toHaveBeenCalledWith(
      path.join(inboxDirectory, 'cmd-0000000001.json'),
      `${remotePath}.test-transfer.uploading`,
    );
    expect(rename).toHaveBeenCalledWith(`${remotePath}.test-transfer.uploading`, remotePath);
  });

  it('removes a partial remote command when an upload fails', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-sftp-test-'));
    temporaryDirectories.push(temporaryDirectory);
    const inboxDirectory = path.join(temporaryDirectory, 'inbox');
    fs.mkdirSync(inboxDirectory);
    fs.writeFileSync(path.join(inboxDirectory, 'cmd-0000000001.json'), '{"action":"ping"}');

    const deleteRemote = vi.fn(async () => {});
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = temporaryDirectory;
    transport.transferId = 'failed-transfer';
    transport.client = {
      exists: vi.fn(async () => false),
      fastPut: vi.fn(async () => { throw new Error('Connection reset'); }),
      rename: vi.fn(async () => {}),
      delete: deleteRemote,
    };

    await expect(transport.uploadInbox()).rejects.toThrow('Connection reset');
    expect(deleteRemote).toHaveBeenCalledWith(
      `${valid.bridgePath}/inbox/cmd-0000000001.json.failed-transfer.uploading`,
    );
  });

  it('refuses to treat a remote directory as an already uploaded command', async () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-sftp-test-'));
    temporaryDirectories.push(temporaryDirectory);
    const inboxDirectory = path.join(temporaryDirectory, 'inbox');
    fs.mkdirSync(inboxDirectory);
    fs.writeFileSync(path.join(inboxDirectory, 'cmd-0000000001.json'), '{"action":"ping"}');

    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = temporaryDirectory;
    transport.client = { exists: vi.fn(async () => 'd') };

    await expect(transport.uploadInbox()).rejects.toThrow('occupied by a directory');
  });

  it('refuses symlinks and oversized remote bridge files', async () => {
    const transport = new PanelBridgeSftpTransport();
    transport.config = validateSftpBridgeConfig(valid);
    transport.cachePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pz-sftp-test-'));
    temporaryDirectories.push(transport.cachePath);
    const fastGet = vi.fn();
    transport.client = { exists: vi.fn(async () => 'l'), stat: vi.fn(), fastGet };

    await expect(transport.copyRemote('status.json.txt')).rejects.toThrow('non-regular entry');
    expect(fastGet).not.toHaveBeenCalled();

    transport.client = {
      exists: vi.fn(async () => '-'),
      stat: vi.fn(async () => ({ size: 16 * 1024 * 1024 + 1 })),
      fastGet,
    };
    await expect(transport.copyRemote('status.json.txt')).rejects.toThrow('download limit');
    expect(fastGet).not.toHaveBeenCalled();
  });
});
