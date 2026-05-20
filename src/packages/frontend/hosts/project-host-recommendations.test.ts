import type { Host } from "@cocalc/conat/hub/api/hosts";
import {
  recommendProjectHosts,
  type ProjectHostRecommendationReason,
} from "./project-host-recommendations";

function host(opts: Partial<Host> = {}): Host {
  return {
    id: "host-1",
    name: "Host 1",
    owner: "account-1",
    region: "us-west1",
    size: "small",
    gpu: false,
    status: "running",
    can_place: true,
    pricing_model: "on_demand",
    ...opts,
  };
}

function reasonIds(reasons: ProjectHostRecommendationReason[]): string[] {
  return [...reasons].sort();
}

describe("project host recommendations", () => {
  it("prefers an available same-region standard host under normal pressure", () => {
    const result = recommendProjectHosts({
      projectRegion: "wnam",
      hosts: [
        host({
          id: "busy",
          name: "Busy",
          pressure: { zone: "pressure" },
        }),
        host({
          id: "normal",
          name: "Normal",
          pressure: { zone: "normal" },
        }),
        host({
          id: "remote",
          name: "Remote",
          region: "europe-west1",
          pressure: { zone: "normal" },
        }),
      ],
    });

    expect(result.recommended?.host.id).toBe("normal");
    expect(
      result.projectRegionCandidates.map((entry) => entry.host.id),
    ).toEqual(["normal", "busy"]);
    expect(result.remoteCandidates.map((entry) => entry.host.id)).toEqual([
      "remote",
    ]);
  });

  it("recommends the best remote host when no host is available in the project region", () => {
    const result = recommendProjectHosts({
      projectRegion: "oc",
      hosts: [
        host({
          id: "west",
          name: "West",
          region: "us-west1",
          pressure: { zone: "normal" },
        }),
        host({
          id: "east",
          name: "East",
          region: "us-east1",
          pressure: { zone: "observe" },
        }),
      ],
    });

    expect(result.projectRegionCandidates).toEqual([]);
    expect(result.recommended?.host.id).toBe("west");
    expect(result.recommended?.sameProjectRegion).toBe(false);
    expect(result.recommended?.reasons).toContain("remote_region");
  });

  it("prioritizes GPU hosts for GPU projects", () => {
    const result = recommendProjectHosts({
      projectRegion: "wnam",
      wantsGpu: true,
      hosts: [
        host({ id: "cpu", name: "CPU" }),
        host({ id: "gpu", name: "GPU", gpu: true }),
      ],
    });

    expect(result.recommended?.host.id).toBe("gpu");
    expect(reasonIds(result.candidates[0].reasons)).toContain("gpu");
    expect(reasonIds(result.candidates[1].reasons)).toContain("missing_gpu");
  });

  it("separates unavailable hosts from ranked candidates", () => {
    const result = recommendProjectHosts({
      projectRegion: "wnam",
      hosts: [
        host({ id: "ok", name: "OK" }),
        host({
          id: "blocked",
          name: "Blocked",
          can_place: false,
          reason_unavailable: "maintenance",
        }),
      ],
    });

    expect(result.candidates.map((entry) => entry.host.id)).toEqual(["ok"]);
    expect(result.unavailable.map((entry) => entry.host.id)).toEqual([
      "blocked",
    ]);
    expect(result.unavailable[0].load).toBe("unavailable");
  });

  it("keeps an explicitly selected host ahead of otherwise similar candidates", () => {
    const result = recommendProjectHosts({
      projectRegion: "wnam",
      selectedHostId: "selected",
      hosts: [
        host({ id: "other", name: "Other" }),
        host({ id: "selected", name: "Selected" }),
      ],
    });

    expect(result.recommended?.host.id).toBe("selected");
    expect(result.recommended?.reasons).toContain("selected");
  });

  it("adds CPU speed reasons for known GCP machine families", () => {
    const result = recommendProjectHosts({
      projectRegion: "wnam",
      hosts: [
        host({
          id: "fast",
          name: "Fast",
          machine: { cloud: "gcp", machine_type: "c3d-standard-4" },
        }),
        host({
          id: "slow",
          name: "Slow",
          machine: { cloud: "gcp", machine_type: "e2-standard-4" },
        }),
      ],
    });

    expect(result.candidates[0].host.id).toBe("fast");
    expect(result.candidates[0].reasons).toContain("fast_cpu");
    expect(result.candidates[1].reasons).toContain("slow_cpu");
  });
});
