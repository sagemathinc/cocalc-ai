import { createHash, randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import type {
  AgentRpcControlApi,
  RpcRoute,
} from "@cocalc/conat/inter-bay/agent-rpc";
import { createAgentRpcControlClient } from "@cocalc/conat/inter-bay/agent-rpc";
import {
  agentRpcEnvelopeKey,
  agentRpcSourceKey,
  isExternalAgentSource,
  rpcOutcome,
  validateAgentEndpoint,
  validateAgentRpcOutcome,
  validateAgentRpcPreparation,
  validateAgentRpcRequest,
  validateAgentRpcSource,
  validateAgentRpcTarget,
  type AgentEndpoint,
  type AgentRpcEnvelope,
  type AgentRpcBroadcast,
  type AgentRpcBroadcastOutcome,
  type AgentRpcRequest,
  type AgentRpcSource,
  type AgentRpcTarget,
} from "@cocalc/conat/agents/rpc";
import { validateAttachmentPayload } from "@cocalc/conat/agents/attachments";
import {
  agentRpcReportForVersion,
  validateAgentRpcTurnFailureReport,
  type AgentRpcExecution,
} from "@cocalc/conat/agents/rpc-reports";
import { claimAgentRpcReportExecution } from "./rpc-report-executions";
import {
  signAgentRpcReportCapability,
  verifyAgentRpcReportCapability,
} from "./rpc-report-capability";
import {
  parseAgentMessagingSubject,
  requireUuid,
} from "@cocalc/conat/agents/protocol";
import type {
  AgentNetworkActivity,
  AgentNetworkAuthorization,
  AgentNetworkDiscovery,
  AgentNetworkMember,
  PersonalAgentDenial,
} from "@cocalc/conat/agents/personal";
import { PersonalAgentAuthorizationError } from "@cocalc/conat/agents/personal";
import {
  parseExternalAgentSubject,
  validateExternalAgentSource,
} from "@cocalc/conat/agents/external";
import { createHostControlClient } from "@cocalc/conat/project-host/api";
import { getExplicitHostControlClient } from "@cocalc/server/conat/route-client";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  resolveHostBayAcrossCluster,
  resolveProjectBay,
} from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { assertProjectHostAgentTokenAccess } from "@cocalc/server/conat/api/project-host-token-auth";
import { assertActor, assertAgent, assertRun } from "./access";
import { agentStore } from "./store";
import {
  assertExternalAgentLoginEnabled,
  externalControl,
  enqueueExternalAgentMessage,
  externalStore,
} from "./external";
import { personalControl, withPersonalHome } from "./personal";

function networkMemberLabel(member: AgentNetworkMember): string {
  if (member.kind === "external") {
    return (
      member.label.trim() || `External agent ${member.member_id.slice(0, 8)}`
    );
  }
  return member.name
    ? `@${member.name}`
    : member.thread_title?.trim() || `Agent ${member.member_id.slice(0, 8)}`;
}
import { AgentRpcCapacityError } from "./admission-capacity";
import {
  claimAgentRpcAdmissionState,
  createAgentRpcAdmissionState,
  deleteAgentRpcAdmissionState,
  findAgentRpcPreparation,
  getAgentRpcAdmissionState,
  hashAgentRpcAdmissionBinding,
} from "./admission-state";

const logger = getLogger("agents:rpc");

