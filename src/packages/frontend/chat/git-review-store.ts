import { webapp_client } from "@cocalc/frontend/webapp-client";
import { getSharedAccountDkv } from "@cocalc/frontend/conat/account-dkv";
import { hash_string } from "@cocalc/util/misc";

const REVIEW_STORE_V2 = "cocalc-git-review-v2";
const REVIEW_STORE_V1 = "cocalc-commit-review-v1";
const REVIEW_DRAFT_STORAGE_PREFIX = "cocalc:git-review:draft:v2:";
const LEGACY_REVIEW_DRAFT_STORAGE_PREFIX = "cocalc:git-review:draft:v2:commit:";
const COMMIT_HASH_RE = /^[0-9a-f]{7,64}$/i;
const REVIEW_EXPORT_KIND = "cocalc-git-review-export-v1";
const REVIEW_ALIAS_CHOICES = "cocalc-git-review-alias-choices-v1";

export type ResolveReviewCommit = (input: string) => Promise<string>;

type AliasInspection = {
  full: string;
  snapshots: Record<string, string>;
  records: GitReviewRecordV2[];
};
type AliasChoice = { selected: string; snapshots: Record<string, string> };
export class GitReviewAliasConflict extends Error {
  constructor(public readonly inspection: AliasInspection) {
    super(
      `Conflicting review keys for ${inspection.full}: ${Object.keys(inspection.snapshots).join(", ")}. No records were changed. Choose the active review; other records will be retained.`,
    );
  }
}
function aliasChoiceStore(accountId: string) {
  return webapp_client.conat_client.conat().sync.akv<AliasChoice>({
    account_id: accountId,
    name: REVIEW_ALIAS_CHOICES,
  });
}

// Retain an existing legacy key until explicit reconciliation. New reviews use
// the full repository-resolved ID; never create a competing canonical record.
export async function resolveReviewStorageCommit({
  accountId,
  commitSha,
  resolveCommit,
}: {
  accountId: string;
  commitSha: string;
  resolveCommit: ResolveReviewCommit;
}): Promise<string> {
  const inspection = await inspectReviewAliases({
    accountId,
    commitSha,
    resolveCommit,
  });
  const keys = Object.keys(inspection.snapshots);
  if (keys.length <= 1) return keys[0] ?? inspection.full;
  const choice = await aliasChoiceStore(accountId).get(inspection.full);
  if (
    choice?.snapshots &&
    keys.includes(choice.selected) &&
    JSON.stringify(Object.keys(choice.snapshots).sort()) ===
      JSON.stringify(keys.sort()) &&
    keys.every(
      (key) =>
        key === choice.selected ||
        choice.snapshots[key] === inspection.snapshots[key],
    )
  )
    return choice.selected;
  throw new GitReviewAliasConflict(inspection);
}

export async function chooseReviewAlias({
  accountId,
  conflict,
  selected,
  resolveCommit,
}: {
  accountId: string;
  conflict: GitReviewAliasConflict;
  selected: string;
  resolveCommit: ResolveReviewCommit;
}): Promise<void> {
  const current = await inspectReviewAliases({
    accountId,
    commitSha: conflict.inspection.full,
    resolveCommit,
  });
  if (
    !Object.hasOwn(current.snapshots, selected) ||
    JSON.stringify(current.snapshots) !==
      JSON.stringify(conflict.inspection.snapshots)
  )
    throw Error(
      "Review records changed while choosing. Reload the review and compare them again.",
    );
  // This only chooses a storage owner. It never merges, overwrites, or deletes
  // any review or draft. Changes to another alias reopen the conflict.
  await aliasChoiceStore(accountId).set(current.full, {
    selected,
    snapshots: current.snapshots,
  });
}

