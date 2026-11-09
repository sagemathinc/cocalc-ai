/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { constants, generateKeyPairSync, privateEncrypt } from "node:crypto";
import {
  FederatedTokenBroker,
  TokenBucketLimiter,
  DEFAULT_RATE_LIMITS,
  type BrokerDeps,
  type MintLogRow,
  type MintRequest,
} from "./broker";
import type { FederationSigner } from "./signer";

// Fake values only. The planted secrets must never leave the token field.
const UUID = (n: number) =>
  `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const ACCESS_TOKEN = "ya29.planted-access-token-PLANTED0123456789";
const FEDERATED_TOKEN = "fed.planted-federated-token-PLANTED987";
const NOW = 1_800_000_000_000;
const KEY_VERSION =
  "projects/example-project-1/locations/us/keyRings/example-ring/cryptoKeys/example-key/cryptoKeyVersions/1";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signer: FederationSigner = {
  keyVersion: KEY_VERSION,
  algorithm: "RS256",
  async signDigest(digest: Buffer) {
    const prefix = Buffer.from("3031300d060960864801650304020105000420", "hex");
    return privateEncrypt(
      { key: keys.privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.concat([prefix, digest]),
    );
  },
  async publicKeyPem() {
    return `${keys.publicKey.export({ type: "spki", format: "pem" })}`;
  },
};

const HOME = { scope: "bay-a", confirmHome: async () => true };

const request = (over: Partial<MintRequest> = {}): MintRequest => ({
  site_id: UUID(1),
  account_id: UUID(2),
  agent_id: UUID(3),
  project_id: UUID(4),
  host_id: UUID(5),
  run_id: UUID(6),
  grant_id: UUID(7),
  lease_id: UUID(8),
  grant_revision: 3,
  ...over,
});

function grantRecord(over: any = {}) {
  return {
    grant: {
      grant_id: UUID(7),
      account_id: UUID(2),
      connection_id: UUID(9),
      revision: 3,
      state: "enabled",
      service_account: "reader-sa@example-project-1.iam.gserviceaccount.com",
      sa_label: "read-only",
      target_project: "example-project-1",
      permission_profile: "read-only",
      ...(over.grant ?? {}),
    },
    connection: {
      connection_id: UUID(9),
      account_id: UUID(2),
      provider: "gcp",
      state: "enabled",
      audience_test_passed: true,
      provider_ref: {
        pool_project_number: "123456789012",
        pool_id: "example-pool",
        provider_id: "example-provider",
      },
      ...(over.connection ?? {}),
    },
  };
}

function setup(
  opts: {
    grant?: any;
    loadGrant?: BrokerDeps["loadGrant"];
    recordMint?: BrokerDeps["recordMint"];
    recordMints?: BrokerDeps["recordMints"];
    withLeaseLock?: BrokerDeps["withLeaseLock"];
    turnLive?: boolean;
    allowlisted?: boolean;
    reference?: number;
    sts?: { status: number; retryAfter?: string };
    iam?: { status: number; expireInMs?: number };
    limiter?: BrokerDeps["limiter"];
  } = {},
) {
  let now = NOW;
  let mono = 1_000;
  const rows: MintLogRow[] = [];
  const calls: { url: string; body?: string; auth?: string }[] = [];
  let referenceCalls = 0;
  const deps: BrokerDeps = {
    issuer: "https://staging.example.com/_cocalc/oidc/connectors",
    signer,
    async fetchImpl(url, init) {
      calls.push({ url, body: init.body, auth: init.headers.Authorization });
      const sts = url.startsWith("https://sts.");
      const spec = sts ? opts.sts : opts.iam;
      const status = spec?.status ?? 200;
      return {
        status,
        headers: {
          get: (name: string) =>
            name === "retry-after" ? ((spec as any)?.retryAfter ?? null) : null,
        },
        async json() {
          return sts
            ? { access_token: FEDERATED_TOKEN, token_type: "Bearer" }
            : {
                accessToken: url.includes("other-sa")
                  ? `${ACCESS_TOKEN}-OTHER`
                  : ACCESS_TOKEN,
                expireTime: new Date(
                  now + ((opts.iam as any)?.expireInMs ?? 900_000),
                ).toISOString(),
              };
        },
      };
    },
    loadGrant:
      opts.loadGrant ??
      (async () => (opts.grant === null ? null : grantRecord(opts.grant))),
    async verifyLiveTurn() {
      if (opts.turnLive === false) throw Error("no live turn");
    },
    async isAllowlisted() {
      return opts.allowlisted ?? true;
    },
    async referenceNow() {
      referenceCalls += 1;
      return opts.reference ?? now;
    },
    now: () => now,
    monotonicNow: () => mono,
    withLeaseLock: opts.withLeaseLock ?? (async (_lease, fn) => await fn()),
    recordMint:
      opts.recordMint ??
      (async (row) => {
        rows.push(row);
      }),
    // Test default: the rows through recordMint (so its fakes still apply).
    recordMints:
      opts.recordMints ??
      (async (rs) => {
        for (const r of rs) await deps.recordMint(r);
      }),
    limiter: opts.limiter ?? new TokenBucketLimiter(DEFAULT_RATE_LIMITS),
    random: () => 0.5,
  };
  // Every call is bound to a caller that is still home unless a test says
  // otherwise.
  const broker = new FederatedTokenBroker(deps);
  const getToken = broker.getToken.bind(broker);
  (broker as any).getToken = (r: MintRequest, guard = HOME) =>
    getToken(r, guard);
  return {
    broker,
    rows,
    calls,
    advance: (ms: number) => {
      now += ms;
      mono += ms;
    },
    /** Steps only the wall clock (the monotonic clock doesn't move). */
    stepWall: (ms: number) => (now += ms),
    referenceCalls: () => referenceCalls,
    setOpts: (o: typeof opts) => Object.assign(opts, o),
  };
}

describe("broker: issuing", () => {
  it("issues a token through sign -> exchange -> generateAccessToken", async () => {
    const t = setup();
    const result = await t.broker.getToken(request());
    expect(result).toEqual({
      status: "issued",
      token: ACCESS_TOKEN,
      expires_at: NOW + 900_000,
      grant_revision: 3,
      connection_id: UUID(9),
      project: "example-project-1",
      sa_label: "read-only",
    });
    expect(t.calls.map((c) => c.url)).toEqual([
      "https://sts.googleapis.com/v1/token",
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/reader-sa%40example-project-1.iam.gserviceaccount.com:generateAccessToken",
    ]);
    const sts = new URLSearchParams(t.calls[0].body);
    expect(sts.get("audience")).toBe(
      "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/example-pool/providers/example-provider",
    );
    expect(sts.get("subject_token_type")).toBe(
      "urn:ietf:params:oauth:token-type:jwt",
    );
    expect(t.calls[1].auth).toBe(`Bearer ${FEDERATED_TOKEN}`);
    expect(JSON.parse(t.calls[1].body!).lifetime).toBe("900s");
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({
      outcome: "issued",
      reason: null,
      grant_id: UUID(7),
      grant_revision: 3,
      lease_id: UUID(8),
      connection_id: UUID(9),
      key_version: KEY_VERSION,
      service_account: "reader-sa@example-project-1.iam.gserviceaccount.com",
      issued_at: NOW,
      expires_at: NOW + 900_000,
    });
    expect("time" in t.rows[0]).toBe(false);
  });

  it("re-checks on every request, but exchanges again only after half-life", async () => {
    const t = setup();
    await t.broker.getToken(request());
    t.advance(60_000);
    expect((await t.broker.getToken(request())).status).toBe("issued");
    expect(t.calls).toHaveLength(2); // still one exchange
    t.advance(400_000); // past 450 s * (0.5 +- 0.1 jitter, here 0)
    expect((await t.broker.getToken(request())).status).toBe("issued");
    expect(t.calls).toHaveLength(4); // a second exchange
    expect(t.rows.filter((r) => r.outcome === "issued")).toHaveLength(2);
  });

  it("runs one exchange for concurrent requests of a lease", async () => {
    const t = setup();
    const [a, b, c] = await Promise.all([
      t.broker.getToken(request()),
      t.broker.getToken(request()),
      t.broker.getToken(request()),
    ]);
    expect([a.status, b.status, c.status]).toEqual([
      "issued",
      "issued",
      "issued",
    ]);
    expect(t.calls).toHaveLength(2);
  });
});

describe("broker: each check refuses on its own", () => {
  const cases: [string, Parameters<typeof setup>[0], string][] = [
    ["grant missing", { grant: null }, "grant_missing"],
    [
      "grant of another account",
      { grant: { grant: { account_id: UUID(99) } } },
      "grant_mismatch",
    ],
    [
      "connection of another account",
      { grant: { connection: { account_id: UUID(99) } } },
      "grant_mismatch",
    ],
    [
      "grant pending",
      { grant: { grant: { state: "pending" } } },
      "grant_not_enabled",
    ],
    [
      "connection disabled",
      { grant: { connection: { state: "disabled" } } },
      "connection_not_enabled",
    ],
    [
      "audience test not passed",
      { grant: { connection: { audience_test_passed: false } } },
      "audience_unverified",
    ],
    ["revision changed", { grant: { grant: { revision: 4 } } }, "revision"],
    [
      "malformed service account",
      { grant: { grant: { service_account: "x@example.com" } } },
      "grant_malformed",
    ],
    ["turn not live", { turnLive: false }, "turn_not_live"],
    ["not allowlisted", { allowlisted: false }, "not_allowlisted"],
  ];
  for (const [name, opts, reason] of cases) {
    it(`denies when ${name}, with no cloud call`, async () => {
      const t = setup(opts);
      expect(await t.broker.getToken(request())).toEqual({
        status: "denied",
        reason,
      });
      expect(t.calls).toHaveLength(0);
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0]).toMatchObject({ outcome: "denied", reason });
    });
  }

  it("refuses a malformed request before any lookup", async () => {
    const loadGrant = jest.fn();
    const t = setup({ loadGrant });
    expect(
      await t.broker.getToken(request({ lease_id: "not-a-uuid" })),
    ).toEqual({ status: "denied", reason: "invalid_request" });
    expect(loadGrant).not.toHaveBeenCalled();
  });

  it("stops renewal at once when the turn ends, even with a cached token", async () => {
    const t = setup();
    await t.broker.getToken(request());
    t.setOpts({ turnLive: false });
    expect(await t.broker.getToken(request())).toEqual({
      status: "denied",
      reason: "turn_not_live",
    });
    // and the cache is gone: a later live turn needs a new exchange
    t.setOpts({ turnLive: true });
    await t.broker.getToken(request());
    expect(t.calls).toHaveLength(4);
  });

  it("stops renewal at once on a grant revision change", async () => {
    const t = setup();
    await t.broker.getToken(request());
    t.setOpts({ grant: { grant: { revision: 4 } } });
    expect(await t.broker.getToken(request())).toEqual({
      status: "denied",
      reason: "revision",
    });
  });

  it("treats a failed grant lookup as an error, not a token", async () => {
    const t = setup({
      loadGrant: async () => {
        throw Error("db down");
      },
    });
    expect(await t.broker.getToken(request())).toEqual({
      status: "error",
      reason: "grant_lookup_failed",
      retry_after_ms: undefined,
    });
    expect(t.calls).toHaveLength(0);
  });
});

describe("broker: a lease id alone never shares a token or an answer", () => {
  it("runs separate checks for the same lease id under another account", async () => {
    const t = setup({
      loadGrant: async ({ account_id }) =>
        account_id === UUID(2) ? grantRecord() : null,
    });
    const [mine, theirs] = await Promise.all([
      t.broker.getToken(request()),
      t.broker.getToken(request({ account_id: UUID(50) })),
    ]);
    expect(mine.status).toBe("issued");
    expect(theirs).toEqual({ status: "denied", reason: "grant_missing" });
    // and with the first token cached, still no sharing
    expect(await t.broker.getToken(request({ account_id: UUID(50) }))).toEqual({
      status: "denied",
      reason: "grant_missing",
    });
  });

  it("never serves another grant's cached token, even at an equal revision", async () => {
    const t = setup({
      loadGrant: async ({ grant_id }) =>
        grant_id === UUID(7)
          ? grantRecord()
          : grantRecord({
              grant: {
                grant_id: UUID(51),
                service_account:
                  "other-sa@example-project-1.iam.gserviceaccount.com",
              },
            }),
    });
    const first = await t.broker.getToken(request());
    const second = await t.broker.getToken(request({ grant_id: UUID(51) }));
    expect(first).toMatchObject({ status: "issued", token: ACCESS_TOKEN });
    expect(second).toMatchObject({
      status: "issued",
      token: `${ACCESS_TOKEN}-OTHER`,
    });
    expect(t.calls).toHaveLength(4); // two separate exchanges
  });

  it.each([
    ["agent", { agent_id: UUID(60) }],
    ["project", { project_id: UUID(61) }],
    ["host", { host_id: UUID(62) }],
    ["run", { run_id: UUID(63) }],
  ])("mints anew for the same lease id with another %s", async (_n, over) => {
    const t = setup();
    await t.broker.getToken(request());
    await t.broker.getToken(request(over as Partial<MintRequest>));
    expect(t.calls).toHaveLength(4);
    expect(t.rows.filter((r) => r.outcome === "issued")).toHaveLength(2);
  });
});

describe("broker: no mint log row, no token", () => {
  it("never caches or returns a token whose issued row failed to write", async () => {
    let fail = true;
    const rows: MintLogRow[] = [];
    const t = setup({
      recordMint: async (row) => {
        if (row.outcome === "issued" && fail) throw Error("db down");
        rows.push(row);
      },
    });
    expect(await t.broker.getToken(request())).toEqual({
      status: "error",
      reason: "audit_write_failed",
    });
    expect(t.broker.stats().cached_tokens).toBe(0);
    fail = false;
    expect((await t.broker.getToken(request())).status).toBe("issued");
    expect(t.calls).toHaveLength(4); // a fresh exchange, nothing reused
    expect(rows.filter((r) => r.outcome === "issued")).toHaveLength(1);
  });

  it("still refuses when a refusal can't be logged", async () => {
    const t = setup({
      allowlisted: false,
      recordMint: async () => {
        throw Error("db down");
      },
    });
    expect(await t.broker.getToken(request())).toEqual({
      status: "denied",
      reason: "not_allowlisted",
    });
  });

  it("records an unexpected failure as broker_failure, best effort", async () => {
    const t = setup({
      withLeaseLock: async () => {
        throw Error("lock unavailable");
      },
    });
    expect(await t.broker.getToken(request())).toEqual({
      status: "error",
      reason: "broker_failure",
    });
    expect(t.rows).toEqual([
      expect.objectContaining({ outcome: "error", reason: "broker_failure" }),
    ]);
  });

  it("counts invalid requests it can't log", async () => {
    const t = setup();
    await t.broker.getToken(request({ host_id: "x" }));
    await t.broker.getToken(request({ grant_revision: 0 }));
    expect(t.broker.stats().invalid_requests).toBe(2);
    expect(t.rows).toHaveLength(0);
  });
});

describe("broker: limits, clock and the provider", () => {
  it("refuses when a rate limit is exhausted", async () => {
    const t = setup({
      limiter: new TokenBucketLimiter({
        ...DEFAULT_RATE_LIMITS,
        grant: { capacity: 1, perMinute: 1 },
      }),
    });
    expect((await t.broker.getToken(request())).status).toBe("issued");
    const second = await t.broker.getToken(request({ lease_id: UUID(10) }));
    expect(second).toMatchObject({ status: "error", reason: "rate_limited" });
  });

  it("refuses to sign when the clock is off", async () => {
    const t = setup({ reference: NOW + 120_000 });
    expect(await t.broker.getToken(request())).toMatchObject({
      status: "error",
      reason: "clock_unverified",
    });
    expect(t.calls).toHaveLength(0);
  });

  it("checks the clock against a fresh reference at most every 5 minutes", async () => {
    const t = setup();
    await t.broker.getToken(request());
    await t.broker.getToken(request({ lease_id: UUID(11) }));
    expect(t.referenceCalls()).toBe(1);
    t.advance(6 * 60_000);
    await t.broker.getToken(request({ lease_id: UUID(12) }));
    expect(t.referenceCalls()).toBe(2);
  });

  it("denies when the provider refuses, and keeps nothing cached", async () => {
    const t = setup({ sts: { status: 403 } });
    expect(await t.broker.getToken(request())).toEqual({
      status: "denied",
      reason: "sts_refused",
    });
    expect(t.rows[0]).toMatchObject({
      outcome: "denied",
      reason: "sts_refused",
      key_version: KEY_VERSION,
    });
  });

  it("reports a transient provider error with its Retry-After", async () => {
    const t = setup({ sts: { status: 503, retryAfter: "7" } });
    expect(await t.broker.getToken(request())).toEqual({
      status: "error",
      reason: "sts_unavailable",
      retry_after_ms: 7000,
    });
  });

  it("refuses an access token that is already expired", async () => {
    const t = setup({ iam: { status: 200, expireInMs: 0 } });
    expect(await t.broker.getToken(request())).toMatchObject({
      status: "error",
      reason: "iam_unexpected_expiry",
    });
    expect(t.broker.stats().cached_tokens).toBe(0);
  });

  it.each([
    ["forward", 60_000],
    ["backward", -60_000],
  ])(
    "refuses to sign after a %s wall-clock step inside the reference window",
    async (_dir, step) => {
      const t = setup();
      expect((await t.broker.getToken(request())).status).toBe("issued");
      t.advance(1_000);
      t.stepWall(step as number);
      const before = t.calls.length;
      expect(
        await t.broker.getToken(request({ lease_id: UUID(70) })),
      ).toMatchObject({ status: "error", reason: "clock_unverified" });
      expect(t.calls).toHaveLength(before); // no provider call
    },
  );

  it("signs after a small wall-clock drift within the allowed skew", async () => {
    const t = setup();
    await t.broker.getToken(request());
    t.advance(1_000);
    t.stepWall(5_000);
    expect(
      (await t.broker.getToken(request({ lease_id: UUID(71) }))).status,
    ).toBe("issued");
  });

  it("denies when the service account call is refused", async () => {
    const t = setup({ iam: { status: 403 } });
    expect(await t.broker.getToken(request())).toEqual({
      status: "denied",
      reason: "iam_refused",
    });
  });
});

describe("broker: secrets stay in the token field", () => {
  it("never puts a token or assertion in rows, results' errors or the console", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) =>
        jest
          .spyOn(console, m)
          .mockImplementation((...args: any[]) =>
            logged.push(args.map(String).join(" ")),
          ),
    );
    try {
      const ok = setup();
      await ok.broker.getToken(request());
      const denied = setup({ iam: { status: 403 } });
      const deniedResult = await denied.broker.getToken(request());
      const failed = setup({ sts: { status: 500 } });
      const failedResult = await failed.broker.getToken(request());
      const everything = JSON.stringify([
        ok.rows,
        denied.rows,
        failed.rows,
        deniedResult,
        failedResult,
        logged,
      ]);
      for (const secret of [ACCESS_TOKEN, FEDERATED_TOKEN, "PLANTED", "eyJ"]) {
        expect(everything).not.toContain(secret);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("broker: the final home-bay check (design v3.3.2)", () => {
  // The directory's answer, which a test moves between the checks.
  function directory(home: string) {
    const state = { home, fail: false };
    const guardFor = (bay: string) => ({
      scope: bay,
      confirmHome: async () => {
        if (state.fail) throw Error("seed unavailable");
        return state.home === bay;
      },
    });
    return { state, guardFor };
  }

  it("issues when the caller is still the home bay", async () => {
    const t = setup();
    const d = directory("bay-a");
    const r = await t.broker.getToken(request(), d.guardFor("bay-a"));
    expect(r.status).toBe("issued");
    expect(t.rows.map((x) => x.outcome)).toEqual(["issued"]);
  });

  it("withholds a token minted while the account moved: nothing reaches A, nothing is cached, B mints afresh", async () => {
    const pairs: MintLogRow[][] = [];
    const t = setup({
      recordMints: async (rows) => {
        pairs.push(rows);
      },
    });
    const d = directory("bay-a");
    // The account moves to B after the initial check, during the mint.
    let fetches = 0;
    const realFetch = (t.broker as any).deps.fetchImpl;
    (t.broker as any).deps.fetchImpl = async (url: string, init: any) => {
      fetches += 1;
      if (fetches === 2) d.state.home = "bay-b";
      return await realFetch(url, init);
    };
    const a = await t.broker.getToken(request(), d.guardFor("bay-a"));
    expect(a).toEqual({ status: "denied", reason: "not_home_bay" });
    expect(JSON.stringify(a)).not.toContain(ACCESS_TOKEN);
    // One transaction: the issued row and the home_bay_moved row together.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].map((x) => [x.outcome, x.reason])).toEqual([
      ["issued", null],
      ["denied", "home_bay_moved"],
    ]);
    expect(pairs[0][1].lease_id).toBe(UUID(8));
    expect(t.broker.stats().cached_tokens).toBe(0);
    expect(t.broker.stats().home_bay_moved).toBe(1);
    // A again: refused (not home), never the discarded token.
    expect(
      (await t.broker.getToken(request(), d.guardFor("bay-a"))).status,
    ).toBe("denied");
    // B, the new home: a fresh Google exchange.
    const before = t.calls.length;
    const b = await t.broker.getToken(request(), d.guardFor("bay-b"));
    expect(b.status).toBe("issued");
    expect(t.calls.length).toBe(before + 2);
  });

  it("withholds the token when the final check fails or is malformed", async () => {
    for (const confirmHome of [
      async () => {
        throw Error("seed unavailable");
      },
      async () => "bay-a" as any,
      async () => undefined as any,
    ]) {
      const t = setup();
      const r = await t.broker.getToken(request(), {
        scope: "bay-a",
        confirmHome,
      });
      expect(r).toEqual({ status: "denied", reason: "not_home_bay" });
      expect(t.rows.map((x) => x.reason)).toEqual([null, "home_bay_moved"]);
      expect(t.broker.stats().cached_tokens).toBe(0);
    }
  });

  it("gives every concurrent waiter not_home_bay, never the token", async () => {
    const t = setup();
    const d = directory("bay-b");
    const results = await Promise.all([
      t.broker.getToken(request(), d.guardFor("bay-a")),
      t.broker.getToken(request(), d.guardFor("bay-a")),
      t.broker.getToken(request(), d.guardFor("bay-a")),
    ]);
    for (const r of results) {
      expect(r).toEqual({ status: "denied", reason: "not_home_bay" });
    }
    expect(t.calls).toHaveLength(2); // one exchange, shared and withheld
  });

  it("never shares an answer across callers", async () => {
    const t = setup();
    const d = directory("bay-a");
    const [a, b] = await Promise.all([
      t.broker.getToken(request(), d.guardFor("bay-a")),
      t.broker.getToken(request(), d.guardFor("bay-b")),
    ]);
    expect(a.status).toBe("issued");
    expect(b).toEqual({ status: "denied", reason: "not_home_bay" });
  });

  it("checks again before returning a cached token", async () => {
    const t = setup();
    const d = directory("bay-a");
    expect(
      (await t.broker.getToken(request(), d.guardFor("bay-a"))).status,
    ).toBe("issued");
    d.state.home = "bay-b";
    t.advance(60_000);
    const r = await t.broker.getToken(request(), d.guardFor("bay-a"));
    expect(r).toEqual({ status: "denied", reason: "not_home_bay" });
    expect(t.rows.at(-1)).toMatchObject({
      outcome: "denied",
      reason: "home_bay_moved",
    });
    expect(t.broker.stats().cached_tokens).toBe(0);
  });

  it("returns no token when the pair of rows can't be written", async () => {
    const t = setup({
      recordMints: async () => {
        throw Error("store down");
      },
    });
    const d = directory("bay-b");
    const r = await t.broker.getToken(request(), d.guardFor("bay-a"));
    expect(r).toEqual({ status: "error", reason: "audit_write_failed" });
    expect(t.broker.stats().cached_tokens).toBe(0);
  });
});

describe("broker: the caller binding and the atomic rows are required", () => {
  it("refuses a missing or malformed guard before any lookup or Google call", async () => {
    for (const guard of [
      undefined,
      null,
      {},
      { scope: "", confirmHome: async () => true },
      { scope: "bay-a" },
      { scope: 1, confirmHome: async () => true },
    ]) {
      const loadGrant = jest.fn(async () => grantRecord());
      const t = setup({ loadGrant });
      const raw = FederatedTokenBroker.prototype.getToken.bind(t.broker);
      expect(await raw(request(), guard as any)).toEqual({
        status: "denied",
        reason: "not_home_bay",
      });
      expect(loadGrant).not.toHaveBeenCalled();
      expect(t.calls).toHaveLength(0);
      expect(t.rows).toHaveLength(0);
    }
  });

  it("can't be built without recordMints (type), and never writes an issued row except through it", async () => {
    // @ts-expect-error recordMints is required
    const deps: BrokerDeps = { recordMint: async () => {} };
    expect(deps).toBeDefined();
    const single: MintLogRow[] = [];
    const batches: MintLogRow[][] = [];
    const t = setup({
      recordMint: async (r) => {
        single.push(r);
      },
      recordMints: async (rs) => {
        batches.push(rs);
      },
    });
    expect((await t.broker.getToken(request())).status).toBe("issued");
    expect(batches.map((b) => b.map((r) => r.outcome))).toEqual([["issued"]]);
    expect(single.filter((r) => r.outcome === "issued")).toEqual([]);
  });
});

describe("broker: a denial drops the lease's cached tokens for every caller", () => {
  it("drops the cache when the turn ends, with a caller binding", async () => {
    const t = setup();
    const guard = { scope: "bay-a", confirmHome: async () => true };
    await t.broker.getToken(request(), guard);
    expect(t.broker.stats().cached_tokens).toBe(1);
    t.setOpts({ turnLive: false });
    expect((await t.broker.getToken(request(), guard)).status).toBe("denied");
    expect(t.broker.stats().cached_tokens).toBe(0);
    t.setOpts({ turnLive: true });
    await t.broker.getToken(request(), guard);
    expect(t.calls).toHaveLength(4); // a fresh exchange, not the old token
  });
});
