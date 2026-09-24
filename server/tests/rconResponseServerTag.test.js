import { describe, expect, it, vi } from 'vitest';
// Same import-order constraint as rconTest.test.js: the database/init.js mock
// factory must be bound before routes/rcon.js is imported.
import { mockGetRoleByName } from './helpers/mockPermissionsDb.js';
import router from '../routes/rcon.js';

vi.mock('../database/init.js', () => ({
  getRoleByName: (name) => mockGetRoleByName(name),
}));

// 2026-09-18 (console follow-ups): the "rcon-live" socket room is global, not
// per server, so a Console page open on server B received every /execute
// broadcast for server A and showed it under B's name. The broadcast now
// carries the id of the server the command actually ran against
// (rconService.serverId -- the same value logCommand() tags command_history
// with), and the client drops events for a server it is not showing.
function getExecuteHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === '/execute' && entry.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = {};
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
}

async function runExecute(rconService) {
  const emitted = [];
  const io = {
    to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
  };
  await getExecuteHandler()(
    {
      body: { command: 'players' },
      app: { get: (key) => (key === 'rconService' ? rconService : io) },
    },
    createResponse(),
  );
  return emitted.find((e) => e.event === 'rcon:response');
}

describe('POST /rcon/execute -- rcon:response broadcast is tagged with the server it ran on', () => {
  it('carries the serverId of the RconService instance that executed the command', async () => {
    const broadcast = await runExecute({
      serverId: '42',
      execute: vi.fn(async () => ({ success: true, response: 'players: Bob' })),
    });

    expect(broadcast.payload.serverId).toBe('42');
  });

  it('tags a failed command too (the failure echo belongs to a server as well)', async () => {
    const broadcast = await runExecute({
      serverId: '7',
      execute: vi.fn(async () => ({ success: false, error: 'Server is not running' })),
    });

    expect(broadcast.payload.success).toBe(false);
    expect(broadcast.payload.serverId).toBe('7');
  });

  it('sends null, not undefined or a guess, when no server backs the RconService', async () => {
    const broadcast = await runExecute({
      serverId: null,
      execute: vi.fn(async () => ({ success: true, response: 'ok' })),
    });

    expect(broadcast.payload).toHaveProperty('serverId', null);
  });
});
