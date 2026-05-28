/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "@cocalc/docs";
import { getSharedAccountDkv } from "@cocalc/frontend/conat/account-dkv";
import { sha1, uuid } from "@cocalc/util/misc";

import {
  DOCS_PRIVATE_STATE_EXPORT_KIND,
  DOCS_PRIVATE_STATE_STORE,
  type DocsPageNoteV1,
  type DocsPageStateV1,
  type DocsPrivateStateExportV1,
  type DocsPrivateStateImportResult,
  type DocsPrivateStateSnapshot,
  type DocsPrivateStoreRecord,
} from "./types";

const PAGE_KEY_PREFIX = "page:";
const NOTE_KEY_PREFIX = "note:";

export function docsPageKey(entryId: string): string {
  return `${PAGE_KEY_PREFIX}${entryId}`;
}

export function docsNoteKey(entryId: string, noteId: string): string {
  return `${NOTE_KEY_PREFIX}${entryId}:${noteId}`;
}

function normalizeId(value: unknown): string {
  return `${value ?? ""}`.trim();
}

export function normalizeDocsNoteText(value: unknown): string {
  return `${value ?? ""}`.replace(/\r\n/g, "\n").trim();
}

export function docsNoteBodyHash(value: unknown): string {
  return sha1(normalizeDocsNoteText(value));
}

