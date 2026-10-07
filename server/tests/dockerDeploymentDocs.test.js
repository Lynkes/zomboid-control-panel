import { describe, expect, it } from "vitest";
import fs from "fs";

const readRepoFile = (relativePath) =>
  fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

// The Lynkes fork keeps only the all-in-one Docker workflow, so the release
// workflow these read may not be there.
const hasReleaseWorkflow = fs.existsSync(
  new URL("../../.github/workflows/release-artifacts.yml", import.meta.url),
);

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

  it("publishes a UDP range for several PZ servers in the all-in-one Compose stack, and tells the panel which", () => {
    const compose = readRepoFile("docker/all-in-one/docker-compose.yml");

    expect(compose).toContain(
      '"${PZ_GAME_PORTS:-16261-16270}:${PZ_GAME_PORTS:-16261-16270}/udp"',
    );
    expect(compose).toContain("PZ_PUBLISHED_GAME_PORTS: ${PZ_GAME_PORTS:-16261-16270}");
  });

  // Auth audit 2026-10-08, #7: every Compose file published "3001:3001" on
  // all host addresses, Docker's published ports bypass UFW, and the docs
  // told reverse-proxy users to set TRUST_PROXY. Anyone reaching 3001
  // directly then forged X-Forwarded-For for a fresh sign-in lockout budget
  // per attempt. bootstrap.sh copies the all-in-one file over again on every
  // run, so the bind address has to be a variable kept in .env. Its default
  // stays blank, not 0.0.0.0: no host IP publishes on IPv4 and IPv6, an
  // explicit 0.0.0.0 on IPv4 only.
  it("publishes the panel port on PANEL_BIND_ADDRESS in every Compose file", () => {
    for (const file of [
      "docker-compose.yml",
      "docker/all-in-one/docker-compose.yml",
      "docker-compose.install.yml",
    ]) {
      const panelPortLines = readRepoFile(file)
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("#") && line.includes(":3001"));

      expect(panelPortLines.length, file).toBeGreaterThan(0);
      for (const line of panelPortLines) {
        expect(line.trim(), file).toBe('- "${PANEL_BIND_ADDRESS:-}:3001:3001"');
      }
    }
  });

  it("keeps PANEL_BIND_ADDRESS in the all-in-one .env and leaves TRUST_PROXY off by default", () => {
    const bootstrap = readRepoFile("docker/all-in-one/bootstrap.sh");
    const compose = readRepoFile("docker/all-in-one/docker-compose.yml");

    expect(bootstrap).toContain("PANEL_BIND_ADDRESS=${PANEL_BIND_ADDRESS:-}");
    expect(bootstrap).toContain("if ! grep -q '^PANEL_BIND_ADDRESS=' \"$CONTEXT_DIR/.env\"; then");
    expect(compose).toContain("TRUST_PROXY: ${TRUST_PROXY:-false}");
  });

  it("tells reverse-proxy users to bind the port to 127.0.0.1, because Docker bypasses UFW", () => {
    for (const file of ["docs/install/docker.md", "docker/all-in-one/README.md"]) {
      const docs = readRepoFile(file);
      expect(docs, file).toContain("PANEL_BIND_ADDRESS=127.0.0.1");
      expect(docs, file).toContain("UFW");
    }
  });

  // Auth review 2026-10-08 (oidc-transport-1): a proxy in its own container
  // that forwards to the host's LAN IP, host.docker.internal or 172.17.0.1
  // can't reach a port published on 127.0.0.1, so following the bare advice
  // turned every page and sign-in into a 502. Each place that gives the
  // advice points that proxy at docs/install/docker.md, which says to join
  // the panel's Docker network first. docker/all-in-one/.env.example, the
  // reference for Path A's .env, was missed once.
  it("points a proxy in another container at docs/install/docker.md wherever it advises 127.0.0.1", () => {
    for (const file of [
      ".env.example",
      "docker/all-in-one/.env.example",
      "docker-compose.yml",
      "docker-compose.install.yml",
      "docker/all-in-one/docker-compose.yml",
      "docker/all-in-one/README.md",
      "docker/all-in-one/bootstrap.sh",
      "server/utils/trustProxy.js",
    ]) {
      // Join comment lines and string pieces into one run of words.
      const text = readRepoFile(file)
        .replace(/["'+]/g, " ")
        .replace(/\s*\r?\n\s*(#\s*)?/g, " ")
        .replace(/\s+/g, " ");
      expect(text, file).toMatch(/proxy in (another|its own) container/i);
      expect(text, file).toContain("docs/install/docker.md");
    }
    expect(readRepoFile("docs/install/docker.md")).toContain("#### A proxy in its own container");
  });

  it("keeps extra all-in-one servers on their own volume", () => {
    const compose = readRepoFile("docker/all-in-one/docker-compose.yml");
    const dockerfile = readRepoFile("docker/all-in-one/Dockerfile");
    const entrypoint = readRepoFile("docker/all-in-one/entrypoint.sh");

    expect(compose).toContain("- pz-servers:/pz-servers");
    expect(compose).toContain("PZ_EXTRA_SERVERS_PATH: /pz-servers");
    expect(dockerfile).toContain("PANEL_ALL_IN_ONE=true");
    expect(entrypoint).toMatch(/chown -R .* \/pz-servers /);
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
    expect(workflow.match(/flavor: latest=false/g) || []).toHaveLength(2);
  });

  it.skipIf(!hasReleaseWorkflow)("uploads the Linux archive from the release tree created by build.js", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");

    expect(workflow).toContain("archive_path: release/ZomboidControlPanel-linux.tar.gz");
    expect(workflow).toContain("path: ${{ matrix.archive_path }}");
  });

  it.skipIf(!hasReleaseWorkflow)("uploads the Windows archive from the root path created by Compress-Archive", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");

    expect(workflow).toContain("archive_path: ZomboidControlPanel-windows.zip");
  });

  it.skipIf(!hasReleaseWorkflow)("verifies all release versions before tag publication", () => {
    const workflow = readRepoFile(".github/workflows/release-artifacts.yml");
    const verifier = readRepoFile("scripts/verify-release-version.mjs");

    expect(workflow).toContain("node scripts/verify-release-version.mjs");
    expect(verifier).toContain("package-lock.json root package");
    expect(verifier).toContain("PanelBridge must contain exactly one");
    expect(verifier).toContain("release-manifest.json client file inventory differs");
  });

  it("keeps the generic installer explicitly panel-only", () => {
    const compose = readRepoFile("docker-compose.install.yml");

    expect(compose).toContain("Project Zomboid runs on another machine");
    expect(compose).not.toContain("16261:16261/udp");
    expect(compose).not.toContain("16262:16262/udp");
  });

  it("documents the opt-in Docker lifecycle prerequisites", () => {
    const compose = readRepoFile("docker-compose.yml");
    const docs = readRepoFile("docs/install/docker.md");

    expect(compose).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(compose).toContain("PANEL_DOCKER_CONTROL_ENABLED");
    expect(compose).toContain("group_add:");
    expect(docs).toContain("zomboid-panel.managed: \"true\"");
    expect(docs).toContain("docker update --label-add zomboid-panel.managed=true");
    expect(docs).toContain("PANEL_DOCKER_CONTROL_ENABLED=true");
    expect(docs).toContain("/var/run/docker.sock");
    expect(docs).toContain("--group-add=281");
  });

  it("offers the Unraid Docker socket field as optional, blank-by-default, and distinct from the container-control grant", () => {
    const xml = readRepoFile("docker/unraid/zomboid-panel.xml");
    const docs = readRepoFile("docs/install/docker.md");

    const socketConfig = xml.match(
      /<Config Name="Docker socket \(optional\)"[\s\S]*?\/>/,
    )?.[0];
    expect(socketConfig).toBeTruthy();
    expect(socketConfig).toContain('Target="/var/run/docker.sock"');
    // Blank by default: Unraid only includes a Path mapping in the actual
    // `docker run` it issues when the field has a value, so an empty
    // Default here is what makes this genuinely opt-in rather than silently
    // granted the moment someone clicks through the install -- see this
    // Config's own long Description for why that distinction matters.
    expect(socketConfig).toContain('Default=""');
    expect(socketConfig).toContain('Required="false"');
    // Hidden behind Advanced View, not shown on the plain install screen --
    // the operator must go looking for it, not stumble into it.
    expect(socketConfig).toContain('Display="advanced"');
    // Must NOT claim to grant PANEL_DOCKER_CONTROL_ENABLED-style container
    // control -- that is the separate, later "Optional: let the panel
    // control the Unraid PZ container" section, with its own explicit
    // opt-in steps (group_add, the zomboid-panel.managed label). This field
    // alone only unlocks path translation.
    expect(socketConfig).not.toContain("PANEL_DOCKER_CONTROL_ENABLED");

    expect(docs).toContain("Optional: let the panel find your folders automatically");
    expect(docs.indexOf("Optional: let the panel find your folders automatically")).toBeLessThan(
      docs.indexOf("Optional: let the panel control the Unraid PZ container"),
    );
  });
});