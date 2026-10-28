/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key: launching and terminating pods with an account's own
RunPod key, and the records that say whose they are.

Crash-safe create: the pod record (state "intent", with a random handle) is
written before RunPod is called, and the handle is the pod's name at RunPod.
A create whose outcome is unknown (a timeout, a lost reply, a 5xx) leaves the
record "ambiguous"; it is resolved by looking the handle up at RunPod, never
by guessing. So no pod CoCalc started can go untracked.

Everything here runs on the key owner's home bay (the *Local functions); the
routed entry points at the bottom forward the whole operation there.
*/

import { randomBytes, randomUUID } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import {
  RunpodApiError,
  type RunpodClient,
  type RunpodCreatePodBody,
} from "@cocalc/cloud/runpod/client";
import type { RunpodPodView } from "@cocalc/util/gpu/runpod";
import { normalizeGpuLaunchSpec } from "@cocalc/util/gpu/launch-spec";
import {
  GPU_POD_LIVE_STATES,
  type GpuActorKind,
  type GpuAttribution,
  type GpuLaunchSpec,
  type GpuPodAction,
  type GpuPodEvent,
  type GpuPodSummary,
} from "@cocalc/util/gpu/types";
import { isValidUUID } from "@cocalc/util/misc";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import {
  createInterBayAccountLocalClient,
  type InterBayGpuApi,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { lockGpuAccountFence } from "@cocalc/server/gpu/account-fence";
import { recordKeyEvent } from "@cocalc/server/gpu/key-events";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { resolveProjectReferenceAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  getRunpodCleanupForAccount,
  getRunpodLaunchAccessForAccount,
  type RunpodCleanupCapability,
} from "@cocalc/server/gpu/provider-keys";
import {
  actualCost,
  admitLaunch,
  enlargeAtBind,
  ensureKeyBudget,
  insertReservations,
  endQuarantineAlert,
  lockBudgetsForPod,
  settleReservations,
} from "@cocalc/server/gpu/budgets";
import { getRunpodCatalog } from "@cocalc/cloud/runpod/catalog";
import { GPU_POD_WRITE_TIMEOUT_MS } from "@cocalc/util/gpu/runpod";
import { parseEd25519PublicKey } from "@cocalc/util/gpu/ssh-key";
import siteURL from "@cocalc/database/settings/site-url";
import { CLEARED_HOSTKEY_FIELDS } from "@cocalc/server/gpu/hostkey-clear";
import {
  agentLaunchPayload,
  consumeGrantLaunch,
  lockUsableGrant,
  NoUsableAgentGrant,
  requestAgentLaunch,
  revokeAgentGrantsForKillSwitch,
  type GpuAgentPrincipal,
} from "@cocalc/server/gpu/agent-grants";
import {
  HOSTKEY_TOKEN_TTL_MS,
  newHostkeyToken,
} from "@cocalc/server/gpu/hostkey-token";
import {
  POD_REGISTRATION_TOKEN_ENV,
  POD_REGISTRATION_URL_ENV,
  podStartCommand,
} from "@cocalc/server/gpu/pod-start";

export interface GpuPodDeps {
  // for tests
  killSwitchResolveMs?: number;
  listResolveMs?: number;
  getLaunchAccess?: (
    account_id: string,
  ) => Promise<
    | { client: RunpodClient; credential_id: string; revision?: string }
    | undefined
  >;
  getCleanup?: (
    account_id: string,
  ) => Promise<RunpodCleanupCapability | undefined>;
  isProjectCollaborator?: (
    account_id: string,
    project_id: string,
  ) => Promise<boolean>;
  isHomeBay?: (account_id: string) => Promise<boolean>;
  homeClient?: (account_id: string) => Promise<InterBayGpuApi | undefined>;
  newHandle?: () => string;
  now?: () => number;
  // for tests: the account fence (default: lockGpuAccountFence)
  accountWriteFence?: typeof lockGpuAccountFence;
  // the site's public URL, for the pod's host-key registration
  siteUrl?: () => Promise<string>;
  // list price per GPU-hour for this type and cloud (default: RunPod's
  // catalog read with the key); undefined when RunPod doesn't list one
  listPrice?: (
    client: RunpodClient,
    gpu_type_id: string,
    cloud: "SECURE" | "COMMUNITY",
  ) => Promise<number | undefined>;
}

async function catalogListPrice(
  client: RunpodClient,
  gpu_type_id: string,
  cloud: "SECURE" | "COMMUNITY",
): Promise<number | undefined> {
  const catalog = await getRunpodCatalog(client);
  const type = catalog.gpuTypes.find((t) => t.id === gpu_type_id);
  const offer = cloud === "SECURE" ? type?.secure : type?.community;
  return offer?.price != null && offer.price > 0 ? offer.price : undefined;
}

// ---- handles and fingerprints ----

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

// cc- + 16 base32 characters: 80 random bits, so handles stay unique over
// years of records (a collision is retried anyway).
export function newPodHandle(): string {
  const bytes = randomBytes(16);
  let s = "cc-";
  for (const b of bytes) s += BASE32[b & 31];
  return s;
}

const HANDLE = /^cc-[a-z2-7]{16}$/;

// As `ssh-keygen -lf` prints it: SHA256 of the key blob, unpadded base64.
// The key is strictly parsed (one ssh-ed25519 wire blob), so this throws on
// anything else.
export function sshKeyFingerprint(publicKey: string): string {
  return parseEd25519PublicKey(publicKey).fingerprint;
}

// ---- the RunPod create body ----

// Where a pod that takes SSH reports its host key, once.
export interface PodRegistration {
  url: string;
  token: string;
}

// The only place a create body is made, and only from the normalized spec.
// The server sets the name, the SSH key and the start script.
export function buildRunpodCreateBody(
  pod: { handle: string },
  spec: GpuLaunchSpec,
  registration?: PodRegistration,
): RunpodCreatePodBody {
  const ports = [...(spec.ports ?? [])];
  const env: Record<string, string> = { ...(spec.env ?? {}) };
  let command: { entrypoint: string[]; cmd: string[] } | undefined;
  if (spec.ssh_public_key) {
    if (registration == null) {
      throw Error("a pod that takes SSH needs its host-key registration");
    }
    // The image installs PUBLIC_KEY as the only authorized key; startSsh
    // stays unset so the account's own SSH keys are never added.
    env.PUBLIC_KEY = parseEd25519PublicKey(spec.ssh_public_key).line;
    env[POD_REGISTRATION_URL_ENV] = registration.url;
    env[POD_REGISTRATION_TOKEN_ENV] = registration.token;
    if (!ports.includes("22/tcp")) ports.push("22/tcp");
    // Hardens sshd before it starts, then reports the host key once.
    command = podStartCommand();
  }
  const body: RunpodCreatePodBody = {
    name: pod.handle,
    image: spec.image,
    gpu: { id: spec.gpu_type_id, count: spec.gpu_count },
    cloud: spec.cloud ?? "SECURE",
    disk: spec.container_disk_gb ?? 20,
    ports,
    env,
  };
  if (spec.data_center_id) body.dataCenterIds = [spec.data_center_id];
  if (spec.volume_gb) {
    body.mounts = { persistent: { size: spec.volume_gb, path: "/workspace" } };
  }
  if (command) {
    body.entrypoint = command.entrypoint;
    body.cmd = command.cmd;
  }
  return body;
}

// ---- records ----

// The spec as stored: env values and the SSH key stay out of the record (the
// key is kept as its fingerprint).
function storedSpec(spec: GpuLaunchSpec) {
  const { ssh_public_key: _key, env, ...rest } = spec;
  return { ...rest, env: Object.keys(env ?? {}) };
}

export interface PodRow {
  id: string;
  handle: string;
  key_owner_account_id: string;
  credential_id: string;
  provider: "runpod";
  provider_pod_id: string | null;
  beneficiary_account_id: string;
  project_id: string | null;
  agent_id: string | null;
  spec: GpuLaunchSpec;
  gpu_type_id: string;
  gpu_count: number;
  cloud: "SECURE" | "COMMUNITY";
  data_center_id: string | null;
  cost_per_hr: string | null;
  reap_attempts: number;
  public_ip: string | null;
  running_since: Date | null;
  state: GpuPodSummary["state"];
  desired_state: GpuPodSummary["desired_state"];
  max_runtime_minutes: number;
  deadline: Date;
  reason: string | null;
  ssh_key_fingerprint: string | null;
  created: Date;
  updated: Date;
  terminated_at: Date | null;
  unmanaged_at?: Date | null;
}

function iso(d: Date | null | undefined): string | undefined {
  return d == null ? undefined : new Date(d).toISOString();
}

export function podSummary(row: PodRow): GpuPodSummary {
  const s: GpuPodSummary = {
    id: row.id,
    handle: row.handle,
    provider: row.provider,
    state: row.state,
    desired_state: row.desired_state,
    key_owner_account_id: row.key_owner_account_id,
    beneficiary_account_id: row.beneficiary_account_id,
    gpu_type_id: row.gpu_type_id,
    gpu_count: row.gpu_count,
    cloud: row.cloud,
    image: row.spec?.image,
    max_runtime_minutes: row.max_runtime_minutes,
    deadline: iso(row.deadline)!,
    created: iso(row.created)!,
    updated: iso(row.updated)!,
  };
  if (row.provider_pod_id) s.provider_pod_id = row.provider_pod_id;
  if (row.project_id) s.project_id = row.project_id;
  if (row.agent_id) s.agent_id = visibleAgentId(row.agent_id);
  if (row.data_center_id) s.data_center_id = row.data_center_id;
  if (row.cost_per_hr != null) s.cost_per_hr = `${row.cost_per_hr}`;
  if (row.terminated_at) s.terminated_at = iso(row.terminated_at);
  if (row.unmanaged_at) s.unmanaged_at = iso(row.unmanaged_at);
  if (row.reason) s.reason = row.reason;
  if (row.ssh_key_fingerprint) s.ssh_key_fingerprint = row.ssh_key_fingerprint;
  return s;
}

export interface Actor {
  kind: GpuActorKind;
  account_id?: string;
  agent_id?: string;
  // the agent's run: who did it, never what it may reach
  run_id?: string;
}

// A standalone event (a lookup, a duplicate terminated at RunPod).
async function recordEvent(
  pod_id: string,
  actor: Actor,
  action: GpuPodAction,
  details?: Record<string, unknown>,
  db: Pick<PoolClient, "query"> = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO gpu_pod_events (id, pod_id, at, actor_kind, actor_account_id, agent_id, turn_id, action, details)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      pod_id,
      actor.kind,
      actor.account_id ?? null,
      actor.agent_id ?? null,
      actor.run_id ?? null,
      action,
      details ?? null,
    ],
  );
}

