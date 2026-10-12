import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// The "already processed" id window (processedIds + processedIdOrder) is meant
// to slide: past 500 entries the oldest half is dropped. The trim sat at the
// end of PanelBridge.processCommands, behind the early return taken whenever
// the legacy commands.json has nothing in it. The numbered inbox queue is the
// normal path and commands.json is empty, so the trim never ran and both
// tables gained one entry per command for as long as the server stayed up.

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

const FILE_STUBS = `
FILES = {}
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

const COUNT_SNIPPET = `
  local keys = 0
  for _ in pairs(PanelBridgeModule.processedIds) do keys = keys + 1 end
  IDS_KEYS = keys
  IDS_ORDER = #PanelBridgeModule.processedIdOrder
  IDS_COUNT = PanelBridgeModule.processedIdCount
`;

describe('PanelBridge.lua processed-command-id window', () => {
  it('stays bounded while commands arrive through the numbered inbox queue', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      for i = 1, 1300 do
        FILES["panelbridge/TestServer/inbox/cmd-" .. string.format("%010d", i) .. ".json"] =
          '{"id":"cmd-' .. i .. '","action":"unknown"}'
      end
      -- 200 commands per tick: seven ticks drain all 1300.
      for _ = 1, 7 do PanelBridgeModule.processCommands() end
      ${COUNT_SNIPPET}
    `);

    expect(bridge.getGlobal('PanelBridgeModule').queueState.lastCommandSeq).toBe(1300);
    expect(bridge.getGlobal('PanelBridgeModule').stats.commandsProcessed).toBe(1300);
    // All three views of the window agree and stay within the 500 cap.
    expect(bridge.getGlobal('IDS_COUNT')).toBeLessThanOrEqual(500);
    expect(bridge.getGlobal('IDS_KEYS')).toBe(bridge.getGlobal('IDS_COUNT'));
    expect(bridge.getGlobal('IDS_ORDER')).toBe(bridge.getGlobal('IDS_COUNT'));
  });

  it('drops the OLDEST ids and keeps the newest, so a recent duplicate is still refused', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      for i = 1, 700 do
        FILES["panelbridge/TestServer/inbox/cmd-" .. string.format("%010d", i) .. ".json"] =
          '{"id":"cmd-' .. i .. '","action":"unknown"}'
      end
      for _ = 1, 4 do PanelBridgeModule.processCommands() end
      OLDEST_KNOWN = PanelBridgeModule.processedIds["cmd-1"] == true
      NEWEST_KNOWN = PanelBridgeModule.processedIds["cmd-700"] == true
      NEWEST_BEFORE = PanelBridgeModule.stats.commandsProcessed

      -- The newest id replayed in a later file must still be recognised.
      FILES["panelbridge/TestServer/inbox/cmd-0000000701.json"] = '{"id":"cmd-700","action":"unknown"}'
      PanelBridgeModule.processCommands()
      NEWEST_AFTER = PanelBridgeModule.stats.commandsProcessed
    `);

    expect(bridge.getGlobal('OLDEST_KNOWN')).toBe(false);
    expect(bridge.getGlobal('NEWEST_KNOWN')).toBe(true);
    expect(bridge.getGlobal('NEWEST_AFTER')).toBe(bridge.getGlobal('NEWEST_BEFORE'));
  });

  it('does not trim a window that is still under the cap', () => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      for i = 1, 300 do
        FILES["panelbridge/TestServer/inbox/cmd-" .. string.format("%010d", i) .. ".json"] =
          '{"id":"cmd-' .. i .. '","action":"unknown"}'
      end
      for _ = 1, 2 do PanelBridgeModule.processCommands() end
      ${COUNT_SNIPPET}
    `);

    expect(bridge.getGlobal('IDS_COUNT')).toBe(300);
    expect(bridge.getGlobal('IDS_KEYS')).toBe(300);
    expect(bridge.getGlobal('IDS_ORDER')).toBe(300);
  });
});
