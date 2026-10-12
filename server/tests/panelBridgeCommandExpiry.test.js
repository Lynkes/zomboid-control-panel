import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// sendCommand() rejects its caller after commandTimeoutMs. The queued command
// carries expiresAt, and PanelBridge.lua's processSingleCommand refuses to start
// a command past it ("Command expired before mod could process it") so that a
// command the caller was told timed out does not run afterwards anyway, which
// a retry would then do twice (horde, airdrop, giveItem). _enqueueCommand set
// expiresAt to TWICE the timeout, so a command stuck behind a long synchronous
// handler still ran 15-30 s after the caller had given up (60-120 s over
// SFTP). The deadline is the timeout plus a small clock-skew allowance.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'pz-mod',
  'PanelBridge',
  'media',
  'lua',
  'server',
  'PanelBridge.lua',
);

const { PanelBridge } = await import('../services/panelBridge.js');

let tmpDir;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function enqueue(commandTimeoutMs) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelbridge-expiry-'));
  const bridge = new PanelBridge();
  bridge.configure(tmpDir, true);
  if (commandTimeoutMs !== undefined) bridge.config.commandTimeoutMs = commandTimeoutMs;
  // A handler that needs no game stubs, so a command that runs succeeds.
  bridge._enqueueCommand('expiry-test-1', 'getAvailableHandlers', {});
  const inboxDir = path.join(tmpDir, 'inbox');
  const file = fs.readdirSync(inboxDir).find((f) => f.startsWith('cmd-'));
  expect(file).toBeTruthy();
  const raw = fs.readFileSync(path.join(inboxDir, file), 'utf-8');
  return { bridge, raw, payload: JSON.parse(raw) };
}

describe('panelBridge.js _enqueueCommand expiresAt', () => {
  it.each([
    ['the local default (15 s)', undefined, 15000],
    ['the SFTP timeout (60 s)', 60000, 60000],
  ])('is the caller timeout plus a small allowance for %s, not twice the timeout', (_label, configured, timeoutMs) => {
    const { bridge, payload } = enqueue(configured);

    expect(bridge.config.commandTimeoutMs).toBe(timeoutMs);
    const window = payload.expiresAt - payload.createdAt;
    // Never shorter than the time the caller is willing to wait...
    expect(window).toBeGreaterThanOrEqual(timeoutMs);
    // ...and only a few seconds longer, for the two hosts' clocks.
    expect(window).toBeLessThanOrEqual(timeoutMs + 10000);
  });
});

describe('a command written by the panel, read by the mod after the caller gave up', () => {
  const FILE_STUBS = `
FILES = {}
CLOCK = 0
getTimestampMs = function() return CLOCK end
function getServerName() return "TestServer" end
function getFileReader(path)
  local value = FILES[path]
  if value == nil then return nil end
  local reader = { value = value, done = false }
  function reader:readLine()
    if self.done then return nil end
    self.done = true
    return self.value
  end
  function reader:close() end
  return reader
end
function getFileWriter(path)
  local writer = { path = path, value = "" }
  function writer:write(value) self.value = self.value .. value end
  function writer:close() FILES[self.path] = self.value end
  return writer
end
`;

  function runAt(raw, createdAt, clockOffsetMs) {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      FILES["panelbridge/TestServer/inbox/cmd-0000000001.json"] = ${JSON.stringify(raw)}
      CLOCK = ${createdAt + clockOffsetMs}
      PanelBridgeModule.processCommands()
    `);
    return bridge.getGlobal('PanelBridgeModule');
  }

  it('runs while the caller is still waiting', () => {
    const { payload, raw } = enqueue();
    const state = runAt(raw, payload.createdAt, 14000);

    expect(state.stats.commandsProcessed).toBe(1);
    expect(state.stats.commandsFailed).toBe(0);
  });

  it('is skipped with an "expired" answer once the caller has been told it timed out', () => {
    const { bridge, payload, raw } = enqueue();
    // 6 s past the 15 s timeout: beyond any clock-skew allowance.
    const state = runAt(raw, payload.createdAt, bridge.config.commandTimeoutMs + 6000);

    expect(state.stats.commandsFailed).toBe(1);
    expect(state.pendingResults[0].error).toMatch(/expired before mod/);
  });

  it('is still skipped when it was stuck for about twice the timeout (what used to run)', () => {
    const { payload, raw } = enqueue();
    const state = runAt(raw, payload.createdAt, 25000);

    expect(state.stats.commandsFailed).toBe(1);
    expect(state.pendingResults[0].error).toMatch(/expired before mod/);
  });
});
