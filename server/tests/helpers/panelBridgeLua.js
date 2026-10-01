// Loads the real pz-mod/PanelBridge/media/lua/server/PanelBridge.lua under
// fengari (a pure-JS Lua 5.3 VM) so its handler logic can be exercised from
// vitest, with fake game-global stubs (getWorld, getSandboxOptions, etc.)
// standing in for Project Zomboid's real API.
//
// HONEST LIMIT -- read this before trusting a green run of anything built on
// this harness: every stub here encodes OUR BELIEF about what a PZ object's
// method looks like (name, arguments, return shape), sourced from reading
// the game's real B42 jar by hand. It is NOT the game itself, and nothing
// here talks to a running PZ instance. A test passing means "PanelBridge.lua's
// logic does what we intended, given inputs shaped the way we believe PZ
// shapes them." It does NOT mean "verified against Project Zomboid." If a
// stub's shape is wrong -- PZ renames a method, changes an arg, changes what
// a getter returns on some game version -- every test built on that stub can
// stay green while the real mod is broken. Kevin's PZ-B42-jar-verified
// (receiver, method) findings and the corresponding real B42 jar audit are
// the actual verified-against-truth work; this harness tests logic sitting
// on top of that, not the truth of the API surface itself.
import fs from 'fs';
import { lua, lauxlib, lualib, to_luastring } from 'fengari';

// Minimal top-level stubs every load needs, regardless of which handler a
// test is exercising -- PanelBridge.lua's own bottom-of-file event
// registration (Events.OnServerStarted.Add / Events.OnTickEvenPaused.Add)
// runs at load time once the file's first statement, the isServer() load
// guard, lets a dedicated server through.
const BASE_STUBS = `
Events = {
  OnServerStarted = { Add = function() end },
  OnTickEvenPaused = { Add = function() end },
}
isServer = function() return true end
getTimestampMs = function() return 0 end
`;

// Optional engine stubs, layered after BASE_STUBS and before the test's own
// extraStubLua (which can still override anything). Every option defaults to
// "leave it as it was", so existing callers load exactly as before. Same
// honest limit as the file header: these encode what javap on the 42.20 jar
// says the globals return (LuaManager$GlobalObject), not a running game.
//
//   isServer: boolean -- GameServer.server (BASE_STUBS already says true);
//     null removes the global entirely.
//   isClient: boolean -- GameClient.client; undefined leaves it undefined.
//   countEvents: true -- replaces Events with a table that makes any
//     Events.<Name> on demand and appends <Name> to EVENT_ADDS per Add call.
//   filenameOfClosure: string | { throws: string } -- getFilenameOfClosure(fn).
//     The real one returns closure.prototype.filename, so the stub insists on
//     a function argument. Calls are counted in GET_FILENAME_OF_CLOSURE_CALLS.
//   activatedMods: string[] | { throws: string } -- getActivatedMods(), an
//     ArrayList<String> (size/get/iterator shaped like the other collection
//     fakes in these tests).
//   modInfo: { [modId]: { modVersion?: string, workshopId?: string|null } }
//     | { throws: string } -- getModInfoByID(id), nil for an unknown id (the
//     real ChooseGameInfo.getModDetails returns null). Calls are counted in
//     GET_MOD_INFO_CALLS.
function engineStubLua(engine = {}) {
  const parts = [];
  if (engine.isServer === null) parts.push('isServer = nil');
  else if (typeof engine.isServer === 'boolean') parts.push(`isServer = function() return ${engine.isServer} end`);
  if (typeof engine.isClient === 'boolean') parts.push(`isClient = function() return ${engine.isClient} end`);
  if (engine.countEvents) {
    parts.push(`
EVENT_ADDS = {}
Events = setmetatable({}, { __index = function(events, name)
  local event = { Add = function(fn) table.insert(EVENT_ADDS, name) end }
  rawset(events, name, event)
  return event
end })`);
  }
  if (engine.filenameOfClosure !== undefined) {
    const body = typeof engine.filenameOfClosure === 'object'
      ? `error(${jsToLuaLiteral(engine.filenameOfClosure.throws)})`
      : `return ${jsToLuaLiteral(engine.filenameOfClosure)}`;
    parts.push(`
GET_FILENAME_OF_CLOSURE_CALLS = 0
getFilenameOfClosure = function(fn)
  GET_FILENAME_OF_CLOSURE_CALLS = GET_FILENAME_OF_CLOSURE_CALLS + 1
  if type(fn) ~= "function" then error("getFilenameOfClosure expects a LuaClosure") end
  ${body}
end`);
  }
  if (engine.activatedMods !== undefined) {
    if (Array.isArray(engine.activatedMods)) {
      const items = engine.activatedMods.map(jsToLuaLiteral).join(', ');
      parts.push(`
getActivatedMods = function()
  local items = { ${items} }
  local list = {}
  function list:size() return #items end
  function list:get(i) return items[i + 1] end
  function list:iterator()
    local index = 0
    local it = {}
    function it:hasNext() return index < #items end
    function it:next() index = index + 1; return items[index] end
    return it
  end
  return list
end`);
    } else {
      parts.push(`getActivatedMods = function() error(${jsToLuaLiteral(engine.activatedMods.throws)}) end`);
    }
  }
  if (engine.modInfo !== undefined) {
    if (typeof engine.modInfo.throws === 'string') {
      parts.push(`
GET_MOD_INFO_CALLS = 0
getModInfoByID = function(id)
  GET_MOD_INFO_CALLS = GET_MOD_INFO_CALLS + 1
  error(${jsToLuaLiteral(engine.modInfo.throws)})
end`);
    } else {
      const entries = Object.entries(engine.modInfo).map(([id, info]) => {
        const version = info.modVersion == null ? 'nil' : jsToLuaLiteral(info.modVersion);
        const workshopId = info.workshopId == null ? 'nil' : jsToLuaLiteral(info.workshopId);
        return `[${jsToLuaLiteral(id)}] = { modVersion = ${version}, workshopId = ${workshopId} }`;
      });
      parts.push(`
GET_MOD_INFO_CALLS = 0
local modInfoById = { ${entries.join(', ')} }
getModInfoByID = function(id)
  GET_MOD_INFO_CALLS = GET_MOD_INFO_CALLS + 1
  local data = modInfoById[id]
  if not data then return nil end
  local info = {}
  function info:getModVersion() return data.modVersion end
  function info:getWorkshopID() return data.workshopId end
  return info
end`);
    }
  }
  return parts.join('\n');
}

