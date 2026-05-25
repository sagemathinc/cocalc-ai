import { listDocsEntries } from "@cocalc/docs";

import {
  docsNoteBodyHash,
  docsNoteKey,
  exportDocsPrivateStateFromSnapshot,
  mergeDocsPrivateStateImport,
  sanitizeDocsNote,
  sanitizeDocsPageState,
} from "./store";
import {
  DOCS_PRIVATE_STATE_EXPORT_KIND,
  type DocsPrivateStateSnapshot,
} from "./types";

const accountId = "acct-1";
const [entry, otherEntry] = listDocsEntries();

describe("docs private state store", () => {
  it("sanitizes page and note records", () => {
    expect(
      sanitizeDocsPageState({
        account_id: accountId,
        entry_id: entry.id,
        slug: entry.slug,
        starred: true,
        created_at: 10,
        updated_at: 12,
        revision: 2,
      }),
    ).toMatchObject({
      account_id: accountId,
      entry_id: entry.id,
      slug: entry.slug,
      starred: true,
      revision: 2,
    });

    const note = sanitizeDocsNote({
      account_id: accountId,
      note_id: "note-1",
      entry_id: entry.id,
      slug: entry.slug,
      body_md: " hello \r\n",
      created_at: 10,
      updated_at: 12,
      revision: 3,
    });
    expect(note).toMatchObject({
      body_hash: docsNoteBodyHash("hello"),
      body_md: "hello",
      note_id: "note-1",
      revision: 3,
    });
  });

  it("exports sorted pages and non-deleted notes", () => {
    const snapshot: DocsPrivateStateSnapshot = {
      pages: {
        [entry.id]: {
          version: 1,
          account_id: accountId,
          entry_id: entry.id,
          slug: entry.slug,
          starred: true,
          created_at: 1,
          updated_at: 10,
          revision: 1,
        },
        [otherEntry.id]: {
          version: 1,
          account_id: accountId,
          entry_id: otherEntry.id,
          slug: otherEntry.slug,
          starred: false,
          created_at: 1,
          updated_at: 20,
          revision: 1,
        },
      },
      notes: {
        [docsNoteKey(entry.id, "old")]: {
          version: 1,
          account_id: accountId,
          note_id: "old",
          entry_id: entry.id,
          slug: entry.slug,
          body_md: "old",
          body_hash: docsNoteBodyHash("old"),
          created_at: 1,
          updated_at: 10,
          deleted_at: 11,
          revision: 1,
        },
        [docsNoteKey(entry.id, "new")]: {
          version: 1,
          account_id: accountId,
          note_id: "new",
          entry_id: entry.id,
          slug: entry.slug,
          body_md: "new",
          body_hash: docsNoteBodyHash("new"),
          created_at: 1,
          updated_at: 20,
          revision: 1,
        },
      },
    };
    const bundle = exportDocsPrivateStateFromSnapshot({ snapshot });
    expect(bundle.kind).toBe(DOCS_PRIVATE_STATE_EXPORT_KIND);
    expect(bundle.pages.map((page) => page.entry_id)).toEqual([
      otherEntry.id,
      entry.id,
    ]);
    expect(bundle.notes.map((note) => note.note_id)).toEqual(["new"]);
  });

  it("merges imported state and deduplicates notes by body hash", () => {
    const existing: DocsPrivateStateSnapshot = {
      pages: {
        [entry.id]: {
          version: 1,
          account_id: accountId,
          entry_id: entry.id,
          slug: "old/slug",
          starred: false,
          starred_updated_at: 10,
          last_viewed_at: 4,
          created_at: 1,
          updated_at: 10,
          revision: 1,
        },
      },
      notes: {
        [docsNoteKey(entry.id, "local-note")]: {
          version: 1,
          account_id: accountId,
          note_id: "local-note",
          entry_id: entry.id,
          slug: entry.slug,
          body_md: "same body",
          body_hash: docsNoteBodyHash("same body"),
          created_at: 1,
          updated_at: 15,
          revision: 1,
        },
      },
    };
    const { pending, result } = mergeDocsPrivateStateImport({
      accountId,
      existing,
      localEntries: [entry, otherEntry],
      payload: {
        kind: DOCS_PRIVATE_STATE_EXPORT_KIND,
        pages: [
          {
            version: 1,
            account_id: "other",
            entry_id: entry.id,
            slug: "remote/slug",
            starred: true,
            starred_updated_at: 20,
            last_viewed_at: 30,
            created_at: 1,
            updated_at: 20,
            revision: 2,
          },
        ],
        notes: [
          {
            version: 1,
            account_id: "other",
            note_id: "remote-note",
            entry_id: entry.id,
            slug: "remote/slug",
            body_md: "same body",
            body_hash: docsNoteBodyHash("same body"),
            created_at: 1,
            updated_at: 30,
            revision: 1,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      deduplicatedNotes: 1,
      importedNotes: 1,
      importedPages: 1,
    });
    expect(pending[`page:${entry.id}`]).toMatchObject({
      slug: entry.slug,
      starred: true,
      last_viewed_at: 30,
    });
    expect(pending[docsNoteKey(entry.id, "local-note")]).toBeUndefined();
    expect(pending[docsNoteKey(entry.id, "remote-note")]).toMatchObject({
      account_id: accountId,
      slug: entry.slug,
    });
  });
});
