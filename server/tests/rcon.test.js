import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RconService } from '../services/rcon.js';
import { PacketReader } from '../utils/sourceRcon.js';

describe('RCON packet framing', () => {
  const packet = (id, type, body) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(4 + 4 + 4 + bodyBuf.length + 2);
    buf.writeInt32LE(4 + 4 + bodyBuf.length + 2, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    bodyBuf.copy(buf, 12);
    return buf;
  };

  it('reads a well-formed packet', () => {
    const [pkt] = new PacketReader().push(packet(7, 0, 'hello'));
    expect(pkt).toEqual({ id: 7, type: 0, body: 'hello' });
  });

  it('discards an undersized length header instead of reading out of bounds', () => {
    const buf = Buffer.alloc(5);
    buf.writeInt32LE(1, 0);
    const reader = new PacketReader();
    expect(() => reader.push(buf)).not.toThrow();
    expect(reader.push(buf)).toEqual([]);
  });
});

// Test RCON service logic by creating a lightweight mock
// This tests the key behaviors without requiring a live RCON connection

class MockRconService extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.connecting = false;
    this.serverStarting = false;
    this.consecutiveHealthFailures = 0;
    this.maxHealthFailures = 3;
    this.lastSuccessfulCommand = null;
    this.commandTimeout = 10000;
    this.client = null;
  }

  async execute(command, { skipLog = false } = {}) {
    if (this.serverStarting) {
      return { success: false, error: 'Server is starting, please wait...' };
    }
    if (!this.connected) {
      return { success: false, error: 'Not connected' };
    }

    // Simulate successful execution
    this.lastSuccessfulCommand = Date.now();
    this.consecutiveHealthFailures = 0; // Reset on successful command
    return { success: true, response: `Executed: ${command}` };
  }

  simulateHealthCheckFailure() {
    this.consecutiveHealthFailures++;
    if (this.consecutiveHealthFailures >= this.maxHealthFailures) {
      this.connected = false;
      this.consecutiveHealthFailures = 0;
    }
  }
}

