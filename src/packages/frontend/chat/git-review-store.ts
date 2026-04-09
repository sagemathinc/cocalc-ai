import { webapp_client } from "@cocalc/frontend/webapp-client";

const REVIEW_STORE_V2 = "cocalc-git-review-v2";
const REVIEW_STORE_V1 = "cocalc-commit-review-v1";
const REVIEW_DRAFT_STORAGE_PREFIX = "cocalc:git-review:draft:v2:commit:";
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;
const REVIEW_EXPORT_KIND = "cocalc-git-review-export-v1";

type LegacyCommitReviewRecord = {
  version?: number;
  reviewed?: boolean;
  note?: string;
  updated_at?: number;
  account_id?: string;
  commit?: string;
};

export type GitReviewCommentSide = "new" | "old" | "context";
export type GitReviewCommentStatus = "draft" | "submitted" | "resolved";

export type GitReviewCommentV2 = {
  id: string;
  file_path: string;
  side: GitReviewCommentSide;
  line?: number;
  hunk_header?: string;
  hunk_hash?: string;
  snippet?: string;
  body_md: string;
  status: GitReviewCommentStatus;
  submitted_at?: number;
  submission_turn_id?: string;
  created_at: number;
  updated_at: number;
  local_revision: number;
};

export type GitReviewRecordV2 = {
  version: 2;
  account_id: string;
  commit_sha: string;
  reviewed: boolean;
  note: string;
  comments: Record<string, GitReviewCommentV2>;
  last_submitted_at?: number;
  last_submission_turn_id?: string;
  created_at: number;
  updated_at: number;
  revision: number;
};

export type GitReviewExportV1 = {
  kind: typeof REVIEW_EXPORT_KIND;
  version: 1;
  exported_at: number;
  records: GitReviewRecordV2[];
};

type GitReviewDraftV2 = {
  reviewed: boolean;
  note: string;
  comments: Record<string, GitReviewCommentV2>;
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

function sanitizeComment(input: unknown): GitReviewCommentV2 | undefined {
  const raw: any = input;
  const id = `${raw?.id ?? ""}`.trim();
  const filePath = `${raw?.file_path ?? ""}`.trim();
  const body = `${raw?.body_md ?? ""}`;
  if (!id || !filePath) return undefined;
  const sideRaw = `${raw?.side ?? ""}`.trim().toLowerCase();
  const side: GitReviewCommentSide =
    sideRaw === "old" || sideRaw === "context" ? sideRaw : "new";
  const statusRaw = `${raw?.status ?? ""}`.trim().toLowerCase();
  const status: GitReviewCommentStatus =
    statusRaw === "submitted" || statusRaw === "resolved" ? statusRaw : "draft";
  const lineNum = Number(raw?.line);
  const createdAt = Number(raw?.created_at);
  const updatedAt = Number(raw?.updated_at);
  const localRevision = Number(raw?.local_revision);
  const submittedAt = Number(raw?.submitted_at);
  return {
    id,
    file_path: filePath,
    side,
    line: Number.isFinite(lineNum) ? lineNum : undefined,
    hunk_header:
      typeof raw?.hunk_header === "string" ? raw.hunk_header : undefined,
    hunk_hash: typeof raw?.hunk_hash === "string" ? raw.hunk_hash : undefined,
    snippet: typeof raw?.snippet === "string" ? raw.snippet : undefined,
    body_md: body,
    status,
    submitted_at: Number.isFinite(submittedAt) ? submittedAt : undefined,
    submission_turn_id:
      typeof raw?.submission_turn_id === "string"
        ? raw.submission_turn_id
        : undefined,
    created_at: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updated_at: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    local_revision: Number.isFinite(localRevision)
      ? Math.max(1, localRevision)
      : 1,
  };
}

function sanitizeComments(input: unknown): Record<string, GitReviewCommentV2> {
  const out: Record<string, GitReviewCommentV2> = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const comment = sanitizeComment(value);
    if (!comment) continue;
    out[`${key}`] = comment;
  }
  return out;
}

function sanitizeReviewRecord(
  input: unknown,
  {
    accountId,
    commitSha,
  }: {
    accountId?: string;
    commitSha?: string;
  } = {},
): GitReviewRecordV2 | undefined {
  const raw: any = input;
  if (!raw || typeof raw !== "object") return undefined;
  const normalizedCommit = normalizeCommitSha(commitSha ?? raw?.commit_sha);
  const normalizedAccountId = `${accountId ?? raw?.account_id ?? ""}`.trim();
  if (!normalizedCommit || !normalizedAccountId) return undefined;
  const now = Date.now();
  const createdAt = Number(raw?.created_at);
  const updatedAt = Number(raw?.updated_at);
  const revision = Number(raw?.revision);
  const lastSubmittedAt = Number(raw?.last_submitted_at);
  return {
    version: 2,
    account_id: normalizedAccountId,
    commit_sha: normalizedCommit,
    reviewed: Boolean(raw?.reviewed),
    note: `${raw?.note ?? ""}`,
    comments: sanitizeComments(raw?.comments),
    last_submitted_at: Number.isFinite(lastSubmittedAt)
      ? lastSubmittedAt
      : undefined,
    last_submission_turn_id:
      typeof raw?.last_submission_turn_id === "string"
        ? raw.last_submission_turn_id
        : undefined,
    created_at: Number.isFinite(createdAt) ? createdAt : now,
    updated_at: Number.isFinite(updatedAt) ? updatedAt : now,
    revision: Number.isFinite(revision) ? Math.max(1, revision) : 1,
  };
}

