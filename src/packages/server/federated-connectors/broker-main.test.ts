/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Synthetic values only.

import { Agent } from "node:https";

const published: any[] = [];
const services: any[] = [];
jest.mock("@cocalc/conat/inter-bay/federated-broker", () => ({
  createInterBayFederatedBrokerClient: jest.fn(() => ({})),
  createFederatedBrokerMintService: jest.fn((cluster, handler) => {
    services.push({ cluster, handler });
    return { close: jest.fn() };
  }),
  publishFederatedBrokerHeartbeat: jest.fn(async (_c, cluster, beat) => {
    published.push({ cluster, beat });
  }),
}));

import { generateKeyPairSync } from "node:crypto";
import { parseBrokerConfig, startBroker } from "./broker-main";

const ID = "109876543210987654321";
const EMAIL = "fake-broker@example-project-1.iam.gserviceaccount.com";
const KEY =
  "projects/example-project-1/locations/us/keyRings/example-ring/cryptoKeys/example-key/cryptoKeyVersions/1";
const PIN = "a".repeat(64);
const ENV = {
  COCALC_BROKER_SIGNER_EMAIL: EMAIL,
  COCALC_BROKER_SIGNER_UNIQUE_ID: ID,
  COCALC_BROKER_FABRIC_URL: "https://10.0.0.2:8443",
  COCALC_BROKER_FABRIC_PATH: "/conat",
  COCALC_BROKER_FABRIC_SPKI_SHA256: PIN,
  COCALC_BROKER_CLUSTER_ID: "cluster-1",
  COCALC_BROKER_SITE_ID: "00000000-0000-4000-8000-000000000001",
  COCALC_BROKER_SEED_BAY_ID: "bay-0",
  COCALC_BROKER_KMS_KEY_VERSION: KEY,
  COCALC_BROKER_ISSUER: "https://staging.example.com/_cocalc/oidc/connectors",
};
const PEM = `${generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).publicKey.export({ type: "spki", format: "pem" })}`;
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln";

function fakes(over: { azp?: string; storeOk?: boolean } = {}) {
  const kmsCalls: string[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  const connectCalls: any[] = [];
  const textFetch = async (url: string) => {
    if (url.endsWith("/email")) return { status: 200, text: async () => EMAIL };
    if (url.endsWith("/token")) {
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ access_token: "ya29.fake", expires_in: 3599 }),
      };
    }
    if (url.includes("/identity?")) {
      return { status: 200, text: async () => ID_TOKEN };
    }
    const azp = over.azp ?? ID;
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
  const jsonFetch = async (url: string, init: any) => {
    kmsCalls.push(`${init.method} ${url}`);
    return {
      status: 200,
      headers: {
        get: (n: string) => (n === "date" ? new Date().toUTCString() : null),
      },
      json: async () =>
        url.endsWith("/publicKey")
          ? { pem: PEM, algorithm: "RSA_SIGN_PKCS1_2048_SHA256" }
          : { state: "ENABLED", algorithm: "RSA_SIGN_PKCS1_2048_SHA256" },
    };
  };
  const tables = ["federated_connector_mint_log", "broker_purge_log"];
  const guards =
    over.storeOk === false
      ? []
      : tables.flatMap((table) =>
          ["insert_time", "append_only", "no_truncate"].map((g) => ({
            table,
            name: `${table}_${g}`,
            enabled: "A",
            current: true,
          })),
        );
  const purges: string[] = [];
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("pg_trigger")) return { rows: guards };
      if (sql.includes("owned_tables")) {
        return {
          rows: [
            {
              owned_tables: 2,
              owned_purge: 1,
              app_can_change: false,
              app_privileged: false,
              app_is_owner: false,
            },
          ],
        };
      }
      if (sql.includes("broker_purge_mint_log")) purges.push(sql);
      return { rows: [{ deleted: 0 }] };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  };
  const client = { close: jest.fn() };
  return {
    kmsCalls,
    purges,
    timers,
    connectCalls,
    deps: {
      env: {},
      textFetch: textFetch as any,
      jsonFetch: jsonFetch as any,
      pool,
      connect: (opts: any) => {
        connectCalls.push(opts);
        return client as any;
      },
      monotonicNow: () => performance.now(),
      now: () => Date.now(),
      every: (ms: number, fn: () => void) => {
        timers.push({ ms, fn });
        return { stop: () => {} };
      },
    },
  };
}

