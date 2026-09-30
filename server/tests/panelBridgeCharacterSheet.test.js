import { describe, expect, it } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { lua } from 'fengari';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// handlers.getCharacterSheet (PanelBridge.lua, CHARACTER SHEET section) under
// fengari. The stubs follow the shapes javap shows on the 42.21 jar:
//   - Role: getName(), hasAdminPower(), hasCapability(Capability).
//   - CharacterStat.X with getMinimumValue()/getMaximumValue(); Stats:get(stat).
//   - PerkFactory.PerkList, an ArrayList<Perk>. Perk: getId(), getName(),
//     getParent() (categories hang off Perks.None), isPassiv(),
//     getTotalXpForLevel(int).
//   - IsoGameCharacter$XP: getXP(perk), getPerkBoost(perk), getMultiplier(perk).
//   - CharacterTraits:getKnownTraits(), a List<CharacterTrait> whose
//     toString is the registry id ("base:athletic"); the static
//     CharacterTraitDefinition.getCharacterTraitDefinition(trait) with
//     getLabel(), getCost(), isFree(). Same for professions (getUIName()).
//   - WornItems/AttachedItems: size(), get(i) -> entry with getItem() and
//     getLocation().
//   - InventoryItem and InventoryContainer.getItemContainer(); ItemContainer
//     getItems(), getContentsWeight(), getCapacity(),
//     getEffectiveCapacity(character); script Item isHidden()/getObsolete().
// Same honest limit as helpers/panelBridgeLua.js: these encode what the jar
// says, not a running game.

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
Now = 1000
function getTimestampMs() return Now end
-- Added to the clock by every item's getFullType(), to spend the walk's time
-- budget deterministically.
ItemCostMs = 0

-- 0-based Java list.
function JList(items)
  local list = { items = items }
  function list:size() return #self.items end
  function list:get(i) return self.items[i + 1] end
  return list
end

-- Registry objects (CharacterTrait, CharacterProfession, ItemBodyLocation)
-- stringify to their id, as their toString does.
function Named(id)
  return setmetatable({ id = id }, { __tostring = function(self) return self.id end })
end

StatRangeReads = {}
function Stat(id, min, max)
  local stat = { id = id, min = min, max = max }
  function stat:getMinimumValue()
    StatRangeReads[self.id] = (StatRangeReads[self.id] or 0) + 1
    return self.min
  end
  function stat:getMaximumValue() return self.max end
  return stat
end
CharacterStat = {
  HUNGER = Stat("HUNGER", 0, 1), THIRST = Stat("THIRST", 0, 1), FATIGUE = Stat("FATIGUE", 0, 1),
  ENDURANCE = Stat("ENDURANCE", 0, 1), STRESS = Stat("STRESS", 0, 1), BOREDOM = Stat("BOREDOM", 0, 100),
  UNHAPPINESS = Stat("UNHAPPINESS", 0, 100), PANIC = Stat("PANIC", 0, 100), PAIN = Stat("PAIN", 0, 100),
  SICKNESS = Stat("SICKNESS", 0, 1), ZOMBIE_INFECTION = Stat("ZOMBIE_INFECTION", 0, 100),
  WETNESS = Stat("WETNESS", 0, 100), INTOXICATION = Stat("INTOXICATION", 0, 100),
}
StatValues = {
  HUNGER = 0.25, THIRST = 0.5, FATIGUE = 0.1, ENDURANCE = 0.9, STRESS = 0, BOREDOM = 10,
  UNHAPPINESS = 5, PANIC = 0, PAIN = 20, SICKNESS = 0, ZOMBIE_INFECTION = 0, WETNESS = 0, INTOXICATION = 0,
}
StatThrows = {}

function Perk(id, parent, opts)
  opts = opts or {}
  local perk = { id = id, parent = parent, opts = opts }
  function perk:getId()
    if self.opts.throws then error("broken perk") end
    return self.id
  end
  function perk:getParent() return self.parent end
  function perk:getName() return self.opts.name or self.id end
  function perk:isPassiv() return self.opts.passive == true end
  function perk:getTotalXpForLevel(level) return level * 100 end
  return perk
end
PerkNone = Perk("None", nil)
PerkCombat = Perk("Combat", PerkNone, { name = "Combat" })
PerkPassiv = Perk("Passiv", PerkNone, { name = "Passive" })
PerkCrafting = Perk("Crafting", PerkNone, { name = "Crafting" })
PerkAxe = Perk("Axe", PerkCombat, { name = "Axe" })
PerkFitness = Perk("Fitness", PerkPassiv, { name = "Fitness", passive = true })
PerkCarpentry = Perk("Woodwork", PerkCrafting, { name = "Carpentry" })
-- A mod perk: no MultiplierConfig option exists for it.
PerkModded = Perk("Blacksmithing", PerkCrafting, { name = "Blacksmithing" })
PerkBroken = Perk("Broken", PerkCombat, { throws = true })
PerkFactory = { PerkList = JList({ PerkCombat, PerkAxe, PerkPassiv, PerkFitness, PerkCrafting, PerkCarpentry, PerkModded, PerkBroken }) }

SandboxVars = { MultiplierConfig = { Global = 1, GlobalToggle = true, Axe = 2.5, Woodwork = 1 } }

getGameTime = function()
  local gameTime = {}
  function gameTime:getMinutesPerDay() return 60 end
  return gameTime
end

Capability = { AddItem = { name = "AddItem" } }

