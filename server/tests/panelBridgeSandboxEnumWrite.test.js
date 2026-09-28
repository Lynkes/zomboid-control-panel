import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// PR #169 made the Mod Settings enum dropdown 1-based (label i sends value i),
// but setSandboxOption's enum branch still clamped as if values were 0..N-1:
// the last choice N became N-1, setValue(N-1) stuck, the read-back matched
// and the handler answered verified="confirmed". A 2-value mod enum could
// never be set to its second value.
//
// The stub copies what javap shows on the 42.20.4 jar:
// EnumConfigOption(name, N, default) calls IntegerConfigOption(name, 1, N,
// default), getNumValues() returns max, and IntegerConfigOption.setValue(int)
// logs and returns without assigning when the value is below min or above
// max. getValueTranslationByIndexOrNull throws outside 1..N.

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

function enumOptionStubs({ numValues, value, labels }) {
  const labelTable = labels.map((label, i) => `[${i + 1}] = ${JSON.stringify(label)}`).join(', ');
  return `
SET_VALUE_CALLS = 0
saveGame = function() end

FakeEnumClass = setmetatable({}, { __tostring = function() return "class zombie.SandboxOptions$EnumSandboxOption" end })

FakeEnumOption = { name = "TestMod.Mode", short = "Mode", tbl = "TestMod", min = 1, max = ${numValues}, value = ${value} }
function FakeEnumOption:getName() return self.name end
function FakeEnumOption:getShortName() return self.short end
function FakeEnumOption:getTableName() return self.tbl end
function FakeEnumOption:getClass() return FakeEnumClass end
function FakeEnumOption:getValue() return self.value end
function FakeEnumOption:getDefaultValue() return 1 end
function FakeEnumOption:getNumValues() return self.max end
function FakeEnumOption:getMin() return self.min end
function FakeEnumOption:getMax() return self.max end
function FakeEnumOption:setValue(v)
  SET_VALUE_CALLS = SET_VALUE_CALLS + 1
  if v < self.min or v > self.max then return end
  self.value = v
end
function FakeEnumOption:getValueTranslationByIndexOrNull(i)
  if i < 1 or i > self.max then error("java.lang.ArrayIndexOutOfBoundsException") end
  local names = { ${labelTable} }
  return names[i]
end

FakeSandbox = {}
function FakeSandbox:getNumOptions() return 1 end
function FakeSandbox:getOptionByIndex(i)
  if i == 0 then return FakeEnumOption end
  return nil
end
function FakeSandbox:toLua() end
getSandboxOptions = function() return FakeSandbox end
`;
}

function gameValue(bridge) {
  bridge.run('GAME_VALUE = FakeEnumOption.value');
  return bridge.getGlobal('GAME_VALUE');
}

describe('PanelBridge.lua handlers.setSandboxOption -- enum values are 1..N', () => {
  it('applies the last value N of an N-value enum instead of clamping it to N-1', () => {
    const bridge = loadPanelBridge(LUA_PATH, enumOptionStubs({
      numValues: 3, value: 2, labels: ['Never', 'Instant', 'Delayed'],
    }));
    const result = bridge.callHandler('setSandboxOption', { name: 'TestMod.Mode', value: 3 });

    expect(result.ok).toBe(true);
    expect(result.data.value).toBe(3);
    expect(result.data.verified).toBe('confirmed');
    expect(gameValue(bridge)).toBe(3);
  });

  it('sets the second value of a 2-value mod enum', () => {
    const bridge = loadPanelBridge(LUA_PATH, enumOptionStubs({
      numValues: 2, value: 1, labels: ['Off', 'On'],
    }));
    const result = bridge.callHandler('setSandboxOption', { name: 'TestMod.Mode', value: '2' });

    expect(result.ok).toBe(true);
    expect(result.data.value).toBe(2);
    expect(gameValue(bridge)).toBe(2);
  });

  it('writes back the value of the last label getAllSandboxOptions listed', () => {
    const bridge = loadPanelBridge(LUA_PATH, enumOptionStubs({
      numValues: 3, value: 1, labels: ['Never', 'Instant', 'Delayed'],
    }));
    const read = bridge.callHandler('getAllSandboxOptions', {});
    const option = read.data.options.TestMod[0];
    // The dropdown sends position + 1 for the label the operator picks.
    const lastChoice = option.enumValues.length;

    const result = bridge.callHandler('setSandboxOption', { name: option.name, value: lastChoice });

    expect(option.enumValues).toEqual(['Never', 'Instant', 'Delayed']);
    expect(result.ok).toBe(true);
    expect(gameValue(bridge)).toBe(3);
  });

  it.each([
    ['0 (the old 0-based first choice)', 0],
    ['N + 1', 4],
    ['a negative value', -1],
  ])('rejects %s with an error and leaves the option untouched', (_label, value) => {
    const bridge = loadPanelBridge(LUA_PATH, enumOptionStubs({
      numValues: 3, value: 2, labels: ['Never', 'Instant', 'Delayed'],
    }));
    const result = bridge.callHandler('setSandboxOption', { name: 'TestMod.Mode', value });

    expect(result.ok).toBe(false);
    expect(result.err).toBe(`Enum value ${value} is out of range (1..3)`);
    expect(bridge.getGlobal('SET_VALUE_CALLS')).toBe(0);
    expect(gameValue(bridge)).toBe(2);
  });
});
