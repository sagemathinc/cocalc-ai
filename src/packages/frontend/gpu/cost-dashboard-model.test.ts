import {
  defaultScopeLabel,
  hourlyRate,
  isLivePod,
  livePods,
  periodSince,
  podGpuLabel,
  podOwnerLabel,
  podStateLabel,
  spendTotals,
} from "./cost-dashboard-model";
import type { GpuPodSummary } from "./types";

function pod(overrides: Partial<GpuPodSummary>): GpuPodSummary {
  return {
    id: "p",
    handle: "cc-aaaaaaaa",
    provider: "runpod",
    key_owner_account_id: "k",
    beneficiary_account_id: "b",
    gpu_type_id: "NVIDIA RTX A5000",
    gpu_count: 1,
    cloud: "SECURE",
    cost_per_hr: "0.27",
    estimated_cost: "0.1",
    state: "running",
    desired_state: "running",
    created: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

describe("GPU cost dashboard model", () => {
  it("counts every pod as live until deletion is confirmed", () => {
    for (const state of [
      "intent",
      "creating",
      "ambiguous",
      "running",
      "stopped",
      "terminating",
    ] as const) {
      expect(isLivePod({ state })).toBe(true);
    }
    expect(isLivePod({ state: "terminated" })).toBe(false);
    expect(isLivePod({ state: "failed" })).toBe(false);
  });

  it("lists live pods oldest first and sums their hourly rate exactly", () => {
    const pods = [
      pod({ id: "b", created: "2026-10-27T11:00:00.000Z", cost_per_hr: "0.1" }),
      pod({ id: "gone", state: "terminated", cost_per_hr: "5" }),
      pod({ id: "a", created: "2026-10-27T09:00:00.000Z", cost_per_hr: "0.2" }),
    ];
    const live = livePods(pods);
    expect(live.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(hourlyRate(live)).toBe("0.3");
    expect(hourlyRate([])).toBe("0");
  });

  it("reports billed spend only when RunPod has billed something", () => {
    expect(
      spendTotals([
        { key: "x", label: "X", estimated: "1.1", pods_live: 0 },
        { key: "y", label: "Y", estimated: "2.2", billed: null, pods_live: 1 },
      ]),
    ).toEqual({ estimated: "3.3", billed: null });
    expect(
      spendTotals([
        { key: "x", label: "X", estimated: "1", billed: "0.9", pods_live: 0 },
        { key: "y", label: "Y", estimated: "2", pods_live: 1 },
      ]),
    ).toEqual({ estimated: "3", billed: "0.9" });
  });

  it("describes state in words, so it never relies on color", () => {
    expect(podStateLabel("stopped")).toBe("Stopped (disk still billed)");
    expect(podStateLabel("ambiguous")).toBe("Checking");
  });

  it("labels pods by GPU, cloud and who they are for", () => {
    expect(podGpuLabel(pod({ gpu_count: 2, cloud: "COMMUNITY" }))).toBe(
      "2 × NVIDIA RTX A5000 (Community Cloud)",
    );
    expect(podOwnerLabel({})).toBe("You");
    expect(podOwnerLabel({ beneficiary_name: "Ada", agent_id: "a1" })).toBe(
      "Ada (agent)",
    );
  });

  it("computes the start of each period", () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    expect(periodSince("24h", now)).toBe("2026-10-26T12:00:00.000Z");
    expect(periodSince("7d", now)).toBe("2026-10-20T12:00:00.000Z");
  });

  it("derives a label for every scope", () => {
    expect(defaultScopeLabel("funded")).toBe("your RunPod key pays for");
    expect(defaultScopeLabel("mine")).toBe("you are responsible for");
    expect(defaultScopeLabel({ course_id: "c" })).toBe("in this course");
    expect(defaultScopeLabel({ grant_id: "g" })).toBe("funded by this grant");
  });
});
