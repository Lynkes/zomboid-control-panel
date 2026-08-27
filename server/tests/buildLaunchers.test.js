import { describe, expect, it } from "vitest";
import { generateStartBat, generateStartSh } from "../../build.js";

describe("standalone launchers", () => {
  it("does not promise a fixed URL from the Linux launcher", () => {
    const launcher = generateStartSh();

    expect(launcher).not.toContain("localhost:3001");
    expect(launcher).toContain("./ZomboidControlPanel");
  });

  it("does not promise a fixed URL from the Windows supervisor", () => {
    expect(generateStartBat()).not.toContain("localhost:3001");
  });
});