TraitDefinitions = {
  ["base:athletic"] = { label = "Athletic", cost = 6, free = false },
  ["base:axeman"] = { label = "Axe Man", cost = 0, free = true },
}
CharacterTraitDefinition = {
  getCharacterTraitDefinition = function(trait)
    local def = TraitDefinitions[tostring(trait)]
    if not def then return nil end
    return {
      getLabel = function(self) return def.label end,
      getCost = function(self) return def.cost end,
      isFree = function(self) return def.free end,
    }
  end,
}
CharacterProfessionDefinition = {
  getCharacterProfessionDefinition = function(profession)
    if tostring(profession) ~= "base:fireofficer" then return nil end
    return { getUIName = function(self) return "Fire Officer" end }
  end,
}

HiddenReads = {}
NextItemId = 100
function Container(items, opts)
  opts = opts or {}
  local container = { list = JList(items) }
  function container:getItems() return self.list end
  function container:getContentsWeight() return opts.contentsWeight or 1 end
  function container:getCapacity() return opts.capacity or 10 end
  function container:getEffectiveCapacity(character)
    if opts.effectiveThrows then error("no effective capacity") end
    return opts.effectiveCapacity or opts.capacity or 10
  end
  return container
end
function Item(fullType, opts)
  opts = opts or {}
  NextItemId = NextItemId + 1
  local item = { id = opts.id or NextItemId, fullType = fullType, opts = opts }
  function item:getID() return self.id end
  function item:getFullType()
    if self.opts.throws then error("broken item") end
    Now = Now + ItemCostMs
    return self.fullType
  end
  function item:getDisplayName() return self.opts.name or self.fullType end
  function item:getDisplayCategory() return self.opts.category or "Item" end
  function item:getModID() return self.opts.modId or "pz-vanilla" end
  function item:getCount() return self.opts.count or 1 end
  function item:getActualWeight() return self.opts.weight or 0.5 end
  function item:getCondition() return self.opts.condition or 10 end
  function item:getConditionMax() return self.opts.conditionMax or 10 end
  function item:IsInventoryContainer() return self.opts.contents ~= nil end
  function item:getItemContainer() return self.inner end
  function item:getScriptItem()
    local fullType, itemOpts = self.fullType, self.opts
    local script = {}
    function script:isHidden()
      HiddenReads[fullType] = (HiddenReads[fullType] or 0) + 1
      return itemOpts.hidden == true
    end
    function script:getObsolete() return itemOpts.obsolete == true end
    return script
  end
  if opts.contents then item.inner = Container(opts.contents, opts) end
  return item
end
function Entry(item, location)
  local entry = {}
  function entry:getItem() return item end
  function entry:getLocation() return location end
  return entry
end

function MakePlayer(username, opts)
  opts = opts or {}
  local player = {
    username = username, opts = opts, statsReads = 0, inventoryReads = 0,
    inventory = opts.inventory or Container({}),
    levels = { Axe = 3, Fitness = 5, Woodwork = 10, Blacksmithing = 2 },
    xp = { Axe = 320, Fitness = 510, Woodwork = 1000, Blacksmithing = 250 },
    boost = { Axe = 1 }, multiplier = { Axe = 2 },
    role = opts.role or { name = "user", adminPower = false, spawn = false },
    worn = opts.worn or {}, attached = opts.attached or {},
  }
  function player:getUsername() return self.username end
  function player:getDisplayName() return self.username .. " (display)" end
  function player:getDescriptor()
    local descriptor = {}
    function descriptor:getForename() return "Alice" end
    function descriptor:getSurname() return "Smith" end
    function descriptor:getCharacterProfession() return Named("base:fireofficer") end
    return descriptor
  end
  function player:getRole()
    local data = self.role
    local role = {}
    function role:getName() return data.name end
    function role:hasAdminPower()
      if data.adminThrows then error("no admin power read") end
      return data.adminPower
    end
    function role:hasCapability(capability) return capability == Capability.AddItem and data.spawn end
    return role
  end
  function player:isAlive() return true end
  function player:isAsleep() return false end
  function player:isSneaking() return false end
  function player:isRunning() return true end
  function player:getX() return 100.5 end
  function player:getY() return 200.25 end
  function player:getZ() return 0 end
  function player:getHoursSurvived() return 30.5 end
  function player:getZombieKills() return 12 end
  function player:getSurvivorKills() return 1 end
  function player:getInventoryWeight() return 12.5 end
  function player:getMaxWeight() return 15 end
  function player:isGodMod() return self.opts.godMode == true end
  function player:isInvisible() return false end
  function player:isNoClip() return false end
  function player:isGhostMode() return false end
  function player:isUnlimitedCarry() return false end
  function player:isUnlimitedEndurance() return false end
  function player:isKnowAllRecipes() return false end
  function player:isInvincible() return false end
  function player:getNutrition()
    local nutrition = {}
    function nutrition:getWeight() return 80 end
    return nutrition
  end
  function player:getStats()
    self.statsReads = self.statsReads + 1
    local stats = {}
    function stats:get(stat)
      if StatThrows[stat.id] then error("stat read failed") end
      return StatValues[stat.id]
    end
    return stats
  end
  function player:getBodyDamage()
    local body = {}
    function body:getOverallBodyHealth() return 90 end
    function body:IsInfected() return false end
    function body:getNumPartsBleeding() return 0 end
    function body:getThermoregulator()
      local thermo = {}
      function thermo:getCoreTemperature() return 37 end
      return thermo
    end
    return body
  end
  function player:getXp()
    local owner = self
    local xp = {}
    function xp:getXP(perk) return owner.xp[perk.id] or 0 end
    function xp:getPerkBoost(perk) return owner.boost[perk.id] or 0 end
    function xp:getMultiplier(perk) return owner.multiplier[perk.id] or 0 end
    return xp
  end
  function player:getPerkLevel(perk) return self.levels[perk.id] or 0 end
  function player:getCharacterTraits()
    local traits = {}
    function traits:getKnownTraits()
      return JList({ Named("base:athletic"), Named("base:axeman"), Named("mod:strange") })
    end
    return traits
  end
  function player:getInventory()
    self.inventoryReads = self.inventoryReads + 1
    return self.inventory
  end
  function player:getPrimaryHandItem() return self.opts.primary end
  function player:getSecondaryHandItem() return self.opts.secondary end
  function player:getWornItems() return JList(self.worn) end
  function player:getAttachedItems() return JList(self.attached) end
  return player
