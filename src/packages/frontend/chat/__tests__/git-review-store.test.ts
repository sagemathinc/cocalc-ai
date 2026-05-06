/** @jest-environment jsdom */

import {
  loadReviewDraft,
  loadReviewRecord,
  saveReviewDraft,
  saveReviewRecord,
  deleteAllReviewRecords,
  exportReviewBundle,
  importReviewBundle,
} from "../git-review-store";

const stores = new Map<string, Map<string, any>>();

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
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: any) => {
      store.set(key, value);
      return { seq: 1, time: Date.now() };
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
    flush: async () => undefined,
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
    akvMock.mockClear();
    dkvMock.mockClear();
    localStorage.clear();
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

  it("loads current review records from the shared v2 dkv without falling back to legacy akv", async () => {
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
    expect(dkvMock).toHaveBeenCalled();
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
});
