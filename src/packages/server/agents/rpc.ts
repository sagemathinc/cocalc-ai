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
  parseAgentMessagingSubject,
  requireUuid,
} from "@cocalc/conat/agents/protocol";
import type {
  AgentSessionActivity,
  AgentSessionAuthorization,
  AgentSessionDiscovery,
  AgentSessionMember,
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
  externalStore,
} from "./external";
import { personalControl, withPersonalHome } from "./personal";

function sessionMemberLabel(member: AgentSessionMember): string {
  if (member.kind === "external") {
    return (
      member.label.trim() || `External agent ${member.member_id.slice(0, 8)}`
    );
  }
  return member.name
    ? `@${member.name}`
    : member.thread_title?.trim() || `Agent ${member.member_id.slice(0, 8)}`;
}
import {
  claimAgentRpcAdmissionState,
  createAgentRpcAdmissionState,
  deleteAgentRpcAdmissionState,
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
  ) => Promise<unknown>,
): Promise<AgentRpcBroadcastOutcome> {
  const claim = (await withPersonalHome(account_id, {
    action: "beginBroadcast",
    options: { source, ...(run_id ? { run_id } : {}), broadcast: request },
  })) as {
    claimed: boolean;
    binding_hash: string;
    outcome?: AgentRpcBroadcastOutcome;
  };
  if (claim.outcome) return claim.outcome;
  if (!claim.claimed)
    return {
      version: 3,
      broadcast_id: request.broadcast_id,
      agent_session_id: request.agent_session_id,
      outcome: "unknown",
      observed_at: Date.now(),
      children: [],
    };
  const children: import("@cocalc/conat/agents/rpc").AgentRpcOutcome[] = [];
  for (const [index, target] of request.targets.entries()) {
    const child = {
      version: 3 as const,
      action: "send" as const,
      attempt_id: broadcastChildId(request.broadcast_id, target, index),
      agent_session_id: request.agent_session_id,
      target,
      body: request.body,
    };
    try {
      children.push(
        (await dispatch(
          child,
        )) as import("@cocalc/conat/agents/rpc").AgentRpcOutcome,
      );
    } catch {
      children.push(
        rpcOutcome(child, "rejected", {
          chat_effect: "none",
          reason: "Broadcast child was rejected before admission",
        }),
      );
    }
  }
  const outcome: AgentRpcBroadcastOutcome = {
    version: 3,
    broadcast_id: request.broadcast_id,
    agent_session_id: request.agent_session_id,
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

async function hostFor(endpoint: AgentEndpoint) {
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

async function sessionProof(
  source: AgentRpcSource,
  run_id: string | undefined,
  target: AgentRpcTarget,
  agent_session_id: string,
): Promise<AgentSessionAuthorization | PersonalAgentDenial> {
  validateAgentRpcSource(source, run_id);
  validateAgentRpcTarget(target);
  requireUuid(agent_session_id, "agent_session_id");
  const account_id = isExternalAgentSource(source)
    ? source.account_id
    : (await sourceRun(source, run_id!)).account_id;
  return (await withPersonalHome(account_id, {
    action: "checkSession",
    options: {
      agent_session_id,
      source,
      ...(run_id ? { run_id } : {}),
      target,
    },
  })) as AgentSessionAuthorization | PersonalAgentDenial;
}

async function observeActivity(
  proof: AgentSessionAuthorization,
  request: import("@cocalc/conat/agents/rpc").AgentRpcAttempt,
  outcome: import("@cocalc/conat/agents/rpc").AgentRpcOutcome,
  deliveryOverride?: AgentSessionActivity["effective_delivery"],
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
  const activity: AgentSessionActivity = {
    attempt_id: request.attempt_id,
    agent_session_id: proof.agent_session_id,
    session_generation: proof.session_generation,
    source_member_id: proof.source.member_id,
    target_member_id: proof.target.member_id,
    configured_delivery: proof.delivery_mode,
    effective_delivery,
    outcome: outcome.outcome,
    observed_at: new Date(outcome.observed_at).toISOString(),
  };
  await withPersonalHome(proof.account_id, {
    action: "observeSessionActivity",
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
  let proof: AgentSessionAuthorization | undefined;
  let observedOutcome:
    | import("@cocalc/conat/agents/rpc").AgentRpcOutcome
    | undefined;
  try {
    const checked = await sessionProof(
      opts.source,
      opts.run_id,
      opts.request.target,
      opts.request.agent_session_id,
    );
    if ("denied" in checked)
      return rpcOutcome(opts.request, "rejected", {
        code: "session_unavailable",
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
      source_label: sessionMemberLabel(proof.source),
      target_label: sessionMemberLabel(proof.target),
      ...(opts.run_id ? { run_id: opts.run_id } : {}),
      permit_id: randomUUID(),
      account_id: proof.account_id,
      session_generation: proof.session_generation,
      account_generation: proof.account_generation,
      configured_delivery: proof.delivery_mode,
      guidance: proof.delivery_mode === "live",
      path: target.path,
      thread_id: target.thread_id,
      deadline: Date.now() + 30_000,
    };
    if (phase !== "prepare" && envelope.snapshot_manifest) {
      const prepared = await claimAgentRpcAdmissionState({
        token_id: envelope.attachment_reservation!,
        kind: "preparation",
        binding_hash: hashAgentRpcAdmissionBinding(preparationKey(envelope)),
        host_id: host.host_id,
        project_id: envelope.target.project_id,
        account_id: envelope.account_id,
      });
      if (!prepared)
        return rpcOutcome(opts.request, "rejected", {
          code: "attachment_preparation_unavailable",
          reason:
            "Attachment preparation expired, changed, or was already used; no message was submitted",
          chat_effect: "none",
        });
      envelope.deadline = Math.min(
        envelope.deadline,
        prepared.expires_at.getTime(),
      );
    }
    permitId = envelope.permit_id;
    await createAgentRpcAdmissionState({
      token_id: envelope.permit_id,
      kind: "permit",
      binding_hash: hashAgentRpcAdmissionBinding(agentRpcEnvelopeKey(envelope)),
      host_id: host.host_id,
      project_id: envelope.target.project_id,
      account_id: envelope.account_id,
      expires_at: new Date(envelope.deadline),
    });
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
      agent_session_id: opts.request.agent_session_id,
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
            ? "session_unavailable"
            : undefined,
        reason: submissionStarted
          ? "Recipient acknowledgment unavailable"
          : error instanceof PersonalAgentAuthorizationError
            ? error.denial
            : "Session, execution account, target, or host unavailable",
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
          logger.warn("session activity observation unavailable", {
            error: `${error}`,
          }),
      );
    }
  }
}

export const agentRpcControl: AgentRpcControlApi = {
  external: externalControl,
  personal: (opts) => personalControl(opts),
  principal: async (opts) => {
    await local(opts, opts.source);
    return {
      account_id: (await sourceRun(opts.source, opts.run_id)).account_id,
      personal_messaging: true,
    };
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
  inspect: async (opts) => {
    await local(opts, opts.request.target);
    validateAgentRpcRequest({ ...opts.request, action: "inspect" });
    const proof = await sessionProof(
      opts.source,
      opts.run_id,
      opts.request.target,
      opts.request.agent_session_id,
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

async function reauthorizeEnvelope(e: AgentRpcEnvelope) {
  if (Date.now() >= e.deadline) throw new Error("submission deadline expired");
  const proof = await sessionProof(
    e.source,
    e.run_id,
    e.target,
    e.agent_session_id,
  );
  if ("denied" in proof)
    throw new PersonalAgentAuthorizationError(proof.denied);
  if (
    proof.account_id !== e.account_id ||
    proof.session_generation !== e.session_generation ||
    proof.account_generation !== e.account_generation ||
    proof.delivery_mode !== e.configured_delivery ||
    e.guidance !== (proof.delivery_mode === "live")
  )
    throw new PersonalAgentAuthorizationError("session_stale");
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
  const proof = await sessionProof(
    authorization.source,
    authorization.source_run_id,
    authorization.target,
    authorization.agent_session_id,
  );
  if ("denied" in proof)
    throw new PersonalAgentAuthorizationError(proof.denied);
  if (
    proof.account_id !== account_id ||
    proof.session_generation !== authorization.session_generation ||
    proof.account_generation !== authorization.account_generation ||
    proof.delivery_mode !== authorization.configured_delivery ||
    authorization.guidance !== (proof.delivery_mode === "live")
  )
    throw new PersonalAgentAuthorizationError("session_stale");
};

async function submitExternalInbox(
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
  const checked = await sessionProof(
    source,
    run_id,
    request.target,
    request.agent_session_id,
  );
  if ("denied" in checked)
    return rpcOutcome(request, "rejected", {
      code: "session_unavailable",
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
    await externalStore().enqueue({
      account_id: checked.account_id,
      installation_id: request.target.installation_id,
      attempt_id: request.attempt_id,
      agent_session_id: checked.agent_session_id,
      session_generation: checked.session_generation,
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
    return rpcOutcome(request, "rejected", {
      chat_effect: "none",
      reason: `External inbox unavailable: ${error}`,
    });
  }
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
      action: "discoverSessions",
      options: { source, run_id },
    });
  if (request.action === "propose-session") {
    const { version: _, action: __, ...proposal } = request;
    return withPersonalHome(run.account_id, {
      action: "proposeSession",
      options: { source, run_id, proposal },
    });
  }
  if (request.action === "broadcast")
    return submitBroadcast(run.account_id, source, run_id, request, (child) =>
      acceptAgentRpc(subject, child),
    );
  if (request.action === "inbox" || request.action === "ack-inbox")
    throw new Error("native agents do not have an external inbox");
  if (isExternalAgentSource(request.target)) {
    if (request.action !== "send")
      return rpcOutcome(request, "rejected", {
        chat_effect: "none",
        reason: "External inbox supports direct send only",
      });
    return submitExternalInbox(source, run_id, request);
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
            source,
            run_id,
            request: registeredSend,
          })
        : api.cancelAttachments({
            ...route,
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
      action: "discoverSessions",
      options: { source },
    })) as AgentSessionDiscovery;
  if (request.action === "propose-session") {
    const { version: _, action: __, ...proposal } = request;
    return withPersonalHome(account_id, {
      action: "proposeSession",
      options: { source, proposal },
    });
  }
  if (request.action === "broadcast")
    return submitBroadcast(account_id, source, undefined, request, (child) =>
      acceptExternalAgentRpc(subject, child),
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
    return submitExternalInbox(source, undefined, request);
  }
  const target = request.target;
  if (request.action === "inspect") {
    const { action: _, ...attempt } = request;
    return routed(target.project_id, (api, route) =>
      api.inspect({
        ...route,
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
    const opts = { ...route, source, request: registeredAttempt };
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