describe('RconService', () => {
  let rcon;

  beforeEach(() => {
    rcon = new MockRconService();
  });

  describe('credential sources', () => {
    it('loads RCON_PASSWORD from a Docker secret file', () => {
      const secretPath = path.join(os.tmpdir(), `rcon-secret-${Date.now()}`);
      fs.writeFileSync(secretPath, 'secret-password\n');
      const previous = process.env.RCON_PASSWORD_FILE;
      process.env.RCON_PASSWORD_FILE = secretPath;

      try {
        expect(new RconService().config.password).toBe('secret-password');
      } finally {
        if (previous === undefined) delete process.env.RCON_PASSWORD_FILE;
        else process.env.RCON_PASSWORD_FILE = previous;
        fs.rmSync(secretPath, { force: true });
      }
    });
  });

  describe('execute', () => {
    it('should return error when server is starting', async () => {
      rcon.serverStarting = true;
      const result = await rcon.execute('players');
      expect(result.success).toBe(false);
      expect(result.error).toContain('starting');
    });

    it('should return error when not connected', async () => {
      rcon.connected = false;
      const result = await rcon.execute('players');
      expect(result.success).toBe(false);
    });

    it('should succeed when connected', async () => {
      rcon.connected = true;
      const result = await rcon.execute('players');
      expect(result.success).toBe(true);
      expect(result.response).toContain('players');
    });

    it('should reset consecutiveHealthFailures on successful command', async () => {
      rcon.connected = true;
      rcon.consecutiveHealthFailures = 2;
      await rcon.execute('players');
      expect(rcon.consecutiveHealthFailures).toBe(0);
    });

    it('should update lastSuccessfulCommand timestamp', async () => {
      rcon.connected = true;
      const before = Date.now();
      await rcon.execute('players');
      expect(rcon.lastSuccessfulCommand).toBeGreaterThanOrEqual(before);
    });
  });

  describe('health check', () => {
    it('should disconnect after max consecutive failures', () => {
      rcon.connected = true;
      rcon.simulateHealthCheckFailure(); // 1
      expect(rcon.connected).toBe(true);
      rcon.simulateHealthCheckFailure(); // 2
      expect(rcon.connected).toBe(true);
      rcon.simulateHealthCheckFailure(); // 3 -> disconnect
      expect(rcon.connected).toBe(false);
    });

    it('should not disconnect before max failures', () => {
      rcon.connected = true;
      rcon.simulateHealthCheckFailure();
      rcon.simulateHealthCheckFailure();
      expect(rcon.connected).toBe(true);
      expect(rcon.consecutiveHealthFailures).toBe(2);
    });

    it('successful command should prevent health check disconnect', async () => {
      rcon.connected = true;
      rcon.simulateHealthCheckFailure(); // 1
      rcon.simulateHealthCheckFailure(); // 2
      await rcon.execute('players'); // resets counter
      rcon.simulateHealthCheckFailure(); // 1 again
      rcon.simulateHealthCheckFailure(); // 2 again
      expect(rcon.connected).toBe(true); // still connected
    });
  });

  describe('auto reconnect', () => {
    it('should still probe RCON when process detection says server is not running', async () => {
      vi.useFakeTimers();

      const liveRcon = new RconService();
      const checkServerRunning = vi.fn().mockResolvedValue(false);
      const connectSpy = vi.spyOn(liveRcon, 'connect').mockResolvedValue(false);

      liveRcon.setServerManager({ checkServerRunning });
      liveRcon.startAutoReconnect();

      await vi.advanceTimersByTimeAsync(liveRcon.autoReconnectDelay);

      expect(checkServerRunning).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledTimes(1);

      liveRcon.stopAutoReconnect();
      vi.useRealTimers();
    });
  });

  describe('serverMessage (ASCII safety)', () => {
    it('strips emoji and other non-ASCII chars before sending to PZ', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.serverMessage('🔧 Mod updates detected: CleanUI. Server will restart in 5 minute(s).');

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const sent = executeSpy.mock.calls[0][0];
      expect(sent).not.toMatch(/[^\x20-\x7E"]/);
      expect(sent).toContain('Mod updates detected');
      expect(sent).toContain('5 minute(s)');
      expect(sent).not.toContain('🔧');
    });

    it('replaces curly quotes/dashes with ASCII equivalents', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.serverMessage('It\u2019s \u2014 \u201Ctest\u201D');

      const sent = executeSpy.mock.calls[0][0];
      // Curly apostrophe -> straight apostrophe (kept), em-dash -> hyphen,
      // curly double quotes get normalized to ", which sanitize() then strips
      // for RCON shell safety. Either way, no non-ASCII bytes remain.
      expect(sent).toContain("It's");
      expect(sent).toContain('-');
      expect(sent).toContain('test');
      expect(sent).not.toMatch(/[\u2018\u2019\u201C\u201D\u2013\u2014]/);
    });

    it('returns rejected:true when PZ replies with the help text', async () => {
      const liveRcon = new RconService();
      vi.spyOn(liveRcon, 'execute').mockResolvedValue({
        success: true,
        response: 'Broadcast a message to all connected players. Use: /servermsg "My Message"',
      });

      const result = await liveRcon.serverMessage('Hello');
      expect(result.rejected).toBe(true);
      expect(result.success).toBe(false);
    });

    it('returns success when PZ broadcasts normally', async () => {
      const liveRcon = new RconService();
      vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'Command executed successfully' });

      const result = await liveRcon.serverMessage('Hello players');
      expect(result.success).toBe(true);
      expect(result.rejected).toBeUndefined();
    });

    it('skips sending when message reduces to empty after sanitization', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true });

      const result = await liveRcon.serverMessage('🔧🎯💀');
      expect(executeSpy).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });
  });

  describe('quoted argument safety', () => {
    it('rejects player names that could break out of quoted RCON args', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await expect(liveRcon.kickPlayer('Player" servermsg "owned')).rejects.toThrow('Username contains unsupported characters');
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('rejects control characters in quoted RCON args', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await expect(liveRcon.addToWhitelist('Admin\nquit')).rejects.toThrow('Username contains unsupported characters');
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('preserves safe quoted arguments instead of rewriting them', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.setAccessLevel('Safe Player', 'admin');

      expect(executeSpy).toHaveBeenCalledWith('setaccesslevel "Safe Player" "admin"');
    });

    it('matches Build 42 whitelist commands for optional passwords and allowed Steam IDs', async () => {
      const liveRcon = new RconService();
      const executeSpy = vi.spyOn(liveRcon, 'execute').mockResolvedValue({ success: true, response: 'ok' });

      await liveRcon.addToWhitelist('NoPassword');
      await liveRcon.addAllowedSteamId('76561198000000000');
      await liveRcon.removeAllowedSteamId('76561198000000000');

      expect(executeSpy.mock.calls).toEqual([
        ['adduser "NoPassword"'],
        ['addSteamID 76561198000000000'],
        ['removeSteamID 76561198000000000'],
      ]);
    });
  });
});
