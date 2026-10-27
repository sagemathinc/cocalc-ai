import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GcsTombstoneStore } from "./gcs-store";
import {
  LocalTombstoneStore,
  MAX_TOMBSTONE_BYTES,
  TOMBSTONE_PREFIX,
  tombstoneBody,
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
  kind: "api-key",
  provider: "anthropic",
  erasedAt: new Date("2026-10-27T06:00:00.000Z"),
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

describe("tombstoneBody", () => {
  it("stores exactly the validated fields", () => {
    expect(JSON.parse(tombstoneBody(content).toString())).toEqual({
      v: 1,
      kind: "api-key",
      provider: "anthropic",
      erased_at: "2026-10-27T06:00:00.000Z",
      reason: "owner_removed",
    });
  });

  it("never writes extra fields, even if a caller passes them", () => {
    const leaky = {
      ...content,
      secret: "sk-ant-SHOULD-NEVER-BE-STORED",
      owner_account_id: OTHER,
    } as any;
    const body = tombstoneBody(leaky).toString();
    expect(body).not.toContain("sk-ant");
    expect(body).not.toContain(OTHER);
    expect(Object.keys(JSON.parse(body)).sort()).toEqual([
      "erased_at",
      "kind",
      "provider",
      "reason",
      "v",
    ]);
  });

  it("rejects invalid or oversized fields", () => {
    for (const bad of [
      { ...content, kind: "x".repeat(65) },
      { ...content, kind: "Has Spaces" },
      { ...content, provider: "" },
      { ...content, provider: "a/b" },
      { ...content, reason: "because" },
      { ...content, erasedAt: new Date("nope") },
      { ...content, erasedAt: "2026-10-27" },
    ] as any[]) {
      expect(() => tombstoneBody(bad)).toThrow(/invalid/);
    }
    expect(tombstoneBody(content).length).toBeLessThan(MAX_TOMBSTONE_BYTES);
  });
});

describe("TombstoneLog with the local store", () => {
  let dir: string;
  let log: TombstoneLog;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tombstones-"));
    log = new TombstoneLog(new LocalTombstoneStore(join(dir, "t")), () => 1234);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("appends, confirms and lists", async () => {
    expect(await log.isTombstoned(ID)).toBe(false);
    await log.append(ID, content);
    expect(await log.isTombstoned(ID)).toBe(true);
    expect(await log.isTombstoned(OTHER)).toBe(false);
    const listing = await log.listAll();
    expect([...listing.names]).toEqual([tombstoneName(ID)]);
    expect(listing.completeThrough).toBe(1234);
  });

  it("never stores a caller's extra fields", async () => {
    await log.append(ID, { ...content, secret: "sk-SECRET" } as any);
    const body = await readFile(join(dir, "t", tombstoneName(ID)), "utf8");
    expect(body).not.toContain("sk-SECRET");
  });

  it("validates before writing anything", async () => {
    await expect(
      log.append(ID, { ...content, reason: "nope" } as any),
    ).rejects.toThrow(/invalid/);
    expect(await log.isTombstoned(ID)).toBe(false);
  });

  it("is idempotent and never overwrites an existing tombstone", async () => {
    await log.append(ID, content);
    await log.append(ID, { ...content, reason: "admin" });
    expect(await readdir(join(dir, "t"))).toEqual([tombstoneName(ID)]);
    const body = JSON.parse(
      await readFile(join(dir, "t", tombstoneName(ID)), "utf8"),
    );
    expect(body.reason).toBe("owner_removed");
  });

  it("counts any object at the name as erased, whatever its content", async () => {
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

describe("TombstoneLog listing cutoff", () => {
  it("is complete only through the time the listing started", async () => {
    // A store that pages in name order and gets a new, earlier-sorting name
    // appended while the listing runs (as GCS can): the late name is missed,
    // and completeThrough is the start time, before that append.
    let clock = 1000;
    const late = tombstoneName(OTHER);
    const store: TombstoneObjectStore = {
      create: async () => "created",
      exists: async () => true,
      list: async () => {
        clock = 2000; // the concurrent append happens at t=2000
        return [tombstoneName(ID)];
      },
    };
    const listing = await new TombstoneLog(store, () => clock).listAll();
    expect(listing.completeThrough).toBe(1000);
    expect(listing.names.has(late)).toBe(false);
  });
});

describe("TombstoneLog failure modes", () => {
  const failing = (over: Partial<TombstoneObjectStore>): TombstoneLog =>
    new TombstoneLog({
      create: async () => "created",
      exists: async () => true,
      list: async () => [],
      ...over,
    });

  it("reports an unreachable store as unavailable, not as 'not erased'", async () => {
    const log = failing({
      exists: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(log.isTombstoned(ID)).rejects.toBeInstanceOf(
      TombstoneUnavailableError,
    );
  });

  it("fails an append that can't be confirmed", async () => {
    const log = failing({ exists: async () => false });
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
  const fake = (
    responses: Array<{ status?: number; body?: unknown }>,
    now?: () => number,
  ) => {
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
        now,
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

  it("checks presence from metadata, never downloading content", async () => {
    const { store, calls } = fake([{ body: { name: "x" } }, { status: 503 }]);
    expect(await store.exists(name)).toBe(true);
    await expect(store.exists(name)).rejects.toThrow(/503/);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("alt")).toBeNull();
    expect(url.pathname).toContain(
      encodeURIComponent(`${TOMBSTONE_PREFIX}${name}`),
    );
  });

  it("treats a 404 as absent only if a listing proves the bucket exists", async () => {
    const { store, calls } = fake([{ status: 404 }, { body: {} }]);
    expect(await store.exists(name)).toBe(false);
    const url = new URL(calls[1].url);
    expect(url.searchParams.get("prefix")).toBe(`${TOMBSTONE_PREFIX}${name}`);
  });

  it("treats a 404 from a missing bucket as an outage, not as 'not erased'", async () => {
    const { store } = fake([{ status: 404 }, { status: 404 }]);
    await expect(store.exists(name)).rejects.toThrow(/list failed \(404\)/);
    const log = new TombstoneLog(
      fake([{ status: 404 }, { status: 404 }]).store,
    );
    await expect(log.isTombstoned(ID)).rejects.toBeInstanceOf(
      TombstoneUnavailableError,
    );
  });

  it("counts an object that appears between the two calls as present", async () => {
    const { store } = fake([
      { status: 404 },
      { body: { items: [{ name: `${TOMBSTONE_PREFIX}${name}` }] } },
    ]);
    expect(await store.exists(name)).toBe(true);
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
      "null",
      "[]",
      "7",
      { items: null },
      { items: "x" },
      { items: [{ name: "elsewhere/x" }] },
      { items: [], nextPageToken: 7 },
      { items: [], nextPageToken: "" },
      // an explicit null is malformed; only an absent token ends a listing
      { items: [], nextPageToken: null },
    ]) {
      const { store } = fake([{ body }]);
      await expect(store.list()).rejects.toBeInstanceOf(
        TombstoneIntegrityError,
      );
    }
  });

  it("fails immediately when a page token repeats", async () => {
    const { store, calls } = fake([
      { body: { items: [], nextPageToken: "same" } },
      { body: { items: [], nextPageToken: "same" } },
      { body: { items: [], nextPageToken: "same" } },
    ]);
    await expect(store.list()).rejects.toBeInstanceOf(TombstoneIntegrityError);
    expect(calls.length).toBe(2);
  });

  it("bounds the whole listing with one deadline", async () => {
    let clock = 0;
    let token = 0;
    const calls: string[] = [];
    const fetch = (async (url: string) => {
      calls.push(url);
      clock += 60_000; // each page takes a minute
      return new Response(
        JSON.stringify({ items: [], nextPageToken: `t${token++}` }),
      );
    }) as unknown as typeof globalThis.fetch;
    const store = new GcsTombstoneStore({
      bucket: "cocalc-credential-tombstones-test",
      getAccessToken: async () => "token",
      fetch,
      now: () => clock,
    });
    await expect(store.list()).rejects.toThrow(/deadline/);
    expect(calls.length).toBeLessThanOrEqual(5);
    // TombstoneLog reports a deadline as an outage
    await expect(new TombstoneLog(store).listAll()).rejects.toBeInstanceOf(
      TombstoneUnavailableError,
    );
  });

  it("refuses invalid names and buckets", async () => {
    const { store } = fake([]);
    await expect(store.exists("../x")).rejects.toThrow(/invalid/);
    expect(
      () =>
        new GcsTombstoneStore({
          bucket: "Bad/Bucket",
          getAccessToken: async () => "t",
        }),
    ).toThrow(/invalid/);
  });
});
