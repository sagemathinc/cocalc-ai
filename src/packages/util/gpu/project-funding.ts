/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Project funding approvals for bring-your-own-key compute (PROJECT_FUNDING.md
in the RunPod working notes): the contract between the funder's home bay (H,
the money authority: the approval's budget layer) and the project's owning
bay (P: requests, the approval's routing record and pod locator).

- Terms: what the approver agrees to, validated the same way everywhere.
- Messages: H's versioned changes to P's routing record. Only a newer
  version applies; 'ended' is final for the approval. The pod locator has a
  version of its own and still applies after the approval ended.
- Requests between the bays all carry source_bay_id, which the typed
  inter-bay service binds to the authenticated calling bay.

The transition and merge functions here are pure, so P, H and project rehome
apply exactly the same rules.
*/

import { isValidUUID } from "@cocalc/util/misc";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";

export const PROJECT_FUNDING_PROVIDERS = ["runpod"] as const;
export type ProjectFundingProvider = (typeof PROJECT_FUNDING_PROVIDERS)[number];

// The longest an approval may run.
export const PROJECT_FUNDING_MAX_DAYS = 120;
// The largest single approval (the funder's key budget also applies).
export const PROJECT_FUNDING_MAX_USD = "100000";
// How long P holds a pending slot for H to create the layer and activate it.
export const PROJECT_FUNDING_LEASE_MS = 10 * 60_000;
// How long a request (no funder yet) is shown.
export const PROJECT_FUNDING_REQUEST_TTL_MS = 7 * 24 * 60 * 60_000;

export const PROJECT_FUNDING_CLOUDS = ["SECURE", "COMMUNITY"] as const;

export interface ProjectFundingTerms {
  provider: ProjectFundingProvider;
  // absolute ceiling over the whole approval, decimal USD
  authorized_usd: string;
  // the approval ends this many days after it is approved
  days: number;
  // optional caps; absent means only the funder's key layer limits apply
  max_hourly_usd?: string;
  max_concurrent_pods?: number;
  max_gpu_count?: number;
  max_runtime_minutes?: number;
  allowed_gpu_type_ids?: string[];
  cloud?: (typeof PROJECT_FUNDING_CLOUDS)[number];
  // whether agents working in the project may launch under it
  agents_allowed: boolean;
}

export class ProjectFundingError extends Error {
  readonly code = "invalid_project_funding";
  constructor(message: string) {
    super(message);
    this.name = "ProjectFundingError";
  }
}

function usdString(value: unknown, label: string, positive: boolean): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)
  ) {
    throw new ProjectFundingError(
      `${label} must be a decimal amount in dollars and cents, like "400" or "12.50".`,
    );
  }
  const amount = toDecimal(value);
  if (positive && amount.lte(0)) {
    throw new ProjectFundingError(`${label} must be more than $0.`);
  }
  if (amount.gt(PROJECT_FUNDING_MAX_USD)) {
    throw new ProjectFundingError(
      `${label} can be at most $${PROJECT_FUNDING_MAX_USD}.`,
    );
  }
  return moneyToDbString(amount);
}

function wholeNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new ProjectFundingError(
      `${label} must be a whole number from ${min} to ${max}.`,
    );
  }
  return value;
}

