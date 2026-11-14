import { computeCallerAccountId } from "./compute-agent-auth";

const agent_auth = {
  account_id: "00000000-0000-4000-8000-000000000001",
  project_id: "00000000-0000-4000-8000-000000000002",
  token_fingerprint: "a".repeat(64),
  issued_at_s: 1,
  expires_at_s: 2,
};

describe("computeCallerAccountId", () => {
  it("is the agent credential's account for an agent call", () => {
    expect(computeCallerAccountId({ agent_auth })).toBe(agent_auth.account_id);
  });
  it("is the calling account otherwise", () => {
    expect(computeCallerAccountId({ account_id: "x" })).toBe("x");
    expect(computeCallerAccountId({})).toBeUndefined();
  });
  it("refuses a call that names both", () => {
    expect(() =>
      computeCallerAccountId({ account_id: "attacker", agent_auth }),
    ).toThrow("ambiguous managed-compute actor");
  });
});