export async function inTransaction<T>(
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

interface PodEvent {
  actor: Actor;
  action: GpuPodAction;
  details?: Record<string, unknown>;
}

// Every move out of the registrable state ("running") also clears the
// host-key registration token and the registered host key, in the same
// statement: a pod that is stopping, stopped, gone or failed can neither
// register nor keep a usable host key. (gpu_pod_events keeps the
// fingerprint.)
const UNREGISTRABLE_STATES = new Set([
  "stopped",
  "terminating",
  "terminated",
  "failed",
]);

export { CLEARED_HOSTKEY_FIELDS };

// The fields of a transition, plus the cleared host-key fields if it leaves
// the registrable state.
export function withHostkeyClearedOnExit(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return UNREGISTRABLE_STATES.has(fields.state as string)
    ? { ...fields, ...CLEARED_HOSTKEY_FIELDS }
    : fields;
}

// One state change and its event, in one transaction: an event never
// describes a change that didn't happen, and a change never lacks its event.
// `where` adds conditions (compare-and-set); undefined means it didn't apply.
//
// Budgets: a change to a terminal state must say how its reservations
// settle (`settle`), and they settle in the same transaction. A transition
// that settles, or runs `after` (bind's re-reservation), first takes the
// budget locks in the global order, before the pod row.
type SettleKind = "actual" | "release" | "quarantine";

interface TransitionOptions {
  settle?: SettleKind;
  // when a state change really happened, for the state ledger (a provider
  // timestamp): clamped to the open interval's start and to now. Default:
  // now, or a bind's running_since.
  effective_at?: Date | null;
  // runs in the transaction after the update applied; may change the row
  after?: (db: PoolClient, row: PodRow) => Promise<PodRow | void>;
}

export async function transition(
  id: string,
  fields: Record<string, unknown>,
  where: string,
  event?: PodEvent,
  opts: TransitionOptions = {},
): Promise<PodRow | undefined> {
  const terminal = fields.state === "terminated" || fields.state === "failed";
  if (terminal && !opts.settle) {
    throw Error("a pod's terminal state must settle its reservations");
  }
  fields = withHostkeyClearedOnExit(fields);
  return await inTransaction(async (db) => {
    if (opts.settle || opts.after) {
      const { rows: pre } = await db.query(
        "SELECT credential_id, key_owner_account_id FROM gpu_pods WHERE id = $1",
        [id],
      );
      if (pre[0]) {
        await lockBudgetsForPod(db, { pod_id: id, ...pre[0] });
      }
    }
    // the state before, for the ledger (the pod row is locked from here on)
    let before: string | undefined;
    if (fields.state !== undefined) {
      const { rows: b } = await db.query(
        "SELECT state FROM gpu_pods WHERE id = $1 FOR UPDATE",
        [id],
      );
      before = b[0]?.state;
    }
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const { rows } = await db.query(
      `UPDATE gpu_pods SET ${[...sets, "updated = now()"].join(", ")}
        WHERE id = $1 ${where} RETURNING *`,
      [id, ...keys.map((k) => fields[k])],
    );
    let row: PodRow | undefined = rows[0];
    if (!row) return undefined;
    if (fields.state !== undefined && row.state !== before) {
      await recordStateChange(db, row, {
        effective_at:
          opts.effective_at ??
          (row.state === "running" && fields.running_since
            ? (fields.running_since as Date)
            : null),
      });
    }
    if (opts.settle) {
      await settleReservations(
        db,
        { pod_id: id, credential_id: row.credential_id },
        opts.settle === "actual"
          ? {
              kind: "actual",
              actual_usd: actualCost({
                cost_per_hr: row.cost_per_hr,
                reserved_hourly_usd:
                  row.cost_per_hr == null
                    ? await reservedHourly(db, id)
                    : undefined,
                running_since: row.running_since,
                ended_at: row.terminated_at ?? new Date(),
              }),
            }
          : { kind: opts.settle },
      );
    }
    if (opts.after) row = (await opts.after(db, row)) || row;
    if (event) {
      await recordEvent(id, event.actor, event.action, event.details, db);
    }
    return row;
  });
}

// A pod that is live again (bound back, or revived after an end) gets its
// billing reopened: it will be reconciled after its next end.
const BILLING_REOPENED = {
  billing_state: "estimated",
  billing_next_at: null,
  billing_attempts: 0,
  billed_at: null,
  billed_usd: null,
};

// ---- the state ledger (5d-2a) ----

// A pod's first interval, in the transaction that inserts it. `started`:
// when the state began (a duplicate's provider start may precede its row),
// never after now.
export async function openFirstStateInterval(
  db: Pick<PoolClient, "query">,
  pod: { id: string; key_owner_account_id: string; state: string },
  started?: Date | null,
): Promise<void> {
  await db.query(
    `INSERT INTO gpu_pod_state_intervals (id, pod_id, key_owner_account_id, state, started)
     VALUES (gen_random_uuid(), $1, $2, $3, LEAST(COALESCE($4::timestamptz, now()), now()))`,
    [pod.id, pod.key_owner_account_id, pod.state, started ?? null],
  );
}

// A state change (the pod row is locked): the open interval ends and the
// new one begins at the effective time, which is never before the open
// interval began and never after now, so intervals never overlap and never
// run backwards. A pod with no open interval (one recorded before the
// ledger) gets one from the effective time, not before its creation.
async function recordStateChange(
  db: Pick<PoolClient, "query">,
  row: PodRow,
  { effective_at }: { effective_at: Date | null },
): Promise<void> {
  const { rows } = await db.query(
    `UPDATE gpu_pod_state_intervals
        SET ended = GREATEST(started, LEAST(COALESCE($2::timestamptz, now()), now()))
      WHERE pod_id = $1 AND ended IS NULL
      RETURNING ended`,
    [row.id, effective_at],
  );
  await db.query(
    `INSERT INTO gpu_pod_state_intervals (id, pod_id, key_owner_account_id, state, started)
     VALUES (gen_random_uuid(), $1, $2, $3,
             COALESCE($4::timestamptz,
                      GREATEST($5::timestamptz, LEAST(COALESCE($6::timestamptz, now()), now()))))`,
    [
      row.id,
      row.key_owner_account_id,
      row.state,
      rows[0]?.ended ?? null,
      row.created,
      effective_at,
    ],
  );
}

async function loadPod(id: string): Promise<PodRow> {
  const { rows } = await getPool().query(
    "SELECT * FROM gpu_pods WHERE id = $1",
    [id],
  );
  return rows[0];
}

// ---- errors in words, never provider text ----

// A create RunPod definitely refused, so no pod exists: a rejected key, no
// permission, rate limiting, or one of the validation answers RunPod
// documents for this endpoint (400 placement, 402 balance, 422 schema).
// Anything else, including a 408 timeout, a 409 or an unknown 4xx, may have
// made a pod and is resolved by its handle.
const DEFINITE_CREATE_REFUSALS = new Set([400, 402, 422]);

function refused(err: unknown): boolean {
  if (!(err instanceof RunpodApiError)) return false;
  if (
    err.kind === "auth" ||
    err.kind === "forbidden" ||
    err.kind === "rate_limited"
  ) {
    return true;
  }
  return (
    err.kind === "invalid" &&
    err.status != null &&
    DEFINITE_CREATE_REFUSALS.has(err.status)
  );
}

function refusalReason(err: unknown): string {
  if (err instanceof RunpodApiError) {
    switch (err.kind) {
      case "auth":
        return "RunPod rejected your API key; it may have been revoked. Connect a new key in Settings → Connectors.";
      case "forbidden":
        return 'Your RunPod API key can\'t create pods. Create a key with "All" permissions.';
      case "rate_limited":
        return "RunPod is rate-limiting requests. Try again shortly.";
      case "invalid":
        if (err.status === 402) {
          return "Your RunPod balance is too low for this pod. Add credit at RunPod.";
        }
        return "RunPod couldn't place this pod (that GPU may be out of stock there, or the request was refused). Check gpu availability and try again.";
    }
  }
  return "RunPod refused to create this pod.";
}

// ---- access ----

export async function requireHomeBay(account_id: string, deps: GpuPodDeps) {
  const here = deps.isHomeBay
    ? await deps.isHomeBay(account_id)
    : (await accountHomeBay(account_id)) === getConfiguredBayId();
  if (!here) {
    throw Error("GPU pods are managed only on the key owner's home bay");
  }
}

async function accountHomeBay(account_id: string): Promise<string> {
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  return `${home_bay_id ?? ""}`.trim() || getConfiguredBayId();
}

export function requireAccount(account_id: unknown): string {
  if (typeof account_id !== "string" || !isValidUUID(account_id)) {
    throw Error("must be signed in");
  }
  return account_id;
}

async function isProjectCollaborator(account_id: string, project_id: string) {
  return (
    (await resolveProjectReferenceAllowRemote({ account_id, project_id })) !=
    null
  );
}

// The pods an account may see and terminate: the ones its key pays for and
// the ones it is responsible for. (Course staff come with classes, step 7.)
const MINE = `(key_owner_account_id = $1 OR beneficiary_account_id = $1)`;

// A principal as it may arrive from another bay (its expiry as text).
type GpuAgentPrincipalWire = Omit<GpuAgentPrincipal, "expires_at"> & {
  expires_at: Date | string;
};

// An agent sees only the managed pods it launched in its own project (its
// principal key, so a chat session sees only that session's pods). Human
// launches and other agents' pods are never in scope for it.
// What an agent may see and reach: the pods it launched in its project. A
// later run of the same agent may clean up an earlier run's pods (STEP6
// "later cleanup"); for a chat session the agent is the session. run_id
// only attributes what it does (events); it never narrows or widens scope.
export interface GpuAgentScope {
  project_id: string;
  agent_id: string;
  run_id?: string;
}

// A chat session's key is derived from its token's fingerprint: never shown.
function visibleAgentId(agent_id: string): string {
  return agent_id.startsWith("session:") ? "chat-session" : agent_id;
}

function agentScopeSql(
  agent: GpuAgentScope | undefined,
  first: number,
): { sql: string; values: unknown[] } {
  if (!agent) return { sql: "", values: [] };
  return {
    sql: ` AND project_id = $${first} AND agent_id = $${first + 1}`,
    values: [agent.project_id, agent.agent_id],
  };
}

export async function findPod(
  account_id: string,
  pod: unknown,
  agent?: GpuAgentScope,
): Promise<PodRow | undefined> {
  const ref = `${pod ?? ""}`.trim();
  const column = isValidUUID(ref)
    ? "id"
    : HANDLE.test(ref)
      ? "handle"
      : /^[A-Za-z0-9_-]{6,64}$/.test(ref)
        ? "provider_pod_id"
        : undefined;
  if (!column) throw Error("Give a pod id or handle.");
  const scope = agentScopeSql(agent, 3);
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_pods WHERE ${column} = $2 AND ${MINE}${scope.sql}`,
    [account_id, ref, ...scope.values],
  );
  return rows[0];
}

// ---- launch ----

export async function launchGpuPodLocal(
  opts: {
    account_id?: string;
    project_id?: unknown;
    spec?: unknown;
    // An agent's launch (step 6b): its verified principal and its own
    // idempotency key. It needs an approved grant for exactly this launch.
    agent?: { principal: GpuAgentPrincipalWire; operation_id: string };
  },
  deps: GpuPodDeps = {},
): Promise<GpuPodSummary> {
  const account_id = requireAccount(opts.account_id);
  await requireHomeBay(account_id, deps);
  const project_id = `${opts.project_id ?? ""}`;
  if (!isValidUUID(project_id)) throw Error("A launch needs a project.");
  // (after an inter-bay hop the expiry arrives as text)
  const agent = opts.agent
    ? {
        ...opts.agent,
        principal: {
          ...opts.agent.principal,
          expires_at: new Date(opts.agent.principal.expires_at),
        },
      }
    : undefined;
  if (
    agent &&
    (agent.principal.account_id !== account_id ||
      agent.principal.project_id !== project_id)
  ) {
    throw Error("An agent can launch only in its own project.");
  }
  if (agent && !/^[A-Za-z0-9._:-]{1,128}$/.test(agent.operation_id ?? "")) {
    throw Error(
      "An agent's GPU launch needs an operation id (cocalc gpu launch --operation <id>).",
    );
  }
  const spec = normalizeGpuLaunchSpec(opts.spec);
  if (
    !(await (deps.isProjectCollaborator ?? isProjectCollaborator)(
      account_id,
      project_id,
    ))
  ) {
    throw Error("project not found or access denied");
  }
  const actor: Actor = agent
    ? {
        kind: "agent",
        account_id,
        agent_id: agent.principal.agent_id,
        run_id: agent.principal.run_id,
      }
    : { kind: "user", account_id };
  const cloud = spec.cloud ?? "SECURE";

  // A pod that takes SSH reports its host key once, with this token; only
  // its verifier is stored. The token is minted on this (the key owner's
  // home) bay, which stays its authority until it expires.
  let registration: PodRegistration | undefined;
  let token: ReturnType<typeof newHostkeyToken> | undefined;
  if (spec.ssh_public_key) {
    const site = `${await (deps.siteUrl ?? siteURL)()}`.replace(/\/+$/, "");
    if (!site.startsWith("https://")) {
      throw Error("SSH to GPU pods needs the site to be on HTTPS.");
    }
    token = newHostkeyToken(getConfiguredBayId());
    registration = { url: `${site}/gpu/pod-host-key`, token: token.token };
  }

  // The estimate the budget reserves: RunPod's list price for the pod. It is
  // read outside the transaction, so no network call is made under the
  // fence; the launch then uses the key read under the fence, which must be
  // the same one. The key is read only after passing the fence once, so a
  // launch that waited behind a rehome cutover reads no key.
  await inTransaction((db) =>
    (deps.accountWriteFence ?? lockGpuAccountFence)(
      db,
      account_id,
      "launch a GPU",
    ),
  );
  const priced = await loadLaunchAccess(account_id, deps);
  let perGpu: number | undefined;
  try {
    perGpu = await (deps.listPrice ?? catalogListPrice)(
      priced.client,
      spec.gpu_type_id,
      cloud,
    );
  } catch {
    throw Error("RunPod's prices could not be read. Try again shortly.");
  }
  if (perGpu == null) {
    throw Error(
      `RunPod lists no ${cloud} price for ${spec.gpu_type_id}; check gpu availability.`,
    );
  }
  const hourly_usd = moneyToDbString(toDecimal(perGpu).times(spec.gpu_count));
  // what an agent's human approves, exactly
  const approval = agent ? agentLaunchPayload(spec, perGpu) : undefined;

  // 1. The budget reservation, the intent and its event, in one transaction,
  // before anything reaches RunPod. The key is read under the account fence
  // that key replacement and removal also take, so no launch can use a key
  // that is being replaced or removed. A launch that doesn't fit writes
  // nothing.
  let intent: Awaited<ReturnType<typeof insertIntent>>;
  try {
    intent = await insertIntent({
      account_id,
      project_id,
      spec,
      hourly_usd,
      priced,
      actor,
      deps,
      token,
      agent:
        agent && approval
          ? { ...agent, payload_hash: approval.payload_hash }
          : undefined,
    });
  } catch (err) {
    if (!(err instanceof NoUsableAgentGrant) || !agent || !approval) throw err;
    // Nothing was written; ask the human, in a transaction of its own.
    throw await inTransaction(async (db) => {
      // serializes this agent's asks with each other and with approvals
      await (deps.accountWriteFence ?? lockGpuAccountFence)(
        db,
        account_id,
        "ask for a GPU approval",
      );
      return await requestAgentLaunch(db, {
        principal: agent.principal,
        operation_id: agent.operation_id,
        payload: approval.payload,
        payload_hash: approval.payload_hash,
        now: new Date((deps.now ?? Date.now)()),
      });
    });
  }
  const { client } = intent;
  let row = intent.row;

  // 2. The create. A terminate that arrived first wins.
  const creating = await transition(
    row.id,
    { state: "creating" },
    "AND state = 'intent' AND desired_state <> 'terminated'",
  );
  if (!creating) {
    const failed = await transition(
      row.id,
      {
        state: "failed",
        reason: "Terminated before it was created.",
        terminated_at: new Date(),
      },
      "AND state = 'intent'",
      { actor, action: "state", details: { state: "failed" } },
      // never sent to RunPod: release the reservation
      { settle: "release" },
    );
    return podSummary(failed ?? (await loadPod(row.id)));
  }
  row = creating;
  let created: RunpodPodView;
  try {
    created = await client.createPod(
      buildRunpodCreateBody(row, spec, registration),
    );
  } catch (err) {
    if (refused(err)) {
      const reason = refusalReason(err);
      await transition(
        row.id,
        { state: "failed", reason, terminated_at: new Date() },
        "AND state = 'creating'",
        { actor, action: "state", details: { state: "failed" } },
        // a definite refusal: no pod exists
        { settle: "release" },
      );
      throw Error(reason);
    }
    // Maybe made: find it by its handle before anyone tries again.
    row =
      (await transition(
        row.id,
        { state: "ambiguous" },
        "AND state = 'creating'",
        { actor, action: "state", details: { state: "ambiguous" } },
      )) ?? (await loadPod(row.id));
    return podSummary(await resolveAmbiguous(row, client, actor, deps));
  }

  // 3. Bind. If recording fails, the pod still has its handle: mark the
  // record ambiguous so it is found by name, and say so.
  try {
    return podSummary(await bind(row, created, client, actor));
  } catch {
    await transition(
      row.id,
      { state: "ambiguous" },
      "AND state = 'creating' AND provider_pod_id IS NULL",
      { actor, action: "state", details: { state: "ambiguous" } },
    ).catch(() => {});
    throw Error(
      `RunPod created pod ${row.handle}, but CoCalc couldn't record it yet. It will be found by that name; check gpu pods.`,
    );
  }
}

