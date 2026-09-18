import { describe, expect, it } from "vitest";
import { buildChatSocketPayload } from "../index.js";

// bug-hunt-2026-09-18 (in-panel chat): the socket.io "chat:message" payload
// index.js emits for every logTailer 'chatMessage' event used to drop
// sourceChatType entirely -- the field logTailer.js already computes to
// distinguish a whisper ("Private"), a faction/safehouse/radio room, or a
// Q-shout from ordinary public chat (ground-truthed against the PZ jar:
// zombie/network/chat/ChatServer's processMessageFromPlayerPacket logs
// EVERY player-submitted chat room's message through the one "Got message:"
// line logTailer.js parses, whisper/faction/safehouse/radio included, not
// just public talking). discordBot.js's handleGameChat already depends on
// this exact same field (PUBLIC_CHAT_TYPES) to keep private channels out of
// Discord -- Chat.tsx never got the same information to show an operator
// reading the panel that a line was a private whisper rather than public
// chat, since it was silently dropped one hop earlier, at the socket
// boundary this file covers.
describe("buildChatSocketPayload carries sourceChatType to the client", () => {
  it("includes sourceChatType alongside the existing fields", () => {
    const payload = buildChatSocketPayload(
      {
        type: "general",
        author: "Alice",
        message: "hey",
        timestamp: new Date("2026-09-18T00:00:00.000Z"),
        sourceChatType: "Private",
      },
      "123-0",
    );
    expect(payload).toEqual({
      id: "123-0",
      type: "general",
      author: "Alice",
      message: "hey",
      timestamp: new Date("2026-09-18T00:00:00.000Z"),
      sourceChatType: "Private",
    });
  });

  it("passes through each real PZ chat room title unchanged (Faction/Safehouse/Radio/Shout)", () => {
    for (const sourceChatType of ["Faction", "Safehouse", "Radio", "Shout", "General", "Local"]) {
      const payload = buildChatSocketPayload(
        { type: "general", author: "A", message: "m", timestamp: new Date(), sourceChatType },
        "id",
      );
      expect(payload.sourceChatType).toBe(sourceChatType);
    }
  });

  it("defaults type to 'general' when logTailer omits it, same as before this fix", () => {
    const payload = buildChatSocketPayload(
      { author: "A", message: "m", timestamp: new Date() },
      "id",
    );
    expect(payload.type).toBe("general");
    expect(payload.sourceChatType).toBeUndefined();
  });
});