// Validate and canonicalize terms from any caller (browser, CLI, another
// bay). Unknown fields are dropped; the result's key order is fixed, so it
// can be hashed.
export function normalizeProjectFundingTerms(
  value: unknown,
): ProjectFundingTerms {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectFundingError("Project funding terms are missing.");
  }
  const v = value as Record<string, unknown>;
  if (!PROJECT_FUNDING_PROVIDERS.includes(v.provider as any)) {
    throw new ProjectFundingError(
      `The provider must be one of ${PROJECT_FUNDING_PROVIDERS.join(", ")}.`,
    );
  }
  if (typeof v.agents_allowed !== "boolean") {
    throw new ProjectFundingError(
      "Say whether agents in the project may use the approval.",
    );
  }
  const terms: ProjectFundingTerms = {
    provider: v.provider as ProjectFundingProvider,
    authorized_usd: usdString(v.authorized_usd, "The amount", true),
    days: wholeNumber(
      v.days,
      "The number of days",
      1,
      PROJECT_FUNDING_MAX_DAYS,
    ),
    agents_allowed: v.agents_allowed,
  };
  if (v.max_hourly_usd != null) {
    terms.max_hourly_usd = usdString(v.max_hourly_usd, "The hourly cap", true);
  }
  if (v.max_concurrent_pods != null) {
    terms.max_concurrent_pods = wholeNumber(
      v.max_concurrent_pods,
      "Pods at once",
      1,
      100,
    );
  }
  if (v.max_gpu_count != null) {
    terms.max_gpu_count = wholeNumber(v.max_gpu_count, "GPUs at once", 1, 800);
  }
  if (v.max_runtime_minutes != null) {
    terms.max_runtime_minutes = wholeNumber(
      v.max_runtime_minutes,
      "The runtime per pod (minutes)",
      1,
      PROJECT_FUNDING_MAX_DAYS * 24 * 60,
    );
  }
  if (v.allowed_gpu_type_ids != null) {
    if (
      !Array.isArray(v.allowed_gpu_type_ids) ||
      v.allowed_gpu_type_ids.length < 1 ||
      v.allowed_gpu_type_ids.length > 50 ||
      !v.allowed_gpu_type_ids.every(
        (id) => typeof id === "string" && /^[A-Za-z0-9 ._()-]{1,64}$/.test(id),
      )
    ) {
      throw new ProjectFundingError(
        "Allowed GPU types must be a list of 1 to 50 GPU type ids.",
      );
    }
    terms.allowed_gpu_type_ids = [...new Set(v.allowed_gpu_type_ids)].sort();
  }
  if (v.cloud != null) {
    if (!PROJECT_FUNDING_CLOUDS.includes(v.cloud as any)) {
      throw new ProjectFundingError("The cloud must be SECURE or COMMUNITY.");
    }
    terms.cloud = v.cloud as ProjectFundingTerms["cloud"];
  }
  return terms;
}

// Canonical JSON of normalized terms, for hashing (server side) and for
// comparing a retried request with the original.
export function canonicalProjectFundingTerms(
  terms: ProjectFundingTerms,
): string {
  const t = normalizeProjectFundingTerms(terms);
  const keys = Object.keys(t).sort() as (keyof ProjectFundingTerms)[];
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, t[k]])));
}

// What P shows about an approval; the funder's bay is the authority.
export interface ProjectFundingDisplay {
  authorized_usd: string;
  ends_at: string;
  agents_allowed: boolean;
  funder_name?: string;
  max_hourly_usd?: string;
  max_concurrent_pods?: number;
  max_runtime_minutes?: number;
}

export type ProjectFundingEndedReason =
  | "revoked"
  | "expired"
  | "lease_expired"
  | "activation_failed"
  | "funder_left_project"
  | "project_deleted"
  | "key_cleanup";

// H -> P: a change to the routing record, in version order.
export type ProjectFundingMessage =
  | {
      kind: "activate";
      approval_id: string;
      version: number;
      layer_id: string;
      display: ProjectFundingDisplay;
    }
  | {
      kind: "update";
      approval_id: string;
      version: number;
      display: ProjectFundingDisplay;
    }
  | {
      kind: "end";
      approval_id: string;
      version: number;
      reason: ProjectFundingEndedReason;
      // the latest locator, so the route stays eligible while pods live
      live_pods: number;
      pods_version: number;
    }
  | {
      kind: "pods";
      approval_id: string;
      live_pods: number;
      pods_version: number;
    };

