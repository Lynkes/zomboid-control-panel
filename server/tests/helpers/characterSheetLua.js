// Engine stubs for PanelBridge.lua's getCharacterSheet handler under fengari,
// shared by panelBridgeCharacterSheet.test.js (the handler itself) and
// characterSheetContract.test.js (its output through the panel's
// normalizeSheet and computeCharacterHints).
//
// The stubs follow the shapes javap shows on the 42.21 jar:
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
import path from "path";
import { fileURLToPath } from "url";
import { loadPanelBridge } from "./panelBridgeLua.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PANEL_BRIDGE_LUA_PATH = path.join(__dirname, "..", "..", "..", "pz-mod", "PanelBridge", "media", "lua", "server", "PanelBridge.lua");

export const CHARACTER_SHEET_STUBS = `
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
  -- The script's instancing count (Nails 5 on B42), not a stack size: the
  -- handler must not read it (each object is one unit).
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

// Alice's inventory for the tests below:
//   main (depth 1)
//     Axe (two-handed: primary and secondary), 2 Nails objects (one reporting
//     getCount() 2, which the walk ignores),
//     2 Apples (conditions 5 and 8), a hidden TestMug, a broken entry,
//     a Hammer attached to the belt, a worn T-shirt,
//     Backpack (worn) -> depth 2: Nails, Bandage,
//       Pouch -> depth 3: Pen,
//         Box -> depth 4 contents: Pencil, Eraser
export const CHARACTER_SHEET_INVENTORY = `
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

/** PanelBridge.lua loaded over the stubs above, plus `extra` Lua run after them. */
export function loadCharacterSheetBridge(extra = "") {
  return loadPanelBridge(PANEL_BRIDGE_LUA_PATH, CHARACTER_SHEET_STUBS + extra);
}