end

Alice = MakePlayer("Alice")
Bob = MakePlayer("Bob")
OnlinePlayers = JList({ Alice, Bob })
getOnlinePlayers = function() return OnlinePlayers end
`;

function load(extra = '') {
  const bridge = loadPanelBridge(LUA_PATH, STUBS + extra);
  // The helper's luaToJs pushes two stack slots per table level and the C API
  // only guarantees 20 free slots, which a nested inventory tree outgrows.
  // Grow the base frame once; it stays grown for later conversions.
  lua.lua_checkstack(bridge.L, 200);
  return bridge;
}

function sheet(bridge, args) {
  const result = bridge.callHandler('getCharacterSheet', args);
  expect(result.ok, result.err).toBe(true);
  return result.data;
}

function perkById(data, id) {
  return data.skills.perks.find((perk) => perk.id === id);
}

describe('getCharacterSheet: base fields and sections', () => {
  it('returns the default sections, with the identity and role fields', () => {
    const bridge = load();
    const data = sheet(bridge, { username: 'alice' });

    expect(data.schema).toBe(1);
    expect(data.generatedAt).toBe(1000);
    expect(data.username).toBe('Alice');
    expect(data.displayName).toBe('Alice (display)');
    expect(data.forename).toBe('Alice');
    expect(data.surname).toBe('Smith');
    expect(data.role).toEqual({ name: 'user', adminPower: false, canSpawnItems: false });
    expect(data.summary).toBeTruthy();
    expect(data.stats).toBeTruthy();
    expect(data.health).toEqual({ overall: 90, isInfected: false, numPartsBleeding: 0, temperature: 37 });
    expect(data.skills).toBeTruthy();
    expect(data.traits).toBeTruthy();
    expect(data.inventory ?? null).toBeNull();
    expect(data.sectionErrors).toEqual({});
    expect(data.cost).toEqual({ ms: 0, walked: 0 });
  });

  it('reads the summary: position, kills, weights, flags, occupation and XP settings', () => {
    const bridge = load();
    const { summary } = sheet(bridge, { username: 'Alice', sections: ['summary'] });

    expect(summary).toMatchObject({
      isAlive: true,
      isAsleep: false,
      isSneaking: false,
      isRunning: true,
      x: 100.5,
      y: 200.25,
      z: 0,
      hoursSurvived: 30.5,
      minutesPerDay: 60,
      zombieKills: 12,
      survivorKills: 1,
      bodyWeight: 80,
      carriedWeight: 12.5,
      maxWeight: 15,
      profession: { id: 'base:fireofficer', label: 'Fire Officer' },
      xpSandbox: { global: 1, globalToggle: true },
    });
    expect(summary.flags).toEqual({
      godMode: false,
      invisible: false,
      noClip: false,
      ghostMode: false,
      unlimitedCarry: false,
      unlimitedEndurance: false,
      knowAllRecipes: false,
      invincible: false,
    });
  });

  it('omits what cannot be read instead of sending a 0', () => {
    const bridge = load(`
