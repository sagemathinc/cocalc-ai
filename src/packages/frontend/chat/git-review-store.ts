import { webapp_client } from "@cocalc/frontend/webapp-client";

const REVIEW_STORE_V2 = "cocalc-git-review-v2";
const REVIEW_STORE_V1 = "cocalc-commit-review-v1";
const REVIEW_DRAFT_STORAGE_PREFIX = "cocalc:git-review:draft:v2:commit:";
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

type LegacyCommitReviewRecord = {
  version?: number;
  reviewed?: boolean;
  note?: string;
  updated_at?: number;
  account_id?: string;
  commit?: string;
};

export type GitReviewRecordV2 = {
  version: 2;
  account_id: string;
  commit_sha: string;
  reviewed: boolean;
  note: string;
  comments: Record<string, unknown>;
  last_submitted_at?: number;
  last_submission_turn_id?: string;
  created_at: number;
  updated_at: number;
  revision: number;
};

type GitReviewDraftV2 = {
  reviewed: boolean;
  note: string;
  updated_at: number;
  revision: number;
};

export function normalizeCommitSha(commitSha?: string): string | undefined {
  const normalized = `${commitSha ?? ""}`.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!COMMIT_HASH_RE.test(normalized)) return undefined;
  return normalized;
}

export function makeReviewKey(commitSha?: string): string | undefined {
  const normalized = normalizeCommitSha(commitSha);
  if (!normalized) return undefined;
  return `commit:${normalized}`;
}

function makeDraftKey(commitSha?: string): string | undefined {
  const normalized = normalizeCommitSha(commitSha);
  if (!normalized) return undefined;
  return `${REVIEW_DRAFT_STORAGE_PREFIX}${normalized}`;
}

function emptyRecord({
  accountId,
  commitSha,
  now = Date.now(),
}: {
  accountId: string;
  commitSha: string;
  now?: number;
}): GitReviewRecordV2 {
  return {
    version: 2,
    account_id: accountId,
    commit_sha: commitSha,
    reviewed: false,
    note: "",
    comments: {},
    created_at: now,
    updated_at: now,
    revision: 1,
  };
}

export function loadReviewDraft(commitSha?: string): GitReviewDraftV2 | undefined {
  const key = makeDraftKey(commitSha);
  if (!key) return undefined;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<GitReviewDraftV2>;
    return {
      reviewed: Boolean(parsed.reviewed),
      note: `${parsed.note ?? ""}`,
      updated_at:
        typeof parsed.updated_at === "number" ? parsed.updated_at : Date.now(),
      revision: typeof parsed.revision === "number" ? parsed.revision : 1,
    };
  } catch {
    return undefined;
  }
}

export function saveReviewDraft(
  commitSha: string,
  draft: Pick<GitReviewDraftV2, "reviewed" | "note">,
): void {
  const key = makeDraftKey(commitSha);
  if (!key) return;
  const prev = loadReviewDraft(commitSha);
  const next: GitReviewDraftV2 = {
    reviewed: Boolean(draft.reviewed),
    note: `${draft.note ?? ""}`,
    updated_at: Date.now(),
    revision: (prev?.revision ?? 0) + 1,
  };
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // ignore localStorage write failures
  }
}

export function clearReviewDraft(commitSha?: string): void {
  const key = makeDraftKey(commitSha);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore localStorage delete failures
  }
}

export function mergeRecordWithDraft(
  record: GitReviewRecordV2 | undefined,
  draft: GitReviewDraftV2 | undefined,
): GitReviewRecordV2 | undefined {
  if (!record && !draft) return undefined;
  if (!record && draft) return undefined;
  if (!record) return undefined;
  if (!draft) return record;
  if (draft.updated_at < record.updated_at) return record;
  return {
    ...record,
    reviewed: draft.reviewed,
    note: draft.note,
    updated_at: draft.updated_at,
    revision: Math.max(record.revision, draft.revision),
  };
}

export async function loadReviewRecord({
  accountId,
  commitSha,
}: {
  accountId: string;
  commitSha: string;
}): Promise<GitReviewRecordV2 | undefined> {
  const normalizedCommit = normalizeCommitSha(commitSha);
  const key = makeReviewKey(commitSha);
  if (!normalizedCommit || !key) return undefined;
  const cn = webapp_client.conat_client.conat();
  const kvV2 = cn.sync.akv<GitReviewRecordV2>({
    account_id: accountId,
    name: REVIEW_STORE_V2,
  });
  const current = await kvV2.get(key);
  if (current) {
    return mergeRecordWithDraft(current, loadReviewDraft(normalizedCommit));
  }
  const kvV1 = cn.sync.akv<LegacyCommitReviewRecord>({
    account_id: accountId,
    name: REVIEW_STORE_V1,
  });
  const legacy = await kvV1.get(normalizedCommit);
  if (!legacy) {
    return mergeRecordWithDraft(
      emptyRecord({ accountId, commitSha: normalizedCommit }),
      loadReviewDraft(normalizedCommit),
    );
  }
  const now = Date.now();
  const migrated: GitReviewRecordV2 = {
    version: 2,
    account_id: accountId,
    commit_sha: normalizedCommit,
    reviewed: Boolean(legacy.reviewed),
    note: `${legacy.note ?? ""}`,
    comments: {},
    created_at:
      typeof legacy.updated_at === "number" ? legacy.updated_at : now,
    updated_at:
      typeof legacy.updated_at === "number" ? legacy.updated_at : now,
    revision: 1,
  };
  await kvV2.set(key, migrated);
  return mergeRecordWithDraft(migrated, loadReviewDraft(normalizedCommit));
}

export async function saveReviewRecord(
  record: GitReviewRecordV2,
): Promise<GitReviewRecordV2> {
  const accountId = `${record.account_id ?? ""}`.trim();
  const commitSha = normalizeCommitSha(record.commit_sha);
  const key = makeReviewKey(commitSha);
  if (!accountId || !commitSha || !key) {
    throw new Error("invalid review record");
  }
  const cn = webapp_client.conat_client.conat();
  const kv = cn.sync.akv<GitReviewRecordV2>({
    account_id: accountId,
    name: REVIEW_STORE_V2,
  });
  const now = Date.now();
  const payload: GitReviewRecordV2 = {
    ...record,
    version: 2,
    account_id: accountId,
    commit_sha: commitSha,
    note: `${record.note ?? ""}`,
    reviewed: Boolean(record.reviewed),
    updated_at: now,
    revision: Math.max(1, (record.revision ?? 0) + 1),
  };
  await kv.set(key, payload);
  clearReviewDraft(commitSha);
  return payload;
}