function getReviewStore(accountId: string) {
  const cn = webapp_client.conat_client.conat();
  return cn.sync.akv<GitReviewRecordV2>({
    account_id: accountId,
    name: REVIEW_STORE_V2,
  });
}

export function loadReviewDraft(
  commitSha?: string,
): GitReviewDraftV2 | undefined {
  const key = makeDraftKey(commitSha);
  if (!key) return undefined;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<GitReviewDraftV2>;
    return {
      reviewed: Boolean(parsed.reviewed),
      note: `${parsed.note ?? ""}`,
      comments: sanitizeComments(parsed.comments),
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
  draft: Pick<GitReviewDraftV2, "reviewed" | "note"> & {
    comments?: Record<string, GitReviewCommentV2>;
  },
): void {
  const key = makeDraftKey(commitSha);
  if (!key) return;
  const prev = loadReviewDraft(commitSha);
  const next: GitReviewDraftV2 = {
    reviewed: Boolean(draft.reviewed),
    note: `${draft.note ?? ""}`,
    comments: sanitizeComments(draft.comments ?? prev?.comments ?? {}),
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
  const normalizedRecord = {
    ...record,
    comments: sanitizeComments(record.comments),
  };
  if (!draft) return normalizedRecord;
  if (draft.updated_at < normalizedRecord.updated_at) return normalizedRecord;
  const draftComments = sanitizeComments(draft.comments);
  return {
    ...normalizedRecord,
    reviewed: draft.reviewed,
    note: draft.note,
    comments:
      Object.keys(draftComments).length > 0
        ? draftComments
        : normalizedRecord.comments,
    updated_at: draft.updated_at,
    revision: Math.max(normalizedRecord.revision, draft.revision),
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
  const kvV2 = getReviewStore(accountId);
  const current = sanitizeReviewRecord(await kvV2.get(key), {
    accountId,
    commitSha: normalizedCommit,
  });
  if (current) {
    return mergeRecordWithDraft(current, loadReviewDraft(normalizedCommit));
  }
  const cn = webapp_client.conat_client.conat();
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
    created_at: typeof legacy.updated_at === "number" ? legacy.updated_at : now,
    updated_at: typeof legacy.updated_at === "number" ? legacy.updated_at : now,
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
  const kv = getReviewStore(accountId);
  const now = Date.now();
  const payload: GitReviewRecordV2 = {
    ...record,
    version: 2,
    account_id: accountId,
    commit_sha: commitSha,
    note: `${record.note ?? ""}`,
    reviewed: Boolean(record.reviewed),
    comments: sanitizeComments(record.comments),
    updated_at: now,
    revision: Math.max(1, (record.revision ?? 0) + 1),
  };
  await kv.set(key, payload);
  clearReviewDraft(commitSha);
  return payload;
}

export async function exportReviewBundle({
  accountId,
}: {
  accountId: string;
}): Promise<GitReviewExportV1> {
  const normalizedAccountId = `${accountId ?? ""}`.trim();
  if (!normalizedAccountId) {
    throw new Error("account id is required to export git reviews");
  }
  const kv = getReviewStore(normalizedAccountId);
  const keys = (await kv.keys()).filter((key) => key.startsWith("commit:"));
  const records = (
    await Promise.all(
      keys.map(async (key) =>
        sanitizeReviewRecord(await kv.get(key), {
          accountId: normalizedAccountId,
        }),
      ),
    )
  )
    .filter((record): record is GitReviewRecordV2 => record != null)
    .sort((a, b) => {
      const updated = (b.updated_at ?? 0) - (a.updated_at ?? 0);
      return updated !== 0 ? updated : a.commit_sha.localeCompare(b.commit_sha);
    });
  return {
    kind: REVIEW_EXPORT_KIND,
    version: 1,
    exported_at: Date.now(),
    records,
  };
}

function extractImportedReviewRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { records?: unknown[] }).records)
  ) {
    return (payload as { records: unknown[] }).records;
  }
  throw new Error("invalid git review import file");
}

export async function importReviewBundle({
  accountId,
  payload,
}: {
  accountId: string;
  payload: unknown;
}): Promise<{ imported: number; skipped: number; total: number }> {
  const normalizedAccountId = `${accountId ?? ""}`.trim();
  if (!normalizedAccountId) {
    throw new Error("account id is required to import git reviews");
  }
  const rawRecords = extractImportedReviewRecords(payload);
  const kv = getReviewStore(normalizedAccountId);
  let imported = 0;
  let skipped = 0;
  for (const raw of rawRecords) {
    const record = sanitizeReviewRecord(raw, {
      accountId: normalizedAccountId,
    });
    if (!record) {
      skipped += 1;
      continue;
    }
    const key = makeReviewKey(record.commit_sha);
    if (!key) {
      skipped += 1;
      continue;
    }
    const existing = sanitizeReviewRecord(await kv.get(key), {
      accountId: normalizedAccountId,
      commitSha: record.commit_sha,
    });
    if (existing && (existing.updated_at ?? 0) >= (record.updated_at ?? 0)) {
      skipped += 1;
      continue;
    }
    const nextRecord: GitReviewRecordV2 = {
      ...record,
      account_id: normalizedAccountId,
      commit_sha: record.commit_sha,
      revision: Math.max(record.revision ?? 1, existing?.revision ?? 1),
    };
    await kv.set(key, nextRecord);
    clearReviewDraft(record.commit_sha);
    imported += 1;
  }
  return {
    imported,
    skipped,
    total: rawRecords.length,
  };
}