const HANDLE_ATTEMPTS = 3;

async function loadLaunchAccess(
  account_id: string,
  deps: GpuPodDeps,
): Promise<{ client: RunpodClient; credential_id: string; revision?: string }> {
  let access:
    | { client: RunpodClient; credential_id: string; revision?: string }
    | undefined;
  try {
    access = await (deps.getLaunchAccess ?? getRunpodLaunchAccessForAccount)(
      account_id,
    );
  } catch (err) {
    if (`${err}`.includes("membership")) {
      throw Error("Your membership doesn't include GPUs on your own key.");
    }
    throw Error("Your RunPod API key could not be loaded. Try again shortly.");
  }
  if (!access) {
    throw Error(
      "No RunPod API key is connected. Connect one in Settings → Connectors.",
    );
  }
  return access;
}

async function insertIntent({
  account_id,
  project_id,
  spec,
  hourly_usd,
  priced,
  actor,
  deps,
  token,
  agent,
}: {
  account_id: string;
  project_id: string;
  spec: GpuLaunchSpec;
  hourly_usd: string;
  // the key the estimate was priced with: the key read under the fence must
  // be the same one, unchanged (same record and same revision: an in-place
  // replacement keeps the record id)
  priced: { credential_id: string; revision?: string };
  actor: Actor;
  deps: GpuPodDeps;
  token?: { token_id: string; verifier: string };
  agent?: {
    principal: GpuAgentPrincipal;
    operation_id: string;
    payload_hash: string;
  };
}): Promise<{ row: PodRow; client: RunpodClient }> {
  const now = (deps.now ?? Date.now)();
  const deadline = new Date(now + spec.max_runtime_minutes * 60_000);
  for (let attempt = 1; ; attempt++) {
    const id = randomUUID();
    const handle = (deps.newHandle ?? newPodHandle)();
    try {
      return await inTransaction(async (db) => {
        // The global lock order: the account fence key mutation takes too
        // (provider-keys.ts), with the authoritative checks made under it
        // (not being rehomed, still homed on this bay); then the key's fence
        // and its layers (admitLaunch); then the new rows.
        await (deps.accountWriteFence ?? lockGpuAccountFence)(
          db,
          account_id,
          "launch a GPU",
        );
        // An agent's grant comes next in the lock order (before the key's
        // fence and layers): exactly this launch, this run, unexpired, unused.
        const grant = agent
          ? await lockUsableGrant(
              db,
              agent.principal,
              agent.payload_hash,
              agent.operation_id,
              new Date(now),
            )
          : undefined;
        if (agent && !grant) throw new NoUsableAgentGrant();
        const { client, credential_id, revision } = await loadLaunchAccess(
          account_id,
          deps,
        );
        if (grant && grant.credential_id !== credential_id) {
          throw Error(
            "Your RunPod key changed since this agent's launch was approved; the agent has to ask again.",
          );
        }
        if (
          credential_id !== priced.credential_id ||
          revision !== priced.revision
        ) {
          throw Error(
            "Your RunPod API key changed during the launch. Try again.",
          );
        }
        await ensureKeyBudget(db, {
          credential_id,
          key_owner_account_id: account_id,
          now: new Date(now),
        });
        const admission = await admitLaunch(db, {
          credential_id,
          key_owner_account_id: account_id,
          beneficiary_account_id: account_id,
          project_id,
          grant_id: grant?.grant_id,
          gpu_type_id: spec.gpu_type_id,
          gpu_count: spec.gpu_count,
          cloud: spec.cloud ?? "SECURE",
          data_center_id: spec.data_center_id,
          max_runtime_minutes: spec.max_runtime_minutes,
          hourly_usd,
          now: new Date(now),
        });
        const { rows } = await db.query(
          `INSERT INTO gpu_pods (id, handle, key_owner_account_id, credential_id, provider,
             beneficiary_account_id, project_id, spec, gpu_type_id, gpu_count, cloud,
             data_center_id, state, desired_state, max_runtime_minutes, deadline,
             ssh_key_fingerprint, hostkey_token_id, hostkey_verifier,
             hostkey_expires, agent_id, turn_id, created, updated)
           VALUES ($1, $2, $3, $4, 'runpod', $3, $5, $6, $7, $8, $9, $10, 'intent',
             'running', $11, $12, $13, $14, $15, $16, $17, $18, now(), now())
           RETURNING *`,
          [
            id,
            handle,
            account_id,
            credential_id,
            project_id,
            storedSpec(spec),
            spec.gpu_type_id,
            spec.gpu_count,
            spec.cloud ?? "SECURE",
            spec.data_center_id ?? null,
            spec.max_runtime_minutes,
            deadline,
            spec.ssh_public_key ? sshKeyFingerprint(spec.ssh_public_key) : null,
            token?.token_id ?? null,
            token?.verifier ?? null,
            token ? new Date(now + HOSTKEY_TOKEN_TTL_MS) : null,
            agent?.principal.agent_id ?? null,
            agent?.principal.run_id ?? null,
          ],
        );
        await openFirstStateInterval(db, rows[0]);
        await insertReservations(db, id, admission, spec.gpu_count);
        if (grant) await consumeGrantLaunch(db, grant.grant_id);
        await recordEvent(
          id,
          actor,
          "create",
          {
            handle,
            project_id,
            gpu_type_id: spec.gpu_type_id,
            gpu_count: spec.gpu_count,
            cloud: spec.cloud,
            max_runtime_minutes: spec.max_runtime_minutes,
            hourly_usd: admission.hourly_usd,
            reserved_usd: admission.estimate_usd,
          },
          db,
        );
        return { row: rows[0], client };
      });
    } catch (err: any) {
      // A handle collision (80 random bits: vanishingly rare) gets a new one.
      if (err?.code === "23505" && attempt < HANDLE_ATTEMPTS) continue;
      throw err;
    }
  }
}