/**
 * The first executable line of a Lua source, skipping blank space, -- line
 * comments and --[[ ]] / --[==[ ]==] block comments (PanelBridge.lua opens
 * with a long one). For the load-guard tests, which need the guard to run
 * before anything else in the file.
 */
export function firstLuaStatement(source) {
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      i += space[0].length;
      continue;
    }
    const block = /^--\[(=*)\[/.exec(rest);
    if (block) {
      const close = `]${block[1]}]`;
      const end = source.indexOf(close, i + block[0].length);
      if (end === -1) throw new Error('firstLuaStatement: unterminated block comment');
      i = end + close.length;
      continue;
    }
    if (rest.startsWith('--')) {
      const newline = source.indexOf('\n', i);
      i = newline === -1 ? source.length : newline + 1;
      continue;
    }
    return rest.split(/\r?\n/, 1)[0].trim();
  }
  return null;
}

function runOrThrow(L, code, label) {
  const st = lauxlib.luaL_loadstring(L, to_luastring(code));
  if (st !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    throw new Error(`[${label || 'lua'}] compile error: ${err}`);
  }
  const rc = lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0);
  if (rc !== lua.LUA_OK) {
    const err = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    throw new Error(`[${label || 'lua'}] runtime error: ${err}`);
  }
}

// Recursively converts the Lua value at the given stack index into a plain
// JS value. Does not pop -- caller owns stack discipline. A table with keys
// forming a contiguous 1..n integer sequence becomes a JS array (matches how
// PanelBridge.lua itself builds lists via table.insert); anything else
// becomes a plain object with string keys. A Lua nil field is simply absent
// from the resulting object (Lua's own nil-omits-the-key semantics), not
// present as an explicit null -- callers asserting on an absent field should
// accept both undefined and null.
function luaToJs(L, index) {
  index = lua.lua_absindex(L, index);
  const t = lua.lua_type(L, index);
  switch (t) {
    case lua.LUA_TNIL:
      return null;
    case lua.LUA_TBOOLEAN:
      return lua.lua_toboolean(L, index);
    case lua.LUA_TNUMBER:
      return lua.lua_tonumber(L, index);
    case lua.LUA_TSTRING:
      return lua.lua_tojsstring(L, index);
    case lua.LUA_TTABLE: {
      const entries = [];
      // Each nesting level holds a key and a value on the stack, and the C
      // API only guarantees 20 free slots: grow as deep tables need it.
      lua.lua_checkstack(L, 4);
      lua.lua_pushnil(L);
      while (lua.lua_next(L, index) !== 0) {
        const key = luaToJs(L, -2);
        const value = luaToJs(L, -1);
        entries.push([key, value]);
        lua.lua_pop(L, 1); // pop value, keep key for next lua_next
      }
      const isArray = entries.length > 0 && entries.every(
        ([k], i) => typeof k === 'number' && k === i + 1,
      );
      if (isArray) return entries.map(([, v]) => v);
      const obj = {};
      for (const [k, v] of entries) obj[String(k)] = v;
      return obj;
    }
    default:
      // function/userdata/thread -- not JSON-shaped, describe it instead of
      // silently coercing to null (a test asserting on this is a test bug).
      return `<lua ${lua.lua_typename(L, t)}>`;
  }
}

