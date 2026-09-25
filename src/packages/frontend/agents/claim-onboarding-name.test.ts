import { claimOnboardingName } from "./claim-onboarding-name";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";

test("claims a fallback after definite server reservation conflicts", async () => {
  const claim = jest
    .fn()
    .mockRejectedValueOnce(
      new Error("name_reserved - callHub: name='agent.nameAgent'"),
    )
    .mockRejectedValueOnce(new Error("name_reserved"))
    .mockResolvedValue({ agent_id: "same-identity" });
  const result = await claimOnboardingName("agent", claim);
  expect(claim.mock.calls[0]).toEqual(["agent"]);
  expect(claim.mock.calls[1]).toEqual(["agent-1"]);
  expect(result.name).toMatch(/^agent-[0-9a-f]{24}$/);
  expect(normalizeAgentName(result.name)).toBe(result.name);
  expect(result.result).toEqual({ agent_id: "same-identity" });
});

test.each(["timeout", "permission denied", "named_agent_limit_reached"])(
  "does not retry %s under a different name",
  async (message) => {
    const claim = jest.fn().mockRejectedValue(new Error(message));
    await expect(claimOnboardingName("agent", claim)).rejects.toThrow(message);
    expect(claim).toHaveBeenCalledTimes(1);
  },
);

test("uses the preferred name when it is available", async () => {
  const claim = jest.fn().mockResolvedValue("ok");
  expect(await claimOnboardingName("agent", claim)).toEqual({
    name: "agent",
    result: "ok",
  });
  expect(claim).toHaveBeenCalledTimes(1);
});