function broadcastChildId(
  broadcast_id: string,
  target: AgentRpcTarget,
  index: number,
) {
  const bytes = createHash("sha256")
    .update(`${broadcast_id}\0${index}\0${agentRpcSourceKey(target)}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function submitBroadcast(
  account_id: string,
  source: AgentRpcSource,
  run_id: string | undefined,
  request: AgentRpcBroadcast,
  dispatch: (
    child: Extract<AgentRpcRequest, { action: "send" }>,
    authorization: AgentNetworkAuthorization,
  ) => Promise<unknown>,
): Promise<AgentRpcBroadcastOutcome> {
  const claim = (await withPersonalHome(account_id, {
    action: "beginBroadcast",
    options: { source, ...(run_id ? { run_id } : {}), broadcast: request },
  })) as {
    claimed: boolean;
    binding_hash: string;
    outcome?: AgentRpcBroadcastOutcome;
    authorizations?: AgentNetworkAuthorization[];
  };
  if (claim.outcome) return claim.outcome;
  if (!claim.claimed)
    return {
      version: 3,
      broadcast_id: request.broadcast_id,
      agent_network_id: request.agent_network_id,
      outcome: "unknown",
      observed_at: Date.now(),
      children: [],
    };
  if (claim.authorizations?.length !== request.targets.length)
    throw new Error("broadcast authorization snapshot unavailable");
  const children: import("@cocalc/conat/agents/rpc").AgentRpcOutcome[] = [];
  for (const [index, target] of request.targets.entries()) {
    const child = {
      version: 3 as const,
      action: "send" as const,
      attempt_id: broadcastChildId(request.broadcast_id, target, index),
      agent_network_id: request.agent_network_id,
      target,
      body: request.body,
    };
    try {
      children.push(
        (await dispatch(
          child,
          claim.authorizations[index],
        )) as import("@cocalc/conat/agents/rpc").AgentRpcOutcome,
      );
    } catch {
      children.push(
        rpcOutcome(child, "unknown", {
          reason: "Broadcast child admission could not be confirmed",
        }),
      );
    }
  }
  const outcome: AgentRpcBroadcastOutcome = {
    version: 3,
    broadcast_id: request.broadcast_id,
    agent_network_id: request.agent_network_id,
    outcome: children.every(({ outcome }) => outcome === "accepted")
      ? "accepted"
      : children.every(({ outcome }) => outcome === "rejected")
        ? "rejected"
        : "unknown",
    observed_at: Date.now(),
    children,
  };
  await withPersonalHome(account_id, {
    action: "finishBroadcast",
    options: {
      broadcast_id: request.broadcast_id,
      binding_hash: claim.binding_hash,
      outcome,
    },
  });
  return outcome;
}

async function owner(project_id: string) {
  requireUuid(project_id, "project_id");
  const route = await resolveProjectBay(project_id);
  if (!route) throw new Error("project owner unavailable");
  return { bay_id: route.bay_id, epoch: route.epoch };
}

async function routed<T>(
  project_id: string,
  fn: (api: AgentRpcControlApi, route: RpcRoute) => Promise<T>,
): Promise<T> {
  const route = await owner(project_id);
  return fn(
    route.bay_id === getConfiguredBayId()
      ? agentRpcControl
      : createAgentRpcControlClient(getInterBayFabricClient(), route.bay_id),
    { project_id, route },
  );
}

async function local(opts: RpcRoute, endpoint: AgentEndpoint) {
  validateAgentEndpoint(endpoint);
  const route = await owner(endpoint.project_id);
  if (
    opts.project_id !== endpoint.project_id ||
    route.bay_id !== getConfiguredBayId() ||
    opts.route?.bay_id !== route.bay_id ||
    opts.route?.epoch !== route.epoch
  )
    throw new Error("stale agent RPC route");
}

async function sourceIdentity(source: AgentEndpoint) {
  validateAgentEndpoint(source);
  const identity = await agentStore().get(source.agent_id);
  if (identity.project_id !== source.project_id)
    throw new Error("source mismatch");
  await assertAgent(identity);
  return identity;
}

async function sourceRun(source: AgentEndpoint, run_id: string) {
  requireUuid(run_id, "run_id");
  await sourceIdentity(source);
  const run = await agentStore().activeRun(source.agent_id, run_id);
  await assertRun(run);
  return run;
}

function preparationKey(e: AgentRpcEnvelope) {
  return agentRpcEnvelopeKey({
    ...e,
    permit_id: "",
    deadline: 0,
    attachment_reservation: undefined,
  });
}

/**
 * The delivery report version a host advertises: 1 if it advertises none,
 * or advertised it for another build than the one it runs now (heartbeat
 * metadata is merged, so a rolled-back host keeps the newer build's value).
 */
/** The report version that has "completed" reports (report_no_reply). */
const REPORT_NO_REPLY_HOST_VERSION = 3;

async function hostAgentRpcReportVersion(host_id: string): Promise<number> {
  const { rows } = await agentStore().query(
    `SELECT metadata->'agent_rpc_report'->>'version' AS version,
            metadata->'agent_rpc_report'->>'project_host' AS for_build,
            metadata->'software'->>'project_host' AS build
       FROM project_hosts WHERE id=$1`,
    [host_id],
  );
  const row = rows[0];
  const version = Number(row?.version);
  if (!Number.isSafeInteger(version) || version < 1) return 1;
  return row?.for_build && row.for_build === row.build ? version : 1;
}

export async function hostFor(endpoint: AgentEndpoint) {
  const project = (
    await agentStore().query(
      "SELECT host_id,state FROM projects WHERE project_id=$1 AND deleted IS NOT TRUE",
      [endpoint.project_id],
    )
  ).rows[0];
  if (!project?.host_id)
    throw new Error("recipient project has no assigned host");
  const hostOwner = await resolveHostBayAcrossCluster(project.host_id);
  if (!hostOwner || hostOwner.bay_id !== getConfiguredBayId())
    throw new Error("host ownership mismatch");
  return {
    host_id: project.host_id as string,
    api: createHostControlClient({
      host_id: project.host_id,
      client: await getExplicitHostControlClient({ host_id: project.host_id }),
      timeout: 35_000,
      noRetry: true,
    }),
  };
}

async function networkProof(
  account_id: string,
  source: AgentRpcSource,
  run_id: string | undefined,
  target: AgentRpcTarget,
  agent_network_id: string,
  forExecution = false,
): Promise<AgentNetworkAuthorization | PersonalAgentDenial> {
  validateAgentRpcSource(source, run_id);
  validateAgentRpcTarget(target);
  requireUuid(agent_network_id, "agent_network_id");
  requireUuid(account_id, "account_id");
  if (isExternalAgentSource(source) && source.account_id !== account_id)
    throw new PersonalAgentAuthorizationError("principal_mismatch");
  return (await withPersonalHome(account_id, {
    action: forExecution ? "checkExecutionNetwork" : "checkNetwork",
    options: {
      agent_network_id,
      source,
      ...(run_id ? { run_id } : {}),
      target,
    },
  })) as AgentNetworkAuthorization | PersonalAgentDenial;
}

function memberSource(member: AgentNetworkMember): AgentRpcSource {
  return member.kind === "registered" ? member.endpoint : member.source;
}

function validateSnapshotAuthorization(
  proof: AgentNetworkAuthorization,
  account_id: string,
  source: AgentRpcSource,
  request: import("@cocalc/conat/agents/rpc").AgentRpcSend,
) {
  if (
    proof.account_id !== account_id ||
    proof.agent_network_id !== request.agent_network_id ||
    agentRpcSourceKey(memberSource(proof.source)) !==
      agentRpcSourceKey(source) ||
    agentRpcSourceKey(memberSource(proof.target)) !==
      agentRpcSourceKey(request.target)
  )
    throw new PersonalAgentAuthorizationError("network_stale");
  return proof;
}

async function observeActivity(
  proof: AgentNetworkAuthorization,
  request: import("@cocalc/conat/agents/rpc").AgentRpcAttempt,
  outcome: import("@cocalc/conat/agents/rpc").AgentRpcOutcome,
  deliveryOverride?: AgentNetworkActivity["effective_delivery"],
) {
  const effective_delivery =
    deliveryOverride ??
    (outcome.operation?.disposition === "steered"
      ? "live-guidance"
      : outcome.operation?.disposition === "queued"
        ? "queued"
        : outcome.operation?.disposition === "running"
          ? "idle-wake"
          : proof.delivery_mode === "live"
            ? "queued-fallback"
            : undefined);
  const activity: AgentNetworkActivity = {
    attempt_id: request.attempt_id,
    agent_network_id: proof.agent_network_id,
    network_generation: proof.network_generation,
    source_member_id: proof.source.member_id,
    target_member_id: proof.target.member_id,
    configured_delivery: proof.delivery_mode,
    effective_delivery,
    outcome: outcome.outcome,
    observed_at: new Date(outcome.observed_at).toISOString(),
  };
  await withPersonalHome(proof.account_id, {
    action: "observeNetworkActivity",
    options: activity,
  });
}

async function submitAgentRpcOperation(
  opts: Parameters<AgentRpcControlApi["submit"]>[0],
  phase: "send" | "prepare" | "cancel" = "send",
): Promise<import("@cocalc/conat/agents/rpc").AgentRpcPreparation> {
  await local(opts, opts.request.target);
  validateAgentRpcRequest(
    {
      ...opts.request,
      action:
        phase === "prepare"
          ? "prepare-attachments"
          : phase === "cancel"
            ? "cancel-attachments"
            : "send",
    },
    true,
  );
  if (opts.request.snapshot_manifest || phase !== "send") {
    if (phase === "send")
      validateAttachmentPayload(
        { kind: "snapshots", files: opts.request.snapshot_manifest! },
        opts.snapshot_payload!,
      );
  } else if (opts.snapshot_payload !== undefined) {
    throw new Error("unexpected attachment bytes");
  }

  let submissionStarted = false;
  let permitId: string | undefined;
  let proof: AgentNetworkAuthorization | undefined;
  let observedOutcome:
    | import("@cocalc/conat/agents/rpc").AgentRpcOutcome
    | undefined;
  try {
    const checked = opts.authorization
      ? validateSnapshotAuthorization(
          opts.authorization,
          opts.account_id,
          opts.source,
          opts.request,
        )
      : await networkProof(
          opts.account_id,
          opts.source,
          opts.run_id,
          opts.request.target,
          opts.request.agent_network_id,
        );
    if ("denied" in checked)
      return rpcOutcome(opts.request, "rejected", {
        code: "network_unavailable",
        reason: checked.denied,
      });
    proof = checked;
    if (
      isExternalAgentSource(opts.source) &&
      opts.request.file_references !== undefined
    )
      throw new Error("external agents cannot send project file references");
    const target = await sourceIdentity(opts.request.target);
    await assertActor(proof.account_id, target.project_id);
    const host = await hostFor(opts.request.target);
    const envelope: AgentRpcEnvelope = {
      ...opts.request,
      source: opts.source,
      source_label: networkMemberLabel(proof.source),
      target_label: networkMemberLabel(proof.target),
      network_title: proof.network_title,
      ...(opts.run_id ? { run_id: opts.run_id } : {}),
      permit_id: randomUUID(),
      account_id: proof.account_id,
      network_generation: proof.network_generation,
      account_generation: proof.account_generation,
      configured_delivery: proof.delivery_mode,
      guidance: proof.delivery_mode === "live",
      path: target.path,
      thread_id: target.thread_id,
      deadline: Date.now() + 30_000,
    };
    // Asked to hear of a turn without a reply: refused, sending nothing, if
    // no report could arrive (checked here, against the current network
    // and the recipient's host, not the sender's earlier discovery).
    if (phase === "send" && opts.request.report_no_reply) {
      const why = envelope.guidance
        ? `Agent Network "${proof.network_title}" delivers live, into the recipient's running turn`
        : isExternalAgentSource(opts.source) ||
            isExternalAgentSource(opts.request.target)
          ? "external network members never get turn reports"
          : (await hostAgentRpcReportVersion(host.host_id)) <
              REPORT_NO_REPLY_HOST_VERSION
            ? "the recipient's project host is too old to report it"
            : undefined;
      if (why)
        return rpcOutcome(opts.request, "rejected", {
          reason: `--report-no-reply is not possible here: ${why}; no message was sent`,
          chat_effect: "none",
        });
    }
    // A queued message starts a turn of its own; if that turn fails, its
    // host may report it, but only this exact message (see
    // rpc-report-capability.ts).
    if (phase === "send" && !envelope.guidance) {
      try {
        envelope.report_capability = signAgentRpcReportCapability(
          executionOfEnvelope(envelope),
        );
      } catch (err) {
        // Reports are a courtesy: the message still goes, unreportable.
        logger.warn("agent message sent without a report capability", {
          attempt_id: envelope.attempt_id,
          err: `${err}`,
        });
      }
    }
    // A send with attachments consumes its one-shot preparation only after
    // its permit is admitted, so a refused permit leaves the reservation for
    // a retry or cancel instead of burning it.
    const preparation =
      phase !== "prepare" && envelope.snapshot_manifest
        ? {
            token_id: envelope.attachment_reservation!,
            binding_hash: hashAgentRpcAdmissionBinding(
              preparationKey(envelope),
            ),
            host_id: host.host_id,
            project_id: envelope.target.project_id,
            account_id: envelope.account_id,
          }
        : undefined;
    const unavailable = () =>
      rpcOutcome(opts.request, "rejected", {
        code: "attachment_preparation_unavailable",
        reason:
          "Attachment preparation expired, changed, or was already used; no message was submitted",
        chat_effect: "none",
      });
    if (preparation) {
      const prepared = await findAgentRpcPreparation(preparation);
      if (!prepared) return unavailable();
      envelope.deadline = Math.min(
        envelope.deadline,
        prepared.expires_at.getTime(),
      );
    }
    permitId = envelope.permit_id;
    await createAgentRpcAdmissionState(
      {
        token_id: envelope.permit_id,
        kind: "permit",
        binding_hash: hashAgentRpcAdmissionBinding(
          agentRpcEnvelopeKey(envelope),
        ),
        host_id: host.host_id,
        project_id: envelope.target.project_id,
        account_id: envelope.account_id,
        expires_at: new Date(envelope.deadline),
      },
      { coveredBy: preparation },
    );
    if (
      preparation &&
      !(await claimAgentRpcAdmissionState({
        ...preparation,
        kind: "preparation",
      }))
    )
      return unavailable();
    if (phase === "prepare") {
      const ready = await host.api.prepareAgentRpcAttachments(envelope);
      validateAgentRpcPreparation(ready, opts.request);
      if (ready.outcome === "prepared") {
        if (
          ready.expires_at > envelope.deadline ||
          ready.expires_at <= Date.now()
        )
          throw new Error("attachment readiness expired or invalid");
        await createAgentRpcAdmissionState({
          token_id: ready.reservation_id,
          kind: "preparation",
          binding_hash: hashAgentRpcAdmissionBinding(preparationKey(envelope)),
          host_id: host.host_id,
          project_id: envelope.target.project_id,
          account_id: envelope.account_id,
          expires_at: new Date(ready.expires_at),
        });
      }
      return ready;
    }
    if (phase === "cancel") {
      await host.api.cancelAgentRpcAttachments(envelope);
      return rpcOutcome(opts.request, "rejected", {
        reason: "Attachment preparation cancelled; no message was submitted",
        chat_effect: "none",
      });
    }
    submissionStarted = true;
    const outcome =
      opts.snapshot_payload === undefined
        ? await host.api.submitAgentRpc(envelope)
        : await host.api.submitAgentRpc(envelope, opts.snapshot_payload);
    validateAgentRpcOutcome(outcome, opts.request);
    observedOutcome = outcome;
    return outcome;
  } catch (error) {
    logger.warn("recipient submission failed", {
      attempt_id: opts.request.attempt_id,
      agent_network_id: opts.request.agent_network_id,
      target: opts.request.target,
      submissionStarted,
      error: `${error}`,
    });
    observedOutcome = rpcOutcome(
      opts.request,
      submissionStarted ? "unknown" : "rejected",
      {
        code:
          error instanceof PersonalAgentAuthorizationError
            ? "network_unavailable"
            : !submissionStarted &&
                error instanceof AgentRpcCapacityError &&
                error.scope === "recipient"
              ? "project_overloaded"
              : undefined,
        reason: submissionStarted
          ? "Recipient acknowledgment unavailable"
          : error instanceof PersonalAgentAuthorizationError
            ? error.denial
            : error instanceof AgentRpcCapacityError
              ? error.reason
              : "Network, execution account, target, or host unavailable",
        ...(!submissionStarted && error instanceof AgentRpcCapacityError
          ? { chat_effect: "none" as const }
          : {}),
      },
    );
    return observedOutcome;
  } finally {
    if (permitId)
      await deleteAgentRpcAdmissionState({
        token_id: permitId,
        kind: "permit",
      }).catch((error) =>
        logger.warn("failed to release agent RPC admission permit", {
          permit_id: permitId,
          error: `${error}`,
        }),
      );
    if (proof && phase === "send" && observedOutcome) {
      // Observation is bounded best-effort evidence and never changes delivery.
      void observeActivity(proof, opts.request, observedOutcome).catch(
        (error) =>
          logger.warn("network activity observation unavailable", {
            error: `${error}`,
          }),
      );
    }
  }
}

