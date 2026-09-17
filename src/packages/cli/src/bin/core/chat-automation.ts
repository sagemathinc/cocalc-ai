import { automationAcp } from "@cocalc/conat/ai/acp/client";
import type {
  AcpAutomationRequest,
  AcpAutomationResponse,
} from "@cocalc/conat/ai/acp/types";
import type { Client } from "@cocalc/conat/core/client";

// The server enforces this independently. Do not switch to saved human
// credentials when a project/agent session attempts a settings mutation.
export async function humanChatAutomation(
  request: AcpAutomationRequest,
  client: Client,
  submit: typeof automationAcp = automationAcp,
): Promise<AcpAutomationResponse> {
  const user = client.info?.user;
  if (
    !user?.account_id ||
    user.account_id !== request.account_id ||
    user.auth_actor === "agent" ||
    (!user.auth_session_hash && user.auth_actor !== "account")
  ) {
    throw new Error(
      "Automation operations require an authenticated human account session. Use your human CLI login and start a new CLI invocation to refresh older project-host credentials; project agent credentials cannot take responsibility for scheduled runs.",
    );
  }
  return submit(request, client);
}
