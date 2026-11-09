/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The token broker process's parts (G3b design v3 §§1-4, v3.1, v3.3), each
testable alone; broker-main.ts wires them together.

- SignerSession: the broker's own access token, from the metadata server
  only, re-verified against the signer record on every refresh.
- createKmsClient: KMS calls with that token. Every successful response's
  Date header (cloudkms is one of the four reference origins) refreshes the
  reference clock.
- ReferenceClock: referenceNow from those Date headers, probed on demand.
- Readiness: a periodic probe (a GET of the key version: no signature, so no
  unaccounted KMS signature on any heartbeat) and a store guard check, cached
  for the heartbeat to read.
- createBrokerLookupDeps: the broker's four lookups on bays, with every reply
  parsed strictly; nothing learned is logged (counts only).
- createBrokerStore: the local store as broker_app.
- createPinnedAgent: the fabric connection's TLS, accepted only for the
  pinned SPKI sha256 (v3.3.2); nothing is written on the socket before the
  pin matches, so a wrong endpoint never sees the broker's credential.
*/

import { createHash } from "node:crypto";
import { Agent } from "node:https";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import { isUuid } from "@cocalc/util/ai/federated-connectors";
import type { InterBayFederatedBrokerApi } from "@cocalc/conat/inter-bay/federated-broker";
import {
  BROKER_STORE_RECORD_MINT_SQL,
  getBrokerStoreStatus,
  purgeBrokerMintLog,
} from "@cocalc/database/postgres/schema/federated-broker-store";
import type {
  BrokerDeps,
  ConnectionRecord,
  GrantRecord,
  MintLogRow,
  MintRequest,
} from "./broker";
import { parseHomeBayReply } from "./broker-lookups";
import type { BrokerReadyState } from "./broker-registration";
import { mintLogParams, withLeaseLockOn, type LockPool } from "./db";
import {
  GoogleIdentityError,
  signerAccessToken,
  type SignerRecord,
  type TextFetch,
} from "./google-identity";
import type { KmsHttpClient } from "./signer";

export const REFERENCE_ORIGINS = [
  "https://cloudkms.googleapis.com",
  "https://sts.googleapis.com",
  "https://iamcredentials.googleapis.com",
  "https://oauth2.googleapis.com",
] as const;

const IMF_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const IMF_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const IMF_RE =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

/**
 * An RFC 7231 IMF-fixdate ("Sun, 06 Nov 1994 08:49:37 GMT"), strictly: that
 * exact form, real calendar fields (no rollover) and the matching weekday.
 * Anything else (RFC 850, asctime, other zones) is undefined.
 */
export function parseImfFixdate(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const m = IMF_RE.exec(value);
  if (m == null) return;
  const [, day, dd, mon, yyyy, hh, mi, ss] = m;
  const year = Number(yyyy);
  const month = IMF_MONTHS.indexOf(mon);
  const date = Number(dd);
  const hour = Number(hh);
  const minute = Number(mi);
  const second = Number(ss);
  if (hour > 23 || minute > 59 || second > 60) return;
  const t = Date.UTC(year, month, date, hour, minute, Math.min(second, 59));
  const d = new Date(t);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month ||
    d.getUTCDate() !== date ||
    IMF_DAYS[d.getUTCDay()] !== day
  ) {
    return;
  }
  return t;
}

/** A reference time from a successful response of one of the four origins. */
export function referenceDateFrom(
  url: string,
  status: number,
  date: string | null,
): number | undefined {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  if (!(REFERENCE_ORIGINS as readonly string[]).includes(origin)) return;
  if (status < 200 || status > 299 || !date) return;
  return parseImfFixdate(date);
}

/** A reference is valid for this long, by the monotonic clock (§7). */
export const REFERENCE_VALID_MS = 60_000;

/** The latest reference for readiness (never the pre-sign source). */
export class ReferenceClock {
  private last?: { reference: number; monotonic: number };

  constructor(
    private monotonicNow: () => number,
    private probe: () => Promise<void>,
    private maxAgeMs = REFERENCE_VALID_MS,
  ) {}

  record(reference: number): void {
    this.last = { reference, monotonic: this.monotonicNow() };
  }

  fresh(): boolean {
    if (this.last == null) return false;
    const age = this.monotonicNow() - this.last.monotonic;
    return age >= 0 && age <= this.maxAgeMs;
  }

