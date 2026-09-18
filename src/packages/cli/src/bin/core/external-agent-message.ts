import { connect } from "@cocalc/conat/core/client";
import {
  externalAgentInbox,
  externalAgentSubject,
} from "@cocalc/conat/agents/external";
import {
  validateAgentRpcRequest,
  validateAgentRpcOutcome,
  validateAgentRpcPreparation,
  validateAgentEndpoint,
  rpcOutcome,
  type AgentRpcRequest,
  type AgentRpcOutcome,
  type AgentRpcPreparation,
  type AgentEndpoint,
} from "@cocalc/conat/agents/rpc";
import { readExternalAgentCredential } from "./external-agent-profile";
import { withTimeout } from "./context";

export interface ExternalDestination {
  link_id: string;
  target: AgentEndpoint;
  target_name?: string;
  expires_at: string;
}

function waitForExternalSignIn(
  client: ReturnType<typeof connect>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      client.off("info", check);
      client.off("connected", check);
      client.off("closed", closed);
      client.conn.off("connect_error", failed);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (client.info?.user?.error) failed();
      else if (client.isConnected() && client.isSignedIn()) finish();
    };
    // Do not relay raw connection errors, which may contain credential details.
    const failed = () =>
      finish(
        new Error("External agent sign-in failed; no submission attempted"),
      );
    const closed = () =>
      finish(new Error("External agent connection closed before sign-in"));
    const timer = setTimeout(
      () => finish(new Error("External agent sign-in deadline exceeded")),
      10_000,
    );
    client.on("info", check);
    client.on("connected", check);
    client.on("closed", closed);
    client.conn.on("connect_error", failed);
    check();
  });
}

/** An explicit profile pins both identity and site; ambient human auth/API is ignored. */
export async function sendExternalAgentMessage(
  profile: string,
  request: AgentRpcRequest,
): Promise<ExternalDestination[] | AgentRpcOutcome | AgentRpcPreparation> {
  validateAgentRpcRequest(request);
  if (
    request.action === "request-connection" ||
    request.action === "connection-request"
  )
    throw new Error("External approval changes require browser-approved login");
  if (
    "body" in request &&
    (request.guidance || request.file_references !== undefined)
  )
    throw new Error(
      "External agents may send snapshots, not guidance or project references",
    );
  const credential = readExternalAgentCredential(profile);
  const { account_id, installation_id } = credential.source;
  const client = connect({
    address: credential.api_url,
    noCache: true,
    reconnection: false,
    rejectUnauthorized: true,
    auth: { bearer: credential.token },
    inboxPrefix: externalAgentInbox(account_id, installation_id),
  });
  let submissionStarted = false;
  try {
    // Authenticate before creating a publish. A denied connection must not sit
    // in Conat's sign-in wait or send later after the caller has given up.
    await waitForExternalSignIn(client);
    submissionStarted = true;
    const response = await withTimeout(
      client.request(
        externalAgentSubject(account_id, installation_id),
        request,
        {
          timeout: 50_000,
          waitForInterest: false,
        },
      ),
      50_000,
      "external agent RPC deadline exceeded",
    );
    if (response.data?.error) throw new Error(response.data.error);
    const result = response.data?.result;
    if (request.action === "destinations") {
      if (!Array.isArray(result) || result.length > 32)
        throw new Error("invalid external destination response");
      for (const item of result) validateAgentEndpoint(item.target);
    } else if (request.action === "prepare-attachments")
      validateAgentRpcPreparation(result, request);
    else validateAgentRpcOutcome(result, request);
    return result;
  } catch (error) {
    if (!submissionStarted && request.action === "send")
      return rpcOutcome(request, "rejected", {
        chat_effect: "none",
        reason: "External agent sign-in unavailable; no submission attempted.",
      });
    if (request.action === "prepare-attachments")
      return rpcOutcome(request, "rejected", {
        code: "attachment_preparation_unavailable",
        chat_effect: "none",
        reason:
          "Preparation not acknowledged; no bytes or message were sent. Startup may still finish.",
      });
    if (request.action === "send" || request.action === "inspect")
      return rpcOutcome(request, "unknown", {
        reason:
          "No authoritative response; inspect before explicitly retrying. Work may have been accepted.",
      });
    throw error;
  } finally {
    client.close();
  }
}

export async function resolveExternalAgentName(
  profile: string,
  name: string,
): Promise<AgentEndpoint> {
  const normalized = name.replace(/^@/, "");
  const destinations = (await sendExternalAgentMessage(profile, {
    version: 2,
    action: "destinations",
  })) as ExternalDestination[];
  const matches = destinations.filter((d) => d.target_name === normalized);
  if (matches.length !== 1)
    throw new Error(
      "No unambiguous approved external destination; run agent rpc destinations",
    );
  return matches[0].target;
}
