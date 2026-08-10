import { describe, expect, it } from "vitest";
import { isManagedContainer, parseContainerStats } from "../services/dockerClient.js";

describe("Docker managed-container boundary", () => {
  it("accepts only containers explicitly opted into panel management", () => {
    expect(isManagedContainer({ Labels: { "zomboid-panel.managed": "true" } })).toBe(true);
    expect(isManagedContainer({ Config: { Labels: { "zomboid-panel.managed": "true" } } })).toBe(true);
    expect(isManagedContainer({ Labels: { "zomboid-panel.role": "pz-server" } })).toBe(false);
    expect(isManagedContainer({ Image: "ich777/steamcmd:projectzomboid", Labels: {} })).toBe(false);
  });
});

describe("parseContainerStats", () => {
  it("calculates bounded CPU, memory, network, and disk counters", () => {
    expect(parseContainerStats({
      cpu_stats: { system_cpu_usage: 2000, online_cpus: 2, cpu_usage: { total_usage: 500, percpu_usage: [250, 250] } },
      precpu_stats: { system_cpu_usage: 1000, cpu_usage: { total_usage: 200 } },
      memory_stats: { usage: 512, limit: 1024 },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 5, tx_bytes: 7 } },
      blkio_stats: { io_service_bytes_recursive: [{ op: "Read", value: 3 }, { op: "Write", value: 4 }] },
    })).toEqual({
      cpuPercent: 60,
      memoryUsed: 512,
      memoryLimit: 1024,
      memoryPercent: 50,
      networkRx: 15,
      networkTx: 27,
      diskRead: 3,
      diskWrite: 4,
    });
  });
});