  private now(): number {
    return this.last!.reference + (this.monotonicNow() - this.last!.monotonic);
  }

  async referenceNow(): Promise<number> {
    if (!this.fresh()) await this.probe();
    if (!this.fresh()) throw Error("no fresh reference time");
    return this.now();
  }
}

/** The broker's own access token, verified against the signer record. */
export class SignerSession {
  private current?: { token: string; until: number };
  private verifiedUntil = 0;

  constructor(
    private opts: {
      fetchImpl: TextFetch;
      record: SignerRecord;
      env: Record<string, string | undefined>;
      monotonicNow: () => number;
    },
  ) {}

  /** True while the last verification is still within the token's life. */
  verified(): boolean {
    return this.opts.monotonicNow() < this.verifiedUntil;
  }

  async token(): Promise<string> {
    const now = this.opts.monotonicNow();
    if (this.current != null && now < this.current.until) {
      return this.current.token;
    }
    this.current = undefined;
    try {
      const { accessToken, expiresInS } = await signerAccessToken(this.opts);
      // Refresh a minute early; never trust a token past its stated life.
      const until = now + Math.max(0, expiresInS - 60) * 1000;
      this.current = { token: accessToken, until };
      this.verifiedUntil = until;
      return accessToken;
    } catch (err) {
      this.verifiedUntil = 0;
      throw err;
    }
  }
}

export type JsonFetch = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect: "error";
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
}>;

/** KMS over the verified signer token; successes refresh the reference. */
export function createKmsClient({
  fetchImpl,
  session,
  onReference,
}: {
  fetchImpl: JsonFetch;
  session: Pick<SignerSession, "token">;
  onReference: (reference: number) => void;
}): KmsHttpClient & {
  /** A request and its own response's reference (strict Date), if any. */
  requestWithReference<T>(opts: {
    url: string;
    method: "GET" | "POST";
    data?: unknown;
    timeout: number;
  }): Promise<{ data: T; reference: number | undefined }>;
} {
  const send = async <T>({
    url,
    method,
    data,
    timeout,
  }: {
    url: string;
    method: "GET" | "POST";
    data?: unknown;
    timeout: number;
  }): Promise<{ data: T; reference: number | undefined }> => {
    if (!url.startsWith("https://cloudkms.googleapis.com/v1/")) {
      throw Error("refused: not a KMS URL");
    }
    const token = await session.token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: controller.signal,
        redirect: "error",
      });
      const reference = referenceDateFrom(
        url,
        res.status,
        res.headers.get("date"),
      );
      if (reference !== undefined) onReference(reference);
      if (res.status < 200 || res.status > 299) {
        // No body or token in the error: only the status.
        throw Error(`KMS request failed (${res.status})`);
      }
      return { data: (await res.json()) as T, reference };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async request<T>(opts: {
      url: string;
      method: "GET" | "POST";
      data?: unknown;
      timeout: number;
    }): Promise<{ data: T }> {
      const { data } = await send<T>(opts);
      return { data };
    },
    requestWithReference: send,
  };
}

/**
 * The pre-sign reference (design v3.4.2 §4): each call makes its own GET of
 * the signing key version (ENABLED, RSA_SIGN_PKCS1_2048_SHA256) and returns
 * that response's strict Date, advanced by the monotonic time since, valid
 * for 60 s. Nothing cached: two signs, two GETs.
 */
export function createPreSignReference({
  kms,
  keyVersion,
  monotonicNow,
}: {
  kms: Pick<ReturnType<typeof createKmsClient>, "requestWithReference">;
  keyVersion: string;
  monotonicNow: () => number;
}): () => Promise<number> {
  return async () => {
    const { data, reference } = await kms.requestWithReference<{
      state?: string;
      algorithm?: string;
    }>({
      url: `https://cloudkms.googleapis.com/v1/${keyVersion}`,
      method: "GET",
      timeout: 10_000,
    });
    const at = monotonicNow();
    if (
      data?.state !== "ENABLED" ||
      data?.algorithm !== "RSA_SIGN_PKCS1_2048_SHA256"
    ) {
      throw Error("signing key version not usable");
    }
    if (reference === undefined) throw Error("no reference time");
    const age = monotonicNow() - at;
    if (!(age >= 0) || age > REFERENCE_VALID_MS) {
      throw Error("reference time too old");
    }
    return reference + age;
  };
}