Alice.getHoursSurvived = function() error("no hours") end
Alice.getNutrition = function() return nil end
getGameTime = nil
SandboxVars = nil
`);
    const { summary } = sheet(bridge, { username: 'Alice', sections: ['summary'] });
    expect(summary.hoursSurvived ?? null).toBeNull();
    expect(summary.bodyWeight ?? null).toBeNull();
    expect(summary.minutesPerDay ?? null).toBeNull();
    expect(summary.xpSandbox ?? null).toBeNull();
    expect(summary.zombieKills).toBe(12);
  });

  it('only runs the requested sections: sections={"skills"} never calls getInventory', () => {
    const bridge = load();
    const data = sheet(bridge, { username: 'Alice', sections: ['skills'] });

    expect(bridge.getGlobal('Alice').inventoryReads).toBe(0);
    expect(bridge.getGlobal('Alice').statsReads).toBe(0);
    expect(data.skills).toBeTruthy();
    for (const key of ['summary', 'stats', 'health', 'traits', 'inventory']) {
      expect(data[key] ?? null, key).toBeNull();
    }
    expect(data.role).toBeTruthy();
  });

  it('ignores unknown section names, and falls back to the defaults when none is known', () => {
    const bridge = load();
    const onlyTraits = sheet(bridge, { username: 'Alice', sections: ['traits', 'bogus'] });
    expect(onlyTraits.traits).toBeTruthy();
    expect(onlyTraits.summary ?? null).toBeNull();

    const fallback = sheet(bridge, { username: 'Bob', sections: ['bogus'] });
    expect(fallback.summary).toBeTruthy();
    expect(fallback.skills).toBeTruthy();
    expect(fallback.inventory ?? null).toBeNull();
  });

  it('rejects a missing username', () => {
    const bridge = load();
    expect(bridge.callHandler('getCharacterSheet', {})).toMatchObject({ ok: false, err: 'Username required' });
  });

  it('reports an unknown player with the lookup error the panel maps to offline', () => {
    const bridge = load();
    expect(bridge.callHandler('getCharacterSheet', { username: 'Zed' })).toMatchObject({
      ok: false,
      err: 'Player not found: Zed',
    });
  });

  it('passes the online-list failure through, so the panel does not call it offline', () => {
    const bridge = load('getOnlinePlayers = function() return nil end');
    expect(bridge.callHandler('getCharacterSheet', { username: 'Alice' })).toMatchObject({
      ok: false,
      err: 'Online player list unavailable',
    });
  });
});

describe('getCharacterSheet: role', () => {
  it('reads name, adminPower and canSpawnItems from getRole()', () => {
    const bridge = load(`Alice.role = { name = "moderator", adminPower = true, spawn = true }`);
    expect(sheet(bridge, { username: 'Alice' }).role).toEqual({
      name: 'moderator',
      adminPower: true,
      canSpawnItems: true,
    });
  });

  it('reads each field in its own pcall', () => {
    const bridge = load(`Alice.role = { name = "custom", adminThrows = true, spawn = true }`);
    expect(sheet(bridge, { username: 'Alice' }).role).toEqual({ name: 'custom', canSpawnItems: true });
  });

  it('leaves role out when getRole is unavailable', () => {
    const bridge = load('Alice.getRole = nil');
    const data = sheet(bridge, { username: 'Alice' });
    expect(data.role ?? null).toBeNull();
    expect(data.summary).toBeTruthy();
  });
});

describe('getCharacterSheet: stats', () => {
  it('sends each stat with its range', () => {
    const bridge = load();
    const { stats } = sheet(bridge, { username: 'Alice', sections: ['stats'] });
    expect(stats.hunger).toEqual({ value: 0.25, min: 0, max: 1 });
    expect(stats.boredom).toEqual({ value: 10, min: 0, max: 100 });
    expect(Object.keys(stats).sort()).toEqual([
      'boredom', 'endurance', 'fatigue', 'hunger', 'intoxication', 'pain', 'panic',
      'sickness', 'stress', 'thirst', 'unhappiness', 'wetness', 'zombieInfection',
    ]);
  });

  it('reads each stat range once, across sheets', () => {
    const bridge = load();
    sheet(bridge, { username: 'Alice', sections: ['stats'] });
    sheet(bridge, { username: 'Alice', sections: ['stats'], fresh: true });
    sheet(bridge, { username: 'Bob', sections: ['stats'] });
    const reads = bridge.getGlobal('StatRangeReads');
    expect(reads.HUNGER).toBe(1);
    expect(reads.ZOMBIE_INFECTION).toBe(1);
  });

  it('omits a stat that throws, and one whose range cannot be read', () => {
    const bridge = load(`
