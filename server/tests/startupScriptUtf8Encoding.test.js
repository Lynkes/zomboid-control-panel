import { describe, expect, it } from "vitest";
import { generateStartupScripts } from "../routes/server.js";

// 2026-09-03, issue #130 (garbled Chinese broadcast, closed, no repro host
// available -- this does NOT claim to fix that ticket): Kevin proved our own
// packet encoding is byte-correct end to end, which means the corruption is
// on PZ's side. The classic Java shape of "mojibake, not boxes" is
// `new String(bytes)` with no charset argument, which falls back to the
// JVM's default platform charset (GBK/CP936 on a Chinese-locale Windows
// host) rather than UTF-8 -- and neither launch script told the JVM
// otherwise. This pins that -Dfile.encoding=UTF-8 reaches BOTH generators:
// jvmArgs feeds the Windows .bat directly and linuxJvmArgs (which spreads
// jvmArgs) feeds the Linux .sh, so a fix applied to one and not the other
// is exactly the kind of thing this test exists to catch.
//
// Deliberately does NOT also pin -Dsun.jnu.encoding=UTF-8 -- that flag
// governs filename/argv decoding, not chat text, and forcing it away from
// the host's actual native encoding risks breaking access to an
// already-existing non-ASCII install/save path. See the comment above the
// flag in routes/server.js for the full reasoning.
describe("generateStartupScripts() -- UTF-8 JVM charset", () => {
  it("passes -Dfile.encoding=UTF-8 to both the Windows .bat and the Linux .sh", () => {
    const scripts = generateStartupScripts({
      installPath: "C:/servers/pz",
      serverName: "MyServer",
      minMemory: 2,
      maxMemory: 4,
      serverPort: 16261,
    });

    expect(scripts.bat).toContain("-Dfile.encoding=UTF-8");
    expect(scripts.sh).toContain("-Dfile.encoding=UTF-8");
  });

  it("does not pass -Dsun.jnu.encoding -- filename decoding risk is deliberately left alone", () => {
    const scripts = generateStartupScripts({
      installPath: "C:/servers/pz",
      serverName: "MyServer",
      minMemory: 2,
      maxMemory: 4,
      serverPort: 16261,
    });

    expect(scripts.bat).not.toContain("sun.jnu.encoding");
    expect(scripts.sh).not.toContain("sun.jnu.encoding");
  });
});
