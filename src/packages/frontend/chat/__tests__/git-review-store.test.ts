/** @jest-environment jsdom */

import {
  loadReviewDraft,
  loadReviewRecord,
  loadReviewRecords,
  saveReviewDraft,
  saveReviewRecord,
  deleteAllReviewRecords,
  exportReviewBundle,
  importReviewBundle,
  resolveReviewStorageCommit,
  chooseReviewAlias,
  GitReviewAliasConflict,
  mergeRecordWithDraft,
} from "../git-review-store";
import { resolveGitReviewSaveState } from "../git-commit/review-state";

const stores = new Map<string, Map<string, any>>();
const sequences = new WeakMap<Map<string, any>, Map<string, number>>();
const flushMock = jest.fn(async () => undefined);
let writeFailure: "before" | "after" | undefined;

function getStore(accountId: string, name: string): Map<string, any> {
  const key = `${accountId}:${name}`;
  let store = stores.get(key);
  if (!store) {
    store = new Map<string, any>();
    stores.set(key, store);
  }
  return store;
}

const akvMock = jest.fn(({ account_id, name }: any) => {
  const store = getStore(account_id, name);
  let seqs = sequences.get(store);
  if (!seqs) {
    seqs = new Map();
    sequences.set(store, seqs);
  }
  return {
    get: async (key: string) => store.get(key),
    getMessage: async (key: string) =>
      store.has(key)
        ? { data: store.get(key), headers: { seq: seqs.get(key) ?? 1 } }
        : undefined,
    set: async (
      key: string,
      value: any,
      options?: { previousSeq?: number },
    ) => {
      if (writeFailure === "before")
        throw Error("connection lost before write");
      const previous = store.has(key) ? (seqs.get(key) ?? 1) : 0;
      if (
        options?.previousSeq !== undefined &&
        options.previousSeq !== previous
      )
        throw Error("sequence mismatch");
      store.set(key, value);
      seqs.set(key, previous + 1);
      if (writeFailure === "after")
        throw Error("connection lost before acknowledgement");
      return { seq: previous + 1, time: Date.now() };
    },
    keys: async () => [...store.keys()],
  };
});

const dkvMock = jest.fn(async ({ account_id, name }: any) => {
  const store = getStore(account_id, name);
  return {
    get: (key: string) => store.get(key),
    getAll: () => Object.fromEntries(store.entries()),
    set: (key: string, value: any) => {
      store.set(key, value);
    },
    setMany: (obj: Record<string, any>) => {
      for (const [key, value] of Object.entries(obj)) {
        if (value === undefined) {
          store.delete(key);
        } else {
          store.set(key, value);
        }
      }
    },
    save: async () => undefined,
    flush: flushMock,
  };
});

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      dkv: (opts: any) => dkvMock(opts),
      conat: () => ({
        sync: {
          akv: (opts: any) => akvMock(opts),
        },
      }),
    },
  },
}));

