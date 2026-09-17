import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import type { AgentApi, AgentHumanAuth } from "@cocalc/conat/hub/api/agent";
import type {
  AgentRpcControlApi,
  RpcRoute,
} from "@cocalc/conat/inter-bay/agent-rpc";
import { createAgentRpcControlClient } from "@cocalc/conat/inter-bay/agent-rpc";
import {
  rpcOutcome,
  validateAgentEndpoint,
  validateAgentRpcRequest,
  validateAgentRpcOutcome,
  validateAgentRpcPreparation,
  agentRpcEnvelopeKey,
  validateAgentRpcSource,
  isExternalAgentSource,
  type AgentRpcSource,
  type AgentEndpoint,
  type AgentRpcEnvelope,
  type AgentRpcLink,
  type AgentRpcRequest,
} from "@cocalc/conat/agents/rpc";
import { validateAttachmentPayload } from "@cocalc/conat/agents/attachments";
import {
  requireUuid,
  parseAgentMessagingSubject,
} from "@cocalc/conat/agents/protocol";
import { createHostControlClient } from "@cocalc/conat/project-host/api";
import { getExplicitHostControlClient } from "@cocalc/server/conat/route-client";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  resolveProjectBay,
  resolveHostBayAcrossCluster,
} from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { assertProjectHostAgentTokenAccess } from "@cocalc/server/conat/api/project-host-token-auth";
import { agentStore } from "./store";
import {
  externalControl,
  checkExternalAgentSend,
  assertExternalAgentLoginEnabled,
  externalStore,
} from "./external";
import { parseExternalAgentSubject } from "@cocalc/conat/agents/external";
import { assertActor, assertAgent, assertRun } from "./access";
import { getIdentity } from "./api";
import { PersonalAgentAuthorizationError } from "@cocalc/conat/agents/personal";
import type { PersonalAgentDenial } from "@cocalc/conat/agents/personal";
import {
  personalControl,
  personalMessagingEnabled,
  withPersonalHome,
} from "./personal";
import {
  claimAgentRpcAdmissionState,
  createAgentRpcAdmissionState,
  deleteAgentRpcAdmissionState,
  getAgentRpcAdmissionState,
  hashAgentRpcAdmissionBinding,
} from "./admission-state";

const logger = getLogger("agents:rpc");

function enabled() {}

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
  enabled();
  const route = await owner(project_id);
  return fn(
    route.bay_id === getConfiguredBayId()
      ? agentRpcControl
      : createAgentRpcControlClient(getInterBayFabricClient(), route.bay_id),
    { project_id, route },
  );
}

