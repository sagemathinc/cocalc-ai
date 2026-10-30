import {
  approvalLine,
  fundingTerms,
  keyRaiseTarget,
  requestLine,
} from "./project-funding-model";

describe("project funding model", () => {
  it("turns the form into whole-cent terms, with only the caps set", () => {
    expect(
      fundingTerms({
        amount: 100.456,
        days: 7,
        agents_allowed: false,
        max_runtime_hours: 2,
      }),
    ).toEqual({
      provider: "runpod",
      authorized_usd: "100.46",
      days: 7,
      agents_allowed: false,
      max_runtime_minutes: 120,
    });
  });

  it("says what was requested and by whom", () => {
    expect(
      requestLine({
        id: "r",
        actor_kind: "agent",
        actor_account_id: "x",
        summary: { gpu_type_id: "H100", gpu_count: 2, max_runtime_minutes: 90 },
        created: "",
        expires_at: null,
      }),
    ).toBe("2×H100 for up to 1.5 h, by an agent");
  });

  it("says who pays, while being approved and when active", () => {
    const base = {
      approval_id: "a",
      funder_account_id: "f",
      live_pods: 0,
      display: {
        authorized_usd: "50",
        ends_at: "2026-11-08T00:00:00Z",
        agents_allowed: false,
        funder_name: "Ada",
      },
    };
    expect(approvalLine({ ...base, state: "pending" }, false)).toMatch(
      /being approved, paid by Ada's RunPod account/,
    );
    expect(approvalLine({ ...base, state: "active" }, true)).toMatch(
      /paid by your RunPod account: up to \$50.00 until .* \(not agents\)\./,
    );
  });

  it("raises the key budget by exactly the shortfall, as a new total", () => {
    expect(keyRaiseTarget({ available: 50, authorized: 400 }, 100)).toBe(
      "450.00",
    );
    expect(
      keyRaiseTarget({ available: 50, authorized: 400 }, 40),
    ).toBeUndefined();
    // overspent (negative available): the whole amount is missing
    expect(keyRaiseTarget({ available: -5, authorized: 20 }, 10)).toBe("30.00");
    expect(keyRaiseTarget(undefined, 10)).toBeUndefined();
  });
});
