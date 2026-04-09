/** @jest-environment jsdom */

import { exportReviewBundle, importReviewBundle } from "../git-review-store";

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
    getAll: () => Object.fromEntries(store.entries()),
    setMany: (obj: Record<string, any>) => {
      for (const [key, value] of Object.entries(obj)) {
        store.set(key, value);
      }
    },
    save: async () => undefined,
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
});
