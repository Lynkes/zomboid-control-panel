import { afterEach, describe, expect, it } from "vitest";
import os from "os";

// normalizeServerMemory is pure (env vars + fs.existsSync only) — safe to
// import the real database module instead of mocking it.
const { normalizeServerMemory } = await import("../database/init.js");

const ORIGINAL_SERVER_PATH = process.env.PZ_SERVER_PATH;
const ORIGINAL_SAVE_PATH = process.env.PZ_SAVE_PATH;

function restoreEnv() {
  if (ORIGINAL_SERVER_PATH === undefined) delete process.env.PZ_SERVER_PATH;
  else process.env.PZ_SERVER_PATH = ORIGINAL_SERVER_PATH;
  if (ORIGINAL_SAVE_PATH === undefined) delete process.env.PZ_SAVE_PATH;
  else process.env.PZ_SAVE_PATH = ORIGINAL_SAVE_PATH;
}

describe("normalizeServerMemory env-var fallback", () => {
  afterEach(restoreEnv);

  it("falls back to PZ_SERVER_PATH / PZ_SAVE_PATH when the db has empty paths", () => {
    process.env.PZ_SERVER_PATH = "/env/pz-server";
    process.env.PZ_SAVE_PATH = "/env/zomboid-data";

    const result = normalizeServerMemory({
      installPath: "",
      zomboidDataPath: null,
    });

    expect(result.installPath).toBe("/env/pz-server");
    expect(result.zomboidDataPath).toBe("/env/zomboid-data");
  });

  it("prefers the db value over the env var when both are set", () => {
    process.env.PZ_SERVER_PATH = "/env/pz-server";
    process.env.PZ_SAVE_PATH = "/env/zomboid-data";

    const result = normalizeServerMemory({
      installPath: "/db/pz-server",
      zomboidDataPath: "/db/zomboid-data",
    });

    expect(result.installPath).toBe("/db/pz-server");
    expect(result.zomboidDataPath).toBe("/db/zomboid-data");
  });

  it("sets isRemote false when the resolved path exists locally", () => {
    delete process.env.PZ_SERVER_PATH;
    delete process.env.PZ_SAVE_PATH;

    const result = normalizeServerMemory({
      installPath: os.tmpdir(),
      zomboidDataPath: null,
      isRemote: true,
    });

    expect(result.isRemote).toBe(false);
  });

  it("sets isRemote true when configured paths don't exist locally", () => {
    delete process.env.PZ_SERVER_PATH;
    delete process.env.PZ_SAVE_PATH;

    const result = normalizeServerMemory({
      installPath: "/definitely/not/a/real/path/pz-cp-test",
      zomboidDataPath: null,
      isRemote: false,
    });

    expect(result.isRemote).toBe(true);
  });

  it("leaves isRemote untouched when no paths are configured at all", () => {
    delete process.env.PZ_SERVER_PATH;
    delete process.env.PZ_SAVE_PATH;

    const result = normalizeServerMemory({
      installPath: "",
      zomboidDataPath: null,
      isRemote: true,
    });

    expect(result.isRemote).toBe(true);
  });
});
