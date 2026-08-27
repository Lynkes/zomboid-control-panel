import { describe, expect, it } from "vitest";
import fs from "fs";

const readRepoFile = (relativePath) =>
  fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

describe("Docker deployment guidance", () => {
  it("uses the all-in-one installer as the primary local-server path", () => {
    const readme = readRepoFile("README.md");
    // Bounded by the next heading (## or ###) rather than a specific one --
    // "### Indifferent Broccoli" no longer directly follows this section
    // (README.md's install-guide rewrite turned it into a docs/install/hosted.md
    // chooser-table row instead of an inline heading), so anchoring on it left
    // this regex matching nothing rather than failing loudly on content.
    const dockerSection = readme.match(
      /### Docker and Unraid([\s\S]*?)\n#{2,3} /,
    )?.[1];

    expect(dockerSection).toBeTruthy();
    expect(dockerSection).toContain("docker/all-in-one/bootstrap.sh");
    expect(dockerSection).toMatch(/publishes\s+the required UDP ports/);
    expect(dockerSection.indexOf("docker/all-in-one/bootstrap.sh")).toBeLessThan(
      dockerSection.indexOf("docker-compose.install.yml"),
    );
  });

  it("publishes both PZ UDP ports in the all-in-one Compose stack", () => {
    const compose = readRepoFile("docker/all-in-one/docker-compose.yml");

    expect(compose).toContain('"16261:16261/udp"');
    expect(compose).toContain('"16262:16262/udp"');
  });

  it("pulls immutable release images before falling back to local builds", () => {
    const bootstrap = readRepoFile("docker/all-in-one/bootstrap.sh");

    expect(bootstrap).toContain("zomboid-panel:aio-$VERSION");
    expect(bootstrap).toContain("zomboid-panel:updater-$VERSION");
    expect(bootstrap).toContain('docker pull "$published_image"');
    expect(bootstrap).toContain('docker build -t "$local_image"');
    expect(bootstrap).toContain("up -d --no-build");
    expect(bootstrap).toContain('if [ "$health" = "healthy" ]');
    expect(bootstrap).toContain("All-in-one installation is ready.");
  });

  it("publishes versioned panel and updater images from release tags", () => {
    const workflow = readRepoFile(".github/workflows/docker-aio-build.yml");

    expect(workflow).toContain("- 'v*'");
    expect(workflow).toContain("type=raw,value=updater");
    expect(workflow).toContain("type=semver,pattern={{version}},prefix=aio-");
    expect(workflow).toContain(
      "type=semver,pattern={{version}},prefix=updater-",
    );
  });

  it("keeps the generic installer explicitly panel-only", () => {
    const compose = readRepoFile("docker-compose.install.yml");

    expect(compose).toContain("Project Zomboid runs on another machine");
    expect(compose).not.toContain("16261:16261/udp");
    expect(compose).not.toContain("16262:16262/udp");
  });
});