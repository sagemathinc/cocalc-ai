/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The token broker process (G3b design v3, v3.1, v3.2.1, v3.3.2), on its own
VM. It holds no stored credential: its Google identity comes from the
metadata server (checked against the signer record), its fabric credential
is a metadata ID token sent only over a TLS connection with the pinned key,
and its store is the VM's local Postgres as broker_app.

Startup order, each step failing closed (the process exits; the gate stays
closed on every bay because no heartbeat arrives):
1. the configuration, strictly, and no credential override in the env;
2. the signer identity (metadata token + tokeninfo);
3. the store (guards ok) and the signing key version (ENABLED, RS256);
4. the fabric connection, the mint service, the readiness probe, the
   heartbeat and the purge (at start, then daily).
*/

import { createPublicKey, randomBytes } from "node:crypto";
import type { Client, ClientOptions } from "@cocalc/conat/core/client";
import {
  createFederatedBrokerMintService,
  createInterBayFederatedBrokerClient,
  publishFederatedBrokerHeartbeat,
} from "@cocalc/conat/inter-bay/federated-broker";
import {
  isGcpServiceAccount,
  isUuid,
} from "@cocalc/util/ai/federated-connectors";
import { isFederationIssuer } from "./issuer";
import {
  DEFAULT_RATE_LIMITS,
  FederatedTokenBroker,
  TokenBucketLimiter,
} from "./broker";
import { createBrokerServiceHandler } from "./broker-service";
import {
  BrokerReadiness,
  createBrokerLookupDeps,
  createBrokerStore,
  createKmsClient,
  createPinnedAgent,
  createPreSignReference,
  parseFabricUrl,
  ReferenceClock,
  referenceDateFrom,
  SignerSession,
  type BrokerStorePool,
  type JsonFetch,
} from "./broker-runtime";
import {
  credentialOverridesPresent,
  isGoogleUniqueId,
  metadataIdToken,
  nodeTextFetch,
  type SignerRecord,
  type TextFetch,
} from "./google-identity";
import { isKmsKeyVersion, KmsFederationSigner } from "./signer";

export const HEARTBEAT_INTERVAL_MS = 10_000;
// Under the 60 s reference validity, so readiness doesn't flap.
export const READINESS_INTERVAL_MS = 30_000;
export const PURGE_INTERVAL_MS = 24 * 60 * 60_000;