// When the pod started being billed: RunPod's startedAt (else its
// createdAt), bounded by the intent's creation (no pod exists before it) and
// now. Without a usable provider time, the intent's creation: an ambiguous
// create found by name later may have run all along.
export function providerStartTime(
  pod: Pick<RunpodPodView, "startedAt" | "createdAt">,
  row: Pick<PodRow, "created">,
  now: Date = new Date(),
): Date {
  const earliest = new Date(row.created).getTime();
  for (const t of [pod.startedAt, pod.createdAt]) {
    const ms = t ? Date.parse(t) : NaN;
    if (Number.isFinite(ms)) {
      return new Date(Math.min(Math.max(ms, earliest), now.getTime()));
    }
  }
  return new Date(Math.min(earliest, now.getTime()));
}

// The pod's reserved list rate, standing in when RunPod reported no cost.
async function reservedHourly(
  db: Pick<PoolClient, "query">,
  pod_id: string,
): Promise<string | null> {
  const { rows } = await db.query(
    "SELECT MAX(hourly_usd) AS hourly FROM gpu_pod_reservations WHERE pod_id = $1",
    [pod_id],
  );
  return rows[0]?.hourly ?? null;
}

// Record RunPod's pod for this handle, only if no pod is bound yet. If the
// record moved on meanwhile (another resolution bound it, or it was given
// up), the pod is either already ours (nothing to do) or would be untracked
// (it is terminated). If a terminate arrived meanwhile, the pod is
// terminated at once.
async function bind(
  row: PodRow,
  pod: RunpodPodView,
  client: Pick<RunpodClient, "terminatePod">,
  actor: Actor,
): Promise<PodRow> {
  const bound = await transition(
    row.id,
    {
      provider_pod_id: pod.id,
      state: "running",
      running_since: providerStartTime(pod, row),
      cost_per_hr: pod.cost ?? null,
      data_center_id: pod.dataCenterId ?? row.data_center_id,
      public_ip: pod.sshDirect?.host ?? null,
    },
    "AND state IN ('creating', 'ambiguous') AND provider_pod_id IS NULL",
    {
      actor,
      action: "bind",
      details: { provider_pod_id: pod.id, cost_per_hr: pod.cost },
    },
    {
      // in the bind's transaction: RunPod's real price must fit the budget,
      // or the pod is terminated at once; and the first IP is recorded
      after: async (db, b) => {
        let out: PodRow = b;
        if (pod.cost != null) {
          const fits = await enlargeAtBind(db, {
            pod_id: b.id,
            credential_id: b.credential_id,
            actual_hourly_usd: moneyToDbString(pod.cost),
            max_runtime_minutes: b.max_runtime_minutes,
          });
          if (!fits) {
            // until RunPod confirms the termination, the pod holds its real
            // price on every layer, so no launch can use what it spends
            await enlargeAtBind(db, {
              pod_id: b.id,
              credential_id: b.credential_id,
              actual_hourly_usd: moneyToDbString(pod.cost),
              max_runtime_minutes: b.max_runtime_minutes,
              force: true,
            });
            const { rows } = await db.query(
              `UPDATE gpu_pods SET desired_state = 'terminated', reason = $2, updated = now()
                WHERE id = $1 RETURNING *`,
              [
                b.id,
                "RunPod's price for this pod is more than your GPU budget allows, so it was terminated.",
              ],
            );
            out = rows[0];
            await recordEvent(
              b.id,
              actor,
              "budget_stop",
              { cost_per_hr: pod.cost },
              db,
            );
          }
        }
        if (b.public_ip) {
          await recordEvent(
            b.id,
            actor,
            "ip_seen",
            { public_ip: b.public_ip, ports: pod.runtime?.ports ?? null },
            db,
          );
        }
        return out;
      },
    },
  );
  if (bound) {
    if (bound.desired_state === "terminated") {
      // Marked terminating first: if RunPod doesn't confirm, the record
      // still says the pod must go, and the next listing (or terminate, or
      // the step 5 reaper) retries. If even that can't be recorded, RunPod
      // isn't asked now: the record stays running with the terminate
      // pending, for the next pass.
      const terminating = await recordTerminating(bound, actor);
      if (!terminating) return await loadPod(bound.id);
      try {
        return await terminateBound(terminating, client, actor);
      } catch {
        return await loadPod(bound.id);
      }
    }
    return bound;
  }
  const current = await loadPod(row.id);
  if (current.provider_pod_id === pod.id) return current;
  await terminateDuplicate(row, pod, client, actor);
  return current;
}

// How long an empty lookup by handle is not taken as proof that no pod was
// made: RunPod's listing may lag a create whose reply was lost.
export const AMBIGUOUS_WINDOW_MS = 15 * 60_000;

async function resolveAmbiguous(
  row: PodRow,
  client: Pick<RunpodClient, "findPodsByName" | "terminatePod">,
  actor: Actor,
  deps: GpuPodDeps,
  // a bounded pass's guard: before each page of RunPod's inventory, after
  // the lookup, and before each terminate or bind
  beforePage?: () => Promise<void>,
): Promise<PodRow> {
  let found: RunpodPodView[];
  try {
    found = await client.findPodsByName(row.handle, { beforePage });
  } catch {
    // if the pass's guard stopped the lookup, the caller stops too (it
    // throws again here); otherwise still unknown, and a later look (pods,
    // terminate) tries again
    await beforePage?.();
    return row;
  }
  // The last (or only) page may have come back after the pass's time or
  // lease ran out: act on it only within both.
  await beforePage?.();
  if (found.length === 0) {
    const age = (deps.now ?? Date.now)() - new Date(row.created).getTime();
    if (age < AMBIGUOUS_WINDOW_MS) return row;
    return (
      (await transition(
        row.id,
        {
          state: "failed",
          reason: "RunPod didn't create this pod.",
          terminated_at: new Date(),
        },
        "AND state = 'ambiguous'",
        {
          actor,
          action: "state",
          details: { state: "failed", resolved: "not_found" },
        },
        // an empty lookup isn't proof: the reservation stays held until the
        // pod shows up (reconcileBindPod) or the owner releases it
        // (releaseQuarantined); a listing never proves it absent
        { settle: "quarantine" },
      )) ?? (await loadPod(row.id))
    );
  }
  // One name, so normally one pod; more would be RunPod retrying a create.
  // Keep the pod the record is already bound to (another resolver may have
  // bound it meanwhile), else the oldest; the rest are duplicates.
  const bound = (await loadPod(row.id))?.provider_pod_id;
  const [keep, ...extra] = [...found].sort((a, b) =>
    a.id === bound
      ? -1
      : b.id === bound
        ? 1
        : `${a.createdAt ?? ""}${a.id}`.localeCompare(
            `${b.createdAt ?? ""}${b.id}`,
          ),
  );
  // before each provider action too (the record stays ambiguous if the pass
  // stops here, so the next one looks again and finishes)
  for (const pod of extra) {
    await beforePage?.();
    await terminateDuplicate(row, pod, client, actor);
  }
  await beforePage?.();
  return await bind(row, keep, client, actor);
}

// Resolve this account's ambiguous records now (a listing or terminate does
// this; the step 5 reconciler will too). Best effort.
// How long a record may stay in intent or creating before it counts as left
// behind by a crash (a create request takes at most 30 s).
export const STALE_CREATE_MS = 2 * 60_000;

// A record a crash left behind: an intent was never sent (no pod can exist,
// so it fails), and a create in flight may have made a pod (it becomes
// ambiguous, to be resolved by its handle). Undefined if it moved on.
async function resolveStaleCreate(
  id: string,
  state: "intent" | "creating",
  actor: Actor,
): Promise<PodRow | undefined> {
  if (state === "intent") {
    return await transition(
      id,
      {
        state: "failed",
        reason: "CoCalc stopped before this pod was created.",
        terminated_at: new Date(),
      },
      "AND state = 'intent'",
      { actor, action: "state", details: { state: "failed", stale: true } },
      // never sent to RunPod: release the reservation
      { settle: "release" },
    );
  }
  return await transition(
    id,
    { state: "ambiguous" },
    "AND state = 'creating'",
    {
      actor,
      action: "state",
      details: { state: "ambiguous", stale: true },
    },
  );
}