/**
 * Readiness for the heartbeat, refreshed by a periodic probe, never by the
 * heartbeat itself. The probe makes no signature.
 */
export class BrokerReadiness {
  private signingOk = false;
  private databaseOk = false;

  constructor(
    private parts: {
      session: Pick<SignerSession, "token" | "verified">;
      /** A GET of the signing key version (state ENABLED, the algorithm). */
      checkSigningKey: () => Promise<void>;
      checkStore: () => Promise<boolean>;
      clock: Pick<ReferenceClock, "fresh">;
    },
  ) {}

  async probe(): Promise<void> {
    try {
      await this.parts.session.token();
      await this.parts.checkSigningKey();
      this.signingOk = true;
    } catch {
      this.signingOk = false;
    }
    try {
      this.databaseOk = await this.parts.checkStore();
    } catch {
      this.databaseOk = false;
    }
  }

  state(): BrokerReadyState {
    return {
      identity: this.parts.session.verified(),
      database: this.databaseOk,
      reference_time: this.parts.clock.fresh(),
      signing: this.signingOk,
    };
  }
}

// ---------------------------------------------------------------------------
// The four lookups, strictly.

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

const isText = (v: unknown, max = 512): v is string =>
  typeof v === "string" && v.length <= max;

const GRANT_KEYS = [
  "grant_id",
  "account_id",
  "connection_id",
  "revision",
  "state",
  "service_account",
  "sa_label",
  "target_project",
  "permission_profile",
] as const;
const CONNECTION_KEYS = [
  "connection_id",
  "account_id",
  "provider",
  "state",
  "audience_test_passed",
  "provider_ref",
] as const;
const PROVIDER_REF_KEYS = [
  "pool_project_number",
  "pool_id",
  "provider_id",
] as const;

/**
 * A loadGrant reply: null (no such grant), the exact grant and connection,
 * or undefined when malformed. The broker's own checks then decide.
 */
export function parseLoadGrantReply(
  value: unknown,
): { grant: GrantRecord; connection: ConnectionRecord } | null | undefined {
  if (value === null) return null;
  if (!exactKeys(value, ["grant", "connection"])) return;
  const { grant: g, connection: c } = value as Record<string, any>;
  if (!exactKeys(g, GRANT_KEYS) || !exactKeys(c, CONNECTION_KEYS)) return;
  if (
    !isUuid(g.grant_id) ||
    !isUuid(g.account_id) ||
    !isUuid(g.connection_id) ||
    !Number.isSafeInteger(g.revision) ||
    g.revision < 1 ||
    !isText(g.state, 32) ||
    !isText(g.service_account) ||
    !isText(g.sa_label) ||
    !isText(g.target_project) ||
    !isText(g.permission_profile, 64)
  ) {
    return;
  }
  if (
    !isUuid(c.connection_id) ||
    !isUuid(c.account_id) ||
    !isText(c.provider, 32) ||
    !isText(c.state, 32) ||
    typeof c.audience_test_passed !== "boolean" ||
    !exactKeys(c.provider_ref, PROVIDER_REF_KEYS) ||
    !PROVIDER_REF_KEYS.every((k) => isText(c.provider_ref[k], 128))
  ) {
    return;
  }
  return { grant: g as GrantRecord, connection: c as ConnectionRecord };
}

export interface BrokerLookupCounters {
  invalid_replies: number;
  failed_lookups: number;
}

