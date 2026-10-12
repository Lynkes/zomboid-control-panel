import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// json.decode's object and array loops only move forward when parse_value
// consumes something. The number fallback consumed nothing for a character
// that is not part of a number, so any non-JSON token (a truncated `nul`, a
// bare word, a stray `]`) made the loop re-read the same character forever.
// pcall cannot catch an infinite loop, and the game thread runs json.decode on
// inbox/cmd-N.json and .queue-state-node.json: one truncated or hand-edited
// file froze the server, and froze it again after every restart because the
// command cursor had not moved past the file yet.
//
// A hang inside the fengari VM would freeze the vitest worker too (a timeout
// cannot interrupt a synchronous loop), so each decode runs under an
// instruction-count hook that turns "never returns" into a failing assertion.

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

// Far more VM instructions than any of these tiny documents needs.
const INSTRUCTION_LIMIT = 2000000;

function decode(text) {
  const bridge = loadPanelBridge(LUA_PATH);
  // json.decode has its own pcall, which would swallow the hook's error and
  // make a hang look like a clean nil, so the hook also records that it fired.
  bridge.run(`
    local text = ${JSON.stringify(text)}
    HOOK_FIRED = false
    debug.sethook(function() HOOK_FIRED = true; error("DECODE_DID_NOT_RETURN") end, "", ${INSTRUCTION_LIMIT})
    local ok, result = pcall(PanelBridgeModule.json.decode, text)
    debug.sethook()
    DECODE_OK = ok
    DECODE_RESULT = result
  `);
  return {
    ok: bridge.getGlobal('DECODE_OK'),
    result: bridge.getGlobal('DECODE_RESULT'),
    hung: bridge.getGlobal('HOOK_FIRED'),
  };
}

describe('PanelBridge.lua json.decode -- a non-JSON token ends the parse instead of looping', () => {
  it.each([
    ['a truncated literal inside an object', '{"a":1,"b":nul'],
    ['a bare word in an array', '[x]'],
    ['a bare word as an object value', '{"a":x}'],
    ['a bare word as an object key', '{x:1}'],
    ['a truncated true', '{"a":tru'],
    ['a stray closing bracket in an object', '{"a":1]'],
    ['a stray closing brace in an array', '[1,2}'],
  ])('returns (nil) for %s', (_label, text) => {
    const outcome = decode(text);

    expect(outcome.hung).toBe(false);
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBeNull();
  });

  it('still decodes ordinary documents, including every literal', () => {
    const outcome = decode('{"a":1,"b":[true,false,null,-2.5e1,"s"],"c":{"d":"x"}}');

    expect(outcome.hung).toBe(false);
    expect(outcome.ok).toBe(true);
    expect(outcome.result.a).toBe(1);
    expect(outcome.result.b[0]).toBe(true);
    expect(outcome.result.b[1]).toBe(false);
    expect(outcome.result.b[3]).toBe(-25);
    expect(outcome.result.b[4]).toBe('s');
    expect(outcome.result.c.d).toBe('x');
  });

  it('keeps decoding what the parser always skipped past: a trailing comma', () => {
    // Only a pass that consumes nothing is an error; this one eats the comma.
    const outcome = decode('{"a":1,}');

    expect(outcome.hung).toBe(false);
    expect(outcome.ok).toBe(true);
    expect(outcome.result.a).toBe(1);
  });

  it('keeps the old behaviour for a document cut off right after a colon', () => {
    // End of input, not a stray character: nothing to loop on, and the
    // fields before the cut were always returned.
    const outcome = decode('{"a":1,"b":');

    expect(outcome.hung).toBe(false);
    expect(outcome.ok).toBe(true);
    expect(outcome.result.a).toBe(1);
  });
});

// The scenario that matters: the file the game thread reads every tick.
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

describe('PanelBridge.lua inbox -- a truncated command file is skipped, not a frozen tick', () => {
  it.each([
    ['a cut-off literal', '{"id":"c1","action":"ping","args":{"a":1,"b":nul'],
    ['a bare word', '{"id":"c1","action":ping}'],
  ])('moves the cursor past %s and runs the next command', (_label, damaged) => {
    const bridge = loadPanelBridge(LUA_PATH, FILE_STUBS);
    bridge.run(`
      FILES["panelbridge/TestServer/inbox/cmd-0000000001.json"] = ${JSON.stringify(damaged)}
      FILES["panelbridge/TestServer/inbox/cmd-0000000002.json"] = '{"id":"c2","action":"unknown"}'
      HOOK_FIRED = false
      debug.sethook(function() HOOK_FIRED = true; error("TICK_DID_NOT_RETURN") end, "", ${INSTRUCTION_LIMIT * 5})
      PanelBridgeModule.processCommands()
      debug.sethook()
    `);

    expect(bridge.getGlobal('HOOK_FIRED')).toBe(false);
    const state = bridge.getGlobal('PanelBridgeModule');
    expect(state.queueState.lastCommandSeq).toBe(2);
    // Only the intact second file reached a handler.
    expect(state.stats.commandsProcessed).toBe(1);
  });
});
