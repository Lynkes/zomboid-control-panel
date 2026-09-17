import { describe, it, expect } from 'vitest';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

const LUA_PATH = 'pz-mod/PanelBridge/media/lua/server/PanelBridge.lua';

const STUBS = `
FILES = {}
FAIL_QUEUE_STATE = false
FAIL_CLOSE = false
FAIL_READER_CLOSE = false
FAIL_OPEN = false
getServerName = function() return "TestServer" end
getFileReader = function(path)
  if FAIL_OPEN then error("reader open failed") end
  local value = FILES[path]
  if value == nil then return nil end
  local reader = { value = value, done = false }
  function reader:readLine()
    if self.done then return nil end
    self.done = true
    return self.value
  end
  function reader:close()
    if FAIL_READER_CLOSE then error("reader close failed") end
  end
  return reader
end
getFileWriter = function(path)
  if FAIL_OPEN then error("writer open failed") end
  if FAIL_QUEUE_STATE and path:find("queue%-state%-lua%.json%.txt", 1, false) then
    return nil
  end
  local writer = { path = path, value = "" }
  function writer:write(value) self.value = self.value .. value end
  function writer:close()
    if FAIL_CLOSE then error("close failed") end
    FILES[self.path] = self.value
  end
  return writer
end
`;

describe('PanelBridge.lua result sequence reservation', () => {
  it('does not write an outbox result when queue-state reservation fails', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run(`
PanelBridgeModule.sendResult("first", true, { value = 1 })
FAIL_QUEUE_STATE = true
PanelBridgeModule.flushResults()
`);

    const files = bridge.getGlobal('FILES');
    expect(Object.keys(files).some((key) => key.includes('outbox/res-'))).toBe(false);
  });

  it('rebuilds nextResultSeq from the Node cursor when Lua queue state is reset', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run(`
FILES["panelbridge/TestServer/queue-state-lua.json.txt"] = "not-json"
FILES["panelbridge/TestServer/.queue-state-node.json"] =
  '{"protocolVersion":"queue-v1","nextCommandSeq":1,"lastConsumedResultSeq":41}'
PanelBridgeModule.readQueueState()
`);

    const state = bridge.getGlobal('PanelBridgeModule').queueState;
    expect(state.nextResultSeq).toBe(42);
  });

  it('preserves the reserved sequence across a fresh Lua state', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run(`
PanelBridgeModule.sendResult("first", true, { value = 1 })
PanelBridgeModule.flushResults()
`);
    const files = bridge.getGlobal('FILES');
    const statePath = 'panelbridge/TestServer/queue-state-lua.json.txt';
    const outboxPath = 'panelbridge/TestServer/outbox/res-0000000001.json.txt';
    expect(files[statePath]).toContain('"nextResultSeq":2');
    expect(files[outboxPath]).toContain('"value":1');

    const restarted = loadPanelBridge(LUA_PATH, STUBS);
    restarted.run(`
FILES[${JSON.stringify(statePath)}] = ${JSON.stringify(files[statePath])}
FILES[${JSON.stringify(outboxPath)}] = ${JSON.stringify(files[outboxPath])}
PanelBridgeModule.readQueueState()
PanelBridgeModule.sendResult("second", true, { value = 2 })
PanelBridgeModule.flushResults()
`);

    const restartedFiles = restarted.getGlobal('FILES');
    expect(restartedFiles[outboxPath]).toContain('"value":1');
    expect(restartedFiles['panelbridge/TestServer/outbox/res-0000000002.json.txt']).toContain('"value":2');
  });

  it('turns a close-time writer failure into a retryable false result', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run(`
FAIL_CLOSE = true
__WRITE_OK = PanelBridgeModule.writeJSON("close-test", { value = 1 })
`);

    expect(bridge.getGlobal('__WRITE_OK')).toBe(false);
  });

  it('turns reader close failures into an absent JSON read instead of throwing', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run(`
FILES["panelbridge/TestServer/read-test.json.txt"] = "{\\"value\\":1}"
FAIL_READER_CLOSE = true
__READ_VALUE = PanelBridgeModule.readJSON("read-test")
`);

    expect(bridge.getGlobal('__READ_VALUE')).toBeNull();
  });

  it('does not throw when the startup sentinel writer closes badly', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run(`
FAIL_CLOSE = true
__ENSURE_OK = PanelBridgeModule.ensureDirectory()
`);

    expect(bridge.getGlobal('__ENSURE_OK')).toBe(false);
  });

  it('turns reader and writer open failures into clean absent/false results', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run(`
FAIL_OPEN = true
__READ_VALUE = PanelBridgeModule.readJSON("read-test")
__WRITE_OK = PanelBridgeModule.writeJSON("open-test", { value = 1 })
`);

    expect(bridge.getGlobal('__READ_VALUE')).toBeNull();
    expect(bridge.getGlobal('__WRITE_OK')).toBe(false);
  });
});