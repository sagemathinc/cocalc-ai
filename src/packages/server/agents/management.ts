import type { PersonalControlRequest } from "@cocalc/conat/inter-bay/agent-rpc";

/** Site-off management may inspect or reduce authority, never create it. */
export function isRestrictiveAgentManagement(
  request: PersonalControlRequest,
): boolean {
  switch (request.action) {
    case "listNamedAgents":
    case "listAgentSessions":
    case "listAgentSessionActivity":
    case "inspectAgentSessionAttempt":
    case "listAgentSessionProposals":
    case "retireNamedAgent":
      return true;
    case "resolveAgentSessionProposal":
      return request.options.action === "reject";
    case "updateAgentSession":
      return ["pause", "remove-member", "close"].includes(
        request.options.action,
      );
    case "setPersonalMessagingState":
      return (
        request.options.action === "pause" ||
        request.options.action === "revoke_all"
      );
    default:
      return false;
  }
}
