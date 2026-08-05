import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import SftpClient from 'ssh2-sftp-client';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Bridge:SFTP');

function safeRemotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('..') || value.includes('\\')) {
    throw new Error('Remote bridge path must be an absolute POSIX path without traversal');
  }
  return value.replace(/\/+$/, '') || '/';
}

export function validateSftpBridgeConfig(config) {
  const host = typeof config?.host === 'string' ? config.host.trim() : '';
  const username = typeof config?.username === 'string' ? config.username.trim() : '';
  const port = Number(config?.port || 22);
  const pollIntervalSeconds = Number(config?.pollIntervalSeconds || 3);
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) throw new Error('A valid SFTP host is required');
  if (!username || username.length > 128 || /[\r\n]/.test(username)) throw new Error('A valid SFTP username is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SFTP port must be between 1 and 65535');
  if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 2 || pollIntervalSeconds > 10) {
    throw new Error('SFTP sync interval must be between 2 and 10 seconds');
  }
  return {
    host,
    port,
    username,
    password: typeof config?.password === 'string' ? config.password : '',
    bridgePath: safeRemotePath(config?.bridgePath),
    pollIntervalSeconds,
  };
}

export function getSftpCachePath(config) {
  const key = crypto.createHash('sha256').update(`${config.host}:${config.port}:${config.username}:${config.bridgePath}`).digest('hex').slice(0, 24);
  return path.join(process.cwd(), 'data', 'panelbridge-sftp-cache', key);
}

// ─── Read-only remote log access ────────────────────────────────────────────
// Separate from the bridge sync loop on purpose: this never writes to the
// remote host and never mirrors whole files to disk. Callers get a directory
// listing or a size-capped tail, fetched on demand, so a multi-GB console log
// on a remote host can be inspected without downloading it.
const LOG_TAIL_MAX_BYTES = 1024 * 1024;
const LOG_TAIL_DEFAULT_BYTES = 256 * 1024;
const LOG_LIST_MAX = 200;
const LOG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOG_EXTENSIONS = ['.txt', '.log'];

export function validateSftpLogConfig(config) {
  const host = typeof config?.host === 'string' ? config.host.trim() : '';
  const username = typeof config?.username === 'string' ? config.username.trim() : '';
  const port = Number(config?.port || 22);
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) throw new Error('A valid SFTP host is required');
  if (!username || username.length > 128 || /[\r\n]/.test(username)) throw new Error('A valid SFTP username is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SFTP port must be between 1 and 65535');
  if (!config?.logPath) throw new Error('A remote log folder is required');
  return {
    host,
    port,
    username,
    password: typeof config?.password === 'string' ? config.password : '',
    logPath: safeRemotePath(config.logPath),
  };
}

async function withLogClient(config, handler) {
  const client = new SftpClient('PanelBridgeSftpLogs');
  try {
    await client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: 10000,
    });
    return await handler(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function listSftpLogs(rawConfig) {
  const config = validateSftpLogConfig(rawConfig);
  return withLogClient(config, async (client) => {
    const entries = await client.list(config.logPath);
    const files = entries
      .filter((entry) => entry.type === '-')
      .filter((entry) => LOG_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext)))
      .map((entry) => ({
        name: entry.name,
        size: entry.size,
        modifiedAt: entry.modifyTime ? new Date(entry.modifyTime).toISOString() : null,
      }))
      .sort((a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || ''))
      .slice(0, LOG_LIST_MAX);
    return { logPath: config.logPath, files };
  });
}

export async function readSftpLogTail(rawConfig, fileName, requestedBytes) {
  const config = validateSftpLogConfig(rawConfig);
  if (typeof fileName !== 'string' || !LOG_NAME_PATTERN.test(fileName)) {
    throw new Error('Invalid log file name');
  }
  if (!LOG_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext))) {
    throw new Error('Only .txt and .log files can be read');
  }
  const maxBytes = Math.min(
    Math.max(Number(requestedBytes) || LOG_TAIL_DEFAULT_BYTES, 1024),
    LOG_TAIL_MAX_BYTES,
  );
  const remotePath = `${config.logPath}/${fileName}`;
  return withLogClient(config, async (client) => {
    const stats = await client.stat(remotePath);
    const size = Number(stats?.size) || 0;
    const start = Math.max(0, size - maxBytes);
    const buffer = size === 0
      ? Buffer.alloc(0)
      : await client.get(remotePath, undefined, {
          readStreamOptions: { start, end: Math.max(start, size - 1) },
        });
    const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
    return {
      name: fileName,
      size,
      truncated: start > 0,
      bytesReturned: Buffer.byteLength(text),
      content: text,
    };
  });
}