async function inspectReviewAliases({
  accountId,
  commitSha,
  resolveCommit,
}: {
  accountId: string;
  commitSha: string;
  resolveCommit: ResolveReviewCommit;
}): Promise<AliasInspection> {
  const full = (await resolveCommit(commitSha)).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(full))
    throw Error("Git did not resolve the review to a full object ID.");
  const cn = webapp_client.conat_client.conat();
  const v2 = getReviewStore(accountId);
  const v1 = cn.sync.akv<LegacyCommitReviewRecord>({
    account_id: accountId,
    name: REVIEW_STORE_V1,
  });
  const candidates = new Set<string>();
  for (const key of await v2.keys()) {
    if (key.startsWith("commit:")) candidates.add(key.slice(7));
  }
  for (const key of await v1.keys()) candidates.add(key);
  try {
    const prefix = makeDraftStoragePrefix(accountId);
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) candidates.add(key.slice(prefix.length));
    }
  } catch {
    // Server records still work when browser storage is disabled.
  }
  const snapshots: Record<string, string> = {};
  const records: GitReviewRecordV2[] = [];
  for (const candidate of [...candidates].sort()) {
    const id = normalizeCommitSha(candidate);
    if (!id || !full.startsWith(id)) continue;
    // A prefix is not proof: Git must reject ambiguous abbreviations in this
    // repository instead of associating another commit's review by string match.
    if ((await resolveCommit(id)).toLowerCase() !== full)
      throw Error("Legacy review abbreviation resolved to a different commit.");
    const raw = await v2.get(`commit:${id}`);
    const legacy = await v1.get(id);
    const draft = loadReviewDraft(id, accountId);
    if (raw != null || legacy != null || draft) {
      snapshots[id] = JSON.stringify([
        raw ?? null,
        legacy ?? null,
        draft ?? null,
      ]);
      const record = sanitizeReviewRecord(raw, {
        accountId,
        commitSha: id,
      }) ?? {
        ...emptyRecord({
          accountId,
          commitSha: id,
          now: legacy?.updated_at ?? draft?.updated_at ?? 0,
        }),
        note: `${legacy?.note ?? ""}`,
        reviewed: Boolean(legacy?.reviewed),
      };
      records.push(mergeRecordWithDraft(record, draft) ?? record);
    }
  }
  return { full, snapshots, records };
}

type LegacyCommitReviewRecord = {
  version?: number;
  reviewed?: boolean;
  note?: string;
  updated_at?: number;
  account_id?: string;
  commit?: string;
};

export type GitReviewCommentSide = "new" | "old" | "context";
export type GitReviewCommentStatus =
  | "draft"
  | "submitted"
  | "resolved"
  | "conflict";

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
  // Transport-only concurrency token; never persisted or exported.
  storageSequence?: number;
  version: 2;
  account_id: string;
  commit_sha: string;
  reviewed: boolean;
  note: string;
  // Private recovery snapshots, never inline comments or agent feedback.
  note_versions?: string[];
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

function makeDraftStoragePrefix(accountId?: string): string {
  const normalizedAccountId = `${accountId ?? ""}`.trim();
  if (!normalizedAccountId) {
    return LEGACY_REVIEW_DRAFT_STORAGE_PREFIX;
  }
  return `${REVIEW_DRAFT_STORAGE_PREFIX}account:${normalizedAccountId}:commit:`;
}

function makeDraftKey(
  commitSha?: string,
  accountId?: string,
): string | undefined {
  const normalized = normalizeCommitSha(commitSha);
  if (!normalized) return undefined;
  return `${makeDraftStoragePrefix(accountId)}${normalized}`;
}

