/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// One message to one network peer, sent with this runtime's agent identity.
// Shared by `cocalc agent send` and `cocalc project chat send --to/--rpc`.

import { randomUUID } from "node:crypto";
import type { AgentSelf } from "@cocalc/conat/agents/protocol";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import type { AgentNetworkDiscovery } from "@cocalc/conat/agents/personal";
import type {
  AgentRpcOutcome,
  AgentRpcPreparation,
  AgentRpcRequest,
  AgentRpcSend,
  AgentRpcTarget,
} from "@cocalc/conat/agents/rpc";
import {
  isExternalAgentSource,
  validateAgentRpcPreparation,
} from "@cocalc/conat/agents/rpc";
import { encodeAgentMessageRuntimeEvent } from "@cocalc/conat/agents/runtime-events";
import { sendIdentityMessage } from "./agent-message";
import {
  resolveExternalAgentName,
  sendExternalAgentMessage,
} from "./external-agent-message";
import {
  readAgentAttachmentSnapshots,
  readAgentFileReferences,
} from "./agent-attachments";
import { resolveRuntimeAgentName } from "./agent-destination";

export interface AgentSendOptions {
  body: string;
  /** Peer name from discovery (or a selected @mention). */
  to?: string;
  /** Registered agent id; requires agentNetwork. */
  toAgent?: string;
  agentNetwork?: string;
  attach?: string[];
  attemptId?: string;
  externalAgent?: string;
  api?: string;
}

export interface AgentSendResult {
  outcome: AgentRpcOutcome;
  target_name?: string;
  project_title?: string;
  agent_network_title: string;
  delivery_mode?: string;
}

export async function sendAgentMessage(
  opts: AgentSendOptions,
): Promise<AgentSendResult> {
  if ((!opts.toAgent && !opts.to) || (opts.toAgent && opts.to))
    throw new Error("Name exactly one recipient: a peer name or --to-agent ID");
  if (opts.toAgent) requireUuid(opts.toAgent, "to-agent");
  const attempt_id = opts.attemptId || randomUUID();
  requireUuid(attempt_id, "attempt-id");
  const send = (request: AgentRpcRequest) =>
    opts.externalAgent
      ? sendExternalAgentMessage(opts.externalAgent, request)
      : sendIdentityMessage(request, opts.api);
  let target: AgentRpcTarget;
  let targetName: string | undefined;
  let projectTitle: string | undefined;
  let deliveryMode: string | undefined;
  let agent_network_id: string;
  let agent_network_title: string;
  if (opts.to) {
    const resolved = opts.externalAgent
      ? await resolveExternalAgentName(
          opts.externalAgent,
          opts.to,
          opts.agentNetwork,
        )
      : await resolveRuntimeAgentName(opts.to, opts.api, opts.agentNetwork);
    target = resolved.target;
    targetName = opts.to.trim().replace(/^@/, "");
    projectTitle = resolved.project_title;
    deliveryMode = resolved.delivery_mode;
    agent_network_id = resolved.agent_network_id;
    agent_network_title = resolved.agent_network_title;
  } else {
    if (!opts.agentNetwork)
      throw new Error(
        "--to-agent requires --agent-network with the exact network title",
      );
    const destinations = (await send({
      version: 3,
      action: "destinations",
    })) as AgentNetworkDiscovery;
    const destination = destinations.peers.find(
      ({ member }) =>
        member.kind === "registered" &&
        member.endpoint.agent_id === opts.toAgent,
    );
    if (!destination || destination.member.kind !== "registered")
      throw new Error(
        "Target is not a registered network member; no submission attempted",
      );
    const networks = destination.networks.filter(
      (network) =>
        network.agent_network_id === opts.agentNetwork ||
        network.title === opts.agentNetwork,
    );
    if (networks.length !== 1)
      throw new Error(
        "--agent-network must identify one exact network title; no submission attempted",
      );
    target = destination.member.endpoint;
    targetName = destination.member.name;
    projectTitle = destination.member.project_title;
    deliveryMode = networks[0].delivery_mode;
    agent_network_id = networks[0].agent_network_id;
    agent_network_title = networks[0].title;
  }
  process.stderr.write(
    `Agent RPC attempt ${attempt_id}; target ${JSON.stringify(target)}\n`,
  );
  const result = (outcome: AgentRpcOutcome): AgentSendResult => ({
    outcome,
    ...(targetName ? { target_name: targetName } : {}),
    ...(projectTitle ? { project_title: projectTitle } : {}),
    agent_network_title,
    ...(deliveryMode ? { delivery_mode: deliveryMode } : {}),
  });
  let file_references;
  let snapshots:
    | Awaited<ReturnType<typeof readAgentAttachmentSnapshots>>
    | undefined;
  if (opts.attach?.length) {
    if (isExternalAgentSource(target))
      throw new Error(
        "Attachments to external network members are not supported",
      );
    const self = opts.externalAgent
      ? undefined
      : ((await sendIdentityMessage(
          { action: "whoami" },
          opts.api,
        )) as AgentSelf);
    if (self?.identity?.project_id !== target.project_id) {
      snapshots = await readAgentAttachmentSnapshots(opts.attach);
    } else {
      const metadata = await readAgentFileReferences(opts.attach);
      if (metadata.kind !== "project-files")
        throw new Error("invalid file references");
      file_references = metadata.files;
    }
  }
  const request: AgentRpcSend = {
    version: 3,
    attempt_id,
    agent_network_id,
    target,
    body: opts.body,
    ...(file_references ? { file_references } : {}),
  };
  if (snapshots) {
    if (snapshots.metadata.kind !== "snapshots")
      throw new Error("invalid snapshot metadata");
    request.snapshot_manifest = snapshots.metadata.files;
    const ready = (await send({
      ...request,
      action: "prepare-attachments",
    })) as AgentRpcPreparation;
    validateAgentRpcPreparation(ready, request);
    if (ready.outcome !== "prepared") return result(ready);
    request.attachment_reservation = ready.reservation_id;
    if (ready.expires_at <= Date.now())
      throw new Error(
        "Attachment preparation expired before transfer; no message was sent",
      );
  }
  const outcome = (await send({
    ...request,
    action: "send",
    ...(snapshots ? { snapshot_payload: snapshots.files } : {}),
  })) as AgentRpcOutcome;
  if (
    process.env.COCALC_CLI_AGENT_MODE === "1" &&
    process.env.COCALC_CODEX_CHAT_PATH &&
    process.env.COCALC_CODEX_THREAD_ID
  ) {
    process.stderr.write(
      encodeAgentMessageRuntimeEvent({
        version: 1,
        type: "agent-message",
        direction: "outgoing",
        target,
        ...(targetName ? { target_name: targetName } : {}),
        body: opts.body,
        agent_network_id,
        agent_network_title,
        attempt_id,
        outcome: outcome.outcome,
        observed_at: outcome.observed_at,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.chat_effect ? { chat_effect: outcome.chat_effect } : {}),
      }),
    );
  }
  return result(outcome);
}