export interface BrokerConfig {
  clusterId: string;
  siteId: string;
  seedBayId: string;
  fabricUrl: URL;
  fabricPath: string;
  fabricPin: string;
  signer: SignerRecord;
  keyVersion: string;
  issuer: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The broker's configuration; an error names the variable, never a value. */
export function parseBrokerConfig(
  env: Record<string, string | undefined>,
): BrokerConfig {
  const get = (name: string, ok: (v: string) => boolean): string => {
    const v = env[name]?.trim();
    if (!v || !ok(v)) throw Error(`invalid or missing ${name}`);
    return v;
  };
  const signer = {
    email: get("COCALC_BROKER_SIGNER_EMAIL", isGcpServiceAccount),
    uniqueId: get("COCALC_BROKER_SIGNER_UNIQUE_ID", isGoogleUniqueId),
  };
  let fabricUrl: URL;
  try {
    fabricUrl = parseFabricUrl(env.COCALC_BROKER_FABRIC_URL);
  } catch {
    throw Error("invalid or missing COCALC_BROKER_FABRIC_URL");
  }
  return {
    clusterId: get("COCALC_BROKER_CLUSTER_ID", (v) => ID_RE.test(v)),
    siteId: get("COCALC_BROKER_SITE_ID", isUuid),
    seedBayId: get("COCALC_BROKER_SEED_BAY_ID", (v) => ID_RE.test(v)),
    fabricUrl,
    fabricPath: get("COCALC_BROKER_FABRIC_PATH", (v) =>
      /^\/[A-Za-z0-9/_.-]{0,128}$/.test(v),
    ),
    fabricPin: get("COCALC_BROKER_FABRIC_SPKI_SHA256", (v) =>
      /^[0-9a-f]{64}$/.test(v),
    ),
    signer,
    keyVersion: get("COCALC_BROKER_KMS_KEY_VERSION", isKmsKeyVersion),
    issuer: get("COCALC_BROKER_ISSUER", isFederationIssuer),
  };
}

export interface BrokerRuntimeDeps {
  env: Record<string, string | undefined>;
  textFetch: TextFetch;
  jsonFetch: JsonFetch;
  pool: BrokerStorePool;
  connect: (opts: ClientOptions) => Client;
  monotonicNow: () => number;
  now: () => number;
  every: (ms: number, fn: () => void) => { stop(): void };
}

/** The DER SPKI (base64) of a PEM public key. */
function spkiDerB64(pem: string): string {
  return createPublicKey(pem)
    .export({ type: "spki", format: "der" })
    .toString("base64");
}

export async function startBroker(
  config: BrokerConfig,
  deps: BrokerRuntimeDeps,
): Promise<{ stop(): void; readiness: BrokerReadiness }> {
  if (credentialOverridesPresent(deps.env).length > 0) {
    throw Error("credential override present");
  }

  // 2. The signer identity.
  const session = new SignerSession({
    fetchImpl: deps.textFetch,
    record: config.signer,
    env: deps.env,
    monotonicNow: deps.monotonicNow,
  });
  await session.token();

  // 3. The store and the signing key.
  const store = createBrokerStore(deps.pool);
  if (!(await store.ok())) throw Error("broker store guards not ok");
  let clock: ReferenceClock;
  const kms = createKmsClient({
    fetchImpl: deps.jsonFetch,
    session,
    onReference: (r) => clock.record(r),
  });
  const checkSigningKey = async () => {
    const { data } = await kms.request<{ state?: string; algorithm?: string }>({
      url: `https://cloudkms.googleapis.com/v1/${config.keyVersion}`,
      method: "GET",
      timeout: 10_000,
    });
    if (
      data?.state !== "ENABLED" ||
      data?.algorithm !== "RSA_SIGN_PKCS1_2048_SHA256"
    ) {
      throw Error("signing key version not usable");
    }
  };
  clock = new ReferenceClock(deps.monotonicNow, checkSigningKey);
  const readiness = new BrokerReadiness({
    session,
    checkSigningKey,
    checkStore: () => store.ok(),
    clock,
  });
  await readiness.probe();
  const ready = readiness.state();
  if (!ready.identity || !ready.database || !ready.signing) {
    throw Error("broker not ready");
  }
  const signer = new KmsFederationSigner(config.keyVersion, {
    client: async () => kms,
  });

  // 4. The fabric: TLS with the pinned key only; a fresh metadata ID token
  // on every (re)connect.
  const client = deps.connect({
    address: config.fabricUrl.origin,
    path: config.fabricPath,
    transports: ["websocket"],
    agent: createPinnedAgent(config.fabricPin) as any,
    auth: (cb: (data: object) => void) => {
      metadataIdToken({
        fetchImpl: deps.textFetch,
        audience: config.clusterId,
        env: deps.env,
      }).then(
        (bearer) => cb({ bearer }),
        () => cb({}),
      );
    },
    noCache: true,
  } as ClientOptions);

  const lookups = createBrokerLookupDeps({
    lookupsAt: (bay) => createInterBayFederatedBrokerClient(client, bay),
    seedBayId: config.seedBayId,
  });
  // STS and iamcredentials responses refresh the reference too.
  const fetchImpl = async (url: string, init: any) => {
    const res = await deps.jsonFetch(url, { ...init, redirect: "error" });
    const reference = referenceDateFrom(
      url,
      res.status,
      res.headers.get("date"),
    );
    if (reference !== undefined) clock.record(reference);
    return res;
  };
  const broker = new FederatedTokenBroker({
    issuer: config.issuer,
    signer,
    fetchImpl,
    loadGrant: lookups.loadGrant,
    verifyLiveTurn: lookups.verifyLiveTurn,
    isAllowlisted: lookups.isAllowlisted,
    // Before every sign: its own key-version GET and strict Date (§4).
    referenceNow: createPreSignReference({
      kms,
      keyVersion: config.keyVersion,
      monotonicNow: deps.monotonicNow,
    }),
    now: deps.now,
    monotonicNow: deps.monotonicNow,
    withLeaseLock: store.withLeaseLock,
    recordMint: store.recordMint,
    recordMints: store.recordMints,
    limiter: new TokenBucketLimiter(DEFAULT_RATE_LIMITS),
  });
  const handler = createBrokerServiceHandler({
    clusterId: config.clusterId,
    homeBayOf: lookups.homeBayOf,
    getToken: (request, guard) => broker.getToken(request, guard),
    publicKeys: async () => [
      {
        version: config.keyVersion,
        spki_der_b64: spkiDerB64(await signer.publicKeyPem()),
      },
    ],
  });
  const service = createFederatedBrokerMintService(config.clusterId, handler, {
    client,
  });

  const instance_id = randomBytes(18).toString("base64url");
  const timers = [
    deps.every(READINESS_INTERVAL_MS, () => void readiness.probe()),
    // The heartbeat reads the cached readiness; it never signs.
    deps.every(HEARTBEAT_INTERVAL_MS, () => {
      void publishFederatedBrokerHeartbeat(client, config.clusterId, {
        instance_id,
        site_id: config.siteId,
        ready: readiness.state(),
      }).catch(() => {});
    }),
    deps.every(PURGE_INTERVAL_MS, () => void store.purge().catch(() => {})),
  ];
  // Also once at start, so a process restarted more often than daily still
  // purges (G3b-2 health alerts on a stale purge log).
  void store.purge().catch(() => {});
  return {
    readiness,
    stop() {
      for (const t of timers) t.stop();
      (service as any)?.close?.();
      client.close();
    },
  };
}

/** The process entry point (run by the broker's systemd unit). */
export async function main(): Promise<void> {
  const env = process.env;
  const config = parseBrokerConfig(env);
  const { Pool } = await import("pg");
  const { connect } = await import("@cocalc/conat/core/client");
  const pool = new Pool({
    // The local unix socket, peer authentication as broker_app.
    host: "/var/run/postgresql",
    user: "broker_app",
    database: "broker",
    max: 8,
    // The store's times are TIMESTAMP: always read and written in UTC.
    options: "-c timezone=UTC",
  });
  const textFetch: TextFetch = nodeTextFetch;
  const jsonFetch: JsonFetch = async (url, init) => await fetch(url, init);
  await startBroker(config, {
    env,
    textFetch,
    jsonFetch,
    pool: pool as unknown as BrokerStorePool,
    connect: (opts) => connect(opts),
    monotonicNow: () => performance.now(),
    now: () => Date.now(),
    every: (ms, fn) => {
      const t = setInterval(fn, ms);
      return { stop: () => clearInterval(t) };
    },
  });
}

if (require.main === module) {
  main().catch((err) => {
    // The message only: configuration errors name a variable, never a value.
    console.error(`federated broker: ${err?.message ?? "failed"}`);
    process.exit(1);
  });
}