StatThrows.PANIC = true
CharacterStat.WETNESS.getMaximumValue = function() error("no max") end
`);
    const { stats } = sheet(bridge, { username: 'Alice', sections: ['stats'] });
    expect(stats.panic ?? null).toBeNull();
    expect(stats.wetness ?? null).toBeNull();
    expect(stats.hunger).toEqual({ value: 0.25, min: 0, max: 1 });
  });

  it('names the section when getStats is unavailable and still sends health', () => {
    const bridge = load('Alice.getStats = nil');
    const data = sheet(bridge, { username: 'Alice', sections: ['stats'] });
    expect(data.sectionErrors).toEqual({ stats: 'getStats unavailable' });
    expect(data.health.overall).toBe(90);
  });
});

describe('getCharacterSheet: skills', () => {
  it('splits categories from perks, including a mod perk', () => {
    const bridge = load();
    const { skills } = sheet(bridge, { username: 'Alice', sections: ['skills'] });

    expect(skills.categories).toEqual([
      { id: 'Combat', name: 'Combat' },
      { id: 'Passiv', name: 'Passive' },
      { id: 'Crafting', name: 'Crafting' },
    ]);
    expect(skills.perks.map((perk) => perk.id)).toEqual(['Axe', 'Fitness', 'Woodwork', 'Blacksmithing']);
    expect(perkById({ skills }, 'Axe')).toEqual({
      id: 'Axe',
      parent: 'Combat',
      name: 'Axe',
      passive: false,
      level: 3,
      xp: 320,
      levelXp: 300,
      nextLevelXp: 400,
      boost: 1,
      multiplier: 2,
      sandboxMultiplier: 2.5,
    });
    expect(perkById({ skills }, 'Fitness')).toMatchObject({ parent: 'Passiv', passive: true, level: 5 });
    expect(perkById({ skills }, 'Blacksmithing')).toMatchObject({ parent: 'Crafting', level: 2, xp: 250 });
    expect(perkById({ skills }, 'Blacksmithing').sandboxMultiplier ?? null).toBeNull();
  });

  it('has no nextLevelXp at level 10', () => {
    const bridge = load();
    const data = sheet(bridge, { username: 'Alice', sections: ['skills'] });
    expect(perkById(data, 'Woodwork')).toMatchObject({ level: 10, levelXp: 1000 });
    expect(perkById(data, 'Woodwork').nextLevelXp ?? null).toBeNull();
  });

  it('counts a throwing perk in `failed` and keeps going', () => {
    const bridge = load();
    const { skills } = sheet(bridge, { username: 'Alice', sections: ['skills'] });
    expect(skills.failed).toBe(1);
    expect(skills.perks).toHaveLength(4);
  });

  it('keeps the perks when XP cannot be read, without xp fields', () => {
    const bridge = load('Alice.getXp = nil');
    const data = sheet(bridge, { username: 'Alice', sections: ['skills'] });
    expect(perkById(data, 'Axe')).toMatchObject({ level: 3, levelXp: 300 });
    expect(perkById(data, 'Axe').xp ?? null).toBeNull();
  });

  it('names the section when PerkFactory is missing, and still sends the others', () => {
    const bridge = load('PerkFactory = nil');
    const data = sheet(bridge, { username: 'Alice' });
    expect(data.sectionErrors).toEqual({ skills: 'PerkFactory unavailable' });
    expect(data.skills ?? null).toBeNull();
    expect(data.summary).toBeTruthy();
    expect(data.traits).toBeTruthy();
  });
});

describe('getCharacterSheet: traits', () => {
  it('reads each trait through its definition, marking occupation traits', () => {
    const bridge = load();
    const { traits } = sheet(bridge, { username: 'Alice', sections: ['traits'] });
    expect(traits).toEqual([
      { id: 'base:athletic', label: 'Athletic', cost: 6, profession: false },
      { id: 'base:axeman', label: 'Axe Man', cost: 0, profession: true },
      // No definition: the id alone.
      { id: 'mod:strange' },
    ]);
  });

  it('keeps the id when the definition lookup throws', () => {
    const bridge = load(`CharacterTraitDefinition.getCharacterTraitDefinition = function() error("boom") end`);
    const { traits } = sheet(bridge, { username: 'Alice', sections: ['traits'] });
    expect(traits.map((trait) => trait.id)).toEqual(['base:athletic', 'base:axeman', 'mod:strange']);
    expect(traits[0].label ?? null).toBeNull();
  });
});

// Alice's inventory for the tests below:
//   main (depth 1)
//     Axe (two-handed: primary and secondary), 2 Nails objects (count 2 + 1),
//     2 Apples (conditions 5 and 8), a hidden TestMug, a broken entry,
//     a Hammer attached to the belt, a worn T-shirt,
//     Backpack (worn) -> depth 2: Nails, Bandage,
//       Pouch -> depth 3: Pen,
//         Box -> depth 4 contents: Pencil, Eraser
const INVENTORY = `
AxeItem = Item("Base.Axe", { id = 1, name = "Axe", category = "Weapon", weight = 3 })
HammerItem = Item("Base.Hammer", { id = 2, name = "Hammer", weight = 1 })
ShirtItem = Item("Base.Tshirt_DefaultTEXTURE", { id = 3, name = "T-Shirt", category = "Clothing" })
BoxItem = Item("Base.Box", { id = 20, name = "Box", contents = { Item("Base.Pencil"), Item("Base.Eraser") } })
PouchItem = Item("Base.Pouch", { id = 21, name = "Pouch", contents = { Item("Base.Pen"), BoxItem } })
BackpackItem = Item("Base.Bag_Schoolbag", {
  id = 22, name = "Loot bag", weight = 0.8, contentsWeight = 4, capacity = 18, effectiveCapacity = 20,
  contents = { Item("Base.Nails", { weight = 0.01 }), Item("Base.Bandage"), PouchItem },
})
Alice.inventory = Container({
  AxeItem,
  Item("Base.Nails", { count = 2, weight = 0.02, name = "Nails" }),
  Item("Base.Apple", { condition = 8, weight = 0.2 }),
  Item("Base.Nails", { count = 1, weight = 0.01, name = "Nails" }),
  Item("Base.Apple", { condition = 5, weight = 0.2 }),
  Item("Base.TestMug", { hidden = true, obsolete = true, modId = "pz-vanilla" }),
  Item("Base.Broken", { throws = true }),
  HammerItem,
  ShirtItem,
  BackpackItem,
}, { contentsWeight = 12, capacity = 8, effectiveCapacity = 9 })
Alice.opts.primary = AxeItem
Alice.opts.secondary = AxeItem
Alice.worn = { Entry(ShirtItem, Named("base:tshirt")), Entry(BackpackItem, Named("base:back")) }
Alice.attached = { Entry(HammerItem, "Belt Left") }
`;

function rowByType(rows, fullType) {
  return rows.find((row) => row.fullType === fullType);
}

describe('getCharacterSheet: inventory', () => {
  it('builds the worn, equipped and attached lists, with the two-handed weapon in both hands', () => {
    const bridge = load(INVENTORY);
    const { inventory } = sheet(bridge, { username: 'Alice', sections: ['inventory'] });

    expect(inventory.equipped).toEqual({
      primary: { itemId: 1, fullType: 'Base.Axe', name: 'Axe' },
      secondary: { itemId: 1, fullType: 'Base.Axe', name: 'Axe' },
    });
    expect(inventory.worn).toEqual([
      { itemId: 3, fullType: 'Base.Tshirt_DefaultTEXTURE', name: 'T-Shirt', location: 'base:tshirt' },
      { itemId: 22, fullType: 'Base.Bag_Schoolbag', name: 'Loot bag', location: 'base:back' },
    ]);
    expect(inventory.attached).toEqual([
      { itemId: 2, fullType: 'Base.Hammer', name: 'Hammer', location: 'Belt Left' },
    ]);
  });

  it('groups stacks by type, name and state, and marks equipped/worn/attached rows once', () => {
    const bridge = load(INVENTORY);
    const { inventory } = sheet(bridge, { username: 'Alice', sections: ['inventory'] });
    const { root } = inventory;

    expect(root).toMatchObject({ kind: 'container', itemId: 'main', contentsWeight: 12, capacity: 9, itemCount: 10 });

    const axe = rowByType(root.rows, 'Base.Axe');
    expect(axe).toMatchObject({ kind: 'stack', qty: 1, equipped: 'primary', worn: false, category: 'Weapon' });
    expect(root.rows.filter((row) => row.fullType === 'Base.Axe')).toHaveLength(1);

    const nails = root.rows.filter((row) => row.fullType === 'Base.Nails');
    expect(nails).toHaveLength(1);
    expect(nails[0].qty).toBe(3);
    expect(nails[0].weight).toBeCloseTo(0.03, 6);

    const apples = rowByType(root.rows, 'Base.Apple');
    expect(apples).toMatchObject({ qty: 2, condition: 5, conditionMax: 10 });
    expect(apples.weight).toBeCloseTo(0.4, 6);

    expect(rowByType(root.rows, 'Base.Hammer')).toMatchObject({ attached: 'Belt Left', qty: 1 });
    expect(rowByType(root.rows, 'Base.Tshirt_DefaultTEXTURE')).toMatchObject({ worn: true });
    expect(rowByType(root.rows, 'Base.TestMug')).toMatchObject({
      hidden: true,
      obsolete: true,
      modId: 'pz-vanilla',
      worn: false,
    });
  });

  it('never groups containers, and uses the container\'s own name and capacity', () => {
    const bridge = load(INVENTORY);
    const { inventory } = sheet(bridge, { username: 'Alice', sections: ['inventory'] });
    const backpack = rowByType(inventory.root.rows, 'Base.Bag_Schoolbag');

    expect(backpack).toMatchObject({
      kind: 'container',
      itemId: 22,
      name: 'Loot bag',
      weight: 0.8,
      contentsWeight: 4,
      capacity: 20,
      itemCount: 3,
      worn: true,
    });
    expect(backpack.rows.map((row) => row.fullType)).toEqual(['Base.Nails', 'Base.Bandage', 'Base.Pouch']);
  });

  it('falls back to getCapacity() when getEffectiveCapacity throws', () => {
    const bridge = load(`