export const agentRpcControl: AgentRpcControlApi = {
  external: externalControl,
  memory: async (opts) =>
    (await import("./memory-home")).memoryHomeControl(opts),
  personal: (opts) => personalControl(opts),
  principal: async (opts) => {
    await local(opts, opts.source);
    return {
      account_id: (await sourceRun(opts.source, opts.run_id)).account_id,
      personal_messaging: true,
    };
  },
  executionPrincipal: async (opts) => {
    await local(opts, opts.source);
    requireUuid(opts.run_id, "run_id");
    await sourceIdentity(opts.source);
    const run = await agentStore().executionRun(
      opts.source.agent_id,
      opts.run_id,
    );
    await assertRun(run);
    return { account_id: run.account_id, personal_messaging: true };
  },
  submit: async (opts) =>
    (await submitAgentRpcOperation(
      opts,
    )) as import("@cocalc/conat/agents/rpc").AgentRpcOutcome,
  prepareAttachments: (opts) => submitAgentRpcOperation(opts, "prepare"),
  cancelAttachments: async (opts) =>
    (await submitAgentRpcOperation(
      opts,
      "cancel",
    )) as import("@cocalc/conat/agents/rpc").AgentRpcOutcome,
  deliverReport: async (opts) => {
    validateAgentRpcTurnFailureReport(opts.report);
    const sender = opts.report.authorization.source;
    if (isExternalAgentSource(sender))
      throw new Error("an external sender has no chat");
    await local(opts, sender);
    // The forwarding bay checked it; so does this one.
    if (!verifyAgentRpcReportCapability(opts.report.authorization))
      throw new Error("the report does not match an admitted message");
    const identity = await sourceIdentity(sender);
    const host = await hostFor(sender);
    // Only what the sender's host can render truthfully (see
    // agentRpcReportForVersion); held reports are tried again later.
    const report = agentRpcReportForVersion(
      opts.report,
      await hostAgentRpcReportVersion(host.host_id),
    );
    if (!report)
      throw new Error(
        "the sender's host must be upgraded before it can receive this report",
      );
    const result = await host.api.deliverAgentRpcReport({
      account_id: opts.account_id,
      report,
      path: identity.path,
      thread_id: identity.thread_id,
      target_label: opts.target_label,
    });
    // Not written (the project did not start, the chat did not open, ...):
    // the recipient's host tries again later.
    if ("not_sent" in result)
      throw new Error(`delivery report not written: ${result.not_sent}`);
    return result;
  },
  inspect: async (opts) => {
    await local(opts, opts.request.target);
    validateAgentRpcRequest({ ...opts.request, action: "inspect" });
    const proof = await networkProof(
      opts.account_id,
      opts.source,
      opts.run_id,
      opts.request.target,
      opts.request.agent_network_id,
    );
    if ("denied" in proof)
      return rpcOutcome(opts.request, "unknown", {
        reason: "Operational evidence unavailable",
      });
    try {
      const outcome = await (
        await hostFor(opts.request.target)
      ).api.inspectAgentRpc({
        source: opts.source,
        request: opts.request,
        account_id: proof.account_id,
      });
      validateAgentRpcOutcome(outcome, opts.request);
      return outcome;
    } catch {
      return rpcOutcome(opts.request, "unknown", {
        reason: "Operational evidence unavailable",
      });
    }
  },
};

