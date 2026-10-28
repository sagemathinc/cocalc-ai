import { GPU_LAUNCH_IMAGES, normalizeGpuLaunchSpec } from "./launch-spec";

const IMAGE = GPU_LAUNCH_IMAGES[0];
const SSH_KEY = `ssh-ed25519 ${"A".repeat(68)} cc-7f3k9q2x`;
const base = {
  gpu_type_id: "NVIDIA GeForce RTX 4090",
  image: IMAGE,
  max_runtime_minutes: 60,
};

describe("normalizeGpuLaunchSpec", () => {
  it("fills defaults and keeps only allowlisted fields", () => {
    expect(
      normalizeGpuLaunchSpec({
        ...base,
        name: "chosen-by-caller",
        dockerStartCmd: ["bash", "-c", "curl evil"],
        templateId: "x",
      }),
    ).toEqual({
      ...base,
      gpu_count: 1,
      cloud: "SECURE",
      container_disk_gb: 20,
      volume_gb: 0,
      ports: [],
      env: {},
    });
  });

  it("accepts a full spec", () => {
    expect(
      normalizeGpuLaunchSpec({
        ...base,
        gpu_count: 2,
        cloud: "COMMUNITY",
        data_center_id: "US-KS-2",
        container_disk_gb: 50,
        volume_gb: 100,
        ports: ["22/tcp", "8888/http", "22/tcp"],
        env: { EPOCHS: "10" },
        ssh_public_key: SSH_KEY,
      }),
    ).toEqual({
      ...base,
      gpu_count: 2,
      cloud: "COMMUNITY",
      data_center_id: "US-KS-2",
      container_disk_gb: 50,
      volume_gb: 100,
      ports: ["22/tcp", "8888/http"],
      env: { EPOCHS: "10" },
      ssh_public_key: SSH_KEY,
    });
  });

  it.each([
    [{ image: "attacker/miner:latest" }, "image must be one of"],
    [{ cloud: "ALL" }, "cloud must be"],
    [{ gpu_count: 9 }, "gpu_count must be a whole number from 1 to 8"],
    [{ gpu_count: 1.5 }, "gpu_count"],
    [{ max_runtime_minutes: undefined }, "max_runtime_minutes"],
    [{ max_runtime_minutes: 24 * 60 + 1 }, "max_runtime_minutes"],
    [{ container_disk_gb: 5000 }, "container_disk_gb"],
    [{ gpu_type_id: "x;rm -rf /" }, "valid GPU type"],
    [{ data_center_id: "../etc" }, "valid data center"],
    [{ ports: ["22/udp"] }, "port must look like"],
    [{ ports: ["0/tcp"] }, "port must look like"],
    [{ ports: ["99999/tcp"] }, "port must look like"],
    [{ ports: Array(6).fill("22/tcp") }, "at most 5"],
    [{ env: { PUBLIC_KEY: "x" } }, "set by CoCalc"],
    [{ env: { RUNPOD_API_KEY: "x" } }, "set by CoCalc"],
    [{ env: { HF_TOKEN: "x" } }, "looks like a credential"],
    [{ env: { AWS_SECRET_ACCESS_KEY: "x" } }, "looks like a credential"],
    [{ env: { lower: "x" } }, "is not valid"],
    [{ env: { A: 1 } }, "must be text"],
    [{ env: { A: "x".repeat(1025) } }, "must be text"],
    [{ env: ["A=1"] }, "env must map"],
    [{ ssh_public_key: "ssh-rsa AAAA" }, "ssh-ed25519"],
    [
      { ssh_public_key: `${SSH_KEY}\nssh-ed25519 ${"B".repeat(68)}` },
      "one ssh-ed25519",
    ],
  ])("rejects %j", (change, message) => {
    expect(() => normalizeGpuLaunchSpec({ ...base, ...change })).toThrow(
      message,
    );
  });

  it("rejects a missing spec", () => {
    expect(() => normalizeGpuLaunchSpec(undefined)).toThrow("needs a spec");
    expect(() => normalizeGpuLaunchSpec([])).toThrow("needs a spec");
  });

  it("limits the total environment", () => {
    const env = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`V${i}`, "x".repeat(1000)]),
    );
    expect(() => normalizeGpuLaunchSpec({ ...base, env })).toThrow(
      "8192 characters in all",
    );
  });
});
