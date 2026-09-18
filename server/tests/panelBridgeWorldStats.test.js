import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

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

describe('PanelBridge.lua getWorldStats', () => {
  it('reads the zombie list through invoke and returns its size', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeZombieList = {}
function FakeZombieList:size() return 7 end
FakeCell = {}
function FakeCell:getZombieList() return FakeZombieList end
FakeWorld = {}
function FakeWorld:getCell() return FakeCell end
function FakeWorld:getMap() return "Muldraugh" end
getWorld = function() return FakeWorld end
getServerName = function() return "TestServer" end
`);

    const result = bridge.callHandler('getWorldStats', {});

    expect(result.ok).toBe(true);
    expect(result.data.serverName).toBe('TestServer');
    expect(result.data.map).toBe('Muldraugh');
    expect(result.data.zombiesInCell).toBe(7);
  });

  it('contains no compound Java field guard for getZombieList', () => {
    const lua = fs.readFileSync(LUA_PATH, 'utf8');
    expect(lua).not.toMatch(/if[^\r\n]*\b\w+\.getZombieList\s+then/);
  });

  it('does not report zero when the zombie collection cannot be read', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakeCell = {}
function FakeCell:getZombieList() error("collection unavailable") end
FakeWorld = {}
function FakeWorld:getCell() return FakeCell end
function FakeWorld:getMap() return "Muldraugh" end
getWorld = function() return FakeWorld end
getServerName = function() return "TestServer" end
`);

    const worldStats = bridge.callHandler('getWorldStats', {});
    const zombieCount = bridge.callHandler('getZombieCount', {});

    expect(worldStats.ok).toBe(false);
    expect(worldStats.err).toMatch(/Zombie list lookup failed/);
    expect(zombieCount.ok).toBe(false);
    expect(zombieCount.err).toMatch(/Zombie list lookup failed/);
  });
});