import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

const source = fileURLToPath(new URL('../../pz-mod/PanelBridge/media/lua/server/PanelBridge.lua', import.meta.url));

function enumStub(size) {
  return `
setCalls = 0
syncCalls = 0
saveCalls = 0
FakeOption = { value = 1 }
function FakeOption:getName() return "Test.Enum" end
function FakeOption:getClass() return "class zombie.SandboxOptions$EnumSandboxOption" end
function FakeOption:getNumValues() return ${size} end
function FakeOption:getValue() return self.value end
function FakeOption:setValue(value)
  setCalls = setCalls + 1
  -- IntegerConfigOption leaves the previous value intact outside its bounds.
  if value >= 1 and value <= ${size} then self.value = value end
end
FakeSandbox = {}
function FakeSandbox:getNumOptions() return 1 end
function FakeSandbox:getOptionByIndex(i) if i == 0 then return FakeOption end end
function FakeSandbox:toLua()
  syncCalls = syncCalls + 1
  syncedValue = FakeOption.value
end
getSandboxOptions = function() return FakeSandbox end
saveGame = function()
  saveCalls = saveCalls + 1
  savedValue = FakeOption.value
end
`;
}

describe('B42 sandbox enum writes use the same 1..N range as the selector', () => {
  it.each([[3, 3], [2, 2], [1, 1], [3, 1], [3, '3']])(
    'applies selection %s-value enum / %s without changing the choice', (size, value) => {
      const bridge = loadPanelBridge(source, enumStub(size));
      const result = bridge.callHandler('setSandboxOption', { name: 'Test.Enum', value });

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ value: Number(value), verified: 'confirmed' });
      expect(bridge.getGlobal('syncedValue')).toBe(Number(value));
      expect(bridge.getGlobal('setCalls')).toBe(1);
      expect(bridge.getGlobal('syncCalls')).toBe(1);
      // A live edit never saves the world: saveGame() writes map_sand.bin,
      // which overrides SandboxVars.lua at every start (#197).
      expect(bridge.getGlobal('saveCalls')).toBe(0);
    },
  );

  it.each([-1, 0, 4, 99, 1.5, 3.1, 'not a number', '1e309'])(
    'rejects invalid value %s before changing, syncing or saving the option', value => {
      const bridge = loadPanelBridge(source, enumStub(3));
      const result = bridge.callHandler('setSandboxOption', { name: 'Test.Enum', value });

      expect(result.ok).toBe(false);
      expect(result.err).toMatch(/enum value/i);
      expect(bridge.getGlobal('setCalls')).toBe(0);
      expect(bridge.getGlobal('syncCalls')).toBe(0);
      expect(bridge.getGlobal('saveCalls')).toBe(0);
    },
  );
});
