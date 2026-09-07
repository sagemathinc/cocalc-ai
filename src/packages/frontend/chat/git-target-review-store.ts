import { webapp_client } from "@cocalc/frontend/webapp-client";
import { reviewTargetKey } from "@cocalc/frontend/components/diff-viewer/review-model";
import type { ImmutableReviewTarget } from "@cocalc/frontend/components/diff-viewer/review-model";
import { sanitizeComments } from "./git-review-store";
import type { GitReviewCommentV2 } from "./git-review-store";

const STORE = "cocalc-git-target-review-v1";

export interface TargetReviewBody {
  reviewed: boolean;
  note: string;
  comments: Record<string, GitReviewCommentV2>;
  last_submitted_at?: number;
  last_submission_turn_id?: string;
}

export interface TargetReviewRevision {
  version: 1;
  accountId: string;
  target: ImmutableReviewTarget;
  id: string;
  parents: string[];
  updatedAt: number;
  body: TargetReviewBody;
}

// A snapshot has a unique key, not a mutable target key. Two windows saving
// from the same parents produce two heads; neither can erase the other's work.
export interface TargetReviewStorage {
  keys(): Promise<string[]>;
  get(key: string): Promise<unknown>;
  set(key: string, value: TargetReviewRevision): Promise<unknown>;
}

function storage(accountId: string): TargetReviewStorage {
  return webapp_client.conat_client.conat().sync.akv({
    account_id: accountId,
    name: STORE,
  });
}

export function validateReviewTarget(target: ImmutableReviewTarget): void {
  const repo = target?.repository;
  if (
    !repo ||
    !["sha1", "sha256"].includes(repo.objectFormat) ||
    ![repo.projectId, repo.commonDirectory, repo.locator].every(
      (value) =>
        typeof value === "string" && value.length > 0 && !value.includes("\0"),
    )
  ) {
    throw Error("Invalid review repository");
  }
  const hash =
    repo.objectFormat === "sha1" ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (target.kind === "commit") {
    if (
      !hash.test(target.commit) ||
      !Number.isSafeInteger(target.parentIndex) ||
      target.parentIndex < 0 ||
      (target.parent === null
        ? target.parentIndex !== 0
        : !hash.test(target.parent) || target.parentIndex < 1)
    ) {
      throw Error("Review commits and parents must be pinned object IDs");
    }
  } else if (target.kind === "comparison") {
    if (
      !["trees", "merge-base"].includes(target.mode) ||
      ![target.base, target.head, target.requestedBase].every((value) =>
        hash.test(value),
      )
    ) {
      throw Error("Review comparisons must use pinned object IDs");
    }
  } else {
    throw Error("Working-state reviews require a separate generation scope");
  }
}

function prefix(accountId: string, target: ImmutableReviewTarget): string {
  if (!accountId.trim()) throw Error("Review account is required");
  validateReviewTarget(target);
  return `${JSON.stringify([accountId, reviewTargetKey(target)])}:`;
}

function sanitizeBody(body: TargetReviewBody): TargetReviewBody {
  const comments = sanitizeComments(body.comments);
  if (
    !body.comments ||
    typeof body.comments !== "object" ||
    Array.isArray(body.comments)
  )
    throw Error("Invalid review comments");
  for (const [key, original] of Object.entries(body.comments)) {
    if (!comments[key] || typeof original?.file_path !== "string")
      throw Error("Invalid review comment; refusing to discard it");
    // Git filenames are literal: whitespace at either end is significant.
    comments[key].file_path = original.file_path;
  }
  return {
    reviewed: Boolean(body.reviewed),
    note: String(body.note ?? ""),
    comments,
    last_submitted_at: Number.isFinite(body.last_submitted_at)
      ? body.last_submitted_at
      : undefined,
    last_submission_turn_id:
      typeof body.last_submission_turn_id === "string"
        ? body.last_submission_turn_id
        : undefined,
  };
}

export function targetReviewHeads(
  revisions: TargetReviewRevision[],
): TargetReviewRevision[] {
  orderRevisions(revisions);
  const superseded = new Set(revisions.flatMap((revision) => revision.parents));
  return revisions
    .filter((revision) => !superseded.has(revision.id))
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
}

function orderRevisions(
  revisions: TargetReviewRevision[],
): TargetReviewRevision[] {
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  if (byId.size !== revisions.length) throw Error("Duplicate review revision");
  const children = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  const ordered: TargetReviewRevision[] = [];
  for (const revision of revisions) {
    const parents = Array.from(new Set(revision.parents));
    remaining.set(revision.id, parents.length);
    if (!parents.length) ordered.push(revision);
    for (const parent of parents) {
      if (!byId.has(parent)) throw Error("Review is missing a parent revision");
      const next = children.get(parent) ?? [];
      next.push(revision.id);
      children.set(parent, next);
    }
  }
  // Avoid recursive stacks for long review histories.
  for (let i = 0; i < ordered.length; i++) {
    for (const child of children.get(ordered[i].id) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (!count) ordered.push(byId.get(child)!);
    }
  }
  if (ordered.length !== revisions.length)
    throw Error("Cyclic review revisions");
  return ordered;
}