function isStale(row: { updated: Date }, deps: GpuPodDeps): boolean {
  return (
    new Date(row.updated).getTime() < (deps.now ?? Date.now)() - STALE_CREATE_MS
  );
}

// Resolve this account's records that need it, oldest first and within
// a batch: crash-left intents and creates, ambiguous creates, and pods that
// must go but whose termination RunPod didn't confirm. A listing and a
// terminate do this, and so does the reaper (as actor "reaper"). A failing
// pod backs off (reap_after), so one bad pod can't stall the rest.
export async function resolvePendingForAccount(
  account_id: string,
  deps: GpuPodDeps,
  {
    actor = { kind: "cleanup" } as Actor,
    limit = 100,
    guard,
    retryBackedOff = false,
  }: {
    actor?: Actor;
    limit?: number;
    // called before each record is acted on: the reaper renews its lease
    // here, and a throw stops the pass
    guard?: () => Promise<void>;
    // a compromised key's cleanup: backed-off pods too, the longest-waiting
    // first (never tried, then the earliest backoff), so pods a slow failure
    // keeps holding up still get their turn on later passes
    retryBackedOff?: boolean;
  } = {},
): Promise<{ full: boolean }> {
  const nowMs = (deps.now ?? Date.now)();
  const now = new Date(nowMs);
  const staleBefore = new Date(nowMs - STALE_CREATE_MS);
  // Left behind by a crash: an intent was never sent (no pod can exist), and
  // a create in flight may have made one, so it is resolved by its handle.
  const { rows: stale } = await getPool().query(
    `SELECT id, state FROM gpu_pods
      WHERE key_owner_account_id = $1 AND state IN ('intent', 'creating')
        AND unmanaged_at IS NULL
        AND updated < $2
      ORDER BY created LIMIT $3`,
    [account_id, staleBefore, limit],
  );
  for (const r of stale) {
    await guard?.();
    await resolveStaleCreate(r.id, r.state, actor);
  }
  const ready =
    "AND (reap_after IS NULL OR reap_after <= $2) AND unmanaged_at IS NULL";
  // what this pass picks ($2 stays typed when the backoff is ignored)
  const pick = retryBackedOff
    ? "AND $2::timestamptz IS NOT NULL AND unmanaged_at IS NULL"
    : ready;
  const order = retryBackedOff
    ? "ORDER BY reap_after NULLS FIRST, created"
    : "ORDER BY created";
  const due = await getPool().query(
    `SELECT 1 FROM gpu_pods WHERE key_owner_account_id = $1
        AND ((desired_state = 'terminated' AND state IN ('running', 'stopped', 'terminating')
              AND provider_pod_id IS NOT NULL)
             OR state = 'ambiguous') ${pick}
      LIMIT 1`,
    [account_id, now],
  );
  if (due.rows.length === 0) return { full: stale.length >= limit };
  const c = await (deps.getCleanup ?? getRunpodCleanupForAccount)(
    account_id,
  ).catch(() => undefined);
  // Ready work this pass can't act on (no key now, or pods of another key)
  // backs off like a failed attempt: it is retried later, and doesn't keep
  // the reaper's sweep from completing (one account's state must not hold
  // every launch on the bay). 5d alerts on pods it can't reach.
  await getPool().query(
    `UPDATE gpu_pods
        SET reap_attempts = reap_attempts + 1,
            reap_after = $2::timestamptz + make_interval(mins => LEAST(power(2, LEAST(reap_attempts, 5))::int, 30))
      WHERE key_owner_account_id = $1
        AND ($3::uuid IS NULL OR credential_id <> $3::uuid)
        AND ((desired_state = 'terminated' AND state IN ('running', 'stopped', 'terminating')
              AND provider_pod_id IS NOT NULL)
             OR state = 'ambiguous') ${ready}`,
    [account_id, now, c?.credential_id ?? null],
  );
  if (!c) return { full: stale.length >= limit };
  // Only pods launched with the key now connected: another key may act for
  // another RunPod account, where these pods don't exist (5c keeps the
  // launching key until its pods end).
  // Pods that must go but whose termination RunPod didn't confirm.
  const { rows: pending } = await getPool().query(
    `SELECT * FROM gpu_pods
      WHERE key_owner_account_id = $1 AND credential_id = $4
        AND desired_state = 'terminated'
        AND state IN ('running', 'stopped', 'terminating')
        AND provider_pod_id IS NOT NULL ${pick}
      ${order} LIMIT $3`,
    [account_id, now, limit, c.credential_id],
  );
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_pods WHERE key_owner_account_id = $1 AND credential_id = $4
        AND state = 'ambiguous' ${pick}
      ${order} LIMIT $3`,
    [account_id, now, limit, c.credential_id],
  );
  const ours = (row: PodRow) => row.credential_id === c.credential_id;
  // the guard, also run inside a record (an inventory lookup's pages): its
  // throw stops the pass there too, without counting against the pod
  let stopped: unknown;
  const inner = guard
    ? async () => {
        try {
          await guard();
        } catch (err) {
          stopped = err;
          throw err;
        }
      }
    : undefined;
  const attempt = async (row: PodRow, fn: () => Promise<unknown>) => {
    // outside the try: a guard that throws stops the pass, not this pod
    await guard?.();
    try {
      await fn();
    } catch {
      if (stopped !== undefined) throw stopped;
      // back off: 1, 2, 4, ... minutes, at most 30
      const minutes = Math.min(2 ** (row.reap_attempts ?? 0), 30);
      await getPool().query(
        `UPDATE gpu_pods SET reap_attempts = reap_attempts + 1,
           reap_after = $2::timestamptz + make_interval(mins => $3)
         WHERE id = $1`,
        [row.id, now, minutes],
      );
    }
  };
  for (const row of (pending as PodRow[]).filter(ours)) {
    await attempt(row, async () => {
      // recorded as terminating before RunPod is asked, as on every path
      const terminating = await recordTerminating(row, actor);
      if (!terminating) return;
      await terminateBound(terminating, c, actor);
    });
  }
  for (const row of (rows as PodRow[]).filter(ours)) {
    await attempt(row, async () => {
      // still unresolved (RunPod's inventory couldn't be read, and the
      // window hasn't closed): a failed attempt, backed off like any other
      const after = await resolveAmbiguous(row, c, actor, deps, inner);
      if (after?.state === "ambiguous") {
        throw Error("the ambiguous create is still unresolved");
      }
    });
  }
  // a full batch may have more behind it: the caller passes again
  return {
    full:
      stale.length >= limit || pending.length >= limit || rows.length >= limit,
  };
}

// A pod listing resolves what it can first, briefly: short RunPod calls and
// a short bound, so the listing answers well within its RPC timeout (the
// reaper finishes the rest).
export const LIST_RESOLVE_MS = 10_000;
const LIST_RESOLVE_CALL_TIMEOUT_MS = 5_000;
const resolveAmbiguousForAccount = (account_id: string, deps: GpuPodDeps) => {
  const deadline = Date.now() + (deps.listResolveMs ?? LIST_RESOLVE_MS);
  return resolvePendingForAccount(
    account_id,
    {
      ...deps,
      getCleanup:
        deps.getCleanup ??
        ((a: string) =>
          getRunpodCleanupForAccount(a, {
            runpodTimeoutMs: LIST_RESOLVE_CALL_TIMEOUT_MS,
          })),
    },
    {
      guard: async () => {
        if (Date.now() >= deadline) throw Error("pod listing resolve deadline");
      },
    },
  ).catch(() => ({ full: false }));
};

// ---- terminate ----

// A second RunPod pod under one handle (RunPod retried a create): it is
// recorded as a pod of its own, terminating, before RunPod is asked, so a
// failed terminate is retried like any other pending termination.
//
// Its spend is real, so it is budgeted: under the budget locks of the pod it
// duplicates, it gets a hold on each of that pod's layers: its pod, GPUs
// and RunPod rate for its whole allowed runtime. Nothing is refused (the
// spend already exists), even past the caps, so the layers refuse new
// launches until it settles: it is live until RunPod confirms its
// termination. Its RunPod cost and start time are recorded, so terminating
// it settles what it actually cost onto those layers.
async function terminateDuplicate(
  of: PodRow,
  pod: RunpodPodView,
  client: Pick<RunpodClient, "terminatePod">,
  actor: Actor,
): Promise<void> {
  const provider_pod_id = pod.id;
  const dup = await inTransaction(async (db) => {
    await lockBudgetsForPod(db, {
      pod_id: of.id,
      credential_id: of.credential_id,
      key_owner_account_id: of.key_owner_account_id,
    });
    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO gpu_pods (id, handle, key_owner_account_id, credential_id, provider,
         provider_pod_id, beneficiary_account_id, project_id, agent_id, spec,
         gpu_type_id, gpu_count, cloud, data_center_id, state, desired_state,
         max_runtime_minutes, deadline, reason, cost_per_hr, running_since,
         created, updated)
       SELECT $1, $2, key_owner_account_id, credential_id, provider, $3,
         beneficiary_account_id, project_id, agent_id, spec, gpu_type_id, gpu_count,
         cloud, data_center_id, 'terminating', 'terminated', max_runtime_minutes,
         now(), $4, $6, $7, now(), now()
         FROM gpu_pods WHERE id = $5
       ON CONFLICT (provider, provider_pod_id) DO NOTHING
       RETURNING *`,
      [
        id,
        newPodHandle(),
        provider_pod_id,
        `A duplicate RunPod made for ${of.handle}; terminated.`,
        of.id,
        pod.cost ?? null,
        providerStartTime(pod, of),
      ],
    );
    if (!rows[0]) return undefined; // already recorded
    // terminating since RunPod started it (it bills from then)
    await openFirstStateInterval(db, rows[0], rows[0].running_since);
    // at its RunPod rate (else the pod's), for its whole allowed runtime
    const { rows: held } = await db.query(
      `INSERT INTO gpu_pod_reservations (id, pod_id, layer_id, state, reserved_usd,
         hourly_usd, gpu_count, pod_slots, created, updated)
       SELECT gen_random_uuid(), $1, layer_id, 'active',
         COALESCE($3::numeric, hourly_usd) * $4::numeric / 60,
         COALESCE($3::numeric, hourly_usd), gpu_count, 1, now(), now()
         FROM gpu_pod_reservations WHERE pod_id = $2
       RETURNING layer_id, reserved_usd`,
      [id, of.id, pod.cost ?? null, of.max_runtime_minutes],
    );
    for (const h of held) {
      await db.query(
        `UPDATE gpu_budget_layers SET reserved_usd = reserved_usd + $2, updated = now() WHERE id = $1`,
        [h.layer_id, h.reserved_usd],
      );
    }
    await recordEvent(
      id,
      actor,
      "create",
      { duplicate_of: of.id, provider_pod_id },
      db,
    );
    await recordEvent(
      of.id,
      actor,
      "terminate",
      { provider_pod_id, duplicate: true },
      db,
    );
    return rows[0] as PodRow;
  });
  // On a conflict, the existing record is acted on only if it is this
  // cleanup's own (an earlier attempt for the same key owner and key, still
  // terminating). A canonical pod another resolver just bound, or anyone
  // else's record, is left alone.
  const row =
    dup ??
    ((
      await getPool().query(
        `SELECT * FROM gpu_pods WHERE provider = 'runpod' AND provider_pod_id = $1
            AND key_owner_account_id = $2 AND credential_id = $3
            AND state = 'terminating' AND desired_state = 'terminated'`,
        [provider_pod_id, of.key_owner_account_id, of.credential_id],
      )
    ).rows[0] as PodRow | undefined);
  if (!row) return;
  // Retried by the next listing (or the reaper) if RunPod doesn't confirm.
  await terminateBound(row, client, actor).catch(() => {});
}