/** Exit status for a send outcome: 0 accepted, 2 rejected, 3 unknown. */
export function agentSendExitCode(outcome: AgentRpcOutcome["outcome"]) {
  return outcome === "accepted" ? 0 : outcome === "rejected" ? 2 : 3;
}

/** One plain sentence on what happened and what to do next. */
export function agentSendSummary(result: AgentSendResult): string {
  const { outcome } = result;
  const who = `@${result.target_name ?? "the recipient"}${
    result.project_title ? ` (${result.project_title})` : ""
  }`;
  const network = `Agent Network "${result.agent_network_title}"`;
  if (outcome.outcome === "accepted") {
    const turn =
      outcome.operation?.disposition === "steered"
        ? "it was added to their running turn"
        : outcome.operation?.disposition === "queued"
          ? "their turn is queued behind their current work"
          : outcome.operation?.disposition === "running"
            ? "their turn started"
            : "their turn was started or queued";
    return `Delivered to ${who} via ${network}: saved in their thread and ${turn}. Accepted means admitted, not finished; a reply, if they send one, arrives as a new message in your thread.`;
  }
  const why = outcome.reason ?? outcome.code ?? "no reason given";
  if (outcome.outcome === "rejected")
    return `Not delivered to ${who} via ${network}: ${why}.${
      outcome.chat_effect === "saved"
        ? " The message was saved in their thread, but no turn started."
        : " Nothing was saved."
    }`;
  const target = outcome.target;
  const inspect = isExternalAgentSource(target)
    ? ""
    : ` Check without resending: agent rpc inspect ${outcome.attempt_id} --agent-network ${outcome.agent_network_id} --to-agent ${target.agent_id} --target-project ${target.project_id}.`;
  return `Delivery to ${who} via ${network} is unconfirmed: ${why}. It may still run, so do not resend automatically.${inspect} A deliberate retry needs a new --attempt-id.`;
}
