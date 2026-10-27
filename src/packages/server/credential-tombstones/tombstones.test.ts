import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GcsTombstoneStore } from "./gcs-store";
import {
  LocalTombstoneStore,
  TOMBSTONE_PREFIX,
  TombstoneIntegrityError,
  TombstoneLog,
  tombstoneName,
  TombstoneUnavailableError,
  type TombstoneContent,
  type TombstoneObjectStore,
} from "./tombstones";

const ID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const OTHER = "11111111-2222-4333-8444-555555555555";
const content: TombstoneContent = {
  v: 1,
  kind: "api-key",
  provider: "anthropic",
  erased_at: "2026-10-27T06:00:00.000Z",
  reason: "owner_removed",
};

describe("tombstoneName", () => {
  it("is stable, case-insensitive and specific to the credential", () => {
    expect(tombstoneName(ID)).toMatch(/^[0-9a-f]{64}$/);
    expect(tombstoneName(ID.toUpperCase())).toBe(tombstoneName(ID));
    expect(tombstoneName(OTHER)).not.toBe(tombstoneName(ID));
  });

  it("does not reveal the credential id", () => {
    expect(tombstoneName(ID)).not.toContain(ID.replace(/-/g, "").slice(0, 8));
  });

  it("rejects anything but a UUID", () => {
    expect(() => tombstoneName("../etc")).toThrow(/invalid/);
    expect(() => tombstoneName("")).toThrow(/invalid/);
  });
});

describe("TombstoneLog with the local store", () => {
  let dir: string;
  let log: TombstoneLog;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tombstones-"));
    log = new TombstoneLog(new LocalTombstoneStore(join(dir, "t")));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("appends, reads back and lists", async () => {
    expect(await log.isTombstoned(ID)).toBe(false);
    await log.append(ID, content);
    expect(await log.isTombstoned(ID)).toBe(true);
    expect(await log.isTombstoned(OTHER)).toBe(false);
    const listing = await log.listAll(1234);
    expect([...listing.names]).toEqual([tombstoneName(ID)]);
    expect(listing.listedAt).toBe(1234);
  });

  it("is idempotent and never overwrites an existing tombstone", async () => {
    await log.append(ID, content);
    await log.append(ID, { ...content, reason: "admin" });
    const files = await readdir(join(dir, "t"));
    expect(files).toEqual([tombstoneName(ID)]);
    const store = new LocalTombstoneStore(join(dir, "t"));
    const body = JSON.parse((await store.get(tombstoneName(ID)))!.toString());
    expect(body.reason).toBe("owner_removed");
  });

  it("counts any object at the name as erased, even unreadable content", async () => {
    await writeFile(join(dir, "t-garbage"), "");
    const store = new LocalTombstoneStore(join(dir, "t"));
    await store.create(tombstoneName(OTHER), Buffer.from("not json"));
    expect(await log.isTombstoned(OTHER)).toBe(true);
  });

  it("treats a listing with foreign names as an integrity failure", async () => {
    await log.append(ID, content);
    await writeFile(join(dir, "t", "not-a-tombstone"), "x");
    await expect(log.listAll()).rejects.toBeInstanceOf(TombstoneIntegrityError);
  });

  it("lists nothing before the first tombstone", async () => {
    expect((await log.listAll()).names.size).toBe(0);
  });
});

