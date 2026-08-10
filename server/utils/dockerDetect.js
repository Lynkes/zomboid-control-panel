// Detect whether the panel is running inside a container. Used to decide
// whether Docker-mount auto-discovery is worth attempting/advertising.
import fs from "fs";

// Docker sets /.dockerenv at the container root; Podman uses
// /run/.containerenv. Falls back to a cgroup scan for runtimes (some CI
// sandboxes, older Docker) that skip the marker file entirely.
export function isContainerized() {
  if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")) {
    return true;
  }
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    return /docker|kubepods|containerd/.test(cgroup);
  } catch {
    return false;
  }
}

export function getContainerInfo() {
  return {
    isDocker: isContainerized(),
    hasDockerSocket: fs.existsSync("/var/run/docker.sock"),
  };
}