// Record a pod as terminating before RunPod is asked to terminate it. The
// row to act on, or undefined when RunPod must not be asked now: recording
// failed (a later pass retries), or the record moved on to something other
// than a pending termination.
async function recordTerminating(
  row: PodRow,
  actor: Actor,
): Promise<PodRow | undefined> {
  let updated: PodRow | undefined;
  try {
    updated = await transition(
      row.id,
      { state: "terminating" },
      "AND state IN ('running', 'stopped') AND desired_state = 'terminated'",
      { actor, action: "state", details: { state: "terminating" } },
    );
  } catch {
    return undefined;
  }
  if (updated) return updated;
  const current = await loadPod(row.id).catch(() => undefined);
  return current?.state === "terminating" &&
    current.desired_state === "terminated" &&
    current.provider_pod_id
    ? current
    : undefined;
}

async function terminateBound(
  row: PodRow,
  client: Pick<RunpodClient, "terminatePod">,
  actor: Actor,
): Promise<PodRow> {
  await client.terminatePod(row.provider_pod_id!);
  return (
    (await transition(
      row.id,
      { state: "terminated", terminated_at: new Date() },
      "AND state <> 'terminated'",
      { actor, action: "state", details: { state: "terminated" } },
      { settle: "actual" },
    )) ?? (await loadPod(row.id))
  );
}

export async function terminateGpuPodLocal(
  opts: { account_id?: string; pod_id?: unknown; agent?: GpuAgentScope },
  deps: GpuPodDeps = {},
): Promise<{ state: GpuPodSummary["state"] }> {
  const account_id = requireAccount(opts.account_id);
  await requireHomeBay(account_id, deps);
  const row = await findPod(account_id, opts.pod_id, opts.agent);
  if (!row) throw Error("No such GPU pod.");
  const actor: Actor = opts.agent
    ? {
        kind: "agent",
        account_id,
        agent_id: opts.agent.agent_id,
        run_id: opts.agent.run_id,
      }
    : {
        kind: row.key_owner_account_id === account_id ? "key_owner" : "user",
        account_id,
      };
  // Recorded first, with its event: a create still in flight sees it when it
  // binds, and an unresolved record keeps it until it is resolved.
  let current = await transition(
    row.id,
    { desired_state: "terminated" },
    "AND state NOT IN ('terminated', 'failed')",
    { actor, action: "terminate" },
  );
  if (!current) return { state: (await loadPod(row.id)).state };
  if (current.state === "intent" || current.state === "creating") {
    // A create still in flight sees the terminate when it binds. One a crash
    // left behind (judged by the record before this terminate touched it)
    // is resolved now: a never-sent intent fails; a create becomes ambiguous
    // and goes through the lookup by handle below.
    if (!isStale(row, deps)) return { state: current.state };
    current =
      (await resolveStaleCreate(current.id, current.state, actor)) ??
      (await loadPod(row.id));
    if (current.state !== "ambiguous") return { state: current.state };
  }
  // Cleanup access: works after a membership lapse.
  const c = await (deps.getCleanup ?? getRunpodCleanupForAccount)(
    row.key_owner_account_id,
  );
  if (!c) {
    throw Error(
      "Your RunPod key was removed, so CoCalc can't terminate this pod. Terminate it at RunPod.",
    );
  }
  if (c.credential_id !== row.credential_id) {
    // The connected key isn't the one that launched this pod, and may act
    // for another RunPod account: asking it would wrongly report the pod
    // gone. The terminate stays recorded.
    throw Error(
      `This pod was launched with a RunPod key that has since been replaced, so CoCalc can't reach it. Terminate it at RunPod${row.provider_pod_id ? ` (pod ${row.provider_pod_id})` : ` (named ${row.handle})`}.`,
    );
  }
  try {
    if (current.state === "ambiguous") {
      current = await resolveAmbiguous(current, c, actor, deps);
      // Terminated on binding, given up as never made, or still unknown
      // (then the terminate stays recorded for when it is resolved).
      if (!current.provider_pod_id || current.state === "terminated") {
        return { state: current.state };
      }
    }
    const terminating = await recordTerminating(current, actor);
    if (!terminating) {
      throw Error(
        "CoCalc couldn't record the termination yet, so RunPod wasn't asked. It stays pending and will be retried; try again shortly.",
      );
    }
    return { state: (await terminateBound(terminating, c, actor)).state };
  } catch (err) {
    if (err instanceof RunpodApiError) {
      throw Error(
        "RunPod didn't confirm the termination. It will be retried; check gpu pods, or terminate it at RunPod.",
      );
    }
    throw err;
  }
}

// ---- reads ----

// RunPod reports a pod's public address only once it runs, so a record's IP
// is refreshed from live views (pods, pods --id), with an ip_seen event per
// new address: attribution by IP can then match the time. Best effort.
export async function recordSeenAddresses(
  records: GpuPodSummary[],
  pods: RunpodPodView[],
): Promise<void> {
  const byProviderId = new Map(
    records
      .filter((r) => r.provider_pod_id)
      .map((r) => [r.provider_pod_id!, r]),
  );
  for (const pod of pods) {
    const record = byProviderId.get(pod.id);
    const ip = pod.sshDirect?.host;
    if (!record || !ip) continue;
    await inTransaction(async (db) => {
      const { rows } = await db.query(
        `UPDATE gpu_pods SET public_ip = $2, updated = now()
          WHERE id = $1 AND public_ip IS DISTINCT FROM $2 RETURNING id`,
        [record.id, ip],
      );
      if (rows[0]) {
        await recordEvent(
          record.id,
          { kind: "cleanup" },
          "ip_seen",
          {
            public_ip: ip,
            ports: (pod.runtime?.ports ?? []).map((p) => ({
              private: p.private,
              public: p.public,
              type: p.type,
            })),
          },
          db,
        );
      }
    });
  }
}

// ---- the reconciler's record changes (5d) ----
//
// The reconciler reads RunPod and records what it sees; it never asks RunPod
// to terminate anything. These two are its only pod-state changes.

// A pod's holds are a live pod's again (its budget locks are held): a
// quarantined hold is still on its layer, so only its state changes; a
// settled one (released, or ended) is held again in full, and what it had
// spent is the live pod's again. True if any had been settled.
async function holdAgain(db: PoolClient, pod_id: string): Promise<boolean> {
  let settled = false;
  const { rows: reservations } = await db.query(
    "SELECT * FROM gpu_pod_reservations WHERE pod_id = $1 ORDER BY id",
    [pod_id],
  );
  for (const r of reservations) {
    if (r.state === "quarantined") {
      await db.query(
        "UPDATE gpu_pod_reservations SET state = 'active', updated = now() WHERE id = $1",
        [r.id],
      );
    } else if (r.state === "settled") {
      settled = true;
      await db.query(
        `UPDATE gpu_pod_reservations
            SET state = 'active', spent_usd = 0, released_usd = 0, overrun_usd = 0,
                settled_at = NULL, updated = now()
          WHERE id = $1`,
        [r.id],
      );
      await db.query(
        `UPDATE gpu_budget_layers
            SET reserved_usd = reserved_usd + $2, spent_usd = spent_usd - $3, updated = now()
          WHERE id = $1`,
        [r.layer_id, r.reserved_usd, r.spent_usd ?? 0],
      );
    }
  }
  return settled;
}

// A pod CoCalc recorded as ended that RunPod, asked by id at `asked` (after
// the end), still has: the "not found" or termination it ended on was older
// than this answer, so it is CoCalc's again, to terminate. Its holds are held
// again in full (its budget shows it, and refuses launches, until it
// settles) and it is marked terminating, so the reaper terminates it at
// RunPod and settles what it actually cost. Only while its key is live
// (the fence is locked first); undefined if the record moved on.
export async function reviveEndedPod(
  row: PodRow,
  actor: Actor,
  asked: Date,
): Promise<PodRow | undefined> {
  return await transition(
    row.id,
    {
      state: "terminating",
      desired_state: "terminated",
      terminated_at: null,
      // live again: whatever billing resolved for the old end no longer holds
      ...BILLING_REOPENED,
      provider_seen_at: asked,
      reason:
        "RunPod still had this pod after CoCalc recorded it as ended, so CoCalc is terminating it.",
    },
    `AND state = 'terminated' AND provider_pod_id IS NOT NULL AND unmanaged_at IS NULL
     AND terminated_at < '${asked.toISOString()}'::timestamptz
     AND EXISTS (SELECT 1 FROM gpu_key_fences f
                  WHERE f.credential_id = gpu_pods.credential_id
                    AND f.state IN ('active', 'draining'))`,
    {
      actor,
      action: "state",
      details: { state: "terminating", seen_after_end: true },
    },
    {
      // the gap since the recorded end counts as live: RunPod still had it
      effective_at: row.terminated_at ?? null,
      after: async (db, b) => void (await holdAgain(db, b.id)),
    },
  );
}

// RunPod says (by id, getPod 404) that a bound pod no longer exists: the
// record ends as if CoCalc had terminated it (wanted terminated, then
// terminated, with its actual settlement and the same events), in ONE
// transaction, and nothing is sent to RunPod (it has already shown the pod
// is gone). `asked`: when RunPod was asked. A sighting recorded after it
// (another pass's listing, newer than this answer's question) wins and
// nothing changes; one that commits while this runs is re-checked by the
// UPDATE itself. Undefined if the record moved on meanwhile.
export async function endPodGoneAtProvider(
  row: PodRow,
  actor: Actor,
  asked: Date,
): Promise<PodRow | undefined> {
  return await transition(
    row.id,
    {
      state: "terminated",
      desired_state: "terminated",
      terminated_at: new Date(),
    },
    `AND state IN ('running', 'stopped', 'terminating') AND unmanaged_at IS NULL
     AND (provider_seen_at IS NULL OR provider_seen_at < '${asked.toISOString()}'::timestamptz)`,
    {
      actor,
      action: "state",
      details: { state: "terminated", gone_at_provider: true },
    },
    {
      settle: "actual",
      after: async (db, ended) => {
        // the terminate this stands for, recorded first (same transaction)
        await recordEvent(
          ended.id,
          actor,
          "terminate",
          { gone_at_provider: true },
          db,
        );
      },
    },
  );
}

