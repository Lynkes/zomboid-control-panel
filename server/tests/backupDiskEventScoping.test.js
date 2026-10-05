import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PR #193 review leftovers (security sweep W2): backup:progress,
// restore:progress and restore:finished went to every connected socket with
// io.emit() -- every role, and before this sweep even sockets opened before
// first-run setup -- carrying raw err.message text that can quote the save
// and backup folders. disk:warning / disk:critical / disk:normal did the
// same with the save volume's host path. #193 moved every other gated
// broadcast into capability rooms or emitToCapabilities(); these now follow:
// backup/restore progress goes to the "backups" room (any backup capability,
// or server.wipe for the pre-wipe backup), with its message path-redacted,
// and disk events to roles holding diagnostics.manage or backups.manage.

const roles = new Map();

vi.mock("../database/init.js", () => ({
  getDb: vi.fn(async () => ({ data: { users: [] } })),
  commitNow: vi.fn(async () => {}),
  peekServerDisplayName: vi.fn(() => null),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
  flushWrites: vi.fn(async () => {}),
  getRoles: async () => [...roles.values()],
  getRoleById: async (id) => [...roles.values()].find((r) => r.id === id) || null,
  getRoleByName: async (name) => roles.get(name) || null,
  getUsersForRole: async () => [],
}));

const { io, app, CAPABILITY_ROOMS, recheckCapabilityRooms, socketMayJoinRoom } = await import("../index.js");
const { BackupService, BACKUP_PROGRESS_ROOM } = await import("../services/backupService.js");

function fakeSocket(id, role, rooms = []) {
  return {
    id,
    user: { userId: id, username: id, role },
    rooms: new Set([id, ...rooms]),
    emit: vi.fn(),
    join(room) {
      this.rooms.add(room);
    },
    leave(room) {
      this.rooms.delete(room);
    },
  };
}

const added = [];
function connect(socket) {
  io.sockets.sockets.set(socket.id, socket);
  added.push(socket.id);
  return socket;
}

beforeEach(() => {
  roles.clear();
  roles.set("Operator", { id: "r1", name: "Operator", capabilities: ["backups.manage", "diagnostics.manage"] });
  roles.set("Downloader", { id: "r2", name: "Downloader", capabilities: ["backups.download"] });
  roles.set("Wiper", { id: "r3", name: "Wiper", capabilities: ["server.wipe"] });
  roles.set("Moderator", { id: "r4", name: "Moderator", capabilities: ["players.view", "players.moderate"] });
});

afterEach(() => {
  for (const id of added.splice(0)) io.sockets.sockets.delete(id);
  vi.restoreAllMocks();
});

describe("backup and restore progress", () => {
  it("goes to the backups room, never to every socket, with host paths redacted", async () => {
    const sent = [];
    const fakeIo = {
      emit: vi.fn(),
      to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }),
    };
    const service = new BackupService();
    service._doCreateBackup = async (_options, _start, emitProgress) => {
      emitProgress("error", 0, "Backup failed: EACCES: permission denied, open '/srv/zomboid/Zomboid/Saves/Multiplayer/world/map_1_1.bin'");
      emitProgress("error", 0, "Backup failed: ENOSPC, write 'C:\\PZ\\backups\\backup-1.zip.tmp'");
      return { success: false };
    };

    await service.createBackup({ io: fakeIo });

    expect(fakeIo.emit).not.toHaveBeenCalled();
    expect(sent.map((s) => [s.room, s.event])).toEqual([
      [BACKUP_PROGRESS_ROOM, "backup:progress"],
      [BACKUP_PROGRESS_ROOM, "backup:progress"],
    ]);
    const text = JSON.stringify(sent);
    expect(text).not.toContain("/srv/zomboid");
    expect(text).not.toContain("C:\\\\PZ");
  });

  it("only a role holding a backup capability, or server.wipe, may join the backups room", async () => {
    expect(BACKUP_PROGRESS_ROOM in CAPABILITY_ROOMS).toBe(true);
    const [onConnection] = io.sockets.listeners("connection");
    const joined = {};
    for (const role of ["Operator", "Downloader", "Wiper", "Moderator"]) {
      const handlers = {};
      const socket = fakeSocket(`s-${role}`, role);
      socket.on = (event, handler) => {
        handlers[event] = handler;
      };
      onConnection(socket);
      await handlers["subscribe:backups"]();
      joined[role] = socket.rooms.has(BACKUP_PROGRESS_ROOM);
    }
    expect(joined).toEqual({ Operator: true, Downloader: true, Wiper: true, Moderator: false });
    expect(await socketMayJoinRoom({}, BACKUP_PROGRESS_ROOM)).toBe(false);
  });

  it("a role edit that takes away every backup capability takes its members out of the room", async () => {
    const member = connect(fakeSocket("s-dl", "Downloader", [BACKUP_PROGRESS_ROOM]));
    roles.set("Downloader", { id: "r2", name: "Downloader", capabilities: ["players.view"] });
    await recheckCapabilityRooms("Downloader");
    expect(member.rooms.has(BACKUP_PROGRESS_ROOM)).toBe(false);
  });
});

describe("disk:* events", () => {
  it("reach only roles that can act on a full save disk, not every socket", async () => {
    const broadcast = vi.spyOn(io, "emit");
    const operator = connect(fakeSocket("s-op", "Operator"));
    const moderator = connect(fakeSocket("s-mod", "Moderator"));
    const anonymous = connect({ id: "s-anon", rooms: new Set(["s-anon"]), emit: vi.fn() });

    const status = {
      path: "/srv/zomboid/Zomboid",
      totalBytes: 100,
      freeBytes: 3,
      usedPercent: 97,
      warning: true,
      critical: true,
      ok: true,
    };
    app.get("diskMonitor")._emitIfChanged(status);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(broadcast).not.toHaveBeenCalledWith("disk:critical", expect.anything());
    expect(operator.emit).toHaveBeenCalledWith("disk:critical", status);
    expect(moderator.emit).not.toHaveBeenCalled();
    expect(anonymous.emit).not.toHaveBeenCalled();
  });
});