// The parts of a project_compute_approvals approval row the state machine
// reads and writes.
export interface ProjectFundingRoute {
  approval_id: string;
  state: "pending" | "active" | "ended";
  version: number;
  layer_id: string | null;
  lease_expires_at: Date | null;
  ended_reason: ProjectFundingEndedReason | null;
  ended_at: Date | null;
  live_pods: number;
  pods_version: number;
  display: ProjectFundingDisplay | null;
}

export type ProjectFundingTransition =
  // the message changed the route
  | { outcome: "applied"; route: ProjectFundingRoute }
  // already applied, or older than what's there: nothing to do (an ack)
  | { outcome: "stale"; route: ProjectFundingRoute }
  // the pending slot's lease ran out first: the route ended instead, and an
  // activate is refused (H then revokes its layer)
  | { outcome: "lease_expired"; route: ProjectFundingRoute };

function withPods(
  route: ProjectFundingRoute,
  live_pods: number,
  pods_version: number,
): ProjectFundingRoute {
  return pods_version > route.pods_version
    ? { ...route, live_pods, pods_version }
    : route;
}

// Apply one message from H to P's route. Pure: the caller stores the result
// in the same transaction that read the route (under the project rehome
// write fence).
export function applyProjectFundingMessage(
  route: ProjectFundingRoute,
  message: ProjectFundingMessage,
  now: Date,
): ProjectFundingTransition {
  if (message.approval_id !== route.approval_id) {
    throw new ProjectFundingError("The message is for a different approval.");
  }
  if (message.kind === "pods") {
    const next = withPods(route, message.live_pods, message.pods_version);
    return next === route
      ? { outcome: "stale", route }
      : { outcome: "applied", route: next };
  }
  if (route.state === "ended" || message.version <= route.version) {
    // An end still carries a locator, which may be newer.
    if (message.kind === "end") {
      const next = withPods(route, message.live_pods, message.pods_version);
      if (next !== route) return { outcome: "applied", route: next };
    }
    return { outcome: "stale", route };
  }
  if (
    route.state === "pending" &&
    route.lease_expires_at != null &&
    route.lease_expires_at.getTime() <= now.getTime() &&
    message.kind !== "end"
  ) {
    return {
      outcome: "lease_expired",
      route: endRoute(route, "lease_expired", route.version + 1, now),
    };
  }
  switch (message.kind) {
    case "activate":
      if (route.state !== "pending") return { outcome: "stale", route };
      return {
        outcome: "applied",
        route: {
          ...route,
          state: "active",
          version: message.version,
          layer_id: message.layer_id,
          lease_expires_at: null,
          display: message.display,
        },
      };
    case "update":
      if (route.state !== "active") return { outcome: "stale", route };
      return {
        outcome: "applied",
        route: { ...route, version: message.version, display: message.display },
      };
    case "end":
      return {
        outcome: "applied",
        route: withPods(
          endRoute(route, message.reason, message.version, now),
          message.live_pods,
          message.pods_version,
        ),
      };
  }
}

function endRoute(
  route: ProjectFundingRoute,
  reason: ProjectFundingEndedReason,
  version: number,
  now: Date,
): ProjectFundingRoute {
  return {
    ...route,
    state: "ended",
    version,
    ended_reason: reason,
    ended_at: now,
    lease_expires_at: null,
  };
}

// Project rehome: merge a route copied from the old owner into the new
// owner's. Field-wise and idempotent: the approval part comes from the higher
// version, the locator from the higher pods_version, never a blind
// overwrite.
export function mergeProjectFundingRoute(
  existing: ProjectFundingRoute | undefined,
  incoming: ProjectFundingRoute,
): ProjectFundingRoute {
  if (existing == null) return incoming;
  if (existing.approval_id !== incoming.approval_id) {
    throw new ProjectFundingError("Can't merge routes of different approvals.");
  }
  const approval =
    incoming.version > existing.version ||
    (incoming.version === existing.version &&
      incoming.state === "ended" &&
      existing.state !== "ended")
      ? incoming
      : existing;
  const pods =
    incoming.pods_version > existing.pods_version ? incoming : existing;
  return {
    ...approval,
    live_pods: pods.live_pods,
    pods_version: pods.pods_version,
  };
}