// Renders a plain JS value (string/number/boolean/null/array/object) as a
// Lua literal, for building one-off argument tables from a test. Deliberately
// narrow -- this is for handler ARGS, which are always plain JSON-shaped
// data in the real system (they arrive over the file-based IPC as JSON).
function jsToLuaLiteral(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (Array.isArray(value)) return `{${value.map(jsToLuaLiteral).join(', ')}}`;
  if (typeof value === 'object') {
    const parts = Object.entries(value).map(([k, v]) => `[${jsToLuaLiteral(k)}] = ${jsToLuaLiteral(v)}`);
    return `{${parts.join(', ')}}`;
  }
  throw new Error(`jsToLuaLiteral: unsupported value ${JSON.stringify(value)}`);
}

/**
 * Loads the real PanelBridge.lua under a fresh fengari state, with the given
 * extra Lua source injected as game-global stubs before the mod file runs.
 * Returns a handle for calling handlers.* and running arbitrary follow-up
 * Lua snippets against the same state.
 *
 * extraStubLua: a Lua source string defining any of getWorld, getSandboxOptions,
 * getPlayerByUsername, etc. that the handler(s) under test touch.
 * engine: optional engine stubs, see engineStubLua above.
 *
 * PanelBridgeModule is whatever the chunk returned: the PanelBridge table on
 * a dedicated server, nil when its load guard stopped it.
 */
export function loadPanelBridge(luaPath, extraStubLua = '', engine = {}) {
  return loadLuaChunk(luaPath, 'PanelBridge.lua', extraStubLua, engine);
}

/**
 * Loads the real PanelBridgeClient.lua the same way. Its chunk returns
 * nothing, so PanelBridgeModule stays nil; tests observe it through the
 * engine stubs it touches (countEvents, sendClientCommand fakes, ...).
 */
export function loadPanelBridgeClient(luaPath, extraStubLua = '', engine = {}) {
  return loadLuaChunk(luaPath, 'PanelBridgeClient.lua', extraStubLua, engine);
}

function loadLuaChunk(luaPath, label, extraStubLua, engine) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  runOrThrow(L, BASE_STUBS, 'base-stubs');
  const engineStubs = engineStubLua(engine);
  if (engineStubs) runOrThrow(L, engineStubs, 'engine-stubs');
  if (extraStubLua) runOrThrow(L, extraStubLua, 'test-stubs');

  const src = fs.readFileSync(luaPath, 'utf8');
  const top = lua.lua_gettop(L);
  runOrThrow(L, src, label);
  // A chunk that returns early (the load guards) leaves nothing on the stack.
  if (lua.lua_gettop(L) === top) lua.lua_pushnil(L);
  lua.lua_setglobal(L, to_luastring('PanelBridgeModule'));
  lua.lua_settop(L, top);

  return {
    L,
    /** Run an arbitrary Lua snippet against the loaded state (e.g. to flip a fake's state between calls). */
    run(code) {
      runOrThrow(L, code, 'test-snippet');
    },
    /**
     * Calls PanelBridgeModule.handlers[name](args) and returns
     * { ok, data, err } as plain JS values, matching the (ok, data, err)
     * contract every handler in PanelBridge.lua follows.
     */
    callHandler(name, args = {}) {
      const argsLua = jsToLuaLiteral(args);
      runOrThrow(L, `
        local __ok, __data, __err = PanelBridgeModule.handlers.${name}(${argsLua})
        __LAST_RESULT = { ok = __ok, data = __data, err = __err }
      `, `call ${name}`);
      lua.lua_getglobal(L, to_luastring('__LAST_RESULT'));
      const result = luaToJs(L, -1);
      lua.lua_pop(L, 1);
      return result;
    },
    /** Reads a global's current value as plain JS (e.g. a fake's call counter). */
    getGlobal(name) {
      lua.lua_getglobal(L, to_luastring(name));
      const value = luaToJs(L, -1);
      lua.lua_pop(L, 1);
      return value;
    },
  };
}
