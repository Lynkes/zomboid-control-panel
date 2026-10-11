import { describe, expect, it, vi } from "vitest";
import { renameWithRetry } from "../utils/renameWithRetry.js";

function codedError(code) {
  const error = new Error(`${code}: rename`);
  error.code = code;
  return error;
}

describe("renameWithRetry", () => {
  it("returns after the first successful attempt without sleeping", async () => {
    const rename = vi.fn();
    const sleep = vi.fn(async () => {});

    await renameWithRetry("a", "b", { rename, sleep });

    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith("a", "b");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits out a transient lock, with a growing pause", async () => {
    const rename = vi
      .fn()
      .mockImplementationOnce(() => {
        throw codedError("EBUSY");
      })
      .mockImplementationOnce(() => {
        throw codedError("EPERM");
      })
      .mockImplementation(() => {});
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();

    await renameWithRetry("a", "b", { rename, sleep, delayMs: 10, onRetry });

    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("throws the last error once the attempts are used up", async () => {
    const rename = vi.fn(() => {
      throw codedError("EACCES");
    });
    const sleep = vi.fn(async () => {});

    await expect(
      renameWithRetry("a", "b", { rename, sleep, attempts: 3 }),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error that waiting cannot fix", async () => {
    for (const code of ["ENOENT", "ENOSPC", "EXDEV"]) {
      const rename = vi.fn(() => {
        throw codedError(code);
      });
      const sleep = vi.fn(async () => {});

      await expect(renameWithRetry("a", "b", { rename, sleep })).rejects.toMatchObject({ code });
      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });
});
