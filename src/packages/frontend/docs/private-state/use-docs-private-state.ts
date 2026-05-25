/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "@cocalc/docs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createDocsNote,
  createDocsPageState,
  docsNoteKey,
  docsPageKey,
  getDocsPrivateStateDkv,
  sanitizeDocsNote,
  snapshotFromDocsPrivateRecords,
} from "./store";
import type {
  DocsPageNoteV1,
  DocsPrivateEntrySummary,
  DocsPrivateStateSnapshot,
} from "./types";

async function flushDkv(dkv: any): Promise<void> {
  if (typeof dkv.flush === "function") {
    await dkv.flush();
  } else if (typeof dkv.save === "function") {
    await dkv.save();
  }
}

function snapshotSummaries(
  snapshot: DocsPrivateStateSnapshot,
): Record<string, DocsPrivateEntrySummary> {
  const summaries: Record<string, DocsPrivateEntrySummary> = {};
  for (const [entryId, page] of Object.entries(snapshot.pages)) {
    summaries[entryId] = {
      starred: Boolean(page.starred),
      noteCount: 0,
      noteText: "",
      lastViewedAt: page.last_viewed_at,
    };
  }
  for (const note of Object.values(snapshot.notes)) {
    if (note.deleted_at != null) continue;
    const summary =
      summaries[note.entry_id] ??
      (summaries[note.entry_id] = {
        starred: false,
        noteCount: 0,
        noteText: "",
      });
    summary.noteCount += 1;
    summary.noteText = `${summary.noteText}\n${note.body_md}`.trim();
  }
  return summaries;
}

export function useDocsPrivateState(accountId?: string) {
  const normalizedAccountId = `${accountId ?? ""}`.trim();
  const [snapshot, setSnapshot] = useState<DocsPrivateStateSnapshot>({
    pages: {},
    notes: {},
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const dkvRef = useRef<any>(null);
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    let mounted = true;
    let dkv: any = null;
    let listener: (() => void) | undefined;
    setSnapshot({ pages: {}, notes: {} });
    setError(undefined);
    dkvRef.current = null;
    if (!normalizedAccountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        dkv = await getDocsPrivateStateDkv(normalizedAccountId);
        if (!mounted) return;
        dkvRef.current = dkv;
        setSnapshot(
          snapshotFromDocsPrivateRecords({
            accountId: normalizedAccountId,
            records: dkv.getAll(),
          }),
        );
        listener = () => {
          if (!mounted || dkvRef.current == null) return;
          setSnapshot(
            snapshotFromDocsPrivateRecords({
              accountId: normalizedAccountId,
              records: dkvRef.current.getAll(),
            }),
          );
        };
        dkv.on?.("change", listener);
      } catch (err) {
        if (mounted) {
          setError(`${err}`);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
      if (listener != null) {
        dkv?.off?.("change", listener);
      }
    };
  }, [normalizedAccountId]);

  const summaries = useMemo(() => snapshotSummaries(snapshot), [snapshot]);

  const updatePage = useCallback(
    async (
      entry: DocsEntry,
      patch: Parameters<typeof createDocsPageState>[0]["patch"],
    ) => {
      if (!normalizedAccountId || dkvRef.current == null) return;
      const next = createDocsPageState({
        accountId: normalizedAccountId,
        entry,
        page: snapshotRef.current.pages[entry.id],
        patch,
      });
      setSnapshot((current) => ({
        ...current,
        pages: { ...current.pages, [entry.id]: next },
      }));
      dkvRef.current.set(docsPageKey(entry.id), next);
      await flushDkv(dkvRef.current);
    },
    [normalizedAccountId],
  );

  const toggleStar = useCallback(
    async (entry: DocsEntry) => {
      const current = Boolean(snapshotRef.current.pages[entry.id]?.starred);
      await updatePage(entry, { starred: !current });
    },
    [updatePage],
  );

  const markViewed = useCallback(
    async (entry: DocsEntry) => {
      await updatePage(entry, { last_viewed_at: Date.now() });
    },
    [updatePage],
  );

  const saveNote = useCallback(
    async (entry: DocsEntry, body: string, note?: DocsPageNoteV1) => {
      if (!normalizedAccountId || dkvRef.current == null) return;
      const next = createDocsNote({
        accountId: normalizedAccountId,
        entry,
        body,
        note,
      });
      setSnapshot((current) => ({
        ...current,
        notes: {
          ...current.notes,
          [docsNoteKey(next.entry_id, next.note_id)]: next,
        },
      }));
      dkvRef.current.set(docsNoteKey(next.entry_id, next.note_id), next);
      await flushDkv(dkvRef.current);
    },
    [normalizedAccountId],
  );

  const deleteNote = useCallback(
    async (note: DocsPageNoteV1) => {
      if (!normalizedAccountId || dkvRef.current == null) return;
      const current = sanitizeDocsNote(note, {
        accountId: normalizedAccountId,
        entryId: note.entry_id,
        slug: note.slug,
      });
      if (current == null) return;
      const deleted: DocsPageNoteV1 = {
        ...current,
        deleted_at: Date.now(),
        updated_at: Date.now(),
        revision: current.revision + 1,
      };
      setSnapshot((snapshot) => ({
        ...snapshot,
        notes: {
          ...snapshot.notes,
          [docsNoteKey(deleted.entry_id, deleted.note_id)]: deleted,
        },
      }));
      dkvRef.current.set(
        docsNoteKey(deleted.entry_id, deleted.note_id),
        deleted,
      );
      await flushDkv(dkvRef.current);
    },
    [normalizedAccountId],
  );

  const notesForEntry = useCallback(
    (entryId: string) =>
      Object.values(snapshot.notes)
        .filter((note) => note.entry_id === entryId && note.deleted_at == null)
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)),
    [snapshot.notes],
  );

  return {
    accountId: normalizedAccountId || undefined,
    deleteNote,
    error,
    loading,
    markViewed,
    notesForEntry,
    saveNote,
    snapshot,
    summaries,
    toggleStar,
  };
}
