import { describe, expect, it } from "vitest";
import {
  acquireLifecycleLock,
  lifecycleActivityCovers,
} from "../services/lifecycleCoordinator.js";

// The server watch takes a server that stops while a panel lifecycle
// operation runs for it -- or just after one ended -- for that operation's
// stop, never for a crash it should restart the server after.

const WINDOW = 60_000;

describe("lifecycleActivityCovers()", () => {
  it("covers a server while a lock names it, or names no server", () => {
    const own = acquireLifecycleLock("stop", "cover-a");
    try {
      expect(lifecycleActivityCovers("cover-a", WINDOW)).toBe(true);
      expect(lifecycleActivityCovers("cover-b", WINDOW, Date.now() + 10 * WINDOW)).toBe(false);
    } finally {
      own.release();
    }

    const anonymous = acquireLifecycleLock("auto-update");
    try {
      expect(lifecycleActivityCovers("cover-b", WINDOW, Date.now() + 10 * WINDOW)).toBe(true);
    } finally {
      anonymous.release();
    }
  });

  it("covers a server for the window after its lock was released, and not after", () => {
    const lock = acquireLifecycleLock("restart", "cover-c");
    lock.release();
    const releasedAround = Date.now();

    expect(lifecycleActivityCovers("cover-c", WINDOW, releasedAround + WINDOW - 1000)).toBe(true);
    expect(lifecycleActivityCovers("cover-c", WINDOW, releasedAround + 10 * WINDOW)).toBe(false);
  });

  it("matches a numeric id against its string form", () => {
    const lock = acquireLifecycleLock("start", 42);
    try {
      expect(lifecycleActivityCovers("42", WINDOW)).toBe(true);
    } finally {
      lock.release();
    }
  });
});