/** The execution authorization the recipient's host builds from an envelope. */
export function executionOfEnvelope(e: AgentRpcEnvelope): AgentRpcExecution {
  return {
    version: 3,
    source: e.source,
    ...(e.run_id ? { source_run_id: e.run_id } : {}),
    target: e.target,
    target_path: e.path,
    target_thread_id: e.thread_id,
    agent_network_id: e.agent_network_id,
    network_generation: e.network_generation,
    account_generation: e.account_generation,
    configured_delivery: e.configured_delivery,
    principal_account_id: e.account_id,
    guidance: e.guidance === true,
    attempt_id: e.attempt_id,
  };
}

async function reauthorizeEnvelope(e: AgentRpcEnvelope) {
  if (Date.now() >= e.deadline) throw new Error("submission deadline expired");
  const proof = await networkProof(
    e.account_id,
    e.source,
    e.run_id,
    e.target,
    e.agent_network_id,
  );
  if ("denied" in proof)
    throw new PersonalAgentAuthorizationError(proof.denied);
  if (
    proof.account_id !== e.account_id ||
    proof.network_generation !== e.network_generation ||
    proof.account_generation !== e.account_generation ||
    proof.delivery_mode !== e.configured_delivery ||
    e.guidance !== (proof.delivery_mode === "live")
  )
    throw new PersonalAgentAuthorizationError("network_stale");
  return proof;
}

