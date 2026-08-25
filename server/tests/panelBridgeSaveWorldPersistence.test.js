import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// Regression coverage for b376b2c: handlers.setSandboxOption used to wrap
// world:saveWorld() in a bare pcall, discard the result, and unconditionally
// report success -- so a failed disk write was indistinguishable from a
// successful one to anything reading the handler's response. See this
// harness's HONEST LIMIT note in helpers/panelBridgeLua.js: these fakes
// encode our belief about getSandboxOptions/getWorld's shape, not a verified
// PZ truth.

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

const STUBS = `
FakeOption = { name = "ZombieCount", value = 4 }
FakeOption.__index = FakeOption
function FakeOption:getName() return self.name end
function FakeOption:getClass() return "class zombie.SandboxOptions$IntegerSandboxOption" end
function FakeOption:getValue() return self.value end
function FakeOption:setValue(v) self.value = v end
setmetatable(FakeOption, FakeOption)

FakeSandbox = {}
FakeSandbox.__index = FakeSandbox
function FakeSandbox:getNumOptions() return 1 end
function FakeSandbox:getOptionByIndex(i) if i == 0 then return FakeOption end return nil end
getSandboxOptions = function() return setmetatable({}, FakeSandbox) end

FakeWorld = {}
FakeWorld.__index = FakeWorld
FakeWorld.shouldFail = false
function FakeWorld:saveWorld()
  if FakeWorld.shouldFail then error("disk full (fake)") end
end
getWorld = function() return setmetatable({}, FakeWorld) end
`;

describe('PanelBridge.lua handlers.setSandboxOption -- world save persistence (b376b2c)', () => {
  it('reports persisted=true and no saveError when world:saveWorld() succeeds', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('FakeWorld.shouldFail = false');

    const result = bridge.callHandler('setSandboxOption', { name: 'ZombieCount', value: '8' });

    expect(result.ok).toBe(true);
    expect(result.data.persisted).toBe(true);
    expect(result.data.saveError == null).toBe(true);
  });

  it('reports persisted=false with the real failure reason when world:saveWorld() throws -- must NOT report silent success', () => {
    const bridge = loadPanelBridge(LUA_PATH, STUBS);
    bridge.run('FakeWorld.shouldFail = true');

    const result = bridge.callHandler('setSandboxOption', { name: 'ZombieCount', value: '9' });

    // The in-memory option write itself genuinely succeeded (setValue ran
    // before the save was attempted), so ok stays true -- what must not
    // happen is claiming the change is durable when the disk write failed.
    expect(result.ok).toBe(true);
    expect(result.data.persisted).toBe(false);
    expect(typeof result.data.saveError).toBe('string');
    expect(result.data.saveError).toContain('disk full');
  });
});
