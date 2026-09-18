import { isRestrictiveAgentManagement } from "./management";
import type { PersonalControlRequest } from "@cocalc/conat/inter-bay/agent-rpc";

test.each([
  ["listNamedAgents", {}, true],
  ["listPersonalConnections", {}, true],
  ["listPersonalConnectionRequests", {}, true],
  ["retireNamedAgent", {}, true],
  ["setPersonalConnectionState", { state: "paused" }, true],
  ["setPersonalConnectionState", { state: "revoked" }, true],
  ["setPersonalMessagingState", { action: "pause" }, true],
  ["setPersonalMessagingState", { action: "revoke_all" }, true],
  ["resolvePersonalConnectionRequest", { decision: "deny" }, true],
  ["setPersonalConnectionState", { state: "active" }, false],
  ["setPersonalMessagingState", { action: "resume" }, false],
  ["resolvePersonalConnectionRequest", { decision: "approve" }, false],
  ["setPersonalConnectionState", { state: "unknown" }, false],
  ["nameAgent", {}, false],
  ["grantPersonalConnection", {}, false],
  ["links", {}, false],
  ["check", {}, false],
  ["request", {}, false],
  ["requestRead", {}, false],
  ["observe", {}, false],
  ["unknown", {}, false],
])("site-off policy for %s %j is %s", (action, options, allowed) => {
  expect(
    isRestrictiveAgentManagement({ action, options } as PersonalControlRequest),
  ).toBe(allowed);
});
