import { isRestrictiveAgentManagement } from "./management";
import type { PersonalControlRequest } from "@cocalc/conat/inter-bay/agent-rpc";

test.each([
  ["listNamedAgents", {}, true],
  ["listAgentNetworks", {}, true],
  ["listAgentNetworkActivity", {}, true],
  ["inspectAgentNetworkAttempt", {}, true],
  ["listAgentNetworkProposals", {}, true],
  ["retireNamedAgent", {}, true],
  ["updateAgentNetwork", { action: "pause" }, true],
  ["updateAgentNetwork", { action: "remove-member" }, true],
  ["updateAgentNetwork", { action: "close" }, true],
  ["resolveAgentNetworkProposal", { action: "reject" }, true],
  ["setPersonalMessagingState", { action: "pause" }, true],
  ["setPersonalMessagingState", { action: "revoke_all" }, true],
  ["updateAgentNetwork", { action: "resume" }, false],
  ["updateAgentNetwork", { action: "add-member" }, false],
  ["setPersonalMessagingState", { action: "resume" }, false],
  ["resolveAgentNetworkProposal", { action: "approve" }, false],
  ["nameAgent", {}, false],
  ["createAgentNetwork", {}, false],
  ["checkNetwork", {}, false],
  ["discoverNetworks", {}, false],
  ["proposeNetwork", {}, false],
  ["beginBroadcast", {}, false],
  ["finishBroadcast", {}, false],
  ["observeNetworkActivity", {}, false],
  ["unknown", {}, false],
])("site-off policy for %s %j is %s", (action, options, allowed) => {
  expect(
    isRestrictiveAgentManagement({ action, options } as PersonalControlRequest),
  ).toBe(allowed);
});