/** The broker's lookup deps over the fabric (v3.3: the seed's homeBay). */
export function createBrokerLookupDeps({
  lookupsAt,
  seedBayId,
}: {
  lookupsAt: (bay_id: string) => InterBayFederatedBrokerApi;
  seedBayId: string;
}) {
  const counters: BrokerLookupCounters = {
    invalid_replies: 0,
    failed_lookups: 0,
  };
  const call = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      counters.failed_lookups += 1;
      throw Error("lookup failed");
    }
  };
  const invalid = (): never => {
    counters.invalid_replies += 1;
    throw Error("lookup reply invalid");
  };

  async function homeBayOf(account_id: string): Promise<string | undefined> {
    const reply = await call(() =>
      lookupsAt(seedBayId).homeBay({ account_id }),
    );
    return parseHomeBayReply(reply) ?? invalid();
  }

  const loadGrant: BrokerDeps["loadGrant"] = async (opts) => {
    const home = await homeBayOf(opts.account_id);
    const reply = await call(() => lookupsAt(home!).loadGrant(opts));
    const parsed = parseLoadGrantReply(reply);
    return parsed === undefined ? invalid() : parsed;
  };

  const verifyLiveTurn = async (request: MintRequest): Promise<void> => {
    const home = await homeBayOf(request.account_id);
    const reply = await call(() => lookupsAt(home!).verifyLiveTurn(request));
    if (!exactKeys(reply, ["live"]) || (reply as any).live !== true) {
      invalid();
    }
  };

  const isAllowlisted: BrokerDeps["isAllowlisted"] = async (entry) => {
    const reply = await call(() =>
      lookupsAt(seedBayId).isAllowlisted(entry as any),
    );
    if (
      !exactKeys(reply, ["allowlisted"]) ||
      typeof (reply as any).allowlisted !== "boolean"
    ) {
      invalid();
    }
    return (reply as { allowlisted: boolean }).allowlisted;
  };

  return { counters, homeBayOf, loadGrant, verifyLiveTurn, isAllowlisted };
}

// ---------------------------------------------------------------------------
// The local store, as broker_app.

export interface BrokerStorePool extends LockPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export function createBrokerStore(pool: BrokerStorePool) {
  return {
    async recordMint(row: MintLogRow): Promise<void> {
      await pool.query(BROKER_STORE_RECORD_MINT_SQL, mintLogParams(row));
    },
    /** Several rows in one transaction: all of them, or none. */
    async recordMints(rows: MintLogRow[]): Promise<void> {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query("BEGIN");
        for (const row of rows) {
          await client.query(BROKER_STORE_RECORD_MINT_SQL, mintLogParams(row));
        }
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          broken = true;
        }
        throw err;
      } finally {
        client.release(broken ? true : undefined);
      }
    },
    async withLeaseLock<T>(lease_id: string, fn: () => Promise<T>) {
      return await withLeaseLockOn(pool, lease_id, fn);
    },
    async purge(): Promise<number> {
      return await purgeBrokerMintLog(pool);
    },
    async ok(): Promise<boolean> {
      return (await getBrokerStoreStatus(pool)).state === "ok";
    },
  };
}

// ---------------------------------------------------------------------------
// The fabric connection's TLS pin.

/** The sha256 (hex) of a certificate's DER SubjectPublicKeyInfo. */
export function spkiSha256(socket: TLSSocket): string | undefined {
  const cert = socket.getPeerX509Certificate?.();
  if (cert == null) return;
  const spki = cert.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("hex");
}

const PIN_RE = /^[0-9a-f]{64}$/;

/**
 * An https Agent for the fabric that completes the TLS handshake, checks the
 * peer's SPKI sha256 against the pin, and only then hands the socket over.
 * The CA chain isn't what's trusted here (an internal listener may have a
 * private certificate); the pin is. A mismatch or a handshake failure is an
 * error with the socket destroyed, before any byte is written.
 */
export function createPinnedAgent(pin: string): Agent {
  if (!PIN_RE.test(pin)) throw Error("invalid fabric pin");
  const agent = new Agent({ keepAlive: false, maxSockets: 4 });
  (agent as any).createConnection = (
    options: any,
    oncreate: (err: Error | null, socket?: TLSSocket) => void,
  ) => {
    let done = false;
    const finish = (err: Error | null, socket?: TLSSocket) => {
      if (done) return;
      done = true;
      oncreate(err, socket);
    };
    const socket = tlsConnect({
      host: options.host,
      port: options.port,
      servername: options.servername,
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
      rejectUnauthorized: false,
    });
    socket.once("secureConnect", () => {
      if (spkiSha256(socket) !== pin) {
        socket.destroy();
        finish(Error("fabric pin mismatch"));
        return;
      }
      finish(null, socket);
    });
    socket.once("error", (err) => {
      socket.destroy();
      finish(err);
    });
    return undefined;
  };
  return agent;
}

/** The fabric URL: https only, never a plaintext fallback. */
export function parseFabricUrl(value: unknown): URL {
  if (typeof value !== "string") throw Error("invalid fabric url");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw Error("the fabric url must be https, without credentials");
  }
  return url;
}

export { GoogleIdentityError };
