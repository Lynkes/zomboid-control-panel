import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(__dirname, '..', '..', 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua');
// Shapes verified in the deployed 42.20.4 class files. Missing Java calls
// emit traces even when Lua pcall catches them, so count the attempts too.
const stubs = `
translationCalls = 0
rangeProbes = 0
getText = function(text) translationCalls = translationCalls + 1; error("Already translated: " .. text) end
function option(kind, name, value)
  local o = {kind=kind, name=name, value=value}
  function o:getName() return self.name end
  function o:getShortName() return self.name end
  function o:getTableName() return "Test" end
  function o:getTooltip() return "50% growth; 10% vehicles" end
  function o:getTranslatedName() return self.name end
  function o:getPageName() return "Test" end
  function o:getClass() return "class zombie.SandboxOptions$" .. self.kind .. "SandboxOption" end
  function o:getValue() return self.value end
  function o:getDefaultValue() return self.value end
  if kind == "Integer" or kind == "Double" then
    function o:getMin() return 0.1 end
    function o:getMax() return 5 end
  end
  -- EnumConfigOption(name, N, default) is an IntegerConfigOption(name, 1, N, default).
  if kind == "Enum" then
    function o:getMin() return 1 end
    function o:getMax() return 3 end
    function o:getNumValues() return 3 end
    function o:getValueTranslationByIndexOrNull(i)
      assert(i >= 1 and i <= 3, "B42 enum translation index must be 1..N")
      return ({"Never", "Instant", "Delayed"})[i]
    end
  end
  return setmetatable(o, {__index=function(_, key)
    if key == "getMin" or key == "getMax" then rangeProbes = rangeProbes + 1 end
    return nil
  end})
end
options = {option("Boolean", "Toggle", true), option("String", "Text", "hello"),
           option("Double", "Rate", 1.6), option("Integer", "Count", 3),
           option("Enum", "Mode", 2)}
sandbox = {}
function sandbox:getNumOptions() return #options end
function sandbox:getOptionByIndex(i) return options[i+1] end
getSandboxOptions = function() return sandbox end
`;

describe('B42 sandbox metadata without exception-based probing', () => {
  it('uses the translated tooltip directly, including percent characters', () => {
    const bridge = loadPanelBridge(source, stubs);
    const result = bridge.callHandler('getAllSandboxOptions', {});
    expect(result.ok).toBe(true);
    expect(bridge.getGlobal('translationCalls')).toBe(0);
    expect(result.data.options.Test[0].tooltipText).toBe('50% growth; 10% vehicles');
  });
  it('does not request numeric limits on boolean or string options', () => {
    const bridge = loadPanelBridge(source, stubs);
    const result = bridge.callHandler('getAllSandboxOptions', {});
    expect(bridge.getGlobal('rangeProbes')).toBe(0);
    expect(result.data.options.Test.find(o => o.name === 'Toggle').min).toBeUndefined();
    expect(result.data.options.Test.find(o => o.name === 'Text').max).toBeUndefined();
  });
  it('preserves values, defaults and numeric ranges', () => {
    const bridge = loadPanelBridge(source, stubs);
    const result = bridge.callHandler('getAllSandboxOptions', {});
    expect(result.data.totalCount).toBe(5);
    expect(Object.fromEntries(result.data.options.Test.map(o => [o.name, o.value])))
      .toEqual({Toggle:true, Text:'hello', Rate:1.6, Count:3, Mode:2});
    expect(result.data.options.Test.find(o => o.name === 'Rate')).toMatchObject({min:0.1, max:5, default:1.6});
    expect(result.data.options.Test.find(o => o.name === 'Count')).toMatchObject({min:0.1, max:5, default:3});
  });
  it('reads the 1..N range of enum options next to their labels', () => {
    const bridge = loadPanelBridge(source, stubs);
    const result = bridge.callHandler('getAllSandboxOptions', {});
    expect(result.data.options.Test.find(o => o.name === 'Mode')).toMatchObject({
      type: 'enum', min: 1, max: 3, default: 2, selectedIndex: 2,
      enumValues: ['Never', 'Instant', 'Delayed'],
    });
  });
});
