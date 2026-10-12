import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPanelBridge } from './helpers/panelBridgeLua.js';

// zombie.GameTime.getDay() / setDay(int) work on a ZERO-BASED day field
// (javap -c, 42.21: getDay returns `day`, getDayPlusOne returns day + 1, setDay
// is a plain putfield). Vanilla's DebugDemoTime.lua shows getDay() + 1 and
// rolls the month over at getDay() >= daysInMonth().
//
// getGameTime returned the raw field while it converted the month to one-based,
// and setGameTime wrote the typed number straight into it. The Events page's
// Clock card therefore showed day 14 on the 15th, typing 20 set the 21st, and
// on the 1st the field read 0, which POST /time (day 1-31) rejects, so "Set
// Time" failed for the first day of every month. Both now speak the calendar
// day (1 = the 1st).

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

// FakeGameTime keeps the zero-based `dayField` the real object keeps.
const STUBS = `
FakeGameTime = { dayField = 14, monthField = 5, yearField = 1993, timeOfDay = 12.5 }
function FakeGameTime:getTimeOfDay() return self.timeOfDay end
function FakeGameTime:setTimeOfDay(v) self.timeOfDay = v end
function FakeGameTime:getDay() return self.dayField end
function FakeGameTime:setDay(v) self.dayField = v end
function FakeGameTime:getDayPlusOne() return self.dayField + 1 end
function FakeGameTime:getMonth() return self.monthField end
function FakeGameTime:setMonth(v) self.monthField = v end
function FakeGameTime:getYear() return self.yearField end
function FakeGameTime:setYear(v) self.yearField = v end
function FakeGameTime:getWorldAgeHours() return 100 end
function FakeGameTime:getNightsSurvived() return 4 end
function FakeGameTime:getTrueMultiplier() return 1 end
getGameTime = function() return FakeGameTime end
getOnlinePlayers = function() return nil end
`;

function load(dayField) {
  const bridge = loadPanelBridge(LUA_PATH, STUBS);
  if (dayField !== undefined) bridge.run(`FakeGameTime.dayField = ${dayField}`);
  return bridge;
}

describe('PanelBridge.lua getGameTime -- the day is the calendar day', () => {
  it.each([
    [0, 1],
    [14, 15],
    [30, 31],
  ])('game day field %s is reported as day %s', (field, calendar) => {
    const result = load(field).callHandler('getGameTime', {});

    expect(result.ok).toBe(true);
    expect(result.data.day).toBe(calendar);
    // The month stays one-based, as before.
    expect(result.data.month).toBe(6);
  });

  it('getServerInfo reports the same calendar day', () => {
    const result = load(14).callHandler('getServerInfo', {});

    expect(result.ok).toBe(true);
    expect(result.data.gameTime.day).toBe(15);
    expect(result.data.gameTime.month).toBe(6);
  });
});

describe('PanelBridge.lua setGameTime -- the day is the calendar day', () => {
  it('typing 20 sets the 20th (field 19), not the 21st', () => {
    const bridge = load(14);
    const result = bridge.callHandler('setGameTime', { day: 20 });

    expect(result.ok).toBe(true);
    expect(result.data.updated.day).toBe(20);
    expect(bridge.getGlobal('FakeGameTime').dayField).toBe(19);
    expect(bridge.callHandler('getGameTime', {}).data.day).toBe(20);
  });

  it('the 1st of a month can be set (field 0)', () => {
    const bridge = load(14);
    const result = bridge.callHandler('setGameTime', { day: 1 });

    expect(result.ok).toBe(true);
    expect(result.data.updated.day).toBe(1);
    expect(bridge.getGlobal('FakeGameTime').dayField).toBe(0);
  });

  it('feeding getGameTime back into setGameTime leaves the date unchanged (on the 1st too)', () => {
    for (const field of [0, 14, 27]) {
      const bridge = load(field);
      const read = bridge.callHandler('getGameTime', {}).data;
      const set = bridge.callHandler('setGameTime', {
        day: read.day,
        month: read.month,
        year: read.year,
      });

      expect(set.ok).toBe(true);
      expect(bridge.getGlobal('FakeGameTime').dayField).toBe(field);
      expect(bridge.getGlobal('FakeGameTime').monthField).toBe(5);
    }
  });

  it.each([0, -3])('day %s is refused before anything is written', (day) => {
    const bridge = load(14);
    const result = bridge.callHandler('setGameTime', { hour: 3, day });

    expect(result.ok).toBe(false);
    expect(result.err).toMatch(/day must be 1 or higher/i);
    // The hour sits before the day in the handler: it must not have been applied.
    expect(bridge.getGlobal('FakeGameTime').timeOfDay).toBe(12.5);
    expect(bridge.getGlobal('FakeGameTime').dayField).toBe(14);
  });

  it('a call without a day leaves the day alone', () => {
    const bridge = load(14);
    const result = bridge.callHandler('setGameTime', { hour: 8 });

    expect(result.ok).toBe(true);
    expect(bridge.getGlobal('FakeGameTime').dayField).toBe(14);
    expect(result.data.updated.day).toBeUndefined();
  });
});