function makeLegacyDraftKey(commitSha?: string): string | undefined {
  const normalized = normalizeCommitSha(commitSha);
  if (!normalized) return undefined;
  return `${LEGACY_REVIEW_DRAFT_STORAGE_PREFIX}${normalized}`;
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
  const filePath = `${raw?.file_path ?? ""}`;
  const body = `${raw?.body_md ?? ""}`;
  if (!id || !filePath) return undefined;
  const sideRaw = `${raw?.side ?? ""}`.trim().toLowerCase();
  const side: GitReviewCommentSide =
    sideRaw === "old" || sideRaw === "context" ? sideRaw : "new";
  const statusRaw = `${raw?.status ?? ""}`.trim().toLowerCase();
  const status: GitReviewCommentStatus =
    statusRaw === "submitted" ||
    statusRaw === "resolved" ||
    statusRaw === "conflict"
      ? statusRaw
      : "draft";
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

export function sanitizeComments(
  input: unknown,
): Record<string, GitReviewCommentV2> {
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
    note_versions: sanitizeNoteVersions(raw?.note_versions),
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

function sanitizeNoteVersions(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const versions = [
    ...new Set(input.filter((x): x is string => typeof x === "string")),
  ];
  return versions.length ? versions : undefined;
}

function getReviewStore(accountId: string) {
  const cn = webapp_client.conat_client.conat();
  return cn.sync.akv<GitReviewRecordV2>({
    account_id: accountId,
    name: REVIEW_STORE_V2,
  });
}

async function getReviewBulkStore(accountId: string) {
  return await getSharedAccountDkv<GitReviewRecordV2>({
    account_id: accountId,
    name: REVIEW_STORE_V2,
  });
}

function parseStoredReviewDraft(raw: string): GitReviewDraftV2 | undefined {
  try {
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

export function loadReviewDraft(
  commitSha?: string,
  accountId?: string,
): GitReviewDraftV2 | undefined {
  const key = makeDraftKey(commitSha, accountId);
  if (!key) return undefined;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      return parseStoredReviewDraft(raw);
    }
    if (!accountId) return undefined;
    const legacyKey = makeLegacyDraftKey(commitSha);
    if (!legacyKey) return undefined;
    const legacyRaw = localStorage.getItem(legacyKey);
    if (!legacyRaw) return undefined;
    const legacyDraft = parseStoredReviewDraft(legacyRaw);
    if (!legacyDraft) return undefined;
    localStorage.setItem(key, JSON.stringify(legacyDraft));
    localStorage.removeItem(legacyKey);
    return legacyDraft;
  } catch {
    return undefined;
  }
}

export function saveReviewDraft(
  commitSha: string,
  draft: Pick<GitReviewDraftV2, "reviewed" | "note"> & {
    comments?: Record<string, GitReviewCommentV2>;
  },
  accountId?: string,
): void {
  const normalizedAccountId = `${accountId ?? ""}`.trim();
  if (!normalizedAccountId) return;
  const key = makeDraftKey(commitSha, accountId);
  if (!key) return;
  const prev = loadReviewDraft(commitSha, accountId);
  const next: GitReviewDraftV2 = {
    reviewed: Boolean(draft.reviewed),
    note: `${draft.note ?? ""}`,
    comments: sanitizeComments(draft.comments ?? prev?.comments ?? {}),
    updated_at: Date.now(),
    revision: (prev?.revision ?? 0) + 1,
  };
  try {
    localStorage.setItem(key, JSON.stringify(next));
    if (accountId) {
      const legacyKey = makeLegacyDraftKey(commitSha);
      if (legacyKey && legacyKey !== key) {
        localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // ignore localStorage write failures
  }
}

export function clearReviewDraft(commitSha?: string, accountId?: string): void {
  const key = makeDraftKey(commitSha, accountId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
    if (accountId) {
      const legacyKey = makeLegacyDraftKey(commitSha);
      if (legacyKey && legacyKey !== key) {
        localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // ignore localStorage delete failures
  }
}

export function clearReviewDraftThroughRevision(
  commitSha: string,
  revision?: number,
  accountId?: string,
): void {
  if (typeof revision !== "number" || !Number.isFinite(revision)) {
    clearReviewDraft(commitSha, accountId);
    return;
  }
  const current = loadReviewDraft(commitSha, accountId);
  if (current && (current.revision ?? 0) > revision) {
    return;
  }
  clearReviewDraft(commitSha, accountId);
}

export function clearReviewDraftThroughUpdatedAt(
  commitSha: string,
  updatedAt?: number,
  accountId?: string,
): void {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    clearReviewDraft(commitSha, accountId);
    return;
  }
  const current = loadReviewDraft(commitSha, accountId);
  if (current && (current.updated_at ?? 0) >= updatedAt) {
    return;
  }
  clearReviewDraft(commitSha, accountId);
}

export function mergeRecoveredComments(
  record: Record<string, GitReviewCommentV2> = {},
  draft: Record<string, GitReviewCommentV2> = {},
): Record<string, GitReviewCommentV2> {
  const result = { ...record };
  const content = (comment: GitReviewCommentV2) =>
    JSON.stringify([
      comment.body_md,
      comment.file_path,
      comment.side,
      comment.line,
      comment.hunk_header,
      comment.hunk_hash,
      comment.snippet,
    ]);
  for (const [id, local] of Object.entries(draft)) {
    const remote = record[id];
    if (!remote) {
      result[id] = local;
    } else if (content(remote) === content(local)) {
      if (local.updated_at > remote.updated_at) result[id] = local;
    } else {
      // There is no trustworthy common ancestor in legacy draft snapshots.
      // Preserve both bodies instead of guessing which author intent wins.
      const fingerprint = content(local);
      const base = `${id}:recovered:${hash_string(fingerprint)}`;
      let key = base;
      let suffix = 0;
      while (result[key] && content(result[key]) !== fingerprint)
        key = `${base}:${++suffix}`;
      if (!result[key]) result[key] = { ...local, id: key, status: "conflict" };
    }
  }
  return result;
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
    note_versions: sanitizeNoteVersions(record.note_versions),
  };
  if (!draft) return normalizedRecord;
  // Legacy drafts have no common ancestor. Keep both versions rather than
  // treating a timestamp as proof that the other note can be discarded.
  if (draft.note !== normalizedRecord.note) {
    normalizedRecord.note_versions = sanitizeNoteVersions([
      ...(normalizedRecord.note_versions ?? []),
      normalizedRecord.note,
      draft.note,
    ]);
  }
  const draftComments = sanitizeComments(draft.comments);
  const comments = mergeRecoveredComments(
    normalizedRecord.comments,
    draftComments,
  );
  if (draft.updated_at < normalizedRecord.updated_at)
    return { ...normalizedRecord, comments };
  return {
    ...normalizedRecord,
    reviewed: draft.reviewed,
    note: draft.note,
    comments,
    updated_at: draft.updated_at,
    revision: Math.max(normalizedRecord.revision, draft.revision),
  };
}

export async function loadReviewRecord({
  accountId,
  commitSha,
  resolveCommit,
}: {
  accountId: string;
  commitSha: string;
  resolveCommit?: ResolveReviewCommit;
}): Promise<GitReviewRecordV2 | undefined> {
  if (resolveCommit) {
    const storageCommit = await resolveReviewStorageCommit({
      accountId,
      commitSha,
      resolveCommit,
    });
    return (
      (await loadReviewRecord({ accountId, commitSha: storageCommit })) ?? {
        ...emptyRecord({ accountId, commitSha: storageCommit }),
        storageSequence: 0,
      }
    );
  }
  const normalizedCommit = normalizeCommitSha(commitSha);
  const key = makeReviewKey(commitSha);
  if (!normalizedCommit || !key) return undefined;
  const kvV2 = getReviewStore(accountId);
  const message = await kvV2.getMessage(key, { includeDeleted: true });
  const current = sanitizeReviewRecord(message?.data, {
    accountId,
    commitSha: normalizedCommit,
  });
  if (current) {
    return mergeRecordWithDraft(
      { ...current, storageSequence: message?.headers?.seq as number },
      loadReviewDraft(normalizedCommit, accountId),
    );
  }
  const cn = webapp_client.conat_client.conat();
  const kvV1 = cn.sync.akv<LegacyCommitReviewRecord>({
    account_id: accountId,
    name: REVIEW_STORE_V1,
  });
  const legacy = await kvV1.get(normalizedCommit);
  const draft = loadReviewDraft(normalizedCommit, accountId);
  if (!legacy) {
    if (!draft) {
      return message
        ? {
            ...emptyRecord({ accountId, commitSha: normalizedCommit }),
            storageSequence: message.headers?.seq as number,
          }
        : undefined;
    }
    return mergeRecordWithDraft(
      {
        ...emptyRecord({
          accountId,
          commitSha: normalizedCommit,
          now: draft.updated_at ?? Date.now(),
        }),
        storageSequence: (message?.headers?.seq as number) ?? 0,
      },
      draft,
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
  const saved = await kvV2.set(key, migrated, {
    previousSeq: (message?.headers?.seq as number) ?? 0,
  });
  return mergeRecordWithDraft(
    { ...migrated, storageSequence: saved.seq },
    draft,
  );
}

export async function loadReviewRecords({
  accountId,
  commitShas,
}: {
  accountId: string;
  commitShas: readonly string[];
}): Promise<readonly (readonly [string, GitReviewRecordV2 | undefined])[]> {
  const normalizedAccountId = `${accountId ?? ""}`.trim();
  if (!normalizedAccountId) return [];
  const commits = Array.from(
    new Set(
      commitShas
        .map((commitSha) => normalizeCommitSha(commitSha))
        .filter((commitSha): commitSha is string => commitSha != null),
    ),
  );
  if (commits.length === 0) return [];
  const kv = await getReviewBulkStore(normalizedAccountId);
  const all = kv.getAll();
  const now = Date.now();
  return commits.map((commitSha) => {
    const key = makeReviewKey(commitSha);
    const current = key
      ? sanitizeReviewRecord(all[key], {
          accountId: normalizedAccountId,
          commitSha,
        })
      : undefined;
    const draft = loadReviewDraft(commitSha, normalizedAccountId);
    if (current) {
      return [commitSha, mergeRecordWithDraft(current, draft)] as const;
    }
    if (!draft) {
      return [commitSha, undefined] as const;
    }
    return [
      commitSha,
      mergeRecordWithDraft(
        emptyRecord({
          accountId: normalizedAccountId,
          commitSha,
          now: draft.updated_at ?? now,
        }),
        draft,
      ),
    ] as const;
  });
}

export async function saveReviewRecord(
  record: GitReviewRecordV2,
  opts?: {
    clearDraftThroughRevision?: number;
    resolveCommit?: ResolveReviewCommit;
  },
): Promise<GitReviewRecordV2> {
  const accountId = `${record.account_id ?? ""}`.trim();
  const commitSha = normalizeCommitSha(
    opts?.resolveCommit
      ? await resolveReviewStorageCommit({
          accountId,
          commitSha: record.commit_sha,
          resolveCommit: opts.resolveCommit,
        })
      : record.commit_sha,
  );
  const key = makeReviewKey(commitSha);
  if (!accountId || !commitSha || !key) {
    throw new Error("invalid review record");
  }
  const kv = getReviewStore(accountId);
  const now = Date.now();
  const { storageSequence, ...storedRecord } = record;
  const payload: GitReviewRecordV2 = {
    ...storedRecord,
    version: 2,
    account_id: accountId,
    commit_sha: commitSha,
    note: `${record.note ?? ""}`,
    note_versions: sanitizeNoteVersions(record.note_versions),
    reviewed: Boolean(record.reviewed),
    comments: sanitizeComments(record.comments),
    updated_at: now,
    revision: Math.max(1, (record.revision ?? 0) + 1),
  };
  let saved;
  try {
    saved = await kv.set(key, payload, { previousSeq: storageSequence ?? 0 });
  } catch (error) {
    throw new Error(
      `Unable to save review; another window may have changed it. Your local draft was not cleared. Reload and reconcile before saving again. ${error}`,
    );
  }
  clearReviewDraftThroughRevision(
    commitSha,
    opts?.clearDraftThroughRevision,
    accountId,
  );
  return { ...payload, storageSequence: saved.seq };
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
  const kv = await getReviewBulkStore(normalizedAccountId);
  const records = Object.entries(kv.getAll())
    .filter(([key]) => key.startsWith("commit:"))
    .map(([, value]) =>
      sanitizeReviewRecord(value, {
        accountId: normalizedAccountId,
      }),
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
  const kv = await getReviewBulkStore(normalizedAccountId);
  const existingAll = kv.getAll();
  const pending: Record<string, GitReviewRecordV2> = {};
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
    const existing = sanitizeReviewRecord(pending[key] ?? existingAll[key], {
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
    if (pending[key]) skipped += 1;
    else imported += 1;
    pending[key] = nextRecord;
  }
  if (imported > 0) {
    kv.setMany(pending);
    await kv.flush();
    // Keep recovery drafts until the remote write is acknowledged. Recheck
    // their timestamps here so edits made while flushing also survive.
    for (const record of Object.values(pending)) {
      clearReviewDraftThroughUpdatedAt(
        record.commit_sha,
        record.updated_at,
        normalizedAccountId,
      );
    }
  }
  return {
    imported,
    skipped,
    total: rawRecords.length,
  };
}

function clearAllReviewDrafts(
  accountId?: string,
  opts?: { includeLegacy?: boolean },
): void {
  try {
    const keys: string[] = [];
    const prefixes = [makeDraftStoragePrefix(accountId)];
    if (opts?.includeLegacy) {
      prefixes.push(LEGACY_REVIEW_DRAFT_STORAGE_PREFIX);
    }
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore localStorage failures
  }
}

export async function deleteAllReviewRecords({
  accountId,
}: {
  accountId: string;
}): Promise<{ deleted: number }> {
  const normalizedAccountId = `${accountId ?? ""}`.trim();
  if (!normalizedAccountId) {
    throw new Error("account id is required to delete git reviews");
  }
  const kv = await getReviewBulkStore(normalizedAccountId);
  const reviewKeys = Object.keys(kv.getAll()).filter((key) =>
    key.startsWith("commit:"),
  );
  const choices = await getSharedAccountDkv<AliasChoice>({
    account_id: normalizedAccountId,
    name: REVIEW_ALIAS_CHOICES,
  });
  choices.setMany(
    Object.fromEntries(
      Object.keys(choices.getAll()).map((key) => [key, undefined]),
    ),
  );
  await choices.flush();
  if (reviewKeys.length === 0) {
    clearAllReviewDrafts(normalizedAccountId, { includeLegacy: true });
    return { deleted: 0 };
  }

  const tombstones: Record<string, GitReviewRecordV2 | undefined> = {};
  for (const key of reviewKeys) {
    tombstones[key] = undefined;
  }
  kv.setMany(tombstones);
  await kv.flush();

  clearAllReviewDrafts(normalizedAccountId, { includeLegacy: true });

  return { deleted: reviewKeys.length };
}