// A RunPod pod named exactly like an ambiguous or failed (quarantined or
// released) record's handle: the pod is live, so the record becomes live and
// managed again. Its quarantined holds go back to active, adding only what
// RunPod's real price needs beyond them; holds the owner released are
// reserved again in full. Nothing settles while it runs, and nothing is
// terminated here: a pod that doesn't fit is marked to terminate, for the
// reaper. Returns the record and whether its holds had been released.
export async function reconcileBindPod(
  row: PodRow,
  pod: RunpodPodView,
  actor: Actor,
  observed_at: Date,
): Promise<{ row?: PodRow; released: boolean }> {
  let released = false;
  const bound = await transition(
    row.id,
    {
      provider_pod_id: pod.id,
      state: "running",
      running_since: providerStartTime(pod, row),
      cost_per_hr: pod.cost ?? null,
      data_center_id: pod.dataCenterId ?? row.data_center_id,
      public_ip: pod.sshDirect?.host ?? null,
      terminated_at: null,
      // live again: whatever billing resolved for the old end no longer holds
      ...BILLING_REOPENED,
      provider_seen_at: observed_at,
    },
    // (and only while its key is live: a pass that finishes after the key
    // was removed or replaced binds nothing. transition takes the account
    // rehome lock (the same one key changes hold, through their close) and
    // then the key's fence row before this UPDATE, whose own snapshot then
    // sees the fence as committed: a close either finished first, or waits
    // and then finds this pod unfinished)
    `AND state IN ('ambiguous', 'failed') AND provider_pod_id IS NULL AND unmanaged_at IS NULL
     AND EXISTS (SELECT 1 FROM gpu_key_fences f
                  WHERE f.credential_id = gpu_pods.credential_id
                    AND f.state IN ('active', 'draining'))`,
    {
      actor,
      action: "bind",
      details: {
        provider_pod_id: pod.id,
        cost_per_hr: pod.cost,
        reconciled: true,
      },
    },
    {
      after: async (db, b) => {
        // the budget locks are held (transition takes them for `after`)
        released = await holdAgain(db, b.id);
        // its holds are a live pod's again
        await endQuarantineAlert(db, b.id, "pod_seen");
        let out: PodRow = b;
        if (pod.cost != null) {
          const fits = await enlargeAtBind(db, {
            pod_id: b.id,
            credential_id: b.credential_id,
            actual_hourly_usd: moneyToDbString(pod.cost),
            max_runtime_minutes: b.max_runtime_minutes,
          });
          if (!fits) {
            await enlargeAtBind(db, {
              pod_id: b.id,
              credential_id: b.credential_id,
              actual_hourly_usd: moneyToDbString(pod.cost),
              max_runtime_minutes: b.max_runtime_minutes,
              force: true,
            });
            const { rows } = await db.query(
              `UPDATE gpu_pods SET desired_state = 'terminated', reason = $2, updated = now()
                WHERE id = $1 RETURNING *`,
              [
                b.id,
                "RunPod's price for this pod is more than your GPU budget allows, so it is being terminated.",
              ],
            );
            out = rows[0];
            await recordEvent(
              b.id,
              actor,
              "budget_stop",
              { cost_per_hr: pod.cost },
              db,
            );
          }
        }
        if (b.public_ip) {
          await recordEvent(
            b.id,
            actor,
            "ip_seen",
            { public_ip: b.public_ip, ports: pod.runtime?.ports ?? null },
            db,
          );
        }
        return out;
      },
    },
  );
  return { row: bound, released };
}

export async function listManagedGpuPodsLocal(
  opts: { account_id?: string; include_ended?: boolean; agent?: GpuAgentScope },
  deps: GpuPodDeps = {},
): Promise<GpuPodSummary[]> {
  const account_id = requireAccount(opts.account_id);
  await requireHomeBay(account_id, deps);
  await resolveAmbiguousForAccount(account_id, deps);
  const scope = agentScopeSql(opts.agent, 3);
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_pods WHERE ${MINE}${scope.sql}
       AND (state = ANY($2)
            ${opts.include_ended ? "OR created > now() - interval '30 days'" : ""})
     ORDER BY created DESC LIMIT 500`,
    [account_id, GPU_POD_LIVE_STATES, ...scope.values],
  );
  return rows.map(podSummary);
}

// Who is responsible for a pod. Provider ids and IPs are only
// lookup hints: results are limited to the caller's own records.
export async function whoGpuPodLocal(
  opts: { account_id?: string; query?: unknown; agent?: GpuAgentScope },
  deps: GpuPodDeps = {},
): Promise<GpuAttribution[]> {
  const account_id = requireAccount(opts.account_id);
  await requireHomeBay(account_id, deps);
  const q = `${opts.query ?? ""}`.trim();
  if (!q || q.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(q)) {
    throw Error("Give a pod id, handle, RunPod pod id or IP address.");
  }
  const scope = agentScopeSql(opts.agent, 3);
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_pods
      WHERE ${MINE}${scope.sql}
        AND (id::text = $2 OR handle = $2 OR provider_pod_id = $2
             OR public_ip = $2
             OR id IN (SELECT pod_id FROM gpu_pod_events
                        WHERE action = 'ip_seen' AND details->>'public_ip' = $2))
      ORDER BY created DESC LIMIT 50`,
    [account_id, q, ...scope.values],
  );
  const out: GpuAttribution[] = [];
  for (const row of rows as PodRow[]) {
    const events = await getPool().query(
      // the newest 200, shown oldest first
      `SELECT * FROM (SELECT * FROM gpu_pod_events WHERE pod_id = $1
         ORDER BY at DESC, id DESC LIMIT 200) e ORDER BY at ASC, id ASC`,
      [row.id],
    );
    out.push({
      pod: podSummary(row),
      events: events.rows.map(eventView),
    });
    await recordEvent(
      row.id,
      opts.agent
        ? {
            kind: "agent",
            account_id,
            agent_id: opts.agent.agent_id,
            run_id: opts.agent.run_id,
          }
        : { kind: "user", account_id },
      "who_lookup",
      {
        query_kind: HANDLE.test(q) ? "handle" : isValidUUID(q) ? "id" : "hint",
      },
    );
  }
  return out;
}

function eventView(row: any): GpuPodEvent {
  const e: GpuPodEvent = {
    id: row.id,
    pod_id: row.pod_id,
    at: iso(row.at)!,
    actor_kind: row.actor_kind,
    action: row.action,
  };
  if (row.actor_account_id) e.actor_account_id = row.actor_account_id;
  if (row.agent_id) e.agent_id = visibleAgentId(row.agent_id);
  if (row.turn_id) e.run_id = visibleAgentId(row.turn_id);
  if (row.details) e.details = row.details;
  return e;
}

// ---- routed entry points (hub API) ----

export async function gpuPodHomeClient(
  account_id: string,
): Promise<InterBayGpuApi | undefined> {
  const dest_bay = await accountHomeBay(account_id);
  if (dest_bay === getConfiguredBayId()) return undefined;
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
    timeout: GPU_POD_WRITE_TIMEOUT_MS,
  });
}

export async function launchGpuPod(
  opts: {
    account_id?: string;
    project_id?: unknown;
    spec?: unknown;
    agent?: { principal: GpuAgentPrincipalWire; operation_id: string };
  },
  deps: GpuPodDeps = {},
): Promise<GpuPodSummary> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuPodHomeClient)(account_id);
  if (home) {
    return await home.gpuLaunch({
      account_id,
      project_id: opts.project_id,
      spec: opts.spec,
      ...(opts.agent ? { agent: opts.agent } : {}),
    });
  }
  return await launchGpuPodLocal({ ...opts, account_id }, deps);
}

export async function terminateGpuPod(
  opts: { account_id?: string; pod_id?: unknown; agent?: GpuAgentScope },
  deps: GpuPodDeps = {},
): Promise<{ state: GpuPodSummary["state"] }> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuPodHomeClient)(account_id);
  if (home)
    return await home.gpuTerminate({
      account_id,
      pod_id: opts.pod_id,
      ...(opts.agent ? { agent: opts.agent } : {}),
    });
  return await terminateGpuPodLocal({ ...opts, account_id }, deps);
}

// ---- removing a key (5c) ----

// A credential's pods CoCalc still manages and that aren't finished.
export async function unfinishedCredentialPods(
  credential_id: string,
  db: Pick<PoolClient, "query"> = getPool(),
): Promise<{ id: string; handle: string }[]> {
  const { rows } = await db.query(
    `SELECT id, handle FROM gpu_pods
      WHERE credential_id = $1 AND state NOT IN ('terminated', 'failed')
        AND unmanaged_at IS NULL
      ORDER BY created`,
    [credential_id],
  );
  return rows;
}

// Mark every unfinished pod of a credential to terminate, now (backoff
// cleared), for a key removal or a compromise.
export async function markCredentialPodsToTerminate(
  db: PoolClient,
  {
    account_id,
    credential_id,
    cause,
  }: {
    account_id: string;
    credential_id: string;
    cause: "key_removal" | "compromised";
  },
): Promise<number> {
  const actor: Actor = { kind: "user", account_id };
  // newly marked ones get an event; a repeat only clears the backoff
  const { rows } = await db.query(
    `UPDATE gpu_pods SET desired_state = 'terminated', reason = $2, updated = now()
      WHERE credential_id = $1 AND state NOT IN ('terminated', 'failed')
        AND unmanaged_at IS NULL AND desired_state <> 'terminated'
      RETURNING id`,
    [
      credential_id,
      cause === "key_removal"
        ? "Its RunPod key is being removed."
        : "Its RunPod key was reported compromised.",
    ],
  );
  for (const { id } of rows) {
    await recordEvent(id, actor, "terminate", { cause }, db);
  }
  await db.query(
    `UPDATE gpu_pods SET reap_after = NULL
      WHERE credential_id = $1 AND state NOT IN ('terminated', 'failed')
        AND unmanaged_at IS NULL AND reap_after IS NOT NULL`,
    [credential_id],
  );
  return rows.length;
}