export const authorizeRpcAdmission: AgentApi["authorizeRpcAdmission"] = async (
  opts,
) => {
  const e = opts.envelope;
  const permit = await getAgentRpcAdmissionState({
    token_id: e.permit_id,
    kind: "permit",
  });
  if (
    !permit ||
    permit.binding_hash !==
      hashAgentRpcAdmissionBinding(agentRpcEnvelopeKey(e)) ||
    permit.host_id !== opts.host_id ||
    permit.project_id !== e.target.project_id ||
    permit.account_id !== e.account_id ||
    e.account_id !== opts.account_id
  )
    throw new Error("RPC admission permit unavailable or mismatched");
  await assertProjectHostAgentTokenAccess({
    account_id: e.account_id,
    host_id: permit.host_id,
    project_id: e.target.project_id,
  });
  const target = await sourceIdentity(e.target);
  if (target.path !== e.path || target.thread_id !== e.thread_id)
    throw new Error("target identity changed");
  if (isExternalAgentSource(e.source) && e.file_references !== undefined)
    throw new Error("external agents cannot send project file references");
  await reauthorizeEnvelope(e);
};

export const authorizeRpcExecution: AgentApi["authorizeRpcExecution"] = async (
  opts,
) => {
  const host_id = `${opts.host_id ?? ""}`.trim();
  const account_id = `${opts.account_id ?? ""}`.trim();
  const authorization = opts.authorization;
  if (!host_id || !account_id || authorization?.version !== 3)
    throw new Error("invalid RPC execution authorization");
  if (authorization.principal_account_id !== account_id)
    throw new PersonalAgentAuthorizationError("principal_mismatch");
  validateAgentRpcSource(authorization.source, authorization.source_run_id);
  validateAgentEndpoint(authorization.target);
  await assertProjectHostAgentTokenAccess({
    account_id,
    host_id,
    project_id: authorization.target.project_id,
  });
  const target = await sourceIdentity(authorization.target);
  if (
    target.path !== authorization.target_path ||
    target.thread_id !== authorization.target_thread_id
  )
    throw new Error("target identity changed");
  // The authenticated destination host supplies its already-admitted queue
  // record, not editable chat content. Recheck current authority, but do not
  // require the original sender process/credential to remain alive.
  const proof = await messageAuthority(authorization);
  if ("denied" in proof)
    throw new PersonalAgentAuthorizationError(proof.denied);
};

