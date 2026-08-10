import fs from "fs";
import http from "http";
import { createLogger } from "../utils/logger.js";

const log = createLogger("DockerClient");
const MANAGED_LABEL = "zomboid-panel.managed";
const REQUEST_TIMEOUT_MS = 5000;

export function isManagedContainer(container) {
  const labels = container?.Labels || container?.Config?.Labels;
  return labels?.[MANAGED_LABEL] === "true";
}

function cpuCount(stats) {
  return stats?.cpu_stats?.online_cpus || stats?.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
}

function sumEntries(entries, operation) {
  return (entries || [])
    .filter((entry) => entry.op?.toLowerCase() === operation)
    .reduce((sum, entry) => sum + (entry.value || 0), 0);
}

function sumNetwork(networks, field) {
  return Object.values(networks || {}).reduce(
    (sum, network) => sum + (network[field] || 0),
    0,
  );
}

export function parseContainerStats(stats) {
  const cpuDelta = (stats?.cpu_stats?.cpu_usage?.total_usage || 0) -
    (stats?.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = (stats?.cpu_stats?.system_cpu_usage || 0) -
    (stats?.precpu_stats?.system_cpu_usage || 0);
  const cores = cpuCount(stats);
  const memoryUsed = stats?.memory_stats?.usage || 0;
  const memoryLimit = stats?.memory_stats?.limit || 0;
  return {
    cpuPercent: systemDelta > 0 && cpuDelta > 0
      ? Math.round((cpuDelta / systemDelta) * cores * 1000) / 10
      : 0,
    memoryUsed,
    memoryLimit,
    memoryPercent: memoryLimit > 0
      ? Math.round((memoryUsed / memoryLimit) * 1000) / 10
      : 0,
    networkRx: sumNetwork(stats?.networks, "rx_bytes"),
    networkTx: sumNetwork(stats?.networks, "tx_bytes"),
    diskRead: sumEntries(stats?.blkio_stats?.io_service_bytes_recursive, "read"),
    diskWrite: sumEntries(stats?.blkio_stats?.io_service_bytes_recursive, "write"),
  };
}

export class DockerClient {
  constructor({ socketPath = "/var/run/docker.sock", enabled = process.env.PANEL_DOCKER_CONTROL_ENABLED === "true" } = {}) {
    this.socketPath = socketPath;
    this.enabled = enabled;
  }

  get available() {
    return this.enabled && fs.existsSync(this.socketPath);
  }

  async listManagedContainers() {
    if (!this.available) return [];
    try {
      const containers = await this._requestJson("GET", "/containers/json?all=true");
      return Array.isArray(containers) ? containers.filter(isManagedContainer) : [];
    } catch (error) {
      log.debug(`Docker discovery failed: ${error.message}`);
      return [];
    }
  }

  async inspectManagedContainer(containerId) {
    if (!this.available) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) return null;
    try {
      const container = await this._requestJson(
        "GET",
        `/containers/${encodeURIComponent(containerId)}/json`,
      );
      return isManagedContainer(container) ? container : null;
    } catch {
      return null;
    }
  }

  async runManagedAction(containerId, action) {
    if (!this.available) return { success: false, error: "Docker control is unavailable" };
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) {
      return { success: false, error: "Invalid container identifier" };
    }
    if (!["start", "stop", "restart"].includes(action)) {
      return { success: false, error: "Invalid container action" };
    }

    try {
      const container = await this.inspectManagedContainer(containerId);
      if (!container) {
        return { success: false, error: "Container is not managed by this panel" };
      }
      const statusCode = await this._requestStatus(
        "POST",
        `/containers/${encodeURIComponent(containerId)}/${action}`,
      );
      if (statusCode === 304) return { success: true, message: "Container is already in the requested state" };
      if (statusCode >= 200 && statusCode < 300) return { success: true };
      return { success: false, error: `Docker API returned ${statusCode}` };
    } catch (error) {
      log.warn(`Docker ${action} failed for ${containerId}: ${error.message}`);
      return { success: false, error: "Docker action failed" };
    }
  }

  async getContainerStats(containerId) {
    if (!this.available) return null;
    try {
      const raw = await this._requestJson(
        "GET",
        `/containers/${encodeURIComponent(containerId)}/stats?stream=false`,
      );
      return parseContainerStats(raw);
    } catch (error) {
      log.debug(`Docker stats failed for ${containerId}: ${error.message}`);
      return null;
    }
  }

  _requestJson(method, requestPath) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath: this.socketPath, method, path: requestPath, timeout: REQUEST_TIMEOUT_MS },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            if (response.statusCode >= 400) {
              reject(new Error(`Docker API returned ${response.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
            } catch {
              reject(new Error("Docker API returned invalid JSON"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("Docker API timed out")));
      request.on("error", reject);
      request.end();
    });
  }

  _requestStatus(method, requestPath) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath: this.socketPath, method, path: requestPath, timeout: REQUEST_TIMEOUT_MS },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("timeout", () => request.destroy(new Error("Docker API timed out")));
      request.on("error", reject);
      request.end();
    });
  }
}