function validTimestamp(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function sanitizeDocsPageState(
  input: unknown,
  {
    accountId,
    entryId,
    slug,
  }: {
    accountId?: string;
    entryId?: string;
    slug?: string;
  } = {},
): DocsPageStateV1 | undefined {
  const raw: any = input;
  if (!raw || typeof raw !== "object") return undefined;
  const normalizedAccountId = normalizeId(accountId ?? raw.account_id);
  const normalizedEntryId = normalizeId(entryId ?? raw.entry_id);
  const normalizedSlug = normalizeId(slug ?? raw.slug);
  if (!normalizedAccountId || !normalizedEntryId || !normalizedSlug) {
    return undefined;
  }
  const now = Date.now();
  const createdAt = validTimestamp(raw.created_at, now);
  const updatedAt = validTimestamp(raw.updated_at, createdAt);
  const starredUpdatedAt = Number(raw.starred_updated_at);
  const learnedAt = Number(raw.learned_at);
  const learnedUpdatedAt = Number(raw.learned_updated_at);
  const lastViewedAt = Number(raw.last_viewed_at);
  const revision = Number(raw.revision);
  return {
    version: 1,
    account_id: normalizedAccountId,
    entry_id: normalizedEntryId,
    slug: normalizedSlug,
    starred: Boolean(raw.starred),
    starred_updated_at: Number.isFinite(starredUpdatedAt)
      ? starredUpdatedAt
      : undefined,
    learned_at: Number.isFinite(learnedAt) ? learnedAt : undefined,
    learned_updated_at: Number.isFinite(learnedUpdatedAt)
      ? learnedUpdatedAt
      : undefined,
    last_viewed_at: Number.isFinite(lastViewedAt) ? lastViewedAt : undefined,
    created_at: createdAt,
    updated_at: updatedAt,
    revision: Number.isFinite(revision) ? Math.max(1, revision) : 1,
  };
}

export function sanitizeDocsNote(
  input: unknown,
  {
    accountId,
    entryId,
    slug,
  }: {
    accountId?: string;
    entryId?: string;
    slug?: string;
  } = {},
): DocsPageNoteV1 | undefined {
  const raw: any = input;
  if (!raw || typeof raw !== "object") return undefined;
  const normalizedAccountId = normalizeId(accountId ?? raw.account_id);
  const normalizedEntryId = normalizeId(entryId ?? raw.entry_id);
  const normalizedSlug = normalizeId(slug ?? raw.slug);
  const noteId = normalizeId(raw.note_id);
  const body = normalizeDocsNoteText(raw.body_md);
  if (
    !normalizedAccountId ||
    !normalizedEntryId ||
    !normalizedSlug ||
    !noteId
  ) {
    return undefined;
  }
  const now = Date.now();
  const createdAt = validTimestamp(raw.created_at, now);
  const updatedAt = validTimestamp(raw.updated_at, createdAt);
  const deletedAt = Number(raw.deleted_at);
  const revision = Number(raw.revision);
  return {
    version: 1,
    account_id: normalizedAccountId,
    note_id: noteId,
    entry_id: normalizedEntryId,
    slug: normalizedSlug,
    body_md: body,
    body_hash: normalizeId(raw.body_hash) || docsNoteBodyHash(body),
    created_at: createdAt,
    updated_at: updatedAt,
    deleted_at: Number.isFinite(deletedAt) ? deletedAt : undefined,
    revision: Number.isFinite(revision) ? Math.max(1, revision) : 1,
  };
}

export function emptyDocsPrivateStateSnapshot(): DocsPrivateStateSnapshot {
  return { pages: {}, notes: {} };
}

export function snapshotFromDocsPrivateRecords({
  accountId,
  records,
}: {
  accountId: string;
  records: Record<string, unknown>;
}): DocsPrivateStateSnapshot {
  const snapshot = emptyDocsPrivateStateSnapshot();
  for (const [key, value] of Object.entries(records)) {
    if (key.startsWith(PAGE_KEY_PREFIX)) {
      const entryId = key.slice(PAGE_KEY_PREFIX.length);
      const page = sanitizeDocsPageState(value, { accountId, entryId });
      if (page != null) snapshot.pages[page.entry_id] = page;
      continue;
    }
    if (key.startsWith(NOTE_KEY_PREFIX)) {
      const [, entryId] = key.split(":");
      const note = sanitizeDocsNote(value, { accountId, entryId });
      if (note != null)
        snapshot.notes[docsNoteKey(note.entry_id, note.note_id)] = note;
    }
  }
  return snapshot;
}

export function createDocsPageState({
  accountId,
  entry,
  page,
  patch,
}: {
  accountId: string;
  entry: Pick<DocsEntry, "id" | "slug">;
  page?: DocsPageStateV1;
  patch?: Partial<Pick<DocsPageStateV1, "starred" | "last_viewed_at">> & {
    learned_at?: number | null;
  };
}): DocsPageStateV1 {
  const now = Date.now();
  const starredChanged =
    patch?.starred != null && Boolean(patch.starred) !== Boolean(page?.starred);
  const learnedPatched = patch != null && "learned_at" in patch;
  const learnedAt = learnedPatched
    ? (patch.learned_at ?? undefined)
    : page?.learned_at;
  return {
    version: 1,
    account_id: accountId,
    entry_id: entry.id,
    slug: entry.slug,
    starred: Boolean(patch?.starred ?? page?.starred),
    starred_updated_at: starredChanged
      ? now
      : (page?.starred_updated_at ??
        (patch?.starred != null ? now : undefined)),
    learned_at: learnedAt,
    learned_updated_at: learnedPatched ? now : page?.learned_updated_at,
    last_viewed_at: patch?.last_viewed_at ?? page?.last_viewed_at,
    created_at: page?.created_at ?? now,
    updated_at: now,
    revision: Math.max(1, (page?.revision ?? 0) + 1),
  };
}

export function createDocsNote({
  accountId,
  entry,
  body,
  note,
}: {
  accountId: string;
  entry: Pick<DocsEntry, "id" | "slug">;
  body: string;
  note?: DocsPageNoteV1;
}): DocsPageNoteV1 {
  const now = Date.now();
  const bodyMd = normalizeDocsNoteText(body);
  return {
    version: 1,
    account_id: accountId,
    note_id: note?.note_id ?? uuid(),
    entry_id: entry.id,
    slug: entry.slug,
    body_md: bodyMd,
    body_hash: docsNoteBodyHash(bodyMd),
    created_at: note?.created_at ?? now,
    updated_at: now,
    revision: Math.max(1, (note?.revision ?? 0) + 1),
  };
}

export function exportDocsPrivateStateFromSnapshot({
  snapshot,
}: {
  snapshot: DocsPrivateStateSnapshot;
}): DocsPrivateStateExportV1 {
  const pages = Object.values(snapshot.pages).sort((a, b) => {
    const updated = (b.updated_at ?? 0) - (a.updated_at ?? 0);
    return updated !== 0 ? updated : a.entry_id.localeCompare(b.entry_id);
  });
  const notes = Object.values(snapshot.notes)
    .filter((note) => note.deleted_at == null)
    .sort((a, b) => {
      const updated = (b.updated_at ?? 0) - (a.updated_at ?? 0);
      if (updated !== 0) return updated;
      const entry = a.entry_id.localeCompare(b.entry_id);
      return entry !== 0 ? entry : a.note_id.localeCompare(b.note_id);
    });
  return {
    kind: DOCS_PRIVATE_STATE_EXPORT_KIND,
    version: 1,
    exported_at: Date.now(),
    pages,
    notes,
  };
}

function extractImportPayload(payload: unknown): {
  pages: unknown[];
  notes: unknown[];
} {
  if (
    payload &&
    typeof payload === "object" &&
    (payload as { kind?: unknown }).kind === DOCS_PRIVATE_STATE_EXPORT_KIND
  ) {
    return {
      pages: Array.isArray((payload as { pages?: unknown[] }).pages)
        ? (payload as { pages: unknown[] }).pages
        : [],
      notes: Array.isArray((payload as { notes?: unknown[] }).notes)
        ? (payload as { notes: unknown[] }).notes
        : [],
    };
  }
  throw new Error("invalid docs private state import file");
}

export function mergeDocsPrivateStateImport({
  accountId,
  existing,
  localEntries,
  payload,
}: {
  accountId: string;
  existing: DocsPrivateStateSnapshot;
  localEntries: DocsEntry[];
  payload: unknown;
}): {
  pending: Record<string, DocsPrivateStoreRecord | undefined>;
  result: DocsPrivateStateImportResult;
} {
  const localById = new Map(localEntries.map((entry) => [entry.id, entry]));
  const { pages: rawPages, notes: rawNotes } = extractImportPayload(payload);
  const result: DocsPrivateStateImportResult = {
    importedPages: 0,
    importedNotes: 0,
    skippedPages: 0,
    skippedNotes: 0,
    deduplicatedNotes: 0,
    totalPages: rawPages.length,
    totalNotes: rawNotes.length,
  };
  const pending: Record<string, DocsPrivateStoreRecord | undefined> = {};
  const workingPages = { ...existing.pages };
  const workingNotes = { ...existing.notes };

  for (const rawPage of rawPages) {
    const page = sanitizeDocsPageState(rawPage, { accountId });
    const localEntry = page != null ? localById.get(page.entry_id) : undefined;
    if (page == null || localEntry == null) {
      result.skippedPages += 1;
      continue;
    }
    const existingPage = workingPages[page.entry_id];
    const importedStarredWins =
      (page.starred_updated_at ?? page.updated_at ?? 0) >
      (existingPage?.starred_updated_at ?? existingPage?.updated_at ?? 0);
    const importedLearnedWins =
      (page.learned_updated_at ?? page.updated_at ?? 0) >
      (existingPage?.learned_updated_at ?? existingPage?.updated_at ?? 0);
    const learnedUpdatedAt = Math.max(
      page.learned_updated_at ?? 0,
      existingPage?.learned_updated_at ?? 0,
    );
    const next: DocsPageStateV1 = {
      version: 1,
      account_id: accountId,
      entry_id: page.entry_id,
      slug: localEntry.slug,
      starred: importedStarredWins
        ? page.starred
        : Boolean(existingPage?.starred),
      starred_updated_at: Math.max(
        page.starred_updated_at ?? 0,
        existingPage?.starred_updated_at ?? 0,
      ),
      last_viewed_at: Math.max(
        page.last_viewed_at ?? 0,
        existingPage?.last_viewed_at ?? 0,
      ),
      learned_at: importedLearnedWins
        ? page.learned_at
        : existingPage?.learned_at,
      learned_updated_at: learnedUpdatedAt > 0 ? learnedUpdatedAt : undefined,
      created_at: Math.min(
        page.created_at,
        existingPage?.created_at ?? page.created_at,
      ),
      updated_at: Math.max(page.updated_at ?? 0, existingPage?.updated_at ?? 0),
      revision: Math.max(page.revision ?? 1, existingPage?.revision ?? 1),
    };
    if (
      existingPage != null &&
      existingPage.starred === next.starred &&
      existingPage.starred_updated_at === next.starred_updated_at &&
      existingPage.learned_at === next.learned_at &&
      existingPage.learned_updated_at === next.learned_updated_at &&
      existingPage.last_viewed_at === next.last_viewed_at &&
      existingPage.slug === next.slug
    ) {
      result.skippedPages += 1;
      continue;
    }
    workingPages[next.entry_id] = next;
    pending[docsPageKey(next.entry_id)] = next;
    result.importedPages += 1;
  }

  for (const rawNote of rawNotes) {
    const note = sanitizeDocsNote(rawNote, { accountId });
    const localEntry = note != null ? localById.get(note.entry_id) : undefined;
    if (note == null || localEntry == null || note.deleted_at != null) {
      result.skippedNotes += 1;
      continue;
    }
    const key = docsNoteKey(note.entry_id, note.note_id);
    const existingNote = sanitizeDocsNote(workingNotes[key], {
      accountId,
      entryId: note.entry_id,
      slug: localEntry.slug,
    });
    if (
      existingNote != null &&
      (existingNote.updated_at ?? 0) >= (note.updated_at ?? 0)
    ) {
      result.skippedNotes += 1;
      continue;
    }
    const duplicateKey = Object.entries(workingNotes).find(
      ([otherKey, other]) =>
        otherKey !== key &&
        other.entry_id === note.entry_id &&
        other.deleted_at == null &&
        other.body_hash === note.body_hash,
    )?.[0];
    if (duplicateKey != null) {
      const duplicate = workingNotes[duplicateKey];
      if ((duplicate.updated_at ?? 0) >= (note.updated_at ?? 0)) {
        result.deduplicatedNotes += 1;
        result.skippedNotes += 1;
        continue;
      }
      pending[duplicateKey] = undefined;
      delete workingNotes[duplicateKey];
      result.deduplicatedNotes += 1;
    }
    const next: DocsPageNoteV1 = {
      ...note,
      account_id: accountId,
      slug: localEntry.slug,
      revision: Math.max(note.revision ?? 1, existingNote?.revision ?? 1),
    };
    workingNotes[key] = next;
    pending[key] = next;
    result.importedNotes += 1;
  }

  return { pending, result };
}

export async function getDocsPrivateStateDkv(accountId: string) {
  return await getSharedAccountDkv<DocsPrivateStoreRecord>({
    account_id: accountId,
    name: DOCS_PRIVATE_STATE_STORE,
    maxListeners: 100,
  });
}

async function saveDkv(dkv: any): Promise<void> {
  if (typeof dkv.flush === "function") {
    await dkv.flush();
  } else if (typeof dkv.save === "function") {
    await dkv.save();
  }
}

export async function exportDocsPrivateStateBundle({
  accountId,
}: {
  accountId: string;
}): Promise<DocsPrivateStateExportV1> {
  const dkv = await getDocsPrivateStateDkv(accountId);
  return exportDocsPrivateStateFromSnapshot({
    snapshot: snapshotFromDocsPrivateRecords({
      accountId,
      records: dkv.getAll(),
    }),
  });
}

export async function importDocsPrivateStateBundle({
  accountId,
  localEntries,
  payload,
}: {
  accountId: string;
  localEntries: DocsEntry[];
  payload: unknown;
}): Promise<DocsPrivateStateImportResult> {
  const dkv = await getDocsPrivateStateDkv(accountId);
  const { pending, result } = mergeDocsPrivateStateImport({
    accountId,
    existing: snapshotFromDocsPrivateRecords({
      accountId,
      records: dkv.getAll(),
    }),
    localEntries,
    payload,
  });
  if (Object.keys(pending).length > 0) {
    dkv.setMany(pending);
    await saveDkv(dkv);
  }
  return result;
}