/**
 * Whether an admitted message (its execution authorization) is still
 * authorized now: the network, its generation and delivery mode unchanged,
 * without requiring the sender's process to still be alive.
 */
async function messageAuthority(
  authorization: AgentRpcExecution,
): Promise<AgentNetworkAuthorization | PersonalAgentDenial> {
  const account_id = authorization.principal_account_id;
  const proof = await networkProof(
    account_id,
    authorization.source,
    authorization.source_run_id,
    authorization.target,
    authorization.agent_network_id,
    true,
  );
  if ("denied" in proof) return proof;
  if (
    proof.account_id !== account_id ||
    proof.network_generation !== authorization.network_generation ||
    proof.account_generation !== authorization.account_generation ||
    proof.delivery_mode !== authorization.configured_delivery ||
    authorization.guidance !== (proof.delivery_mode === "live")
  )
    return { denied: "network_stale" } as PersonalAgentDenial;
  return proof;
}

/**
 * The recipient's host reports that the turn a message started ended in an
 * error before the recipient replied. Recheck that message's authority and
 * tell its sender: an external sender's inbox, or the sender's own chat
 * (through the sender's project bay and host). Refusals are not_sent and
 * final; delivery failures throw, so the host tries again later.
 */
export const reportRpcTurnFailure: AgentApi["reportRpcTurnFailure"] = async (
  opts,
) => {
  const host_id = `${opts.host_id ?? ""}`.trim();
  const account_id = `${opts.account_id ?? ""}`.trim();
  if (!host_id || !account_id) throw new Error("invalid delivery report");
  const report = opts.report;
  validateAgentRpcTurnFailureReport(report);
  const message = report.authorization;
  if (message.principal_account_id !== account_id)
    throw new PersonalAgentAuthorizationError("principal_mismatch");
  // Only a message the hub admitted, exactly as admitted.
  if (!verifyAgentRpcReportCapability(message))
    return { not_sent: "the report does not match an admitted message" };
  // External senders read an inbox where a reply cannot yet be checked for;
  // they are not sent reports (rather than a false "before it replied").
  if (isExternalAgentSource(message.source))
    return { not_sent: "external senders are not sent delivery reports" };
  // Only the host the failed turn ran on (the recipient's) may report it.
  await assertProjectHostAgentTokenAccess({
    account_id,
    host_id,
    project_id: message.target.project_id,
  });
  const recipient = await sourceIdentity(message.target);
  if (
    recipient.path !== message.target_path ||
    recipient.thread_id !== message.target_thread_id
  )
    return { not_sent: "the recipient's conversation changed" };
  const proof = await messageAuthority(message);
  if ("denied" in proof)
    return { not_sent: `the message is no longer authorized: ${proof.denied}` };
  const target_label = networkMemberLabel(proof.target);
  const sender = message.source as AgentEndpoint;
  return await routed(sender.project_id, (api, route) =>
    api.deliverReport({ ...route, account_id, report, target_label }),
  );
};

