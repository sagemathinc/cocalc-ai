import { isRestrictiveAgentManagement } from "./management";
import type { PersonalControlRequest } from "@cocalc/conat/inter-bay/agent-rpc";

test.each([
  ["listNamedAgents", {}, true],
  ["listAgentSessions", {}, true],
  ["listAgentSessionActivity", {}, true],
  ["inspectAgentSessionAttempt", {}, true],
  ["listAgentSessionProposals", {}, true],
  ["retireNamedAgent", {}, true],
  ["updateAgentSession", { action: "pause" }, true],
  ["updateAgentSession", { action: "remove-member" }, true],
  ["updateAgentSession", { action: "close" }, true],
  ["resolveAgentSessionProposal", { action: "reject" }, true],
  ["setPersonalMessagingState", { action: "pause" }, true],
  ["setPersonalMessagingState", { action: "revoke_all" }, true],
  ["updateAgentSession", { action: "resume" }, false],
  ["updateAgentSession", { action: "add-member" }, false],
  ["setPersonalMessagingState", { action: "resume" }, false],
  ["resolveAgentSessionProposal", { action: "approve" }, false],
  ["nameAgent", {}, false],
  ["createAgentSession", {}, false],
  ["checkSession", {}, false],
  ["discoverSessions", {}, false],
  ["proposeSession", {}, false],
  ["beginBroadcast", {}, false],
  ["finishBroadcast", {}, false],
  ["observeSessionActivity", {}, false],
  ["unknown", {}, false],
])("site-off policy for %s %j is %s", (action, options, allowed) => {
  expect(
    isRestrictiveAgentManagement({ action, options } as PersonalControlRequest),
  ).toBe(allowed);
});