Alice.inventory = Container({ Item("Base.Bag_Schoolbag", { contents = {}, capacity = 18, effectiveThrows = true }) })
`);
    const { inventory } = sheet(bridge, { username: 'Alice', sections: ['inventory'] });
    expect(inventory.root.rows[0]).toMatchObject({ kind: 'container', capacity: 18, itemCount: 0 });
  });

  it('descends to maxDepth and reports the real size below it', () => {
    const bridge = load(INVENTORY);
    const { inventory } = sheet(bridge, { username: 'Alice', sections: ['inventory'] });
    const backpack = rowByType(inventory.root.rows, 'Base.Bag_Schoolbag');
    const pouch = rowByType(backpack.rows, 'Base.Pouch');
    const box = rowByType(pouch.rows, 'Base.Box');

    expect(pouch.truncatedDepth ?? null).toBeNull();
    expect(box).toMatchObject({ kind: 'container', truncatedDepth: true, itemCount: 2 });
    expect(box.rows ?? null).toBeNull();
    expect(inventory.totals).toMatchObject({ maxDepth: 3, truncated: false });

    const shallow = sheet(bridge, { username: 'Alice', sections: ['inventory'], maxDepth: 1 }).inventory;
    const shallowBackpack = rowByType(shallow.root.rows, 'Base.Bag_Schoolbag');
    expect(shallowBackpack).toMatchObject({ truncatedDepth: true, itemCount: 3 });
    expect(shallowBackpack.rows ?? null).toBeNull();
  });

  it('counts a broken entry as skipped and keeps walking', () => {
    const bridge = load(INVENTORY);
    const { totals } = sheet(bridge, { username: 'Alice', sections: ['inventory'] }).inventory;
    // 10 in main + 3 in the backpack + 2 in the pouch.
    expect(totals.walked).toBe(15);
    expect(totals.skipped).toBe(1);
    expect(totals.truncated).toBe(false);
    expect(totals.truncatedReason ?? null).toBeNull();
    // Units: Axe 1, Nails 3, Apple 2, TestMug 1, Hammer 1, T-shirt 1, backpack 1,
    // then Nails 1, Bandage 1, pouch 1, then Pen 1, box 1.
    expect(totals.itemCount).toBe(15);
    // Stack types only: Axe, Nails, Apple, TestMug, Hammer, T-shirt, Bandage, Pen.
    expect(totals.distinctTypes).toBe(8);
  });

  it('reads isHidden once per type per walk', () => {
    const bridge = load(INVENTORY);
    sheet(bridge, { username: 'Alice', sections: ['inventory'] });
    const reads = bridge.getGlobal('HiddenReads');
    // Nails: 2 objects in main and 1 in the backpack.
    expect(reads['Base.Nails']).toBe(1);
    expect(reads['Base.Apple']).toBe(1);
    // Containers take their facts from the row, not the type table.
    expect(reads['Base.Bag_Schoolbag'] ?? null).toBeNull();
  });

  it('stops at maxItems and says so', () => {
    const bridge = load(`