// Whether P must ask this approval's funder about the project's pods: it
// may still pay for one (PROJECT_FUNDING.md §7).
export function routeMayHavePods(route: ProjectFundingRoute): boolean {
  return route.state === "active" || route.live_pods > 0;
}

export function isProjectFundingId(value: unknown): value is string {
  return typeof value === "string" && isValidUUID(value);
}

// ---- inter-bay requests (source_bay_id: the authenticated calling bay) ----

// H -> P: hold the project's one approval slot before H creates the layer.
export interface ProjectFundingReserveRequest {
  source_bay_id: string;
  project_id: string;
  provider: ProjectFundingProvider;
  approval_id: string;
  // idempotency: a retry with the same operation and terms is the same slot
  operation_id: string;
  terms_hash: string;
  funder_account_id: string;
  display: ProjectFundingDisplay;
}

export type ProjectFundingReserveResult =
  | { status: "reserved"; lease_expires_at: string; version: number }
  | { status: "taken"; message: string }
  | { status: "not_collaborator" }
  | { status: "rehoming" };

// H -> P: deliver one message (see applyProjectFundingMessage).
export interface ProjectFundingDeliverRequest {
  source_bay_id: string;
  project_id: string;
  funder_account_id: string;
  message: ProjectFundingMessage;
}

export type ProjectFundingDeliverResult =
  | {
      status: "committed";
      outcome: ProjectFundingTransition["outcome"];
      state: ProjectFundingRoute["state"];
      version: number;
      pods_version: number;
    }
  // never treated as 'ended': retry after re-resolving the project's owner
  | { status: "rehoming" }
  | { status: "unknown_approval" };

// H -> P: the route's state, for H's reconciliation of activations it never
// saw acknowledged, and the reaper's binding check.
export interface ProjectFundingStatusRequest {
  source_bay_id: string;
  project_id: string;
  approval_id: string;
  funder_account_id: string;
}

export type ProjectFundingStatusResult =
  | {
      status: "found";
      state: ProjectFundingRoute["state"];
      version: number;
      ended_reason: ProjectFundingEndedReason | null;
      project_deleted: boolean;
      funder_is_collaborator: boolean;
    }
  | { status: "rehoming" }
  | { status: "unknown_approval"; project_deleted: boolean };

// P -> H: P ended a route on its own (the lease ran out, the project was
// deleted); H revokes the layer.
export interface ProjectFundingEndedOnProjectRequest {
  source_bay_id: string;
  project_id: string;
  approval_id: string;
  funder_account_id: string;
  reason: ProjectFundingEndedReason;
  version: number;
}

// ---- project rehome: a project_compute_approvals row in portable state ----

// Every column, JSON-safe (timestamps as ISO strings), as the old owner read
// it; the new owner merges it (approval rows with mergeProjectFundingRoute).
export interface ProjectComputeApprovalPortableRow {
  id: string;
  kind: "request" | "approval";
  project_id: string;
  provider: ProjectFundingProvider;
  state: string;
  approval_id: string | null;
  operation_id: string | null;
  terms_hash: string | null;
  funder_account_id: string | null;
  funder_bay_id: string | null;
  layer_id: string | null;
  version: number;
  lease_expires_at: string | null;
  ended_reason: ProjectFundingEndedReason | null;
  ended_at: string | null;
  live_pods: number;
  pods_version: number;
  display: ProjectFundingDisplay | null;
  actor_kind: "project" | "user" | "agent" | null;
  actor_account_id: string | null;
  request_summary: Record<string, unknown> | null;
  request_expires_at: string | null;
  created: string;
  updated: string;
}
