import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { agentProjectTitle } from "./project-title";

it("replaces registration-time UUID/title fallbacks with the live title", () => {
  const agent = { project_title: "stale-uuid" } as NamedAgent;
  expect(agentProjectTitle(agent, "Primes")).toBe("Primes");
  expect(agentProjectTitle(agent, "Renamed project")).toBe("Renamed project");
  expect(agentProjectTitle(agent)).toBe("stale-uuid");
  expect(agentProjectTitle({} as NamedAgent)).toBe("Agent project");
});