export class PanelBridgeSftpTransport {
  constructor() {
    this.config = null;
    this.cachePath = null;
    this.client = null;
    this.timer = null;
    this.running = false;
    this.syncing = false;
    this.lastSyncAt = null;
    this.lastError = null;
    this.lastLatencyMs = null;
  }

  async start(config, cachePath) {
    this.config = validateSftpBridgeConfig(config);
    this.cachePath = cachePath;
    fs.mkdirSync(path.join(cachePath, 'inbox'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(cachePath, 'outbox'), { recursive: true, mode: 0o700 });
    this.running = true;
    await this.syncNow(true);
    this.timer = setInterval(() => this.syncNow().catch(() => {}), this.config.pollIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.client) await this.client.end().catch(() => {});
    this.client = null;
  }

  async connect() {
    if (this.client) return this.client;
    const client = new SftpClient('PanelBridgeSftp');
    await client.connect({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      readyTimeout: 10000,
    });
    this.client = client;
    return client;
  }

  remote(relativeName) {
    if (!relativeName || relativeName.includes('..') || relativeName.includes('\\')) throw new Error('Invalid remote bridge file path');
    return `${this.config.bridgePath}/${relativeName}`;
  }

  async copyRemote(relativeName) {
    const client = await this.connect();
    const remotePath = this.remote(relativeName);
    const exists = await client.exists(remotePath);
    if (!exists) return false;
    const localPath = path.join(this.cachePath, relativeName);
    fs.mkdirSync(path.dirname(localPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${localPath}.download`;
    await client.fastGet(remotePath, temporaryPath);
    fs.renameSync(temporaryPath, localPath);
    return true;
  }

  async syncModFile(baseName) {
    const suffixed = `${baseName}.txt`;
    if (await this.copyRemote(suffixed)) return suffixed;
    await this.copyRemote(baseName);
    return baseName;
  }

  async syncOutbox() {
    const statePath = path.join(this.cachePath, '.queue-state-node.json');
    let nextSequence = 1;
    try {
      nextSequence = Math.max(1, Number(JSON.parse(fs.readFileSync(statePath, 'utf8')).lastConsumedResultSeq || 0) + 1);
    } catch (_) { /* cache is not initialized yet */ }
    for (let offset = 0; offset < 100; offset++) {
      const sequence = String(nextSequence + offset).padStart(10, '0');
      const jsonName = `outbox/res-${sequence}.json`;
      const txtName = `${jsonName}.txt`;
      const copied = await this.copyRemote(txtName) || await this.copyRemote(jsonName);
      if (!copied) break;
    }
  }

  async uploadInbox() {
    const inbox = path.join(this.cachePath, 'inbox');
    const names = fs.readdirSync(inbox).filter((name) => /^cmd-\d+\.json$/.test(name)).sort();
    for (const name of names) {
      const remotePath = this.remote(`inbox/${name}`);
      const client = await this.connect();
      if (await client.exists(remotePath)) continue;
      await client.fastPut(path.join(inbox, name), remotePath);
    }
  }

  async syncNow(throwOnError = false) {
    if (!this.running || this.syncing) return;
    this.syncing = true;
    const startedAt = Date.now();
    try {
      // Upload first so a newly queued command never waits behind remote
      // reads. Results are collected in the same pass after the Lua mod ticks.
      await this.uploadInbox();
      await this.syncModFile('status.json');
      await this.syncModFile('queue-state-lua.json');
      await this.syncOutbox();
      this.lastSyncAt = Date.now();
      this.lastLatencyMs = this.lastSyncAt - startedAt;
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      if (this.client) await this.client.end().catch(() => {});
      this.client = null;
      log.debug(`Sync failed: ${error.message}`);
      if (throwOnError) throw error;
    } finally {
      this.syncing = false;
    }
  }

  getStatus() {
    return {
      type: 'sftp',
      running: this.running,
      cachePath: this.cachePath,
      lastSyncAt: this.lastSyncAt,
      lastLatencyMs: this.lastLatencyMs,
      lastError: this.lastError,
      pollIntervalSeconds: this.config?.pollIntervalSeconds ?? null,
    };
  }
}

export async function testSftpBridge(config) {
  const validated = validateSftpBridgeConfig(config);
  const client = new SftpClient('PanelBridgeSftpTest');
  const startedAt = Date.now();
  try {
    await client.connect({ host: validated.host, port: validated.port, username: validated.username, password: validated.password, readyTimeout: 10000 });
    const statusExists = Boolean(await client.exists(`${validated.bridgePath}/status.json.txt`) || await client.exists(`${validated.bridgePath}/status.json`));
    return { success: true, statusExists, latencyMs: Date.now() - startedAt };
  } finally {
    await client.end().catch(() => {});
  }
}
