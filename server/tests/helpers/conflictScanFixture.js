import fs from "fs";
import path from "path";

// A generated Workshop folder of many mods, shaped like a real heavy modlist,
// for the conflict scanner's performance test. Deterministic (no randomness)
// so two runs scan exactly the same bytes.
//
// Per mod (about 25 files): B42 layout for 3 of every 5 mods (42/mod.info,
// common/media + 42/media), the old root layout for the rest; unique Lua,
// script, translation and texture files; and, every few mods, a file another
// mod ships too (a vanilla Lua override, a shared script file, an item both
// redefine, a shared texture that is sometimes byte-identical, a shared
// translation key).

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function luaBody(modId, kind, lines = 40) {
  let out = `-- ${modId} ${kind}\nlocal ${modId}_${kind} = {}\n`;
  for (let i = 0; i < lines; i++) {
    out += `function ${modId}_${kind}.fn${i}(a, b)\n  return a + b + ${i}\nend\n`;
  }
  out += `Events.OnGameStart.Add(function() print("${modId}") end)\nreturn ${modId}_${kind}\n`;
  return out;
}

function scriptBody(modId, count = 20) {
  let out = `module ${modId} {\n  imports { Base }\n`;
  for (let i = 0; i < count; i++) {
    out += `  item ${modId}Item${i}\n  {\n    DisplayName = ${modId} Item ${i},\n    Weight = 0.${(i % 9) + 1},\n    Icon = ${modId}Icon${i},\n  }\n`;
  }
  return out + "}\n";
}

export const PERF_WORKSHOP_BASE = 3_000_000_000;

/**
 * Writes `modCount` mods (one per Workshop item) under
 * <installPath>/steamapps/workshop/content/108600 and returns
 * { workshopIds, modIds } in load order.
 */
export function writeConflictScanFixture(installPath, modCount = 400) {
  const content = path.join(installPath, "steamapps", "workshop", "content", "108600");
  const workshopIds = [];
  const modIds = [];
  const png = Buffer.alloc(2048, 7);
  for (let n = 0; n < modCount; n++) {
    const wsId = String(PERF_WORKSHOP_BASE + n);
    const modId = `PerfMod${n}`;
    workshopIds.push(wsId);
    modIds.push(modId);
    const modRoot = path.join(content, wsId, "mods", modId);
    const b42 = n % 5 < 3;
    const modInfo = `name=Perf Mod ${n}\nid=${modId}\n${n % 9 === 1 && n > 1 ? `require=\\PerfMod${n - 1}\n` : ""}`;
    let mediaCommon;
    let mediaVersion;
    if (b42) {
      write(path.join(modRoot, "42", "mod.info"), modInfo);
      write(path.join(modRoot, "common", "poster.png"), png);
      mediaCommon = path.join(modRoot, "common", "media");
      mediaVersion = path.join(modRoot, "42", "media");
    } else {
      write(path.join(modRoot, "mod.info"), modInfo);
      write(path.join(modRoot, "poster.png"), png);
      mediaCommon = path.join(modRoot, "media");
      mediaVersion = mediaCommon;
    }
    // Unique files.
    write(path.join(mediaVersion, "lua", "client", `${modId}_UI.lua`), luaBody(modId, "UI"));
    write(path.join(mediaVersion, "lua", "shared", `${modId}_Shared.lua`), luaBody(modId, "Shared"));
    write(path.join(mediaVersion, "lua", "server", `${modId}_Server.lua`), luaBody(modId, "Server", 20));
    write(path.join(mediaVersion, "scripts", `${modId}_items.txt`), scriptBody(modId));
    const translation = {};
    for (let i = 0; i < 20; i++) translation[`ItemName_${modId}.${modId}Item${i}`] = `${modId} Item ${i}`;
    if (n % 7 === 0) translation["ItemName_Base.Axe"] = `Axe (${modId})`;
    write(
      path.join(mediaVersion, "lua", "shared", "Translate", "EN", "ItemName.json"),
      JSON.stringify(translation, null, 2),
    );
    for (let i = 0; i < 12; i++) {
      write(path.join(mediaCommon, "textures", modId, `Item_${modId}_${i}.png`), png);
    }
    for (let i = 0; i < 3; i++) {
      write(path.join(mediaCommon, "sound", modId, `${modId}_${i}.ogg`), Buffer.alloc(4096, n % 251));
    }
    // Shared paths.
    if (n % 10 === 0) {
      write(
        path.join(mediaVersion, "lua", "client", "ISUI", "ISInventoryPaneContextMenu.lua"),
        `${luaBody(modId, "Ctx", 10)}\nfunction ISInventoryPaneContextMenu.createMenu(player, isInPlayerInventory, items, x, y, origin)\n  return nil\nend\n`,
      );
    }
    if (n % 5 === 0) {
      write(path.join(mediaVersion, "scripts", "items_weapons.txt"), scriptBody(`Shared${n}`, 5));
    }
    if (n % 7 === 0) {
      write(
        path.join(mediaVersion, "scripts", `${modId}_axe.txt`),
        `module Base {\n  item Axe\n  {\n    DisplayName = Axe,\n    MaxDamage = ${2 + (n % 5)},\n  }\n}\n`,
      );
    }
    if (n % 4 === 0) {
      write(
        path.join(mediaCommon, "textures", "Item_SharedIcon.png"),
        n % 8 === 0 ? png : Buffer.alloc(2048, n % 251),
      );
    }
    if (n % 6 === 0) write(path.join(mediaCommon, "readme.txt"), `Perf mod ${n}\n`);
  }
  return { workshopIds, modIds };
}