/** Before the turn a delivery report started runs, recheck it. */
export const authorizeRpcReportExecution: AgentApi["authorizeRpcReportExecution"] =
  async (opts) => {
    const host_id = `${opts.host_id ?? ""}`.trim();
    const account_id = `${opts.account_id ?? ""}`.trim();
    if (!host_id || !account_id)
      throw new Error("invalid delivery report execution");
    const report = opts.report;
    validateAgentRpcTurnFailureReport(report);
    const message = report.authorization;
    if (message.principal_account_id !== account_id)
      throw new PersonalAgentAuthorizationError("principal_mismatch");
    // Only a report of a message the hub sent, exactly as sent, recently.
    if (!verifyAgentRpcReportCapability(message))
      throw new Error("the report does not match an admitted message");
    if (isExternalAgentSource(message.source))
      throw new Error("an external sender has no turn to run");
    // The report runs as a turn of the message's sender, on its host.
    await assertProjectHostAgentTokenAccess({
      account_id,
      host_id,
      project_id: message.source.project_id,
    });
    const sender = await sourceIdentity(message.source);
    if (
      sender.path !== opts.delivery?.path ||
      sender.thread_id !== opts.delivery?.thread_id
    )
      throw new Error("sender identity changed");
    const proof = await messageAuthority(message);
    if ("denied" in proof)
      throw new PersonalAgentAuthorizationError(proof.denied);
    // Last, once everything else allowed it: one turn per reported message.
    if (
      !(await claimAgentRpcReportExecution({
        attempt_id: report.attempt_id,
        report_id: report.report_id,
        account_id,
        project_id: message.source.project_id,
        host_id,
        path: sender.path,
        thread_id: sender.thread_id,
      }))
    )
      throw new Error("this delivery report already started a turn");
  };

async function submitExternalInbox(
  account_id: string,
  source: AgentRpcSource,
  run_id: string | undefined,
  request: import("@cocalc/conat/agents/rpc").AgentRpcSend,
) {
  if (!isExternalAgentSource(request.target))
    throw new Error("external inbox target required");
  if (
    request.file_references !== undefined ||
    request.snapshot_manifest !== undefined ||
    request.attachment_reservation !== undefined
  )
    return rpcOutcome(request, "rejected", {
      code: "attachment_unavailable",
      chat_effect: "none",
      reason: "External inbox attachments are not available",
    });
  const checked = await networkProof(
    account_id,
    source,
    run_id,
    request.target,
    request.agent_network_id,
  );
  if ("denied" in checked)
    return rpcOutcome(request, "rejected", {
      code: "network_unavailable",
      chat_effect: "none",
      reason: checked.denied,
    });
  if (
    checked.account_id !== request.target.account_id ||
    checked.target.kind !== "external" ||
    checked.target.source.installation_id !== request.target.installation_id
  )
    return rpcOutcome(request, "rejected", {
      code: "principal_mismatch",
      chat_effect: "none",
      reason: "External target principal mismatch",
    });
  try {
    await enqueueExternalAgentMessage({
      account_id: checked.account_id,
      installation_id: request.target.installation_id,
      attempt_id: request.attempt_id,
      agent_network_id: checked.agent_network_id,
      network_generation: checked.network_generation,
      source,
      body: request.body,
    });
    const outcome = rpcOutcome(request, "accepted", {
      chat_effect: "saved",
      reason: "Accepted by the external agent inbox",
    });
    void observeActivity(checked, request, outcome, "external-inbox").catch(
      (error) =>
        logger.warn("external inbox activity observation unavailable", {
          error: `${error}`,
        }),
    );
    return outcome;
  } catch (error) {
    return rpcOutcome(request, "unknown", {
      reason: `External inbox admission could not be confirmed: ${error}`,
    });
  }
}

async function submitAuthorizedBroadcastChild(
  account_id: string,
  source: AgentRpcSource,
  run_id: string | undefined,
  request: import("@cocalc/conat/agents/rpc").AgentRpcSend,
  authorization: AgentNetworkAuthorization,
) {
  if (isExternalAgentSource(request.target))
    return submitExternalInbox(account_id, source, run_id, request);
  const target = request.target;
  return routed(target.project_id, (api, route) =>
    api.submit({
      ...route,
      account_id,
      source,
      ...(run_id ? { run_id } : {}),
      request: { ...request, target },
      authorization,
    }),
  );
}

