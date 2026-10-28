import {
  defaultScopeLabel,
  hourlyRate,
  isLivePod,
  livePods,
  periodSince,
  podGpuLabel,
  podOwnerLabel,
  podStateLabel,
  spendRowLabel,
  spendTotal,
} from "./cost-dashboard-model";
import type { DashboardPod } from "./types";

function pod(overrides: Partial<DashboardPod>): DashboardPod {
  return {
    id: "p",
    handle: "cc-aaaaaaaa",
    provider: "runpod",
    key_owner_account_id: "k",
    beneficiary_account_id: "b",
    gpu_type_id: "NVIDIA RTX A5000",
    gpu_count: 1,
    cloud: "SECURE",
    image: "runpod/pytorch",
    cost_per_hr: "0.27",
    max_runtime_minutes: 60,
    deadline: "2026-10-28T11:00:00.000Z",
    state: "running",
    desired_state: "running",
    created: "2026-10-27T10:00:00.000Z",
    updated: "2026-10-27T10:00:00.000Z",
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

  it("lists live pods oldest first; unpriced pods are counted apart, never as zero", () => {
    const pods = [
      pod({ id: "b", created: "2026-10-27T11:00:00.000Z", cost_per_hr: "0.1" }),
      pod({ id: "gone", state: "terminated", cost_per_hr: "5" }),
      pod({ id: "a", created: "2026-10-27T09:00:00.000Z", cost_per_hr: "0.2" }),
      pod({
        id: "c",
        created: "2026-10-27T12:00:00.000Z",
        cost_per_hr: undefined,
      }),
    ];
    const live = livePods(pods);
    expect(live.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(hourlyRate(live)).toEqual({ total: "0.3", unpriced: 1 });
    expect(hourlyRate([])).toEqual({ total: "0", unpriced: 0 });
  });

  it("describes state in words, so it never relies on color", () => {
    expect(podStateLabel({ state: "stopped" })).toBe(
      "Stopped (disk still billed)",
    );
    expect(podStateLabel({ state: "ambiguous" })).toBe("Checking");
    expect(
      podStateLabel({ state: "running", unmanaged_at: "2026-10-28T00:00:00Z" }),
    ).toBe("Unmanaged (may still bill at RunPod)");
  });

  it("labels pods by GPU, cloud and who they are for", () => {
    expect(podGpuLabel(pod({ gpu_count: 2, cloud: "COMMUNITY" }))).toBe(
      "2 × NVIDIA RTX A5000 (Community Cloud)",
    );
    const mine = { beneficiary_account_id: "me" };
    // a missing name is never assumed to be the viewer
    expect(podOwnerLabel(mine)).toBe("Unknown person");
    expect(podOwnerLabel({ beneficiary_account_id: "other" }, "me")).toBe(
      "Unknown person",
    );
    expect(podOwnerLabel(mine, "me")).toBe("You");
    expect(
      podOwnerLabel({
        beneficiary_account_id: "x",
        beneficiary_name: "Ada",
        agent_id: "a1",
      }),
    ).toBe("Ada (agent)");
  });

  it("labels spend rows per grouping", () => {
    const names = { "acct-1": "Ada Lovelace" };
    const projectTitle = (id: string) =>
      id === "proj-1" ? "Thesis" : undefined;
    const labels = { viewerAccountId: "me", names, projectTitle };
    expect(spendRowLabel({ key: "me" }, "beneficiary", labels)).toBe("You");
    expect(spendRowLabel({ key: "acct-1" }, "beneficiary", labels)).toBe(
      "Ada Lovelace",
    );
    expect(spendRowLabel({ key: "acct-2" }, "beneficiary", labels)).toBe(
      "Unknown person",
    );
    expect(spendRowLabel({ key: "agent-123456789" }, "agent", labels)).toBe(
      "Agent agent-12",
    );
    expect(spendRowLabel({ key: "" }, "agent", labels)).toBe(
      "No agent (a person)",
    );
    expect(spendRowLabel({ key: "proj-1" }, "project", labels)).toBe("Thesis");
    expect(spendRowLabel({ key: "proj-2abcdef" }, "project", labels)).toBe(
      "Project proj-2ab",
    );
    expect(spendRowLabel({ key: "" }, "project", labels)).toBe("No project");
    expect(
      spendRowLabel({ key: "pod-1", label: "cc-abc" }, "pod", labels),
    ).toBe("cc-abc");
  });

  it("adds a spend row's parts exactly", () => {
    expect(
      spendTotal({
        spent_usd: "1.1",
        live_estimate_usd: "2.2",
        held_usd: "0.3",
      }),
    ).toBe("3.6");
  });

  it("computes the start of each period, and labels each scope", () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    expect(periodSince("24h", now)).toBe("2026-10-26T12:00:00.000Z");
    expect(periodSince("7d", now)).toBe("2026-10-20T12:00:00.000Z");
    expect(defaultScopeLabel("funded")).toBe("your RunPod key pays for");
    expect(defaultScopeLabel({ course_id: "c" })).toBe("in this course");
  });
});
