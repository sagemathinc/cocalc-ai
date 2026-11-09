/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Synthetic values only.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import {
  BrokerReadiness,
  createBrokerLookupDeps,
  createBrokerStore,
  createKmsClient,
  createPinnedAgent,
  parseFabricUrl,
  parseLoadGrantReply,
  ReferenceClock,
  referenceDateFrom,
  SignerSession,
} from "./broker-runtime";

// Test fakes answer text(); the production contract is a byte stream.
const asStream = (f: any) => async (url: string, init: any) => {
  const r = await f(url, init);
  return { status: r.status, body: [Buffer.from(await r.text())] };
};

const U = (n: number) => `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const DATE = "Mon, 09 Nov 2026 07:00:00 GMT";
const DATE_MS = Date.parse(DATE);

describe("reference time", () => {
  it("takes the Date header of a successful response from the four origins only", () => {
    for (const origin of [
      "https://cloudkms.googleapis.com",
      "https://sts.googleapis.com",
      "https://iamcredentials.googleapis.com",
      "https://oauth2.googleapis.com",
    ]) {
      expect(referenceDateFrom(`${origin}/v1/x`, 200, DATE)).toBe(DATE_MS);
    }
    expect(
      referenceDateFrom("https://example.com/x", 200, DATE),
    ).toBeUndefined();
    expect(
      referenceDateFrom("http://cloudkms.googleapis.com/x", 200, DATE),
    ).toBeUndefined();
    expect(
      referenceDateFrom(
        "https://cloudkms.googleapis.com.example.com/",
        200,
        DATE,
      ),
    ).toBeUndefined();
    expect(
      referenceDateFrom("https://cloudkms.googleapis.com/x", 403, DATE),
    ).toBeUndefined();
    expect(
      referenceDateFrom("https://cloudkms.googleapis.com/x", 200, "garbage"),
    ).toBeUndefined();
    expect(
      referenceDateFrom("https://cloudkms.googleapis.com/x", 200, null),
    ).toBeUndefined();
  });

  it("advances by the monotonic clock, probes when stale, and fails closed", async () => {
    let mono = 0;
    let probes = 0;
    let answer = true;
    const clock = new ReferenceClock(
      () => mono,
      async () => {
        probes += 1;
        if (answer) clock.record(DATE_MS + mono);
      },
    );
    expect(clock.fresh()).toBe(false);
    expect(await clock.referenceNow()).toBe(DATE_MS);
    mono = 60_000;
    expect(await clock.referenceNow()).toBe(DATE_MS + 60_000);
    expect(probes).toBe(1);
    mono = 60_000 + 5 * 60_000 + 1;
    answer = false;
    await expect(clock.referenceNow()).rejects.toThrow("no fresh reference");
    expect(probes).toBe(2);
  });
});

describe("the signer session", () => {
  const RECORD = {
    email: "fake-broker@example-project-1.iam.gserviceaccount.com",
    uniqueId: "109876543210987654321",
  };
  function fakeFetch(azp = RECORD.uniqueId) {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/email")) {
        return { status: 200, text: async () => RECORD.email };
      }
      if (url.endsWith("/token")) {
        return {
          status: 200,
          text: async () =>
            JSON.stringify({ access_token: "ya29.fake", expires_in: 3599 }),
        };
      }
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            azp,
            aud: azp,
            scope: "https://www.googleapis.com/auth/cloud-platform",
            expires_in: "3599",
          }),
      };
    };
    return { calls, fetchImpl: asStream(fetchImpl) };
  }

  it("verifies on every refresh and caches until a minute before expiry", async () => {
    let mono = 0;
    const f = fakeFetch();
    const s = new SignerSession({
      fetchImpl: f.fetchImpl as any,
      record: RECORD,
      env: {},
      monotonicNow: () => mono,
    });
    expect(s.verified()).toBe(false);
    expect(await s.token()).toBe("ya29.fake");
    expect(s.verified()).toBe(true);
    const n = f.calls.length;
    mono = 3_000_000;
    await s.token();
    expect(f.calls.length).toBe(n);
    mono = 3_540_000;
    await s.token();
    expect(f.calls.length).toBe(2 * n);
  });

  it("refuses another identity, and is then not verified", async () => {
    const s = new SignerSession({
      fetchImpl: fakeFetch("109876543210987654322").fetchImpl as any,
      record: RECORD,
      env: {},
      monotonicNow: () => 0,
    });
    await expect(s.token()).rejects.toThrow();
    expect(s.verified()).toBe(false);
  });

  it("refuses a credential override", async () => {
    const s = new SignerSession({
      fetchImpl: fakeFetch().fetchImpl as any,
      record: RECORD,
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/x" },
      monotonicNow: () => 0,
    });
    await expect(s.token()).rejects.toThrow();
  });
});

describe("the KMS client", () => {
  it("calls KMS only, with the session token, and records the reference", async () => {
    const seen: any[] = [];
    const refs: number[] = [];
    const kms = createKmsClient({
      fetchImpl: async (url, init) => {
        seen.push({ url, auth: init.headers.Authorization, body: init.body });
        return {
          status: 200,
          headers: { get: (n: string) => (n === "date" ? DATE : null) },
          json: async () => ({ state: "ENABLED" }),
        };
      },
      session: { token: async () => "ya29.fake" },
      onReference: (r) => refs.push(r),
    });
    const url = "https://cloudkms.googleapis.com/v1/projects/p/x";
    expect(
      await kms.request({ url, method: "POST", data: { a: 1 }, timeout: 1000 }),
    ).toEqual({ data: { state: "ENABLED" } });
    expect(seen[0]).toEqual({
      url,
      auth: "Bearer ya29.fake",
      body: JSON.stringify({ a: 1 }),
    });
    expect(refs).toEqual([DATE_MS]);
    await expect(
      kms.request({
        url: "https://example.com/v1/x",
        method: "GET",
        timeout: 1,
      }),
    ).rejects.toThrow("not a KMS URL");
  });

  it("reports a failure by status only", async () => {
    const kms = createKmsClient({
      fetchImpl: async () => ({
        status: 403,
        headers: { get: () => DATE },
        json: async () => ({ error: "planted-secret-detail" }),
      }),
      session: { token: async () => "ya29.fake" },
      onReference: () => {
        throw Error("a failure is no reference");
      },
    });
    const err = await kms
      .request({
        url: "https://cloudkms.googleapis.com/v1/x",
        method: "GET",
        timeout: 1000,
      })
      .catch((e) => e);
    expect(err.message).toBe("KMS request failed (403)");
  });
});

describe("readiness", () => {
  it("reflects the last probe, which makes no signature", async () => {
    let keyOk = true;
    let fresh = true;
    const checkSigningKey = jest.fn(async () => {
      if (!keyOk) throw Error("disabled");
    });
    const r = new BrokerReadiness({
      session: { token: async () => "t", verified: () => true },
      checkSigningKey,
      checkStore: async () => true,
      clock: { fresh: () => fresh },
    });
    expect(r.state()).toEqual({
      identity: true,
      database: false,
      reference_time: true,
      signing: false,
    });
    await r.probe();
    expect(r.state()).toEqual({
      identity: true,
      database: true,
      reference_time: true,
      signing: true,
    });
    keyOk = false;
    fresh = false;
    await r.probe();
    expect(r.state().signing).toBe(false);
    expect(r.state().reference_time).toBe(false);
    // Reading the state never probes.
    const n = checkSigningKey.mock.calls.length;
    r.state();
    r.state();
    expect(checkSigningKey.mock.calls.length).toBe(n);
  });
});

function loadGrantReply(over: any = {}) {
  return {
    grant: {
      grant_id: U(7),
      account_id: U(2),
      connection_id: U(9),
      revision: 3,
      state: "enabled",
      service_account: "reader-sa@example-project-1.iam.gserviceaccount.com",
      sa_label: "read-only",
      target_project: "example-project-1",
      permission_profile: "read-only",
      ...(over.grant ?? {}),
    },
    connection: {
      connection_id: U(9),
      account_id: U(2),
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

describe("lookup replies", () => {
  it("parses loadGrant strictly", () => {
    expect(parseLoadGrantReply(null)).toBeNull();
    expect(parseLoadGrantReply(loadGrantReply())).toEqual(loadGrantReply());
    for (const bad of [
      undefined,
      {},
      { ...loadGrantReply(), extra: 1 },
      loadGrantReply({ grant: { extra: 1 } }),
      loadGrantReply({ grant: { revision: 0 } }),
      loadGrantReply({ grant: { grant_id: "x" } }),
      loadGrantReply({ connection: { audience_test_passed: "yes" } }),
      loadGrantReply({ connection: { provider_ref: { pool_id: "p" } } }),
    ]) {
      expect(parseLoadGrantReply(bad)).toBeUndefined();
    }
  });

  function lookups(replies: Record<string, any>) {
    const asked: string[] = [];
    const deps = createBrokerLookupDeps({
      seedBayId: "seed",
      lookupsAt: (bay) =>
        ({
          homeBay: async () => (asked.push(`${bay}:homeBay`), replies.homeBay),
          loadGrant: async () => (
            asked.push(`${bay}:loadGrant`),
            replies.loadGrant
          ),
          verifyLiveTurn: async () => (
            asked.push(`${bay}:verifyLiveTurn`),
            replies.verifyLiveTurn
          ),
          isAllowlisted: async () => (
            asked.push(`${bay}:isAllowlisted`),
            replies.isAllowlisted
          ),
        }) as any,
    });
    return { deps, asked };
  }

  it("asks the seed for the home bay, then the home bay for the grant and the turn", async () => {
    const { deps, asked } = lookups({
      homeBay: { home_bay_id: "bay-a" },
      loadGrant: loadGrantReply(),
      verifyLiveTurn: { live: true },
      isAllowlisted: { allowlisted: true },
    });
    await deps.loadGrant({ account_id: U(2), grant_id: U(7) });
    await deps.verifyLiveTurn({ account_id: U(2) } as any);
    expect(
      await deps.isAllowlisted({
        provider: "gcp",
        service_account: "s",
        permission_profile: "p",
        target_project: "t",
      }),
    ).toBe(true);
    expect(asked).toEqual([
      "seed:homeBay",
      "bay-a:loadGrant",
      "seed:homeBay",
      "bay-a:verifyLiveTurn",
      "seed:isAllowlisted",
    ]);
  });

  it("refuses malformed replies, counting them", async () => {
    const { deps } = lookups({
      homeBay: { home_bay_id: "bay-a", email: "x" },
      verifyLiveTurn: { live: "yes" },
      isAllowlisted: { allowlisted: 1 },
    });
    await expect(deps.homeBayOf(U(2))).rejects.toThrow("invalid");
    await expect(
      deps.isAllowlisted({
        provider: "gcp",
        service_account: "s",
        permission_profile: "p",
        target_project: "t",
      }),
    ).rejects.toThrow("invalid");
    expect(deps.counters.invalid_replies).toBe(2);
  });

  it("logs nothing it learns", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => jest.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const { deps } = lookups({ homeBay: { home_bay_id: "bay-a" } });
      await deps.homeBayOf(U(2));
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("the store's row pair", () => {
  function pool(failAt?: number) {
    const log: string[] = [];
    let n = 0;
    const client = {
      query: async (sql: string) => {
        const word = sql.trim().split(/\s+/)[0];
        log.push(word);
        if (word === "INSERT" && ++n === failAt) throw Error("write failed");
        return { rows: [] };
      },
      release: jest.fn(),
    };
    return {
      log,
      client,
      pool: {
        query: client.query,
        connect: async () => client,
      },
    };
  }
  const row = { outcome: "issued" } as any;

  it("writes the rows in one transaction", async () => {
    const p = pool();
    await createBrokerStore(p.pool).recordMints([row, row]);
    expect(p.log).toEqual(["BEGIN", "INSERT", "INSERT", "COMMIT"]);
    expect(p.client.release).toHaveBeenCalledWith(undefined);
  });

  it("rolls back both when the second fails", async () => {
    const p = pool(2);
    await expect(
      createBrokerStore(p.pool).recordMints([row, row]),
    ).rejects.toThrow("write failed");
    expect(p.log).toEqual(["BEGIN", "INSERT", "INSERT", "ROLLBACK"]);
  });
});

describe("the fabric connection's TLS pin", () => {
  let dir: string;
  const certs: { key: Buffer; cert: Buffer; pin: string }[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pin-test-"));
    for (const name of ["a", "b"]) {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-subj",
          "/CN=fabric.example",
          "-days",
          "1",
          "-keyout",
          join(dir, `${name}.key`),
          "-out",
          join(dir, `${name}.crt`),
        ],
        { stdio: "ignore" },
      );
      const cert = readFileSync(join(dir, `${name}.crt`));
      const spki = new X509Certificate(cert).publicKey.export({
        type: "spki",
        format: "der",
      });
      certs.push({
        key: readFileSync(join(dir, `${name}.key`)),
        cert,
        pin: createHash("sha256").update(spki).digest("hex"),
      });
    }
  }, 30_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function serve(fn: (port: number, seen: string[]) => Promise<void>) {
    const seen: string[] = [];
    const server = createHttpsServer(
      { key: certs[0].key, cert: certs[0].cert },
      (req, res) => {
        seen.push(`${req.headers.authorization ?? ""}`);
        res.end("ok");
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await fn((server.address() as any).port, seen);
    } finally {
      server.close();
    }
  }

  function get(port: number, pin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = httpsGet(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          agent: createPinnedAgent(pin),
          headers: { Authorization: "Bearer planted-id-token" },
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve(body));
        },
      );
      req.on("error", reject);
    });
  }

  it("connects for the pinned key", async () => {
    await serve(async (port, seen) => {
      expect(await get(port, certs[0].pin)).toBe("ok");
      expect(seen).toEqual(["Bearer planted-id-token"]);
    });
  });

  it("refuses another key before sending anything", async () => {
    await serve(async (port, seen) => {
      await expect(get(port, certs[1].pin)).rejects.toThrow(
        "fabric pin mismatch",
      );
      expect(seen).toEqual([]);
    });
  });

  it("refuses a malformed pin and a non-https fabric url", () => {
    expect(() => createPinnedAgent("abc")).toThrow("invalid fabric pin");
    expect(() => parseFabricUrl("http://10.0.0.2:443")).toThrow("https");
    expect(() => parseFabricUrl("wss://10.0.0.2")).toThrow("https");
    expect(() => parseFabricUrl("https://u:p@10.0.0.2")).toThrow("https");
    expect(parseFabricUrl("https://10.0.0.2:8443").port).toBe("8443");
  });
});