async function local(opts: RpcRoute, endpoint: AgentEndpoint) {
  enabled();
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

function fresh(at: number) {
  if (
    !Number.isFinite(at) ||
    Date.now() - at > 30_000 ||
    at > Date.now() + 5000
  )
    throw new Error("fresh human approval attestation expired");
}
async function human(opts: AgentHumanAuth) {
  requireUuid(opts.account_id, "account_id");
  await requireDangerousSessionAuth({
    account_id: opts.account_id,
    session_hash: opts.session_hash,
    require_second_factor: "if_enabled",
    allow_actor_impersonation: false,
  });
  return opts.account_id;
}

function link(row: any, source: AgentEndpoint): AgentRpcLink {
  return {
    link_id: row.link_id,
    source,
    target: {
      project_id: row.target_project_id,
      agent_id: row.target_agent_id,
    },
    approved_by: row.approved_by,
    reason: row.reason,
    allow_guidance: row.allow_guidance,
    expires_at: new Date(row.expires_at).toISOString(),
    revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
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
  // The host can serve chat files while the project is stopped. It performs
  // authorized autostart before admission; the hub must not reject that case.
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

async function submissionProof(
  source: AgentRpcSource,
  run_id: string | undefined,
  target: AgentEndpoint,
  guidance: boolean,
) {
  validateAgentRpcSource(source, run_id);
  if (isExternalAgentSource(source)) {
    if (guidance) throw new Error("external agents cannot steer turns");
    const proof = await checkExternalAgentSend(source, target);
    return {
      link: {
        link_id: proof.destination.link_id,
        approved_by: source.account_id,
        principal_account_id: source.account_id,
      },
    };
  }
  return routed(source.project_id, (api, route) =>
    api.check({
      ...route,
      source,
      run_id: run_id!,
      target,
      guidance,
    }),
  );
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
  } else if (opts.snapshot_payload !== undefined)
    throw new Error("unexpected attachment bytes");
  let submissionStarted = false;
  let observation: { account_id: string; link_id: string } | undefined;
  let accepted = false;
  let permitId: string | undefined;
  try {
    const proof = await submissionProof(
      opts.source,
      opts.run_id,
      opts.request.target,
      opts.request.guidance === true,
    );
    if (
      isExternalAgentSource(opts.source) &&
      opts.request.file_references !== undefined
    )
      throw new Error("external agents cannot send project file references");
    if ("denied" in proof)
      return rpcOutcome(opts.request, "rejected", { reason: proof.denied });
    const target = await sourceIdentity(opts.request.target);
    if (
      personalMessagingEnabled() !==
      (proof.link.principal_account_id !== undefined)
    )
      throw new Error("personal messaging mode mismatch between bays");
    if (
      personalMessagingEnabled() &&
      proof.link.principal_account_id !== proof.link.approved_by
    )
      throw new PersonalAgentAuthorizationError("principal_mismatch");
    if (
      !personalMessagingEnabled() &&
      target.created_by !== proof.link.approved_by
    )
      throw new Error("target approver changed");
    await assertActor(proof.link.approved_by, target.project_id);
    const host = await hostFor(opts.request.target);
    if (personalMessagingEnabled() && !isExternalAgentSource(opts.source))
      observation = {
        account_id: proof.link.approved_by,
        link_id: proof.link.link_id,
      };
    const envelope: AgentRpcEnvelope = {
      ...opts.request,
      source: opts.source,
      ...(opts.run_id ? { run_id: opts.run_id } : {}),
      permit_id: randomUUID(),
      link_id: proof.link.link_id,
      account_id: personalMessagingEnabled()
        ? proof.link.approved_by
        : target.created_by,
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
    // Omit absent positional arguments: MsgPack transports undefined array
    // elements as null, which is not a valid attachment payload.
    const outcome =
      opts.snapshot_payload === undefined
        ? await host.api.submitAgentRpc(envelope)
        : await host.api.submitAgentRpc(envelope, opts.snapshot_payload);
    validateAgentRpcOutcome(outcome, opts.request);
    accepted = outcome.outcome === "accepted";
    return outcome;
  } catch (error) {
    logger.warn("recipient submission failed", {
      attempt_id: opts.request.attempt_id,
      target: opts.request.target,
      submissionStarted,
      error: `${error}`,
    });
    return rpcOutcome(
      opts.request,
      submissionStarted ? "unknown" : "rejected",
      {
        reason: submissionStarted
          ? "Recipient acknowledgment unavailable"
          : personalMessagingEnabled() &&
              error instanceof PersonalAgentAuthorizationError
            ? error.denial
            : "Link, execution account or target host unavailable",
      },
    );
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
    // Observations are not receipts. Unavailable telemetry cannot change an
    // outcome or cause a send retry, and must not delay the host response.
    if (submissionStarted && observation)
      void withPersonalHome(observation.account_id, {
        action: "observe",
        options: { link_id: observation.link_id, accepted },
      }).catch((error) =>
        logger.warn("personal attempt observation unavailable", {
          error: `${error}`,
        }),
      );
  }
}

export const agentRpcControl: AgentRpcControlApi = {
  external: externalControl,
  personal: (opts) => personalControl(opts),
  principal: async (opts) => {
    await local(opts, opts.source);
    return {
      account_id: (await sourceRun(opts.source, opts.run_id)).account_id,
      personal_messaging: personalMessagingEnabled(),
    };
  },
  grant: async (opts) => {
    await local(opts, opts.source);
    fresh(opts.fresh_auth_at);
    requireUuid(opts.link_id, "link_id");
    validateAgentEndpoint(opts.target);
    if (
      !Number.isInteger(opts.ttl_seconds) ||
      opts.ttl_seconds < 1 ||
      opts.ttl_seconds > 30 * 86400
    )
      throw new Error("link expiry must be between 1 second and 30 days");
    if (
      typeof opts.reason !== "string" ||
      !opts.reason.trim() ||
      opts.reason.length > 2000
    )
      throw new Error("approval reason required (maximum 2000 characters)");
    if (
      opts.allow_guidance !== undefined &&
      typeof opts.allow_guidance !== "boolean"
    )
      throw new Error("invalid guidance permission");
    await sourceIdentity(opts.source);
    await assertActor(opts.account_id, opts.source.project_id);
    const target = await getIdentity({
      account_id: opts.account_id,
      ...opts.target,
    });
    if (target.disabled_at || target.created_by !== opts.account_id)
      throw new Error("the target registrant must approve this link");
    const db = agentStore();
    const row = await db.transaction(async (sql) => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `agent-rpc-links:${opts.source.agent_id}`,
      ]);
      const prior = (
        await sql.query("SELECT * FROM agent_rpc_links WHERE link_id=$1", [
          opts.link_id,
        ])
      ).rows[0];
      if (prior) return prior;
      const count = (
        await sql.query(
          "SELECT count(*) AS count FROM agent_rpc_links WHERE source_agent_id=$1",
          [opts.source.agent_id],
        )
      ).rows[0];
      if (+count.count >= 1000) throw new Error("agent_rpc_link_capacity");
      return (
        await sql.query(
          `INSERT INTO agent_rpc_links(link_id,source_agent_id,target_agent_id,target_project_id,approved_by,reason,allow_guidance,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 second') RETURNING *`,
          [
            opts.link_id,
            opts.source.agent_id,
            opts.target.agent_id,
            opts.target.project_id,
            opts.account_id,
            opts.reason.trim(),
            opts.allow_guidance === true,
            opts.ttl_seconds,
          ],
        )
      ).rows[0];
    });
    if (
      row.source_agent_id !== opts.source.agent_id ||
      row.target_agent_id !== opts.target.agent_id ||
      row.target_project_id !== opts.target.project_id ||
      row.approved_by !== opts.account_id ||
      row.reason !== opts.reason.trim() ||
      row.allow_guidance !== (opts.allow_guidance === true)
    )
      throw new Error("link ID already used for a different approval");
    return link(row, opts.source);
  },
  revoke: async (opts) => {
    await local(opts, opts.source);
    fresh(opts.fresh_auth_at);
    requireUuid(opts.link_id, "link_id");
    const source = await sourceIdentity(opts.source);
    await assertActor(opts.account_id, opts.source.project_id);
    const row = (
      await agentStore().query(
        "SELECT * FROM agent_rpc_links WHERE link_id=$1 AND source_agent_id=$2",
        [opts.link_id, opts.source.agent_id],
      )
    ).rows[0];
    if (
      !row ||
      (row.approved_by !== opts.account_id &&
        source.created_by !== opts.account_id)
    )
      throw new Error("not authorized to revoke link");
    await agentStore().query(
      "UPDATE agent_rpc_links SET revoked_at=COALESCE(revoked_at,now()) WHERE link_id=$1",
      [opts.link_id],
    );
  },
  links: async (opts) => {
    await local(opts, opts.source);
    const source = await sourceIdentity(opts.source);
    if (personalMessagingEnabled()) {
      const account_id = opts.run_id
        ? (await sourceRun(opts.source, opts.run_id)).account_id
        : opts.account_id;
      requireUuid(account_id, "account_id");
      if (opts.run_id && opts.account_id && opts.account_id !== account_id)
        throw new Error("principal_mismatch");
      await assertActor(account_id, opts.source.project_id);
      return (await withPersonalHome(account_id, {
        action: "links",
        options: { source: opts.source },
      })) as AgentRpcLink[];
    }
    if (opts.run_id) await sourceRun(opts.source, opts.run_id);
    else {
      requireUuid(opts.account_id, "account_id");
      await assertActor(opts.account_id, opts.source.project_id);
    }
    const rows = (
      await agentStore().query(
        `SELECT * FROM agent_rpc_links WHERE source_agent_id=$1
      AND ($2::uuid IS NULL OR approved_by=$2 OR $3::boolean)
      AND revoked_at IS NULL AND expires_at>now() ORDER BY expires_at DESC LIMIT 100`,
        [
          opts.source.agent_id,
          opts.run_id ? null : opts.account_id,
          source.created_by === opts.account_id,
        ],
      )
    ).rows;
    return rows.map((row) => link(row, opts.source));
  },
  check: async (opts) => {
    await local(opts, opts.source);
    validateAgentEndpoint(opts.target);
    const run = await sourceRun(opts.source, opts.run_id);
    if (personalMessagingEnabled()) {
      const personalLink = (await withPersonalHome(run.account_id, {
        action: "check",
        options: {
          source: opts.source,
          target: opts.target,
          guidance: opts.guidance,
        },
      })) as AgentRpcLink | PersonalAgentDenial;
      if ("denied" in personalLink) return personalLink;
      if (personalLink.approved_by !== run.account_id)
        return { denied: "principal_mismatch" };
      return { source: await sourceIdentity(opts.source), link: personalLink };
    }
    const row = (
      await agentStore().query(
        `SELECT * FROM agent_rpc_links
      WHERE source_agent_id=$1 AND target_project_id=$2 AND target_agent_id=$3
      AND revoked_at IS NULL AND expires_at>now() AND (NOT $4::boolean OR allow_guidance)
      ORDER BY expires_at DESC LIMIT 1`,
        [
          opts.source.agent_id,
          opts.target.project_id,
          opts.target.agent_id,
          opts.guidance,
        ],
      )
    ).rows[0];
    if (!row) throw new Error("no active send-only link");
    await assertActor(row.approved_by, opts.source.project_id);
    return {
      source: await sourceIdentity(opts.source),
      link: link(row, opts.source),
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
    // Source authentication is checked at its owning bay. The host returns only
    // evidence for this exact source/target/attempt, never receiver content.
    validateAgentRpcSource(opts.source, opts.run_id);
    const source = opts.source;
    const account_id = isExternalAgentSource(source)
      ? (await checkExternalAgentSend(source, opts.request.target)).source
          .account_id
      : await routed(source.project_id, async (api, route) => {
          const principal = await api.principal({
            ...route,
            source,
            run_id: opts.run_id!,
          });
          if (principal.personal_messaging !== personalMessagingEnabled())
            throw new Error("personal messaging mode mismatch between bays");
          if (personalMessagingEnabled()) {
            const proof = await api.check({
              ...route,
              source,
              run_id: opts.run_id!,
              target: opts.request.target,
              guidance: false,
            });
            if ("denied" in proof)
              throw new PersonalAgentAuthorizationError(proof.denied);
            if (proof.link.principal_account_id !== proof.link.approved_by)
              throw new Error("principal_mismatch");
            return proof.link.approved_by;
          } else
            await api.links({
              ...route,
              source,
              run_id: opts.run_id!,
            });
        });
    try {
      const outcome = await (
        await hostFor(opts.request.target)
      ).api.inspectAgentRpc({
        source: opts.source,
        request: opts.request,
        ...(account_id ? { account_id } : {}),
      });
      validateAgentRpcOutcome(outcome, opts.request);
      return outcome;
    } catch {
      return rpcOutcome(opts.request, "unknown", {
        reason: "Recipient evidence unavailable",
      });
    }
  },
};

export const grantRpcLink: AgentApi["grantRpcLink"] = async (opts) => {
  const account_id = await human(opts);
  const request = {
    source: opts.source,
    target: opts.target,
    link_id: opts.link_id,
    ttl_seconds: opts.ttl_seconds,
    reason: opts.reason,
    allow_guidance: opts.allow_guidance,
    account_id,
    fresh_auth_at: Date.now(),
  };
  return routed(opts.source.project_id, (api, route) =>
    api.grant({ ...request, ...route }),
  );
};
export const revokeRpcLink: AgentApi["revokeRpcLink"] = async (opts) => {
  const account_id = await human(opts);
  return routed(opts.source.project_id, (api, route) =>
    api.revoke({
      ...route,
      source: opts.source,
      link_id: opts.link_id,
      account_id,
      fresh_auth_at: Date.now(),
    }),
  );
};
export const listRpcLinks: AgentApi["listRpcLinks"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  return routed(opts.source.project_id, (api, route) =>
    api.links({ ...route, source: opts.source, account_id: opts.account_id }),
  );
};
export const authorizeRpcAdmission: AgentApi["authorizeRpcAdmission"] = async (
  opts,
) => {
  // The 30-second envelope is not a cached grant: every host admission guard
  // rechecks the source and account home, including after startup waits. A
  // pause after that authority snapshot may race with the already authorized
  // admission; it does not retract saved messages or cancel running work.
  enabled();
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
  if (
    (!personalMessagingEnabled() && target.created_by !== e.account_id) ||
    target.path !== e.path ||
    target.thread_id !== e.thread_id
  )
    throw new Error("target identity changed");
  if (isExternalAgentSource(e.source) && e.file_references !== undefined)
    throw new Error("external agents cannot send project file references");
  const proof = await submissionProof(
    e.source,
    e.run_id,
    e.target,
    e.guidance === true,
  );
  if ("denied" in proof)
    throw new PersonalAgentAuthorizationError(proof.denied);
  if (
    proof.link.link_id !== e.link_id ||
    proof.link.approved_by !== e.account_id ||
    personalMessagingEnabled() !==
      (proof.link.principal_account_id !== undefined) ||
    (personalMessagingEnabled() &&
      proof.link.principal_account_id !== e.account_id) ||
    Date.now() >= e.deadline
  )
    throw new Error("RPC link authorization changed or expired");
};

export const authorizeRpcExecution: AgentApi["authorizeRpcExecution"] = async (
  opts,
) => {
  enabled();
  const host_id = `${opts.host_id ?? ""}`.trim();
  const account_id = `${opts.account_id ?? ""}`.trim();
  const authorization = opts.authorization;
  if (!host_id || !account_id || authorization?.version !== 2)
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
  const proof = await submissionProof(
    authorization.source,
    authorization.source_run_id,
    authorization.target,
    authorization.guidance,
  );
  if ("denied" in proof)
    throw new PersonalAgentAuthorizationError(proof.denied);
  if (
    proof.link.link_id !== authorization.link_id ||
    proof.link.approved_by !== account_id ||
    personalMessagingEnabled() !==
      (proof.link.principal_account_id !== undefined) ||
    (personalMessagingEnabled() &&
      proof.link.principal_account_id !== account_id)
  )
    throw new Error("RPC execution authorization changed or expired");
};

export async function acceptAgentRpc(
  subject: string,
  request: AgentRpcRequest,
) {
  enabled();
  validateAgentRpcRequest(request);
  const { agent_id, run_id } = parseAgentMessagingSubject(subject);
  const identity = await agentStore().get(agent_id);
  const source = { agent_id, project_id: identity.project_id };
  const run = await sourceRun(source, run_id);
  if (request.action === "request-connection") {
    const { action: _action, version: _version, ...options } = request;
    return withPersonalHome(run.account_id, {
      action: "request",
      options: { ...options, source, run_id },
    });
  }
  if (request.action === "connection-request")
    return withPersonalHome(run.account_id, {
      action: "requestRead",
      options: { source, run_id, request_id: request.request_id },
    });
  if (request.action === "destinations")
    return routed(source.project_id, (api, route) =>
      api.links({ ...route, source, run_id }),
    );
  if (
    request.action === "prepare-attachments" ||
    request.action === "cancel-attachments"
  ) {
    const { action, ...attempt } = request;
    return routed(request.target.project_id, (api, route) =>
      action === "prepare-attachments"
        ? api.prepareAttachments({ ...route, source, run_id, request: attempt })
        : api.cancelAttachments({ ...route, source, run_id, request: attempt }),
    );
  }
  const { action, ...rest } = request;
  const { snapshot_payload, ...attempt } = rest as typeof rest & {
    snapshot_payload?: import("@cocalc/conat/agents/attachments").AgentSnapshot[];
  };
  return routed(request.target.project_id, (api, route) =>
    action === "send"
      ? api.submit({
          ...route,
          source,
          run_id,
          request: attempt as import("@cocalc/conat/agents/rpc").AgentRpcSend,
          ...(snapshot_payload ? { snapshot_payload } : {}),
        })
      : api.inspect({ ...route, source, run_id, request: attempt }),
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
  if (
    request.action === "request-connection" ||
    request.action === "connection-request"
  )
    throw new Error(
      "External destination changes require a new browser-approved installation",
    );
  if (request.action === "destinations") {
    const destinations: Array<{
      link_id: string;
      target: AgentEndpoint;
      target_name?: string;
      expires_at: string;
    }> = [];
    // Read-only checks; disappearing access does not wake any target.
    const names = await withPersonalHome(account_id, {
      action: "listNamedAgents",
      options: {},
    });
    for (const destination of installation.destinations) {
      try {
        await externalStore().check(
          account_id,
          installation_id,
          destination.target,
        );
        const name =
          names && "agents" in names
            ? names.agents.find(
                (n) =>
                  n.endpoint.project_id === destination.target.project_id &&
                  n.endpoint.agent_id === destination.target.agent_id,
              )
            : undefined;
        destinations.push({
          ...destination,
          target_name:
            name && "name" in name ? (name.name as string) : undefined,
          expires_at: installation.expires_at,
        });
      } catch {
        /* Do not disclose targets whose approval/access is no longer valid. */
      }
    }
    await externalStore().activeInstallation(account_id, installation_id);
    return destinations;
  }
  await externalStore().check(account_id, installation_id, request.target);
  const { action, ...rest } = request;
  const { snapshot_payload, ...attempt } = rest as typeof rest & {
    snapshot_payload?: import("@cocalc/conat/agents/attachments").AgentSnapshot[];
  };
  return routed(request.target.project_id, (api, route) => {
    const opts = { ...route, source, request: attempt };
    if (action === "inspect") return api.inspect(opts);
    const sendOpts = {
      ...opts,
      request: attempt as import("@cocalc/conat/agents/rpc").AgentRpcSend,
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
