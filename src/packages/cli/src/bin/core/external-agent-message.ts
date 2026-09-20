import { connect } from "@cocalc/conat/core/client";
import {
  externalAgentInbox,
  externalAgentSubject,
  type ExternalAgentInboxMessage,
} from "@cocalc/conat/agents/external";
import {
  validateAgentRpcRequest,
  validateAgentRpcOutcome,
  validateAgentRpcPreparation,
  validateAgentRpcBroadcastOutcome,
  rpcOutcome,
  type AgentRpcRequest,
  type AgentRpcOutcome,
  type AgentRpcPreparation,
  type AgentRpcBroadcastOutcome,
} from "@cocalc/conat/agents/rpc";
import type {
  AgentNetworkDiscovery,
  AgentNetworkProposal,
} from "@cocalc/conat/agents/personal";
import type { ResolvedAgentDestination } from "./agent-destination";
import { readExternalAgentCredential } from "./external-agent-profile";
import { withTimeout } from "./context";

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
): Promise<
  | AgentNetworkDiscovery
  | AgentNetworkProposal
  | AgentRpcBroadcastOutcome
  | AgentRpcOutcome
  | AgentRpcPreparation
  | ExternalAgentInboxMessage[]
  | { acknowledged: true; message_id: string }
> {
  validateAgentRpcRequest(request);
  if ("file_references" in request && request.file_references !== undefined)
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
      if (!result || !Array.isArray(result.peers) || result.peers.length > 64)
        throw new Error("invalid external destination response");
    } else if (request.action === "prepare-attachments")
      validateAgentRpcPreparation(result, request);
    else if (request.action === "broadcast")
      validateAgentRpcBroadcastOutcome(result, request);
    else if (request.action === "inbox") {
      if (!Array.isArray(result) || result.length > (request.limit ?? 50))
        throw new Error("invalid external inbox response");
      for (const message of result) {
        if (
          typeof message?.message_id !== "string" ||
          typeof message?.attempt_id !== "string" ||
          typeof message?.agent_network_id !== "string" ||
          typeof message?.body !== "string" ||
          typeof message?.created_at !== "string" ||
          typeof message?.expires_at !== "string" ||
          !message?.source
        )
          throw new Error("invalid external inbox message");
      }
    } else if (request.action === "ack-inbox") {
      if (
        result?.acknowledged !== true ||
        result?.message_id !== request.message_id
      )
        throw new Error("invalid external inbox acknowledgment");
    } else if (request.action === "propose-network") {
      if (
        result?.proposal_id !== request.proposal_id ||
        result?.state === undefined
      )
        throw new Error("invalid network proposal response");
    } else validateAgentRpcOutcome(result, request);
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
  agentNetworkId?: string,
): Promise<ResolvedAgentDestination> {
  const normalized = name.replace(/^@/, "");
  const destinations = (await sendExternalAgentMessage(profile, {
    version: 3,
    action: "destinations",
  })) as AgentNetworkDiscovery;
  const matches = destinations.peers.filter(
    ({ member, networks }) =>
      member.kind === "registered" &&
      member.name === normalized &&
      networks.some(
        ({ agent_network_id }) =>
          agentNetworkId === undefined || agent_network_id === agentNetworkId,
      ),
  );
  if (matches.length !== 1 || matches[0].member.kind !== "registered")
    throw new Error(
      "No unambiguous network peer; run agent destinations and specify --agent-network",
    );
  const networks = matches[0].networks.filter(
    ({ agent_network_id }) =>
      agentNetworkId === undefined || agent_network_id === agentNetworkId,
  );
  if (networks.length !== 1)
    throw new Error("Specify the exact --agent-network for this peer");
  return {
    target: matches[0].member.endpoint,
    agent_network_id: networks[0].agent_network_id,
  };
}