describe("TombstoneLog failure modes", () => {
  const failing = (over: Partial<TombstoneObjectStore>): TombstoneLog =>
    new TombstoneLog({
      create: async () => "created",
      get: async () => Buffer.from("x"),
      list: async () => [],
      ...over,
    });

  it("reports an unreachable store as unavailable, not as 'not erased'", async () => {
    const log = failing({
      get: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(log.isTombstoned(ID)).rejects.toBeInstanceOf(
      TombstoneUnavailableError,
    );
  });

  it("fails an append that can't be read back", async () => {
    const log = failing({ get: async () => undefined });
    await expect(log.append(ID, content)).rejects.toBeInstanceOf(
      TombstoneUnavailableError,
    );
  });

  it("separates outages from integrity failures when listing", async () => {
    await expect(
      failing({
        list: async () => {
          throw new Error("503");
        },
      }).listAll(),
    ).rejects.toBeInstanceOf(TombstoneUnavailableError);
    await expect(
      failing({
        list: async () => {
          throw new TombstoneIntegrityError();
        },
      }).listAll(),
    ).rejects.toBeInstanceOf(TombstoneIntegrityError);
    const n = tombstoneName(ID);
    await expect(
      failing({ list: async () => [n, n] }).listAll(),
    ).rejects.toBeInstanceOf(TombstoneIntegrityError);
  });
});

describe("GcsTombstoneStore", () => {
  type Call = { url: string; init: RequestInit };
  const fake = (responses: Array<{ status?: number; body?: unknown }>) => {
    const calls: Call[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      const text =
        next.body === undefined
          ? ""
          : typeof next.body === "string"
            ? next.body
            : JSON.stringify(next.body);
      return new Response(text, { status: next.status ?? 200 });
    }) as unknown as typeof globalThis.fetch;
    return {
      calls,
      store: new GcsTombstoneStore({
        bucket: "cocalc-credential-tombstones-test",
        getAccessToken: async () => "token",
        fetch,
      }),
    };
  };
  const name = tombstoneName(ID);

  it("creates only if absent", async () => {
    const { store, calls } = fake([{ status: 200, body: {} }, { status: 412 }]);
    expect(await store.create(name, Buffer.from("{}"))).toBe("created");
    expect(await store.create(name, Buffer.from("{}"))).toBe("exists");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(
      "/upload/storage/v1/b/cocalc-credential-tombstones-test/o",
    );
    expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
    expect(url.searchParams.get("name")).toBe(`${TOMBSTONE_PREFIX}${name}`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
  });

  it("gets an object, or nothing on 404, and throws on other errors", async () => {
    const { store, calls } = fake([
      { body: "{}" },
      { status: 404 },
      { status: 503 },
    ]);
    expect((await store.get(name))?.toString()).toBe("{}");
    expect(await store.get(name)).toBeUndefined();
    await expect(store.get(name)).rejects.toThrow(/503/);
    expect(calls[0].url).toContain(
      encodeURIComponent(`${TOMBSTONE_PREFIX}${name}`),
    );
  });

  it("lists every page", async () => {
    const other = tombstoneName(OTHER);
    const { store, calls } = fake([
      {
        body: {
          items: [{ name: `${TOMBSTONE_PREFIX}${name}` }],
          nextPageToken: "p2",
        },
      },
      { body: { items: [{ name: `${TOMBSTONE_PREFIX}${other}` }] } },
    ]);
    expect(await store.list()).toEqual([name, other]);
    expect(new URL(calls[1].url).searchParams.get("pageToken")).toBe("p2");
  });

  it("treats an empty bucket as an empty listing", async () => {
    const { store } = fake([{ body: {} }]);
    expect(await store.list()).toEqual([]);
  });

  it("fails a malformed listing as an integrity error", async () => {
    for (const body of [
      "not json",
      { items: "x" },
      { items: [{ name: "elsewhere/x" }] },
      { items: [], nextPageToken: 7 },
    ]) {
      const { store } = fake([{ body }]);
      await expect(store.list()).rejects.toBeInstanceOf(
        TombstoneIntegrityError,
      );
    }
  });

  it("refuses invalid names and buckets", async () => {
    const { store } = fake([]);
    await expect(store.get("../x")).rejects.toThrow(/invalid/);
    expect(
      () =>
        new GcsTombstoneStore({
          bucket: "Bad/Bucket",
          getAccessToken: async () => "t",
        }),
    ).toThrow(/invalid/);
  });
});