describe("git review import/export", () => {
  beforeEach(() => {
    const {
      resetSharedAccountDkvCacheForTests,
    } = require("@cocalc/frontend/conat/account-dkv");
    resetSharedAccountDkvCacheForTests?.();
    stores.clear();
    writeFailure = undefined;
    akvMock.mockClear();
    dkvMock.mockClear();
    flushMock.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
  });

  async function conflictingAliases() {
    const full = "e".repeat(40);
    const accountId = "alias-choice";
    for (const commit_sha of [full, full.slice(0, 7)]) {
      await saveReviewRecord({
        version: 2,
        account_id: accountId,
        commit_sha,
        reviewed: false,
        note: commit_sha,
        comments: {},
        created_at: 1,
        updated_at: 1,
        revision: 1,
      });
    }
    const options = {
      accountId,
      commitSha: full,
      resolveCommit: async () => full,
    };
    let conflict: GitReviewAliasConflict | undefined;
    try {
      await resolveReviewStorageCommit(options);
    } catch (err) {
      if (err instanceof GitReviewAliasConflict) conflict = err;
      else throw err;
    }
    expect(conflict).toBeInstanceOf(GitReviewAliasConflict);
    return { options, conflict: conflict!, full };
  }

  it("rejects stale window saves without clearing their draft or overwriting remote data", async () => {
    const options = {
      accountId: "concurrent",
      commitSha: "a".repeat(40),
      resolveCommit: async () => "a".repeat(40),
    };
    const first = (await loadReviewRecord(options))!;
    const second = (await loadReviewRecord(options))!;
    const saved = await saveReviewRecord({ ...first, note: "first window" });
    saveReviewDraft(
      options.commitSha,
      { reviewed: false, note: "second window", comments: {} },
      options.accountId,
    );
    await expect(
      saveReviewRecord({ ...second, note: "second window" }),
    ).rejects.toThrow("another window");
    expect(loadReviewDraft(options.commitSha, options.accountId)?.note).toBe(
      "second window",
    );
    const bundle = await exportReviewBundle({ accountId: options.accountId });
    expect(bundle.records[0].note).toBe("first window");
    expect(bundle.records[0].storageSequence).toBeUndefined();
    await saveReviewRecord({ ...saved, note: "first window again" });
  });

  it.each(["before", "after"] as const)(
    "recovers a disconnected write failing %s storage without losing or duplicating comments",
    async (failure) => {
      const options = {
        accountId: `disconnected-${failure}`,
        commitSha: "b".repeat(40),
        resolveCommit: async () => "b".repeat(40),
      };
      const base = (await loadReviewRecord(options))!;
      const comment = {
        id: "local",
        file_path: "a.ts",
        side: "new" as const,
        line: 1,
        body_md: "Keep this comment ![image](/blobs/test.png)",
        status: "draft" as const,
        created_at: 1,
        updated_at: 1,
      };
      saveReviewDraft(
        options.commitSha,
        { reviewed: false, note: "", comments: { local: comment } },
        options.accountId,
      );
      const draft = loadReviewDraft(options.commitSha, options.accountId)!;
      const payload = { ...base, comments: draft.comments };
      writeFailure = failure;
      await expect(saveReviewRecord(payload)).rejects.toThrow(
        "connection lost",
      );
      expect(loadReviewDraft(options.commitSha, options.accountId)).toEqual(
        draft,
      );
      writeFailure = undefined;
      if (failure === "after") {
        // Retrying the old sequence must not overwrite an acknowledged-by-storage write.
        await expect(saveReviewRecord(payload)).rejects.toThrow(
          "another window",
        );
        expect(loadReviewDraft(options.commitSha, options.accountId)).toEqual(
          draft,
        );
      }
      const recovered = (await loadReviewRecord(options))!;
      expect(recovered.comments).toEqual(draft.comments);
      await saveReviewRecord(recovered, {
        clearDraftThroughRevision: draft.revision,
      });
      expect(
        loadReviewDraft(options.commitSha, options.accountId),
      ).toBeUndefined();
      expect((await loadReviewRecord(options))!.comments).toEqual(
        draft.comments,
      );
    },
  );

  it("preserves independent remote comments when recovering and resaving a stale draft", async () => {
    const options = {
      accountId: "inline-recovery",
      commitSha: "c".repeat(40),
      resolveCommit: async () => "c".repeat(40),
    };
    const comment = (id: string) => ({
      id,
      file_path: "a.ts",
      side: "new" as const,
      line: 1,
      body_md: id,
      status: "draft" as const,
      created_at: 1,
      updated_at: 1,
    });
    const base = (await loadReviewRecord(options))!;
    await saveReviewRecord({
      ...base,
      comments: { remote: comment("remote") },
    });
    saveReviewDraft(
      options.commitSha,
      { reviewed: false, note: "", comments: { local: comment("local") } },
      options.accountId,
    );
    const recovered = (await loadReviewRecord(options))!;
    expect(Object.keys(recovered.comments).sort()).toEqual(["local", "remote"]);
    const state = resolveGitReviewSaveState({
      draft: loadReviewDraft(options.commitSha, options.accountId),
      reviewed: false,
      reviewNote: "",
      reviewNoteDraft: "",
      reviewComments: recovered.comments,
    });
    expect(Object.keys(state.comments).sort()).toEqual(["local", "remote"]);
    await saveReviewRecord({ ...recovered, ...state });
    expect(
      Object.keys((await loadReviewRecord(options))!.comments).sort(),
    ).toEqual(["local", "remote"]);
  });

  it.each([50, 150])(
    "retains both private notes across recovery, resave and export for draft timestamp %s",
    async (updated_at) => {
      const options = { accountId: "note-recovery", commitSha: "f".repeat(40) };
      const record = {
        version: 2 as const,
        account_id: options.accountId,
        commit_sha: options.commitSha,
        reviewed: false,
        note: "Remote private note",
        comments: {},
        created_at: 1,
        updated_at: 100,
        revision: 1,
      };
      const draft = {
        reviewed: false,
        note: "Local private note ![image](/blobs/note.png)",
        comments: {},
        updated_at,
        revision: 2,
      };
      const recovered = mergeRecordWithDraft(record, draft)!;
      expect(recovered.note_versions).toEqual([record.note, draft.note]);
      expect(recovered.note).toBe(updated_at < 100 ? record.note : draft.note);
      expect(mergeRecordWithDraft(recovered, draft)!.note_versions).toEqual(
        recovered.note_versions,
      );
      await saveReviewRecord(recovered);
      expect((await loadReviewRecord(options))!.note_versions).toEqual(
        recovered.note_versions,
      );
      const bundle = await exportReviewBundle({ accountId: options.accountId });
      expect(bundle.records[0].note_versions).toEqual(recovered.note_versions);
      await importReviewBundle({ accountId: "note-import", payload: bundle });
      expect(
        (await loadReviewRecord({ ...options, accountId: "note-import" }))!
          .note_versions,
      ).toEqual(recovered.note_versions);
      expect(recovered.comments).toEqual({});
      const cleared = mergeRecordWithDraft(recovered, { ...draft, note: "" })!;
      expect(cleared.note_versions).toEqual([record.note, draft.note, ""]);
      expect(
        mergeRecordWithDraft(cleared, { ...draft, note: "" })!.note_versions,
      ).toEqual(cleared.note_versions);
    },
  );

  it.each([50, 150])(
    "retains both same-ID bodies from a draft timestamp %s",
    async (updated_at) => {
      const options = {
        accountId: "conflict-recovery",
        commitSha: "d".repeat(40),
        resolveCommit: async () => "d".repeat(40),
      };
      const base = (await loadReviewRecord(options))!;
      const comment = {
        id: "shared",
        file_path: "a.ts",
        side: "new" as const,
        body_md: "remote",
        status: "draft" as const,
        created_at: 1,
        updated_at: 100,
        local_revision: 1,
      };
      const record = {
        ...base,
        updated_at: 100,
        comments: { shared: comment },
      };
      const draft = {
        reviewed: false,
        note: "",
        updated_at,
        revision: 2,
        comments: {
          shared: { ...comment, body_md: "local" },
          unique: { ...comment, id: "unique", body_md: "independent" },
        },
      };
      const recovered = mergeRecordWithDraft(record, draft)!;
      expect(recovered.comments.shared).toEqual(comment);
      expect(
        Object.values(recovered.comments)
          .map((c) => c.body_md)
          .sort(),
      ).toEqual(["independent", "local", "remote"]);
      const alternative = Object.values(recovered.comments).find(
        (c) => c.body_md === "local",
      )!;
      expect(alternative.status).toBe("conflict");
      expect(alternative.id).not.toBe("shared");
      const collision = mergeRecordWithDraft(
        {
          ...record,
          comments: {
            ...record.comments,
            [alternative.id]: { ...alternative, body_md: "other recovery" },
          },
        },
        draft,
      )!;
      expect(
        Object.values(collision.comments)
          .map((c) => c.body_md)
          .sort(),
      ).toEqual(["independent", "local", "other recovery", "remote"]);
      expect(mergeRecordWithDraft(recovered, draft)!.comments).toEqual(
        recovered.comments,
      );
      await saveReviewRecord(recovered);
      expect((await loadReviewRecord(options))!.comments).toEqual(
        recovered.comments,
      );
    },
  );

  it("retains a deleted key's sequence when recreating a review", async () => {
    const options = { accountId: "deleted", commitSha: "b".repeat(40) };
    const kv = akvMock({
      account_id: options.accountId,
      name: "cocalc-git-review-v2",
    });
    await kv.set(`commit:${options.commitSha}`, null);
    const record = (await loadReviewRecord(options))!;
    expect(record.storageSequence).toBe(1);
    const saved = await saveReviewRecord({ ...record, note: "recreated" });
    expect(saved.storageSequence).toBe(2);
    expect(
      (await kv.get(`commit:${options.commitSha}`)).storageSequence,
    ).toBeUndefined();
  });

  it("explicitly chooses an alias without changing records and reopens conflicts on other edits", async () => {
    const { options, conflict, full } = await conflictingAliases();
    const before = (await exportReviewBundle(options)).records;
    const selected = full.slice(0, 7);
    await chooseReviewAlias({ ...options, conflict, selected });
    expect(await resolveReviewStorageCommit(options)).toBe(selected);
    expect((await exportReviewBundle(options)).records).toEqual(before);
    const record = (await loadReviewRecord(options))!;
    await saveReviewRecord(
      { ...record, note: "continued" },
      { resolveCommit: options.resolveCommit },
    );
    expect(await resolveReviewStorageCommit(options)).toBe(selected);
    const store = getStore(options.accountId, "cocalc-git-review-v2");
    store.set(`commit:${full}`, {
      ...store.get(`commit:${full}`),
      note: "other writer",
    });
    await expect(resolveReviewStorageCommit(options)).rejects.toBeInstanceOf(
      GitReviewAliasConflict,
    );
  });

  it("rejects stale choices and clears choice metadata when reviews are deleted", async () => {
    const { options, conflict, full } = await conflictingAliases();
    saveReviewDraft(
      full,
      { note: "new draft", reviewed: false },
      options.accountId,
    );
    await expect(
      chooseReviewAlias({ ...options, conflict, selected: full }),
    ).rejects.toThrow("changed while choosing");
    expect(
      getStore(options.accountId, "cocalc-git-review-alias-choices-v1").size,
    ).toBe(0);
    let updated: GitReviewAliasConflict | undefined;
    try {
      await resolveReviewStorageCommit(options);
    } catch (err) {
      updated = err as GitReviewAliasConflict;
    }
    await chooseReviewAlias({ ...options, conflict: updated!, selected: full });
    expect(loadReviewDraft(full, options.accountId)?.note).toBe("new draft");
    await deleteAllReviewRecords(options);
    expect(
      getStore(options.accountId, "cocalc-git-review-alias-choices-v1").size,
    ).toBe(0);
  });

  it("resolves new abbreviated reviews to full IDs before saving", async () => {
    const full = "a".repeat(64);
    const resolveCommit = jest.fn(async () => full);
    const record = await loadReviewRecord({
      accountId: "canonical",
      commitSha: "aaaaaaa",
      resolveCommit,
    });
    expect(record?.commit_sha).toBe(full);
    await saveReviewRecord(
      { ...record!, note: "new review" },
      { resolveCommit },
    );
    expect([...getStore("canonical", "cocalc-git-review-v2").keys()]).toEqual([
      `commit:${full}`,
    ]);
  });

  it("loads and edits an existing alias without creating or deleting a competing key", async () => {
    const full = "b".repeat(40);
    const resolveCommit = async () => full;
    const alias = "bbbbbbb";
    await saveReviewRecord({
      version: 2,
      account_id: "alias",
      commit_sha: alias,
      reviewed: false,
      note: "legacy",
      comments: {},
      created_at: 1,
      updated_at: 1,
      revision: 1,
    });
    const record = await loadReviewRecord({
      accountId: "alias",
      commitSha: full,
      resolveCommit,
    });
    expect(record?.commit_sha).toBe(alias);
    saveReviewDraft(
      record!.commit_sha,
      { reviewed: false, note: "edited" },
      "alias",
    );
    await saveReviewRecord(
      { ...record!, commit_sha: full, note: "edited" },
      { resolveCommit },
    );
    expect([...getStore("alias", "cocalc-git-review-v2").keys()]).toEqual([
      `commit:${alias}`,
    ]);
    expect(loadReviewDraft(alias, "alias")).toBeUndefined();
    expect(
      (
        await loadReviewRecord({
          accountId: "alias",
          commitSha: full,
          resolveCommit,
        })
      )?.note,
    ).toBe("edited");
  });

  it("rejects conflicting full/short records while preserving both in exports", async () => {
    const full = "c".repeat(40);
    for (const commit of [full, full.slice(0, 7)]) {
      await saveReviewRecord({
        version: 2,
        account_id: "conflict",
        commit_sha: commit,
        reviewed: false,
        note: commit,
        comments: {},
        created_at: 1,
        updated_at: 1,
        revision: 1,
      });
    }
    const before = await exportReviewBundle({ accountId: "conflict" });
    await expect(
      loadReviewRecord({
        accountId: "conflict",
        commitSha: full,
        resolveCommit: async () => full,
      }),
    ).rejects.toThrow("Conflicting review keys");
    await expect(
      saveReviewRecord(before.records[0], { resolveCommit: async () => full }),
    ).rejects.toThrow("Conflicting review keys");
    expect(
      (await exportReviewBundle({ accountId: "conflict" })).records,
    ).toEqual(before.records);
  });

  it("requires Git to disambiguate legacy prefixes, not just a string prefix match", async () => {
    const full = "d".repeat(40);
    saveReviewDraft("ddddddd", { reviewed: false, note: "keep" }, "ambiguous");
    await expect(
      resolveReviewStorageCommit({
        accountId: "ambiguous",
        commitSha: full,
        resolveCommit: async (input) => {
          if (input.length < 40) throw Error("ambiguous revision");
          return full;
        },
      }),
    ).rejects.toThrow("ambiguous revision");
    expect(loadReviewDraft("ddddddd", "ambiguous")?.note).toBe("keep");
  });

  it("round-trips SHA-256 reviews and literal filename whitespace without losing submission metadata", async () => {
    const commit = "a".repeat(64);
    const comment = {
      id: "literal-path",
      file_path: " directory/file.md ",
      side: "old" as const,
      line: 2,
      body_md: "![image](/blobs/example.png)",
      status: "submitted" as const,
      submission_turn_id: "turn-1",
      submitted_at: 12,
      created_at: 10,
      updated_at: 12,
      local_revision: 3,
    };
    saveReviewDraft(
      commit,
      { reviewed: false, note: "draft", comments: { [comment.id]: comment } },
      "acct-sha256",
    );
    expect(
      loadReviewDraft(commit, "acct-sha256")?.comments[comment.id],
    ).toEqual(comment);
    await saveReviewRecord({
      version: 2,
      account_id: "acct-sha256",
      commit_sha: commit,
      reviewed: true,
      note: "review",
      comments: { [comment.id]: comment },
      created_at: 10,
      updated_at: 12,
      revision: 3,
    });
    const bundle = await exportReviewBundle({ accountId: "acct-sha256" });
    expect(bundle.records[0].commit_sha).toBe(commit);
    expect(bundle.records[0].comments[comment.id]).toEqual(comment);
    await importReviewBundle({ accountId: "acct-copy", payload: bundle });
    expect(
      (await loadReviewRecord({ accountId: "acct-copy", commitSha: commit }))
        ?.comments[comment.id],
    ).toEqual(comment);
    expect(
      getStore("acct-copy", "cocalc-git-review-v2").has(`commit:${commit}`),
    ).toBe(true);
  });

  it("exports persisted git review records from the account review store", async () => {
    const store = getStore("acct-1", "cocalc-git-review-v2");
    store.set("commit:bbb2222", {
      version: 2,
      account_id: "acct-1",
      commit_sha: "bbb2222",
      reviewed: true,
      note: "later",
      comments: {},
      created_at: 20,
      updated_at: 200,
      revision: 2,
    });
    store.set("commit:aaa1111", {
      version: 2,
      account_id: "acct-1",
      commit_sha: "aaa1111",
      reviewed: false,
      note: "earlier",
      comments: {},
      created_at: 10,
      updated_at: 100,
      revision: 1,
    });
    store.set("misc:key", { ignore: true });

    const exported = await exportReviewBundle({ accountId: "acct-1" });

    expect(exported.kind).toBe("cocalc-git-review-export-v1");
    expect(exported.version).toBe(1);
    expect(exported.records.map((record) => record.commit_sha)).toEqual([
      "bbb2222",
      "aaa1111",
    ]);
  });

  it("loads current review records from the v2 akv store without falling back to legacy reviews", async () => {
    const store = getStore("acct-1", "cocalc-git-review-v2");
    store.set("commit:abc1234", {
      version: 2,
      account_id: "acct-1",
      commit_sha: "abc1234",
      reviewed: true,
      note: "persisted v2 review",
      comments: {},
      created_at: 10,
      updated_at: 100,
      revision: 2,
    });

    await expect(
      loadReviewRecord({
        accountId: "acct-1",
        commitSha: "abc1234",
      }),
    ).resolves.toMatchObject({
      account_id: "acct-1",
      commit_sha: "abc1234",
      reviewed: true,
      note: "persisted v2 review",
    });
    expect(akvMock).toHaveBeenCalled();
  });

  it("bulk loads review records from one dkv snapshot", async () => {
    const store = getStore("acct-1", "cocalc-git-review-v2");
    store.set("commit:abc1234", {
      version: 2,
      account_id: "acct-1",
      commit_sha: "abc1234",
      reviewed: true,
      note: "persisted review",
      comments: {},
      created_at: 10,
      updated_at: 100,
      revision: 2,
    });

    saveReviewDraft(
      "def5678",
      {
        reviewed: true,
        note: "draft-only review",
        comments: {},
      },
      "acct-1",
    );

    const records = await loadReviewRecords({
      accountId: "acct-1",
      commitShas: ["abc1234", "def5678", "999aaaa", "abc1234"],
    });

    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject([
      "abc1234",
      {
        account_id: "acct-1",
        commit_sha: "abc1234",
        reviewed: true,
        note: "persisted review",
      },
    ]);
    expect(records[1]).toMatchObject([
      "def5678",
      {
        account_id: "acct-1",
        commit_sha: "def5678",
        reviewed: true,
        note: "draft-only review",
      },
    ]);
    expect(records[2]).toEqual(["999aaaa", undefined]);
    expect(dkvMock).toHaveBeenCalledTimes(1);
    expect(akvMock).not.toHaveBeenCalled();
  });

  it("imports newer review records and rewrites them to the current account", async () => {
    const store = getStore("acct-2", "cocalc-git-review-v2");
    store.set("commit:aaa1111", {
      version: 2,
      account_id: "acct-2",
      commit_sha: "aaa1111",
      reviewed: true,
      note: "keep newer local copy",
      comments: {},
      created_at: 50,
      updated_at: 500,
      revision: 3,
    });

    const result = await importReviewBundle({
      accountId: "acct-2",
      payload: {
        version: 1,
        records: [
          {
            version: 2,
            account_id: "old-account",
            commit_sha: "aaa1111",
            reviewed: false,
            note: "older import",
            comments: {},
            created_at: 10,
            updated_at: 400,
            revision: 1,
          },
          {
            version: 2,
            account_id: "old-account",
            commit_sha: "bbb2222",
            reviewed: true,
            note: "new import",
            comments: {},
            created_at: 20,
            updated_at: 600,
            revision: 2,
          },
        ],
      },
    });

    expect(result).toEqual({
      imported: 1,
      skipped: 1,
      total: 2,
    });
    expect(store.get("commit:aaa1111").note).toBe("keep newer local copy");
    expect(store.get("commit:bbb2222")).toMatchObject({
      account_id: "acct-2",
      commit_sha: "bbb2222",
      note: "new import",
      reviewed: true,
    });
  });

  it("does not clear a newer local draft when importing an older remote review", async () => {
    saveReviewDraft(
      "bbb2222",
      {
        reviewed: false,
        note: "newer local draft",
        comments: {},
      },
      "acct-5",
    );
    const draftBeforeImport = loadReviewDraft("bbb2222", "acct-5");
    expect(draftBeforeImport?.note).toBe("newer local draft");

    const result = await importReviewBundle({
      accountId: "acct-5",
      payload: {
        version: 1,
        records: [
          {
            version: 2,
            account_id: "old-account",
            commit_sha: "bbb2222",
            reviewed: true,
            note: "older imported review",
            comments: {},
            created_at: 20,
            updated_at: (draftBeforeImport?.updated_at ?? Date.now()) - 1,
            revision: 2,
          },
        ],
      },
    });

    expect(result).toEqual({
      imported: 1,
      skipped: 0,
      total: 1,
    });
    expect(loadReviewDraft("bbb2222", "acct-5")).toMatchObject({
      note: "newer local draft",
      reviewed: false,
      revision: draftBeforeImport?.revision,
    });
  });

  it("retains recovery drafts when an import cannot flush", async () => {
    saveReviewDraft(
      "bbb2222",
      { reviewed: false, note: "recover me", comments: {} },
      "failed-import",
    );
    const before = loadReviewDraft("bbb2222", "failed-import")!;
    flushMock.mockRejectedValueOnce(Error("offline"));
    await expect(
      importReviewBundle({
        accountId: "failed-import",
        payload: [
          {
            version: 2,
            account_id: "source",
            commit_sha: "bbb2222",
            reviewed: true,
            note: "imported",
            comments: {},
            created_at: 1,
            updated_at: before.updated_at + 1,
            revision: 2,
          },
        ],
      }),
    ).rejects.toThrow("offline");
    expect(loadReviewDraft("bbb2222", "failed-import")).toEqual(before);
  });

  it.each([
    [10, 20],
    [20, 10],
  ])("imports only the newest duplicate in order %j", async (first, second) => {
    const result = await importReviewBundle({
      accountId: "duplicates",
      payload: [first, second].map((updated_at) => ({
        version: 2,
        account_id: "source",
        commit_sha: "bbb2222",
        reviewed: false,
        note: String(updated_at),
        comments: {},
        created_at: 1,
        updated_at,
        revision: 1,
      })),
    });
    expect(result).toEqual({ imported: 1, skipped: 1, total: 2 });
    expect(
      getStore("duplicates", "cocalc-git-review-v2").get("commit:bbb2222").note,
    ).toBe("20");
  });

  it("retains drafts edited while import is flushing", async () => {
    saveReviewDraft(
      "bbb2222",
      { reviewed: false, note: "before", comments: {} },
      "inflight-import",
    );
    const updated_at = loadReviewDraft(
      "bbb2222",
      "inflight-import",
    )!.updated_at;
    flushMock.mockImplementationOnce(async () => {
      const now = jest.spyOn(Date, "now").mockReturnValue(updated_at + 10);
      saveReviewDraft(
        "bbb2222",
        { reviewed: false, note: "during flush", comments: {} },
        "inflight-import",
      );
      now.mockRestore();
    });
    await importReviewBundle({
      accountId: "inflight-import",
      payload: [
        {
          version: 2,
          account_id: "source",
          commit_sha: "bbb2222",
          reviewed: true,
          note: "imported",
          comments: {},
          created_at: 1,
          updated_at,
          revision: 2,
        },
      ],
    });
    expect(loadReviewDraft("bbb2222", "inflight-import")?.note).toBe(
      "during flush",
    );
  });

  it("does not merge one account's local draft into another account's review", async () => {
    const accountTwoStore = getStore("acct-7", "cocalc-git-review-v2");
    accountTwoStore.set("commit:ccc3333", {
      version: 2,
      account_id: "acct-7",
      commit_sha: "ccc3333",
      reviewed: false,
      note: "acct-7 persisted note",
      comments: {},
      created_at: 30,
      updated_at: 300,
      revision: 1,
    });

    saveReviewDraft(
      "ccc3333",
      {
        reviewed: true,
        note: "acct-6 private draft",
        comments: {},
      },
      "acct-6",
    );

    await expect(
      loadReviewRecord({
        accountId: "acct-7",
        commitSha: "ccc3333",
      }),
    ).resolves.toMatchObject({
      account_id: "acct-7",
      commit_sha: "ccc3333",
      reviewed: false,
      note: "acct-7 persisted note",
    });
  });

  it("loads draft-only review state when no persisted record exists yet", async () => {
    saveReviewDraft(
      "eee5555",
      {
        reviewed: true,
        note: "draft-only note",
        comments: {},
      },
      "acct-9",
    );

    await expect(
      loadReviewRecord({
        accountId: "acct-9",
        commitSha: "eee5555",
      }),
    ).resolves.toMatchObject({
      account_id: "acct-9",
      commit_sha: "eee5555",
      reviewed: true,
      note: "draft-only note",
    });
  });

  it("returns undefined when no persisted or draft review state exists", async () => {
    await expect(
      loadReviewRecord({
        accountId: "acct-11",
        commitSha: "999aaaa",
      }),
    ).resolves.toBeUndefined();
  });

  it("migrates legacy unscoped drafts into account-scoped storage on load", async () => {
    localStorage.setItem(
      "cocalc:git-review:draft:v2:commit:ddd4444",
      JSON.stringify({
        reviewed: true,
        note: "legacy draft",
        comments: {},
        updated_at: 444,
        revision: 7,
      }),
    );

    await expect(
      loadReviewRecord({
        accountId: "acct-8",
        commitSha: "ddd4444",
      }),
    ).resolves.toMatchObject({
      account_id: "acct-8",
      commit_sha: "ddd4444",
      reviewed: true,
      note: "legacy draft",
    });

    expect(
      localStorage.getItem("cocalc:git-review:draft:v2:commit:ddd4444"),
    ).toBe(null);
    expect(loadReviewDraft("ddd4444", "acct-8")).toMatchObject({
      reviewed: true,
      note: "legacy draft",
      revision: 7,
    });
  });

  it("does not create new legacy drafts when no account id is available", () => {
    saveReviewDraft("fff6666", {
      reviewed: true,
      note: "should not persist",
      comments: {},
    });

    expect(
      localStorage.getItem("cocalc:git-review:draft:v2:commit:fff6666"),
    ).toBe(null);
    expect(loadReviewDraft("fff6666")).toBeUndefined();
  });

  it("deletes all persisted reviews and local drafts for the account", async () => {
    const store = getStore("acct-3", "cocalc-git-review-v2");
    store.set("commit:aaa1111", {
      version: 2,
      account_id: "acct-3",
      commit_sha: "aaa1111",
      reviewed: true,
      note: "one",
      comments: {},
      created_at: 10,
      updated_at: 100,
      revision: 1,
    });
    store.set("commit:bbb2222", {
      version: 2,
      account_id: "acct-3",
      commit_sha: "bbb2222",
      reviewed: false,
      note: "two",
      comments: {},
      created_at: 20,
      updated_at: 200,
      revision: 2,
    });
    store.set("misc:key", { ignore: true });
    saveReviewDraft(
      "aaa1111",
      {
        reviewed: false,
        note: "draft",
        comments: {},
      },
      "acct-3",
    );
    localStorage.setItem(
      "cocalc:git-review:draft:v2:commit:legacy999",
      JSON.stringify({ note: "legacy draft" }),
    );

    await expect(
      deleteAllReviewRecords({ accountId: "acct-3" }),
    ).resolves.toEqual({
      deleted: 2,
    });

    expect(store.get("commit:aaa1111")).toBeUndefined();
    expect(store.get("commit:bbb2222")).toBeUndefined();
    expect(store.get("misc:key")).toEqual({ ignore: true });
    expect(loadReviewDraft("aaa1111", "acct-3")).toBeUndefined();
    expect(
      localStorage.getItem("cocalc:git-review:draft:v2:commit:legacy999"),
    ).toBe(null);
  });

  it("does not clear a newer local draft when an older save finishes", async () => {
    saveReviewDraft(
      "aaa1111",
      {
        reviewed: false,
        note: "older draft",
        comments: {},
      },
      "acct-4",
    );
    const olderDraft = loadReviewDraft("aaa1111", "acct-4");
    expect(olderDraft?.revision).toBe(1);

    saveReviewDraft(
      "aaa1111",
      {
        reviewed: true,
        note: "newer draft",
        comments: {},
      },
      "acct-4",
    );
    expect(loadReviewDraft("aaa1111", "acct-4")?.revision).toBe(2);

    await saveReviewRecord(
      {
        version: 2,
        account_id: "acct-4",
        commit_sha: "aaa1111",
        reviewed: false,
        note: "saved record",
        comments: {},
        created_at: 10,
        updated_at: 10,
        revision: 1,
      },
      {
        clearDraftThroughRevision: olderDraft?.revision,
      },
    );

    expect(loadReviewDraft("aaa1111", "acct-4")).toMatchObject({
      reviewed: true,
      note: "newer draft",
      revision: 2,
    });
  });

  it("saves live review edits through the v2 akv path instead of the shared dkv", async () => {
    await saveReviewRecord({
      version: 2,
      account_id: "acct-10",
      commit_sha: "abc1234",
      reviewed: true,
      note: "reviewed",
      comments: {},
      created_at: 10,
      updated_at: 10,
      revision: 1,
    });

    expect(akvMock).toHaveBeenCalled();
    expect(
      getStore("acct-10", "cocalc-git-review-v2").get("commit:abc1234"),
    ).toMatchObject({
      account_id: "acct-10",
      commit_sha: "abc1234",
      reviewed: true,
      note: "reviewed",
    });
  });
});
