import type { PersonalControlRequest } from "@cocalc/conat/inter-bay/agent-rpc";

/** Site-off management may inspect or reduce authority, never create it. */
export function isRestrictiveAgentManagement(
  request: PersonalControlRequest,
): boolean {
  switch (request.action) {
    case "listNamedAgents":
    case "listAgentNetworks":
    case "listAgentNetworkActivity":
    case "inspectAgentNetworkAttempt":
    case "listAgentNetworkProposals":
    case "retireNamedAgent":
      return true;
    case "resolveAgentNetworkProposal":
      return request.options.action === "reject";
    case "updateAgentNetwork":
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