export async function acceptAgentRpc(
  subject: string,
  request: AgentRpcRequest,
) {
  validateAgentRpcRequest(request);
  const { agent_id, run_id } = parseAgentMessagingSubject(subject);
  const identity = await agentStore().get(agent_id);
  const source = { agent_id, project_id: identity.project_id };
  const run = await sourceRun(source, run_id);
  if (request.action === "destinations")
    return withPersonalHome(run.account_id, {
      action: "discoverNetworks",
      options: { source, run_id },
    });
  if (request.action === "propose-network") {
    const { version: _, action: __, ...proposal } = request;
    return withPersonalHome(run.account_id, {
      action: "proposeNetwork",
      options: { source, run_id, proposal },
    });
  }
  if (request.action === "broadcast")
    return submitBroadcast(
      run.account_id,
      source,
      run_id,
      request,
      (child, authorization) =>
        submitAuthorizedBroadcastChild(
          run.account_id,
          source,
          run_id,
          child,
          authorization,
        ),
    );
  if (request.action === "inbox" || request.action === "ack-inbox")
    throw new Error("native agents do not have an external inbox");
  if (isExternalAgentSource(request.target)) {
    if (request.action !== "send")
      return rpcOutcome(request, "rejected", {
        chat_effect: "none",
        reason: "External inbox supports direct send only",
      });
    return submitExternalInbox(run.account_id, source, run_id, request);
  }
  const target = request.target;
  if (
    request.action === "prepare-attachments" ||
    request.action === "cancel-attachments"
  ) {
    const { action, ...attempt } = request;
    const registeredSend = { ...attempt, target };
    return routed(target.project_id, (api, route) =>
      action === "prepare-attachments"
        ? api.prepareAttachments({
            ...route,
            account_id: run.account_id,
            source,
            run_id,
            request: registeredSend,
          })
        : api.cancelAttachments({
            ...route,
            account_id: run.account_id,
            source,
            run_id,
            request: registeredSend,
          }),
    );
  }
  if (request.action === "inspect") {
    const { action: _, ...attempt } = request;
    return routed(target.project_id, (api, route) =>
      api.inspect({
        ...route,
        account_id: run.account_id,
        source,
        run_id,
        request: { ...attempt, target },
      }),
    );
  }
  const { action: _, ...rest } = request;
  const { snapshot_payload, ...attempt } = rest as typeof rest & {
    snapshot_payload?: import("@cocalc/conat/agents/attachments").AgentSnapshot[];
  };
  const registeredAttempt = { ...attempt, target };
  return routed(target.project_id, (api, route) =>
    api.submit({
      ...route,
      account_id: run.account_id,
      source,
      run_id,
      request: registeredAttempt,
      ...(snapshot_payload ? { snapshot_payload } : {}),
    }),
  );
}

/** Only the external credential's exact sealed Conat subject reaches here. */
export async function acceptExternalAgentRpc(
  subject: string,
  request: AgentRpcRequest,
) {
  assertExternalAgentLoginEnabled();
  validateAgentRpcRequest(request);
  const { account_id, installation_id } = parseExternalAgentSubject(subject);
  const installation = await externalStore().activeInstallation(
    account_id,
    installation_id,
  );
  const source = {
    kind: "external" as const,
    account_id,
    installation_id,
    agent_id: installation.agent_id,
  };
  validateExternalAgentSource(source);
  if (request.action === "destinations")
    return (await withPersonalHome(account_id, {
      action: "discoverNetworks",
      options: { source },
    })) as AgentNetworkDiscovery;
  if (request.action === "propose-network") {
    const { version: _, action: __, ...proposal } = request;
    return withPersonalHome(account_id, {
      action: "proposeNetwork",
      options: { source, proposal },
    });
  }
  if (request.action === "broadcast")
    return submitBroadcast(
      account_id,
      source,
      undefined,
      request,
      (child, authorization) =>
        submitAuthorizedBroadcastChild(
          account_id,
          source,
          undefined,
          child,
          authorization,
        ),
    );
  if (request.action === "inbox")
    return externalStore().inbox(account_id, installation_id, request.limit);
  if (request.action === "ack-inbox")
    return externalStore().acknowledge(
      account_id,
      installation_id,
      request.message_id,
    );
  if (isExternalAgentSource(request.target)) {
    if (request.action !== "send")
      return rpcOutcome(request, "rejected", {
        chat_effect: "none",
        reason: "External inbox supports direct send only",
      });
    return submitExternalInbox(account_id, source, undefined, request);
  }
  const target = request.target;
  if (request.action === "inspect") {
    const { action: _, ...attempt } = request;
    return routed(target.project_id, (api, route) =>
      api.inspect({
        ...route,
        account_id,
        source,
        request: { ...attempt, target },
      }),
    );
  }
  const { action, ...rest } = request;
  const { snapshot_payload, ...attempt } = rest as typeof rest & {
    snapshot_payload?: import("@cocalc/conat/agents/attachments").AgentSnapshot[];
  };
  const registeredAttempt = { ...attempt, target };
  return routed(target.project_id, (api, route) => {
    const opts = {
      ...route,
      account_id,
      source,
      request: registeredAttempt,
    };
    const sendOpts = {
      ...opts,
      request: registeredAttempt,
    };
    if (action === "prepare-attachments")
      return api.prepareAttachments(sendOpts);
    if (action === "cancel-attachments") return api.cancelAttachments(sendOpts);
    return api.submit({
      ...sendOpts,
      ...(snapshot_payload ? { snapshot_payload } : {}),
    });
  });
}
