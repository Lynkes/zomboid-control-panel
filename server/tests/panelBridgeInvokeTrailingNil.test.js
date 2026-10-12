import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// PanelBridge.invoke(obj, name, ...) collected its arguments as `{ ... }` and
// passed unpack(args), which stops at the first trailing nil: the length
// operator treats a trailing nil as the end of the list. So
// invoke(player, "Kill", nil) called player:Kill() with NO argument, and the
// game (IsoGameCharacter only has Kill overloads taking 1 to 4 arguments)
// raised "No implementation found for function: Kill". POST /players/:name/kill
// could never kill anyone, after it had already stripped godmode. The argument
// count must come from select('#', ...).

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

describe('PanelBridge.invoke -- argument count survives nil arguments', () => {
  function load() {
    const bridge = loadPanelBridge(LUA_PATH, `
      RECEIVED = {}
      Target = {}
      function Target:record(...)
        RECEIVED[#RECEIVED + 1] = select("#", ...)
        return true
      end
      -- Same arity rule as IsoGameCharacter.Kill: 1 to 4 arguments, never 0.
      function Target:strict(...)
        if select("#", ...) < 1 then
          error("No implementation found for function: strict")
        end
        return "ok"
      end
    `);
    return bridge;
  }

  it('a single trailing nil is still passed as one argument', () => {
    const bridge = load();
    bridge.run('INVOKE_OK, INVOKE_RESULT = PanelBridgeModule.invoke(Target, "strict", nil)');
    expect(bridge.getGlobal('INVOKE_OK')).toBe(true);
    expect(bridge.getGlobal('INVOKE_RESULT')).toBe('ok');
  });

  it('every argument position is preserved, including trailing and middle nils', () => {
    const bridge = load();
    bridge.run(`
      PanelBridgeModule.invoke(Target, "record")
      PanelBridgeModule.invoke(Target, "record", nil)
      PanelBridgeModule.invoke(Target, "record", 1, nil)
      PanelBridgeModule.invoke(Target, "record", nil, nil, nil)
      PanelBridgeModule.invoke(Target, "record", 1, nil, 3)
      PanelBridgeModule.invoke(Target, "record", 1, 2, 3, 4)
    `);
    expect(bridge.getGlobal('RECEIVED')).toEqual([0, 1, 2, 3, 3, 4]);
  });

  it('values still arrive in order', () => {
    const bridge = load();
    bridge.run(`
      function Target:echo(...) return table.concat({ tostring(select(1, ...)), tostring(select(2, ...)), tostring(select(3, ...)) }, ",") end
      OK, ECHO = PanelBridgeModule.invoke(Target, "echo", "a", nil, "c")
    `);
    expect(bridge.getGlobal('OK')).toBe(true);
    expect(bridge.getGlobal('ECHO')).toBe('a,nil,c');
  });

  it('tryGet and safeCall forward a nil argument the same way', () => {
    const bridge = load();
    bridge.run(`
      TRY = PanelBridgeModule.tryGet(Target, "strict", nil)
      SAFE_OK = PanelBridgeModule.safeCall(Target, "strict", nil)
    `);
    expect(bridge.getGlobal('TRY')).toBe('ok');
    expect(bridge.getGlobal('SAFE_OK')).toBe(true);
  });
});