local many = {}
for i = 1, 120 do many[i] = Item("Base.Nails") end
Alice.inventory = Container(many)
`);
    const { inventory, cost } = sheet(bridge, { username: 'Alice', sections: ['inventory'], maxItems: 50 });
    expect(inventory.totals).toMatchObject({ walked: 50, truncated: true, truncatedReason: 'maxItems', maxItems: 50 });
    expect(inventory.root.rows).toHaveLength(1);
    expect(inventory.root.rows[0].qty).toBe(50);
    expect(inventory.root.itemCount).toBe(120);
    expect(cost.walked).toBe(50);
  });

  it('does not flag truncation when the inventory holds exactly maxItems', () => {
    const bridge = load(`
local many = {}
for i = 1, 50 do many[i] = Item("Base.Nails") end
Alice.inventory = Container(many)
`);
    const { totals } = sheet(bridge, { username: 'Alice', sections: ['inventory'], maxItems: 50 }).inventory;
    expect(totals).toMatchObject({ walked: 50, truncated: false });
  });

  it('checks the clock every 25 items and stops when budgetMs runs out', () => {
    const bridge = load(`
local many = {}
for i = 1, 200 do many[i] = Item("Base.Nails") end
Alice.inventory = Container(many)
ItemCostMs = 1
`);
    const { inventory } = sheet(bridge, { username: 'Alice', sections: ['inventory'], budgetMs: 20 });
    expect(inventory.totals).toMatchObject({ walked: 25, truncated: true, truncatedReason: 'timeBudget', budgetMs: 20 });
    expect(inventory.root.rows[0].qty).toBe(25);
  });

  it('clamps the limits', () => {
    const bridge = load();
    const low = sheet(bridge, { username: 'Alice', sections: ['inventory'], maxItems: 5, maxDepth: 0, budgetMs: 1 });
    expect(low.inventory.totals).toMatchObject({ maxItems: 50, maxDepth: 1, budgetMs: 5 });
    const high = sheet(bridge, { username: 'Alice', sections: ['inventory'], maxItems: 5000, maxDepth: 9, budgetMs: 999 });
    expect(high.inventory.totals).toMatchObject({ maxItems: 1000, maxDepth: 4, budgetMs: 50 });
    const defaults = sheet(bridge, { username: 'Bob', sections: ['inventory'] });
    expect(defaults.inventory.totals).toMatchObject({ maxItems: 500, maxDepth: 3, budgetMs: 20 });
  });

  it('names the section when getInventory is unavailable', () => {
    const bridge = load('Alice.getInventory = nil');
    const data = sheet(bridge, { username: 'Alice', sections: ['inventory', 'summary'] });
    expect(data.sectionErrors).toEqual({ inventory: 'getInventory unavailable' });
    expect(data.summary).toBeTruthy();
  });
});

describe('getCharacterSheet: cache', () => {
  it('serves a repeat within 3 s from the cache, then reads again', () => {
    const bridge = load();
    sheet(bridge, { username: 'Alice', sections: ['stats'] });
    const again = sheet(bridge, { username: 'ALICE', sections: ['stats'] });
    expect(again.generatedAt).toBe(1000);
    expect(bridge.getGlobal('Alice').statsReads).toBe(1);

    bridge.run('Now = 3999');
    sheet(bridge, { username: 'Alice', sections: ['stats'] });
    expect(bridge.getGlobal('Alice').statsReads).toBe(1);

    bridge.run('Now = 4000');
    const later = sheet(bridge, { username: 'Alice', sections: ['stats'] });
    expect(later.generatedAt).toBe(4000);
    expect(bridge.getGlobal('Alice').statsReads).toBe(2);
  });

  it('keeps a sheet with the inventory for 10 s', () => {
    const bridge = load();
    sheet(bridge, { username: 'Alice', sections: ['inventory'] });
    bridge.run('Now = 10999');
    sheet(bridge, { username: 'Alice', sections: ['inventory'] });
    expect(bridge.getGlobal('Alice').inventoryReads).toBe(1);
    bridge.run('Now = 11000');
    sheet(bridge, { username: 'Alice', sections: ['inventory'] });
    expect(bridge.getGlobal('Alice').inventoryReads).toBe(2);
  });

  it('keys by player, by sections in any order, and by the inventory limits', () => {
    const bridge = load();
    sheet(bridge, { username: 'Alice', sections: ['stats', 'summary'] });
    sheet(bridge, { username: 'alice', sections: ['summary', 'stats'] });
    expect(bridge.getGlobal('Alice').statsReads).toBe(1);

    const bob = sheet(bridge, { username: 'Bob', sections: ['stats', 'summary'] });
    expect(bob.username).toBe('Bob');
    expect(bridge.getGlobal('Bob').statsReads).toBe(1);

    sheet(bridge, { username: 'Alice', sections: ['stats'] });
    expect(bridge.getGlobal('Alice').statsReads).toBe(2);

    sheet(bridge, { username: 'Alice', sections: ['inventory'] });
    sheet(bridge, { username: 'Alice', sections: ['inventory'], maxItems: 100 });
    expect(bridge.getGlobal('Alice').inventoryReads).toBe(2);
  });

  it('fresh=true reads again and refreshes the cached answer', () => {
    const bridge = load();
    sheet(bridge, { username: 'Alice', sections: ['stats'] });
    bridge.run('Now = 2000; StatValues.HUNGER = 0.75');
    const fresh = sheet(bridge, { username: 'Alice', sections: ['stats'], fresh: true });
    expect(fresh.stats.hunger.value).toBe(0.75);
    expect(bridge.getGlobal('Alice').statsReads).toBe(2);

    bridge.run('Now = 2500');
    const cached = sheet(bridge, { username: 'Alice', sections: ['stats'] });
    expect(cached.generatedAt).toBe(2000);
    expect(bridge.getGlobal('Alice').statsReads).toBe(2);
  });

  it('does not serve a cached sheet for a player who left', () => {
    const bridge = load();
    sheet(bridge, { username: 'Bob', sections: ['stats'] });
    bridge.run('OnlinePlayers = JList({ Alice })');
    expect(bridge.callHandler('getCharacterSheet', { username: 'Bob', sections: ['stats'] })).toMatchObject({
      ok: false,
      err: 'Player not found: Bob',
    });
  });

  it('refetches when the clock moves back', () => {
    const bridge = load();
    sheet(bridge, { username: 'Alice', sections: ['stats'] });
    bridge.run('Now = 500');
    sheet(bridge, { username: 'Alice', sections: ['stats'] });
    expect(bridge.getGlobal('Alice').statsReads).toBe(2);
  });

  it('holds at most 16 answers and evicts the oldest', () => {
    const bridge = load();
    const names = ['summary', 'stats', 'skills', 'traits', 'inventory'];
    // The 16 section sets that include stats: 16 keys for Alice, cached one
    // millisecond apart.
    const sets = [];
    for (let mask = 1; mask < 32; mask++) {
      const set = names.filter((_, i) => mask & (1 << i));
      if (set.includes('stats')) sets.push(set);
    }
    expect(sets).toHaveLength(16);
    sets.forEach((set, i) => {
      bridge.run(`Now = ${1000 + i}`);
      sheet(bridge, { username: 'Alice', sections: set });
    });
    expect(bridge.getGlobal('Alice').statsReads).toBe(16);

    // A 17th key evicts the oldest (sets[0]); sets[1] stays cached.
    bridge.run('Now = 1100');
    sheet(bridge, { username: 'Bob', sections: ['stats'] });
    sheet(bridge, { username: 'Alice', sections: sets[1] });
    expect(bridge.getGlobal('Alice').statsReads).toBe(16);
    sheet(bridge, { username: 'Alice', sections: sets[0] });
    expect(bridge.getGlobal('Alice').statsReads).toBe(17);
  });
});

// The dispatcher side: processCommands() reads the inbox files, so the file
// API is stubbed as in panelBridgeSandboxOptionsCacheInvalidation.test.js.
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

function enqueue(bridge, commands, startSeq) {
  bridge.run(commands.map((cmd, i) => {
    const n = startSeq + i;
    const seq = String(n).padStart(10, '0');
    const json = JSON.stringify({ seq: n, ...cmd });
    return `FILES["panelbridge/TestServer/inbox/cmd-${seq}.json"] = ${JSON.stringify(json)}`;
  }).join('\n'));
}

describe('getCharacterSheet: dispatcher', () => {
  it('leaves a primed getAllPlayerDetails cache in place and logs at DEBUG', () => {
    const bridge = load(FILE_STUBS);

    enqueue(bridge, [{ id: 'all1', action: 'getAllPlayerDetails' }], 1);
    bridge.run('PanelBridgeModule.processCommands()');

    // A change the cached list must not show yet.
    bridge.run('Alice.getX = function() return 999 end');
    enqueue(bridge, [
      { id: 'sheet', action: 'getCharacterSheet', args: { username: 'Alice' } },
      { id: 'all2', action: 'getAllPlayerDetails' },
    ], 2);
    bridge.run('PanelBridgeModule.processCommands()');

    const state = bridge.getGlobal('PanelBridgeModule');
    const byId = Object.fromEntries(state.pendingResults.map((r) => [r.id, r]));
    expect(byId.sheet.success).toBe(true);
    expect(byId.sheet.data.summary.x).toBe(999);
    expect(byId.all2.success).toBe(true);
    expect(byId.all2.data.players.find((p) => p.username === 'Alice').x).toBe(100.5);

    const messages = state.debugLog.map((e) => [e.level, e.message]);
    expect(messages).toContainEqual(['DEBUG', 'Processing command: getCharacterSheet']);
    expect(messages).not.toContainEqual(['INFO', 'Processing command: getCharacterSheet']);
    expect(messages).toContainEqual(['DEBUG', 'Command served from cache: getAllPlayerDetails']);
  });

  it('control: an action outside READ_ONLY_UNCACHED_ACTIONS still clears that cache', () => {
    const bridge = load(FILE_STUBS);
    enqueue(bridge, [{ id: 'all1', action: 'getAllPlayerDetails' }], 1);
    bridge.run('PanelBridgeModule.processCommands()');
    bridge.run('Alice.getX = function() return 999 end');
    // getPlayerDetails reads too, but isn't exempt (a follow-up once the old
    // Vitals poll is gone), so it drops the live caches like any action.
    enqueue(bridge, [
      { id: 'details', action: 'getPlayerDetails', args: { username: 'Alice' } },
      { id: 'all2', action: 'getAllPlayerDetails' },
    ], 2);
    bridge.run('PanelBridgeModule.processCommands()');

    const state = bridge.getGlobal('PanelBridgeModule');
    const byId = Object.fromEntries(state.pendingResults.map((r) => [r.id, r]));
    expect(byId.details.success).toBe(true);
    expect(byId.all2.data.players.find((p) => p.username === 'Alice').x).toBe(999);
  });
});
