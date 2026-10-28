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

import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import {
  createInterBayAccountLocalClient,
  type InterBayGpuApi,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { resolveProjectReferenceAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  getRunpodCleanupForAccount,
  getRunpodLaunchAccessForAccount,
  type RunpodCleanupCapability,
} from "@cocalc/server/gpu/provider-keys";
import { GPU_POD_WRITE_TIMEOUT_MS } from "@cocalc/util/gpu/runpod";

export interface GpuPodDeps {
  // for tests
  getLaunchAccess?: (
    account_id: string,
  ) => Promise<{ client: RunpodClient; credential_id: string } | undefined>;
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
export function sshKeyFingerprint(publicKey: string): string {
  const blob = Buffer.from(publicKey.trim().split(/\s+/)[1] ?? "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

// ---- the RunPod create body ----

// The only place a create body is made, and only from the normalized spec.
// The server sets the name, the SSH key and (step 4) the start script.
export function buildRunpodCreateBody(
  pod: { handle: string },
  spec: GpuLaunchSpec,
): RunpodCreatePodBody {
  const ports = [...(spec.ports ?? [])];
  const env: Record<string, string> = { ...(spec.env ?? {}) };
  if (spec.ssh_public_key) {
    // The image installs PUBLIC_KEY as the only authorized key; startSsh
    // stays unset so the account's own SSH keys are never added.
    env.PUBLIC_KEY = spec.ssh_public_key;
    if (!ports.includes("22/tcp")) ports.push("22/tcp");
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
  return body;
}

// ---- records ----

// The spec as stored: env values and the SSH key stay out of the record (the
// key is kept as its fingerprint).
function storedSpec(spec: GpuLaunchSpec) {
  const { ssh_public_key: _key, env, ...rest } = spec;
  return { ...rest, env: Object.keys(env ?? {}) };
}

interface PodRow {
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
  public_ip: string | null;
  state: GpuPodSummary["state"];
  desired_state: GpuPodSummary["desired_state"];
  max_runtime_minutes: number;
  deadline: Date;
  reason: string | null;
  ssh_key_fingerprint: string | null;
  created: Date;
  updated: Date;
  terminated_at: Date | null;
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
  if (row.agent_id) s.agent_id = row.agent_id;
  if (row.data_center_id) s.data_center_id = row.data_center_id;
  if (row.cost_per_hr != null) s.cost_per_hr = `${row.cost_per_hr}`;
  if (row.terminated_at) s.terminated_at = iso(row.terminated_at);
  if (row.reason) s.reason = row.reason;
  if (row.ssh_key_fingerprint) s.ssh_key_fingerprint = row.ssh_key_fingerprint;
  return s;
}

interface Actor {
  kind: GpuActorKind;
  account_id?: string;
  agent_id?: string;
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
    `INSERT INTO gpu_pod_events (id, pod_id, at, actor_kind, actor_account_id, agent_id, action, details)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      pod_id,
      actor.kind,
      actor.account_id ?? null,
      actor.agent_id ?? null,
      action,
      details ?? null,
    ],
  );
}

async function inTransaction<T>(
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

// One state change and its event, in one transaction: an event never
// describes a change that didn't happen, and a change never lacks its event.
// `where` adds conditions (compare-and-set); undefined means it didn't apply.
async function transition(
  id: string,
  fields: Record<string, unknown>,
  where: string,
  event?: PodEvent,
): Promise<PodRow | undefined> {
  return await inTransaction(async (db) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const { rows } = await db.query(
      `UPDATE gpu_pods SET ${[...sets, "updated = now()"].join(", ")}
        WHERE id = $1 ${where} RETURNING *`,
      [id, ...keys.map((k) => fields[k])],
    );
    if (rows[0] && event) {
      await recordEvent(id, event.actor, event.action, event.details, db);
    }
    return rows[0];
  });
}

async function loadPod(id: string): Promise<PodRow> {
  const { rows } = await getPool().query(
    "SELECT * FROM gpu_pods WHERE id = $1",
    [id],
  );
  return rows[0];
}

// ---- errors in words, never provider text ----

function refused(err: unknown): boolean {
  return (
    err instanceof RunpodApiError &&
    (err.kind === "auth" ||
      err.kind === "forbidden" ||
      err.kind === "invalid" ||
      err.kind === "conflict" ||
      err.kind === "rate_limited")
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
      case "conflict":
        return "RunPod reported a conflict creating this pod. Try again.";
    }
  }
  return "RunPod refused to create this pod.";
}

// ---- access ----

async function requireHomeBay(account_id: string, deps: GpuPodDeps) {
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

function requireAccount(account_id: unknown): string {
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

async function findPod(
  account_id: string,
  pod: unknown,
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
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_pods WHERE ${column} = $2 AND ${MINE}`,
    [account_id, ref],
  );
  return rows[0];
}

// ---- launch ----

export async function launchGpuPodLocal(
  opts: {
    account_id?: string;
    project_id?: unknown;
    spec?: unknown;
  },
  deps: GpuPodDeps = {},
): Promise<GpuPodSummary> {
  const account_id = requireAccount(opts.account_id);
  await requireHomeBay(account_id, deps);
  const project_id = `${opts.project_id ?? ""}`;
  if (!isValidUUID(project_id)) throw Error("A launch needs a project.");
  const spec = normalizeGpuLaunchSpec(opts.spec);
  if (
    !(await (deps.isProjectCollaborator ?? isProjectCollaborator)(
      account_id,
      project_id,
    ))
  ) {
    throw Error("project not found or access denied");
  }
  let access: Awaited<ReturnType<typeof getRunpodLaunchAccessForAccount>>;
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
  const { client, credential_id } = access;
  const actor: Actor = { kind: "user", account_id };

  // 1. The intent and its event, before anything reaches RunPod.
  let row = await insertIntent({
    account_id,
    project_id,
    credential_id,
    spec,
    actor,
    deps,
  });

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
    );
    return podSummary(failed ?? (await loadPod(row.id)));
  }
  row = creating;
  let created: RunpodPodView;
  try {
    created = await client.createPod(buildRunpodCreateBody(row, spec));
  } catch (err) {
    if (refused(err)) {
      const reason = refusalReason(err);
      await transition(
        row.id,
        { state: "failed", reason, terminated_at: new Date() },
        "AND state = 'creating'",
        { actor, action: "state", details: { state: "failed" } },
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

async function insertIntent({
  account_id,
  project_id,
  credential_id,
  spec,
  actor,
  deps,
}: {
  account_id: string;
  project_id: string;
  credential_id: string;
  spec: GpuLaunchSpec;
  actor: Actor;
  deps: GpuPodDeps;
}): Promise<PodRow> {
  const now = (deps.now ?? Date.now)();
  const deadline = new Date(now + spec.max_runtime_minutes * 60_000);
  for (let attempt = 1; ; attempt++) {
    const id = randomUUID();
    const handle = (deps.newHandle ?? newPodHandle)();
    try {
      return await inTransaction(async (db) => {
        const { rows } = await db.query(
          `INSERT INTO gpu_pods (id, handle, key_owner_account_id, credential_id, provider,
             beneficiary_account_id, project_id, spec, gpu_type_id, gpu_count, cloud,
             data_center_id, state, desired_state, max_runtime_minutes, deadline,
             ssh_key_fingerprint, created, updated)
           VALUES ($1, $2, $3, $4, 'runpod', $3, $5, $6, $7, $8, $9, $10, 'intent',
             'running', $11, $12, $13, now(), now())
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
          ],
        );
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
          },
          db,
        );
        return rows[0];
      });
    } catch (err: any) {
      // A handle collision (80 random bits: vanishingly rare) gets a new one.
      if (err?.code === "23505" && attempt < HANDLE_ATTEMPTS) continue;
      throw err;
    }
  }
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
  );
  if (bound) {
    if (bound.desired_state === "terminated") {
      // Marked terminating first: if RunPod doesn't confirm, the record
      // still says the pod must go, and the next listing (or terminate, or
      // the step 5 reaper) retries.
      const terminating =
        (await transition(
          bound.id,
          { state: "terminating" },
          "AND state = 'running'",
        )) ?? bound;
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
  await client.terminatePod(pod.id);
  await recordEvent(row.id, actor, "terminate", {
    provider_pod_id: pod.id,
    duplicate: true,
  });
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
): Promise<PodRow> {
  let found: RunpodPodView[];
  try {
    found = await client.findPodsByName(row.handle);
  } catch {
    // Still unknown; a later look (pods, terminate) tries again.
    return row;
  }
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
      )) ?? (await loadPod(row.id))
    );
  }
  // One name, so normally one pod; more would be RunPod retrying a create.
  // Keep the oldest and terminate the rest, which nothing else records.
  const [keep, ...extra] = [...found].sort((a, b) =>
    `${a.createdAt ?? ""}${a.id}`.localeCompare(`${b.createdAt ?? ""}${b.id}`),
  );
  for (const pod of extra) {
    await client.terminatePod(pod.id);
    await recordEvent(row.id, actor, "terminate", {
      provider_pod_id: pod.id,
      duplicate: true,
    });
  }
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

async function resolveAmbiguousForAccount(
  account_id: string,
  deps: GpuPodDeps,
): Promise<void> {
  const staleBefore = new Date((deps.now ?? Date.now)() - STALE_CREATE_MS);
  const actor: Actor = { kind: "cleanup" };
  // Left behind by a crash: an intent was never sent (no pod can exist), and
  // a create in flight may have made one, so it is resolved by its handle.
  const { rows: stale } = await getPool().query(
    `SELECT id, state FROM gpu_pods
      WHERE key_owner_account_id = $1 AND state IN ('intent', 'creating')
        AND updated < $2`,
    [account_id, staleBefore],
  );
  for (const r of stale) {
    await resolveStaleCreate(r.id, r.state, actor);
  }
  // Pods that must go but whose termination RunPod didn't confirm.
  const { rows: pending } = await getPool().query(
    `SELECT * FROM gpu_pods
      WHERE key_owner_account_id = $1 AND desired_state = 'terminated'
        AND state IN ('running', 'stopped', 'terminating')
        AND provider_pod_id IS NOT NULL`,
    [account_id],
  );
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_pods WHERE key_owner_account_id = $1 AND state = 'ambiguous'`,
    [account_id],
  );
  if (rows.length === 0 && pending.length === 0) return;
  const c = await (deps.getCleanup ?? getRunpodCleanupForAccount)(
    account_id,
  ).catch(() => undefined);
  if (!c) return;
  // Only pods launched with the key now connected: another key may act for
  // another RunPod account, where these pods don't exist (step 5 keeps the
  // launching key until its pods end).
  const ours = (row: PodRow) => row.credential_id === c.credential_id;
  for (const row of (pending as PodRow[]).filter(ours)) {
    // recorded as terminating before RunPod is asked, as on every path
    const terminating =
      (await transition(
        row.id,
        { state: "terminating" },
        "AND state IN ('running', 'stopped')",
      ).catch(() => undefined)) ?? row;
    await terminateBound(terminating, c, actor).catch(() => {});
  }
  for (const row of (rows as PodRow[]).filter(ours)) {
    await resolveAmbiguous(row, c, { kind: "cleanup" }, deps).catch(() => {});
  }
}

// ---- terminate ----

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
    )) ?? (await loadPod(row.id))
  );
}

export async function terminateGpuPodLocal(
  opts: { account_id?: string; pod_id?: unknown },
  deps: GpuPodDeps = {},
): Promise<{ state: GpuPodSummary["state"] }> {
  const account_id = requireAccount(opts.account_id);
  await requireHomeBay(account_id, deps);
  const row = await findPod(account_id, opts.pod_id);
  if (!row) throw Error("No such GPU pod.");
  const actor: Actor = {
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
    current =
      (await transition(
        row.id,
        { state: "terminating" },
        "AND state IN ('running', 'stopped', 'terminating')",
      )) ?? current;
    return { state: (await terminateBound(current, c, actor)).state };
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

export async function listManagedGpuPodsLocal(
  opts: { account_id?: string; include_ended?: boolean },
  deps: GpuPodDeps = {},
): Promise<GpuPodSummary[]> {
  const account_id = requireAccount(opts.account_id);
  await requireHomeBay(account_id, deps);
  await resolveAmbiguousForAccount(account_id, deps);
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_pods WHERE ${MINE}
       AND (state = ANY($2)
            ${opts.include_ended ? "OR created > now() - interval '30 days'" : ""})
     ORDER BY created DESC LIMIT 500`,
    [account_id, GPU_POD_LIVE_STATES],
  );
  return rows.map(podSummary);
}

// Who is responsible for a pod. Provider ids and IPs are only
// lookup hints: results are limited to the caller's own records.
export async function whoGpuPodLocal(
  opts: { account_id?: string; query?: unknown },
  deps: GpuPodDeps = {},
): Promise<GpuAttribution[]> {
  const account_id = requireAccount(opts.account_id);
  await requireHomeBay(account_id, deps);
  const q = `${opts.query ?? ""}`.trim();
  if (!q || q.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(q)) {
    throw Error("Give a pod id, handle, RunPod pod id or IP address.");
  }
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_pods
      WHERE ${MINE}
        AND (id::text = $2 OR handle = $2 OR provider_pod_id = $2
             OR public_ip = $2
             OR id IN (SELECT pod_id FROM gpu_pod_events
                        WHERE action = 'ip_seen' AND details->>'public_ip' = $2))
      ORDER BY created DESC LIMIT 50`,
    [account_id, q],
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
    await recordEvent(row.id, { kind: "user", account_id }, "who_lookup", {
      query_kind: HANDLE.test(q) ? "handle" : isValidUUID(q) ? "id" : "hint",
    });
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
  if (row.agent_id) e.agent_id = row.agent_id;
  if (row.details) e.details = row.details;
  return e;
}

// ---- routed entry points (hub API) ----

async function gpuPodHomeClient(
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
  opts: { account_id?: string; project_id?: unknown; spec?: unknown },
  deps: GpuPodDeps = {},
): Promise<GpuPodSummary> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuPodHomeClient)(account_id);
  if (home) {
    return await home.gpuLaunch({
      account_id,
      project_id: opts.project_id,
      spec: opts.spec,
    });
  }
  return await launchGpuPodLocal({ ...opts, account_id }, deps);
}

export async function terminateGpuPod(
  opts: { account_id?: string; pod_id?: unknown },
  deps: GpuPodDeps = {},
): Promise<{ state: GpuPodSummary["state"] }> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuPodHomeClient)(account_id);
  if (home) return await home.gpuTerminate({ account_id, pod_id: opts.pod_id });
  return await terminateGpuPodLocal({ ...opts, account_id }, deps);
}

export async function whoGpuPod(
  opts: { account_id?: string; query?: unknown },
  deps: GpuPodDeps = {},
): Promise<GpuAttribution[]> {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? gpuPodHomeClient)(account_id);
  if (home) return await home.gpuWho({ account_id, query: opts.query });
  return await whoGpuPodLocal({ ...opts, account_id }, deps);
}
