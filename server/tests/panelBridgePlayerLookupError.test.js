import { describe, it, expect } from 'vitest';
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

describe('PanelBridge.lua player lookup errors', () => {
  it('distinguishes an unreadable online-player collection from an offline player', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
getOnlinePlayers = function() return FakeBrokenPlayers end
FakeBrokenPlayers = {}
function FakeBrokenPlayers:size() return 1 end
function FakeBrokenPlayers:iterator() error("player collection unavailable") end
`);

    const result = bridge.callHandler('getPlayerDetails', { username: 'Alice' });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/Online player list unavailable/);
    expect(result.err).not.toMatch(/Player not found/);
  });

  it('keeps the ordinary Player not found response when the collection is readable', () => {
    const bridge = loadPanelBridge(LUA_PATH, `
FakePlayers = {}
function FakePlayers:size() return 0 end
function FakePlayers:iterator()
  local iterator = { done = false }
  function iterator:hasNext() return not self.done end
  function iterator:next() self.done = true return nil end
  return iterator
end
getOnlinePlayers = function() return FakePlayers end
`);

    const result = bridge.callHandler('getPlayerDetails', { username: 'Alice' });

    expect(result.ok).toBe(false);
    expect(result.err).toBe('Player not found: Alice');
  });
});