export async function loadTargetReview({
  accountId,
  target,
  kv = storage(accountId),
}: {
  accountId: string;
  target: ImmutableReviewTarget;
  kv?: TargetReviewStorage;
}): Promise<{
  revisions: TargetReviewRevision[];
  heads: TargetReviewRevision[];
}> {
  const start = prefix(accountId, target);
  const revisions: TargetReviewRevision[] = [];
  // Bound reads rather than issuing one request for every saved revision at once.
  for (const key of (await kv.keys()).filter((key) => key.startsWith(start))) {
    const raw = (await kv.get(key)) as TargetReviewRevision | undefined;
    if (
      !raw ||
      raw.version !== 1 ||
      raw.accountId !== accountId ||
      typeof raw.id !== "string" ||
      key !== start + raw.id ||
      !Array.isArray(raw.parents) ||
      !raw.parents.every((id) => typeof id === "string" && id !== raw.id) ||
      !Number.isFinite(raw.updatedAt) ||
      !raw.body
    ) {
      throw Error(
        "Invalid stored target review; original record has been retained",
      );
    }
    validateReviewTarget(raw.target);
    if (reviewTargetKey(raw.target) !== reviewTargetKey(target))
      throw Error("Review target mismatch");
    revisions.push({ ...raw, body: sanitizeBody(raw.body) });
  }
  return { revisions, heads: targetReviewHeads(revisions) };
}

export async function saveTargetReview({
  accountId,
  target,
  body,
  parents,
  kv = storage(accountId),
}: {
  accountId: string;
  target: ImmutableReviewTarget;
  body: TargetReviewBody;
  // Only IDs the editor actually loaded/reconciled, never blindly the newest heads.
  parents: string[];
  kv?: TargetReviewStorage;
}): Promise<TargetReviewRevision> {
  const start = prefix(accountId, target);
  const uniqueParents = Array.from(new Set(parents));
  for (const id of uniqueParents) {
    const parent = (await kv.get(start + id)) as
      | TargetReviewRevision
      | undefined;
    if (
      !parent ||
      parent.id !== id ||
      parent.accountId !== accountId ||
      reviewTargetKey(parent.target) !== reviewTargetKey(target)
    )
      throw Error("Review parent is unavailable");
  }
  const revision: TargetReviewRevision = {
    version: 1,
    accountId,
    target,
    id: crypto.randomUUID(),
    parents: uniqueParents,
    updatedAt: Date.now(),
    body: sanitizeBody(body),
  };
  await kv.set(start + revision.id, revision);
  return revision;
}

export function exportTargetReview(revisions: TargetReviewRevision[]) {
  return {
    kind: "cocalc-git-target-review-export-v1" as const,
    version: 1 as const,
    revisions,
  };
}

export async function importTargetReview({
  accountId,
  target,
  payload,
  kv = storage(accountId),
}: {
  accountId: string;
  target: ImmutableReviewTarget;
  payload: unknown;
  kv?: TargetReviewStorage;
}): Promise<number> {
  const bundle = payload as ReturnType<typeof exportTargetReview>;
  if (
    bundle?.kind !== "cocalc-git-target-review-export-v1" ||
    bundle.version !== 1 ||
    !Array.isArray(bundle.revisions)
  )
    throw Error("Invalid target review export");
  const start = prefix(accountId, target);
  const pending = new Map<string, TargetReviewRevision>();
  for (const raw of bundle.revisions) {
    if (
      !raw ||
      raw.version !== 1 ||
      typeof raw.id !== "string" ||
      !raw.id ||
      pending.has(raw.id) ||
      !Array.isArray(raw.parents) ||
      !raw.parents.every((id) => typeof id === "string") ||
      !raw.body ||
      !Number.isFinite(raw.updatedAt)
    )
      throw Error("Invalid imported revision");
    validateReviewTarget(raw.target);
    if (reviewTargetKey(raw.target) !== reviewTargetKey(target))
      throw Error("Imported review belongs to another target");
    pending.set(raw.id, { ...raw, accountId, body: sanitizeBody(raw.body) });
  }
  // Validate the entire graph before writing. Fresh IDs ensure importing a
  // conflicting archive never overwrites an existing local or remote revision.
  const ordered = orderRevisions(Array.from(pending.values()));
  const ids = new Map(
    ordered.map((revision) => [revision.id, crypto.randomUUID()]),
  );
  for (const revision of ordered) {
    const next = {
      ...revision,
      id: ids.get(revision.id)!,
      parents: revision.parents.map((id) => ids.get(id)!),
    };
    await kv.set(start + next.id, next);
  }
  return ordered.length;
}
