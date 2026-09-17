import type { PersonalControlRequest } from "@cocalc/conat/inter-bay/agent-rpc";

/** Site-off management may inspect or reduce authority, never create it. */
export function isRestrictiveAgentManagement(
  request: PersonalControlRequest,
): boolean {
  switch (request.action) {
    case "listNamedAgents":
    case "listPersonalConnections":
    case "listPersonalConnectionRequests":
    case "retireNamedAgent":
      return true;
    case "setPersonalConnectionState":
      return (
        request.options.state === "paused" ||
        request.options.state === "revoked"
      );
    case "setPersonalMessagingState":
      return (
        request.options.action === "pause" ||
        request.options.action === "revoke_all"
      );
    case "resolvePersonalConnectionRequest":
      return request.options.decision === "deny";
    default:
      return false;
  }
}