describe("parseBrokerConfig", () => {
  it("reads a complete configuration", () => {
    const c = parseBrokerConfig(ENV);
    expect(c.signer).toEqual({ email: EMAIL, uniqueId: ID });
    expect(c.fabricUrl.origin).toBe("https://10.0.0.2:8443");
  });

  it.each(Object.keys(ENV))("refuses a missing %s, naming only it", (name) => {
    const env = { ...ENV, [name]: undefined };
    expect(() => parseBrokerConfig(env)).toThrow(name);
  });

  it("refuses plaintext fabric and malformed values, without echoing them", () => {
    for (const [name, value] of [
      ["COCALC_BROKER_FABRIC_URL", "http://10.0.0.2:8443"],
      ["COCALC_BROKER_FABRIC_SPKI_SHA256", "SECRET-LOOKING-VALUE"],
      ["COCALC_BROKER_SIGNER_UNIQUE_ID", "0123"],
      ["COCALC_BROKER_CLUSTER_ID", "a.b"],
    ]) {
      const err = (() => {
        try {
          parseBrokerConfig({ ...ENV, [name]: value });
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err?.message).toContain(name);
      expect(err?.message).not.toContain(value);
    }
  });
});

describe("startBroker", () => {
  beforeEach(() => {
    published.length = 0;
    services.length = 0;
  });

  it("refuses a credential override before anything else", async () => {
    const f = fakes();
    await expect(
      startBroker(parseBrokerConfig(ENV), {
        ...f.deps,
        env: { GOOGLE_APPLICATION_CREDENTIALS: "/x" },
      }),
    ).rejects.toThrow("credential override");
    expect(f.connectCalls).toHaveLength(0);
  });

  it("never connects when the identity isn't the signer record", async () => {
    const f = fakes({ azp: "109876543210987654322" });
    await expect(startBroker(parseBrokerConfig(ENV), f.deps)).rejects.toThrow();
    expect(f.connectCalls).toHaveLength(0);
  });

  it("never connects when the store's guards aren't ok", async () => {
    const f = fakes({ storeOk: false });
    await expect(startBroker(parseBrokerConfig(ENV), f.deps)).rejects.toThrow(
      "store",
    );
    expect(f.connectCalls).toHaveLength(0);
  });

  it("connects over the pinned TLS agent with a fresh metadata ID token", async () => {
    const f = fakes();
    const b = await startBroker(parseBrokerConfig(ENV), f.deps);
    expect(f.connectCalls).toHaveLength(1);
    const opts = f.connectCalls[0];
    expect(opts.address).toBe("https://10.0.0.2:8443");
    expect(opts.path).toBe("/conat");
    expect(opts.transports).toEqual(["websocket"]);
    expect(opts.agent).toBeInstanceOf(Agent);
    expect(opts.systemAccountPassword).toBeUndefined();
    const auth = await new Promise((r) => opts.auth(r));
    expect(auth).toEqual({ bearer: ID_TOKEN });
    expect(services[0].cluster).toBe("cluster-1");
    b.stop();
  });

  it("heartbeats the cached readiness and never signs for it", async () => {
    const f = fakes();
    await startBroker(parseBrokerConfig(ENV), f.deps);
    const heartbeat = f.timers.find((t) => t.ms === 10_000)!;
    for (let i = 0; i < 5; i++) heartbeat.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(published).toHaveLength(5);
    expect(published[0].beat).toMatchObject({
      site_id: ENV.COCALC_BROKER_SITE_ID,
      ready: {
        identity: true,
        database: true,
        reference_time: true,
        signing: true,
      },
    });
    expect(published[0].beat.instance_id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(f.kmsCalls.filter((c) => c.includes(":asymmetricSign"))).toEqual([]);
  });

  it("serves the pinned key's public bytes", async () => {
    const f = fakes();
    await startBroker(parseBrokerConfig(ENV), f.deps);
    const reply = await services[0].handler.publicKeys({
      cluster_id: "cluster-1",
      bay_id: "bay-0",
      bay_credential_id: "cred",
    });
    expect(reply.keys).toHaveLength(1);
    expect(reply.keys[0].version).toBe(KEY);
  });

  it("purges once at start, then on the daily timer", async () => {
    const f = fakes();
    await startBroker(parseBrokerConfig(ENV), f.deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.purges).toHaveLength(1);
    f.timers.find((t) => t.ms === 24 * 60 * 60_000)!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.purges).toHaveLength(2);
  });
});