// A forced removal: the credential's remaining pods leave CoCalc's
// management. Their state is left as it is (they may still run and bill at
// RunPod; nothing claims they stopped), their reservations are quarantined
// (cost unknown; 5d settles them if billing shows it), and each gets an
// event. Called under the account fence, before the key is revoked.
export async function markCredentialPodsUnmanaged(
  db: PoolClient,
  { account_id, credential_id }: { account_id: string; credential_id: string },
): Promise<string[]> {
  const actor: Actor = { kind: "user", account_id };
  const pods = await unfinishedCredentialPods(credential_id, db);
  for (const pod of pods) {
    await lockBudgetsForPod(db, {
      pod_id: pod.id,
      credential_id,
      key_owner_account_id: account_id,
    });
    await settleReservations(
      db,
      { pod_id: pod.id, credential_id },
      { kind: "quarantine" },
    );
    await db.query(
      `UPDATE gpu_pods SET unmanaged_at = now(), updated = now() WHERE id = $1`,
      [pod.id],
    );
    await recordEvent(pod.id, actor, "unmanaged", {}, db);
  }
  return pods.map((p) => p.handle);
}

// ---- releasing quarantined holds (5d) ----

export const RELEASE_QUARANTINED_WARNING =
  "If this pod does exist at RunPod, it may be running and billing there, and your GPU budget no longer holds money for it. If CoCalc sees it later, it manages it again and holds its money in full.";

// The owner says a pod whose create CoCalc couldn't confirm (or that a
// forced removal left unmanaged) doesn't exist, or is gone: its quarantined
// holds are released, all at once, with one audited event. Fresh
// authentication (checked by the bay the owner is signed in to): it loosens
// the budget. Nothing is asked of RunPod. Only quarantined holds: a pod with
// a live hold isn't quarantined.
export async function releaseQuarantinedLocal(
  opts: {
    account_id?: string;
    pod_id?: unknown;
    fresh_auth_verified?: boolean;
  },
  deps: GpuPodDeps = {},
): Promise<{ pod_id: string; released_usd: string; warning: string }> {
  const account_id = requireAccount(opts.account_id);
  if (opts.fresh_auth_verified !== true) {
    throw Object.assign(
      Error("Releasing a held GPU budget needs you to sign in again."),
      { code: "fresh_auth_required" },
    );
  }
  await requireHomeBay(account_id, deps);
  const row = await findPod(account_id, opts.pod_id);
  // only the key owner's budget is held, so only they release it
  if (!row || row.key_owner_account_id !== account_id) {
    throw Error("No such GPU pod launched with your key.");
  }
  let released = "0";
  // its one event, recorded after `after` with the amount filled in
  const details: Record<string, unknown> = {};
  const done = await transition(
    row.id,
    {},
    `AND (state = 'failed' OR unmanaged_at IS NOT NULL)
     AND EXISTS (SELECT 1 FROM gpu_pod_reservations r
                  WHERE r.pod_id = gpu_pods.id AND r.state = 'quarantined')
     AND NOT EXISTS (SELECT 1 FROM gpu_pod_reservations r
                      WHERE r.pod_id = gpu_pods.id AND r.state = 'active')`,
    {
      actor: { kind: "key_owner", account_id },
      action: "quarantine_released",
      details,
    },
    {
      after: async (db, b) => {
        // the budget locks are held (transition takes them for `after`)
        const { rows } = await db.query(
          `SELECT COALESCE(SUM(reserved_usd), 0) AS held FROM gpu_pod_reservations
            WHERE pod_id = $1 AND state = 'quarantined'`,
          [b.id],
        );
        released = moneyToDbString(rows[0].held);
        await settleReservations(
          db,
          { pod_id: b.id, credential_id: b.credential_id },
          { kind: "release" },
        );
        details.released_usd = released;
      },
    },
  );
  if (!done) {
    throw Error(
      "This pod has no held budget to release: it is live, ended normally, or was already released.",
    );
  }
  return {
    pod_id: row.id,
    released_usd: released,
    warning: RELEASE_QUARANTINED_WARNING,
  };
}

// ---- the kill switch ----

export interface GpuKillSwitchResult {
  // pods newly marked to terminate
  marked: number;
  // pods still not confirmed terminated by RunPod (the reaper retries)
  remaining: number;
  // whether new launches are paused by the kill switch now (persisted state)
  paused: boolean;
}

// Stop every live pod CoCalc started with the owner's key (optionally only
// one project's). The account kill switch also pauses new launches (unless
// pause: false) until the owner resumes; a project's never does.
// It only narrows, so it needs no fresh auth. Marked under the account fence,
// so no launch admitted before it can slip past; then terminated at once,
// best effort (the reaper finishes what RunPod doesn't confirm).
// How long the kill switch itself terminates pods before returning (one
// RunPod call, at most 30 s, may still be in flight then): inside the home
// bay's 120 s and the CLI's 150 s write deadlines.
export const KILL_SWITCH_RESOLVE_MS = 60_000;

export async function killSwitchLocal(
  opts: { account_id?: string; project_id?: unknown; pause?: unknown },
  deps: GpuPodDeps = {},
): Promise<GpuKillSwitchResult> {
  const started = Date.now();
  const account_id = requireAccount(opts.account_id);
  await requireHomeBay(account_id, deps);
  let project_id: string | null = null;
  if (opts.project_id != null && opts.project_id !== "") {
    project_id = `${opts.project_id}`;
    if (!isValidUUID(project_id)) throw Error("Give a valid project id.");
  }
  // The account kill switch pauses new launches unless told not to; one
  // project's never pauses the whole key (there's no per-project pause).
  if (project_id != null && opts.pause === true) {
    throw Error(
      "The kill switch pauses launches for the whole key; stop the project's pods without pausing, or use the account kill switch.",
    );
  }
  const pause = project_id == null && opts.pause !== false;
  const actor: Actor = { kind: "user", account_id };
  const { marked, paused } = await inTransaction(async (db) => {
    await (deps.accountWriteFence ?? lockGpuAccountFence)(
      db,
      account_id,
      "stop GPU pods",
    );
    // agents' approvals end with it (next in the lock order: grants, then
    // key fences and layers): nothing an agent was allowed survives a resume
    await revokeAgentGrantsForKillSwitch(db, { account_id, project_id });
    const { rows } = await db.query(
      `UPDATE gpu_pods SET desired_state = 'terminated', reason = $3, updated = now()
        WHERE key_owner_account_id = $1
          AND ($2::uuid IS NULL OR project_id = $2::uuid)
          AND state NOT IN ('terminated', 'failed')
          AND desired_state <> 'terminated'
          AND unmanaged_at IS NULL
        RETURNING id`,
      [account_id, project_id, "Stopped by the kill switch."],
    );
    for (const { id } of rows) {
      await recordEvent(id, actor, "kill_switch", { project_id }, db);
    }
    // a human pressing it again means "now": pods already marked but backed
    // off are retried at once (without another event)
    await db.query(
      `UPDATE gpu_pods SET reap_after = NULL
        WHERE key_owner_account_id = $1
          AND ($2::uuid IS NULL OR project_id = $2::uuid)
          AND desired_state = 'terminated'
          AND state NOT IN ('terminated', 'failed')
          AND unmanaged_at IS NULL
          AND reap_after IS NOT NULL`,
      [account_id, project_id],
    );
    // the connected key's fence exists from its connect (5c); make sure, so
    // the pause always lands
    await db.query(
      `INSERT INTO gpu_key_fences (credential_id, key_owner_account_id, state, created, updated)
       SELECT id, owner_account_id, 'active', now(), now() FROM external_credentials
        WHERE owner_account_id = $1 AND kind = 'gpu-provider-api-key' AND revoked IS NULL
       ON CONFLICT (credential_id) DO NOTHING`,
      [account_id],
    );
    // the currently connected key only (a closed, draining or compromised
    // fence admits nothing anyway)
    const { rows: fences } = await db.query(
      `SELECT f.credential_id FROM gpu_key_fences f
         JOIN external_credentials c ON c.id = f.credential_id
        WHERE f.key_owner_account_id = $1 AND f.state = 'active'
          AND c.revoked IS NULL`,
      [account_id],
    );
    for (const f of fences) {
      await recordKeyEvent(
        {
          credential_id: f.credential_id,
          key_owner_account_id: account_id,
          actor: { kind: "user", account_id },
          action: "kill_switch",
          details: { project_id, marked: rows.length, paused: pause },
        },
        db,
      );
    }
    if (pause) {
      // its own field: a safety pause (an alert's) is left alone
      await db.query(
        `UPDATE gpu_key_fences SET kill_switch_at = now(), updated = now()
          WHERE credential_id = ANY($1::uuid[]) AND kill_switch_at IS NULL`,
        [fences.map((f) => f.credential_id)],
      );
    }
    // what is actually paused now (--no-pause never lifts a pause; only a
    // fresh-auth resume does)
    const { rows: paused } = await db.query(
      `SELECT bool_or(kill_switch_at IS NOT NULL) AS paused FROM gpu_key_fences
        WHERE credential_id = ANY($1::uuid[])`,
      [fences.map((f) => f.credential_id)],
    );
    return { marked: rows.length, paused: paused[0]?.paused === true };
  });
  // Best effort, bounded: what isn't done in time the reaper finishes, and
  // the caller gets the remaining count well within its RPC deadline.
  const deadline =
    started + (deps.killSwitchResolveMs ?? KILL_SWITCH_RESOLVE_MS);
  await resolvePendingForAccount(account_id, deps, {
    guard: async () => {
      if (Date.now() >= deadline) throw Error("kill switch resolve deadline");
    },
  }).catch(() => {});
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM gpu_pods
      WHERE key_owner_account_id = $1
        AND ($2::uuid IS NULL OR project_id = $2::uuid)
        AND desired_state = 'terminated'
        AND state NOT IN ('terminated', 'failed')
        AND unmanaged_at IS NULL`,
    [account_id, project_id],
  );
  return { marked, remaining: rows[0].n, paused };
}

export async function killSwitch(
  opts: { account_id?: string; project_id?: unknown; pause?: unknown },
  deps: GpuPodDeps = {},
): Promise<GpuKillSwitchResult> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuPodHomeClient)(account_id);
  if (home) {
    return await home.gpuKillSwitch({
      account_id,
      project_id: opts.project_id,
      pause: opts.pause,
    });
  }
  return await killSwitchLocal({ ...opts, account_id }, deps);
}

export async function whoGpuPod(
  opts: { account_id?: string; query?: unknown; agent?: GpuAgentScope },
  deps: GpuPodDeps = {},
): Promise<GpuAttribution[]> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuPodHomeClient)(account_id);
  if (home)
    return await home.gpuWho({
      account_id,
      query: opts.query,
      ...(opts.agent ? { agent: opts.agent } : {}),
    });
  return await whoGpuPodLocal({ ...opts, account_id }, deps);
}
