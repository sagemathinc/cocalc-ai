/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The computer's side of CoCalc (`cocalc computer connect`): pair with an
// account, then run the daemon and keep a conat session to the home bay.
// Plan: src/.agents/computers-plan-2026-10-11.md (part 4b, revision 3).
//
// Each session is its own conat connection: a fresh single-use challenge, a
// login signed by the computer's key, and subjects bound to that session.
// Conat's own reconnection is off (it would replay a consumed login); when
// a session ends (disconnect, lease, revocation) the loop logs in again.
//
// Files (owner-only, under ~/.local/share/cocalc/computers/<computer_id>):
//   connection.json  site, computer id and name
//   key.pem          the computer's private key, only for a computer without
//                    a time limit (a time-limited one keeps it in memory, so
//                    its session never outlives this process)
//   state/           the daemon's state, ledger, jobs and output

import { hostname, homedir, userInfo } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  parseComputerPolicy,
  parseRequestedPolicy,
  type ComputerPolicy,
} from "@cocalc/util/computers/policy";
import {
  parseComputerCertificate,
  parsePairingTranscript,
  parseSignedEnvelope,
  site as protocolSite,
  SIGNED_KINDS,
} from "@cocalc/util/computers/protocol";
import { UNSAFE_TEXT_CHARS } from "@cocalc/util/computers/canonical";
import { isValidUUID } from "@cocalc/util/misc";
import {
  computerOpSubject,
  computerSubjectAllowed,
  isSubjectToken,
  type ComputerOpMessage,
  type ComputerReplyMessage,
} from "@cocalc/conat/computers/subjects";
import { connect, type Client } from "@cocalc/conat/core/client";
import {
  generateAgreementKey,
  generateSigningKey,
  keyPairFromPrivatePem,
  policyHash,
  privateKeyToPem,
  randomNonce,
  signEnvelope,
  transcriptHash,
  transcriptPairingPhrase,
  type KeyPair,
} from "./crypto";
import {
  signChallengeRequest,
  signComputerLogin,
  type LoginChallengeView,
} from "./login";
import type { ReceiveLimits } from "@cocalc/conat/core/receive-budget";
import {
  ensurePrivateDir,
  readJson,
  writeDurable,
  writeDurableJson,
} from "./daemon/durable";
import { DaemonStore } from "./daemon/state";
import { ComputerDaemon } from "./daemon/daemon";
import { HubClock, SessionClock, systemClocks } from "./daemon/clock";

/**
 * Raw limits on what the hub may send, enforced before reassembly: an
 * operation message is a ticket, a proof and a request (stdin is at most
 * 1 MiB, base64).
 */
export const OP_RECEIVE_LIMITS: ReceiveLimits = {
  maxMessageBytes: 4 * 1024 * 1024,
  maxInflightBytes: 16 * 1024 * 1024,
  maxInflightMessages: 16,
  maxFragmentsPerMessage: 64,
};

export interface ConnectorIO {
  log(message: string): void;
  /** Ask the person at the machine; false if nobody can answer. */
  confirm(question: string): Promise<boolean>;
}

export interface Connection {
  dir: string;
  origin: string;
  computer_id: string;
  name: string;
  key: KeyPair;
  /**
   * For end-to-end encryption to this computer (not used yet). Only in
   * memory for a time-limited computer, like its signing key.
   */
  agreement?: KeyPair;
  /** From pairing: the session's limits (null: none). */
  duration: ComputerPolicy["duration"];
}

/** Where computers keep their files (XDG data dir). */
export function computersDir(): string {
  const base =
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(base, "cocalc", "computers");
}

/** `https://site/c/R-XXXXXXXXXX` -> its origin and request id. */
export function parsePairingUrl(url: string): {
  origin: string;
  request_id: string;
} {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(
      "give the line CoCalc showed you, like https://cocalc.ai/c/R-...",
    );
  }
  const m = u.pathname.match(/^\/c\/(R-[0-9A-HJ-NP-Z]{10})\/?$/);
  if (m == null || (u.protocol !== "https:" && u.protocol !== "http:")) {
    throw new Error(
      "give the line CoCalc showed you, like https://cocalc.ai/c/R-...",
    );
  }
  if (
    u.protocol === "http:" &&
    !["localhost", "127.0.0.1"].includes(u.hostname)
  ) {
    throw new Error("pairing needs https");
  }
  return { origin: u.origin, request_id: m[1] };
}

/** The pairing endpoints answer with small JSON objects. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One POST to the site's computers API. The site is untrusted until the
 * person at the machine confirms, so: no redirects (they could point this
 * machine at another origin, e.g. a local service), a timeout plus the
 * caller's abort signal, a byte cap read before parsing, and error text
 * cleaned before anyone prints it.
 */
async function post<T>(
  origin: string,
  path: string,
  body: object,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${origin}/api/v2/computers/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new Error("stopped");
    throw new Error(
      `could not reach ${origin}: ${clean((err as Error)?.message ?? err, 200)}`,
    );
  }
  let text: string;
  try {
    text = await readCapped(res, MAX_RESPONSE_BYTES);
  } catch (err) {
    if (signal?.aborted) throw new Error("stopped");
    throw new Error(`${origin}: ${clean((err as Error)?.message ?? err, 200)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${origin} answered ${res.status} without JSON`);
  }
  if (data?.error != null) throw new Error(clean(data.error, 300));
  if (!res.ok) throw new Error(`${origin} answered ${res.status}`);
  return data as T;
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (reader == null) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error("the server's answer is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Pair this machine: show the request, resolve the policy, claim it with
 * fresh keys, show the pairing phrase, and wait for the owner's approval.
 */
export async function pairComputer({
  url,
  io,
  pollMs = 2000,
  signal,
}: {
  url: string;
  io: ConnectorIO;
  pollMs?: number;
  signal?: AbortSignal;
}): Promise<Connection> {
  const { origin, request_id } = parsePairingUrl(url);
  // Nothing from the server is trusted as is: every field is parsed, and
  // identities come from the signed certificate and our own resolved policy.
  const view = parseView(
    await post<unknown>(origin, "pairing/view", { request_id }, signal),
    request_id,
    origin,
  );
  if (view.state !== "pending") {
    throw new Error(`this request is ${view.state}; make a new one in CoCalc`);
  }
  const requested = parseRequestedPolicy(view.requested_policy);
  if (requested.mode !== "direct") {
    throw new Error("only direct mode is supported so far");
  }
  if (requested.mounts.length > 0) {
    throw new Error("a direct-mode computer has no mounts");
  }
  const policy = parseComputerPolicy({ ...requested, mounts: [] });
  const limit =
    policy.duration == null
      ? "no time limit"
      : `${Math.round(policy.duration.initial_seconds / 60)} minutes (at most ${Math.round(policy.duration.max_seconds / 3600)} hours)`;
  io.log(
    [
      `${origin} asks to connect this computer:`,
      `  account:  ${view.account_label}`,
      `  name:     ${view.name}`,
      `  mode:     DIRECT: agents in that account's agent network run commands`,
      `            here as ${userInfo().username}, with all of your access`,
      `  time:     ${limit}`,
      view.why ? `  why:      ${view.why}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  // Always asked: connecting gives that account full trust here.
  if (!(await io.confirm("Connect this computer?"))) {
    throw new Error("not connected");
  }

  const key = generateSigningKey();
  const agreement = generateAgreementKey();
  const transcript = parsePairingTranscript({
    type: "cocalc-computer-pairing",
    version: 1,
    site: view.site,
    cluster_id: view.cluster_id,
    request_id,
    account_id: view.account_id,
    policy_hash: policyHash(policy),
    signing_key: key.fingerprint,
    agreement_key: agreement.fingerprint,
    client_nonce: randomNonce(),
    server_nonce: view.server_nonce,
    machine: {
      hostname: hostname().slice(0, 255),
      os: process.platform,
      arch: process.arch,
      user: userInfo().username,
    },
  });
  const ours = transcriptHash(transcript);
  const submitted: any = await post<unknown>(
    origin,
    "pairing/submit",
    {
      request_id,
      transcript: signEnvelope(SIGNED_KINDS.transcript, transcript, key),
      signing_public_key: key.publicDer,
      resolved_policy: policy,
    },
    signal,
  );
  if (submitted?.transcript_hash !== ours) {
    throw new Error("the server answered for another pairing");
  }
  // The phrase is ours to compute: it comes from the transcript we signed.
  const pairing_phrase = transcriptPairingPhrase(transcript);
  io.log(
    `\nPairing phrase:  ${pairing_phrase}\n\nApprove it in CoCalc, after checking it shows exactly this phrase. Waiting...`,
  );

  let status: any;
  for (;;) {
    if (signal?.aborted) throw new Error("stopped");
    status = await post<unknown>(
      origin,
      "pairing/status",
      { request_id, transcript_hash: ours },
      signal,
    );
    if (status?.state === "approved") break;
    if (status?.state === "expired") {
      throw new Error(
        "The request expired before it was approved. Ask for a new one in CoCalc and run its line again.",
      );
    }
    if (status?.state === "declined") {
      throw new Error("The request was declined in CoCalc.");
    }
    if (status?.state !== "paired" && status?.state !== "pending") {
      throw new Error(`The request is ${clean(status?.state, 40)}.`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const certificate = parseSignedEnvelope(
    status.certificate,
    parseComputerCertificate,
    "certificate",
  );
  const c = certificate.payload;
  // Everything the certificate binds must be what we paired.
  if (
    c.signing_key !== key.fingerprint ||
    c.signing_public_key !== key.publicDer ||
    c.agreement_key !== agreement.fingerprint ||
    c.transcript_hash !== ours ||
    c.ceiling_hash !== policyHash(policy) ||
    c.account_id !== view.account_id ||
    c.site !== view.site ||
    c.cluster_id !== view.cluster_id
  ) {
    throw new Error("the certificate is not for this pairing");
  }
  const computer_id = c.computer_id; // a UUID: the parser checked
  // The name the person at the machine confirmed; the status's is unsigned.
  const name = view.name;
  const dir = join(computersDir(), computer_id);
  // Never clobber another pairing's files (keys, ledger, jobs).
  if (existsSync(dir)) {
    throw new Error(
      `${dir} already exists; this computer id is already paired here`,
    );
  }
  ensurePrivateDir(dir);
  // Checks the certificate's signature against the home bay's key in the
  // directory (which DaemonStore validates key by key).
  DaemonStore.create(join(dir, "state"), {
    certificate,
    ceiling: policy,
    directory: Array.isArray(status.directory) ? status.directory : [],
    computer_key: key.fingerprint,
    agent_network_id: policy.agent_network_id,
  });
  const connection: Connection = {
    dir,
    origin,
    computer_id,
    name,
    key,
    agreement,
    duration: policy.duration,
  };
  writeDurableJson(join(dir, "connection.json"), {
    origin,
    computer_id,
    name,
    duration: policy.duration,
  });
  if (policy.duration == null) {
    writeDurable(join(dir, "key.pem"), privateKeyToPem(key.privateKey));
    // Kept for end-to-end encryption to this computer (not used yet).
    writeDurable(
      join(dir, "agreement.pem"),
      privateKeyToPem(agreement.privateKey),
    );
  }
  io.log(`Approved: this computer is @${name}.`);
  return connection;
}

const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Server text for the terminal: no control or bidi characters, bounded. */
function clean(value: unknown, max: number): string {
  return `${value ?? ""}`.replace(UNSAFE_TEXT_CHARS_GLOBAL, "?").slice(0, max);
}

const UNSAFE_TEXT_CHARS_GLOBAL = new RegExp(UNSAFE_TEXT_CHARS.source, "gu");

interface ParsedView {
  site: string;
  cluster_id: string;
  account_id: string;
  account_label: string;
  name: string;
  requested_policy: unknown;
  why: string;
  server_nonce: string;
  state: string;
}

function parseView(input: any, request_id: string, origin: string): ParsedView {
  if (input == null || typeof input !== "object") {
    throw new Error("the server's answer is malformed");
  }
  if (input.request_id !== request_id) {
    throw new Error("the server answered for another request");
  }
  if (!isValidUUID(input.account_id) || !NAME.test(`${input.name}`)) {
    throw new Error("the server's answer is malformed");
  }
  if (
    typeof input.server_nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.server_nonce)
  ) {
    throw new Error("the server's answer is malformed");
  }
  let site: string;
  try {
    site = protocolSite(input.site);
  } catch {
    throw new Error("the server's answer is malformed");
  }
  // The site the computer is paired with (and its certificate names) is the
  // one this machine actually talked to.
  if (site !== protocolSite(origin)) {
    throw new Error(
      `this pairing line is for ${clean(site, 200)}, not ${origin}`,
    );
  }
  return {
    site,
    cluster_id: `${input.cluster_id}`,
    account_id: input.account_id,
    account_label: clean(input.account_label, 200).replace(/\s+/g, " "),
    name: input.name,
    requested_policy: input.requested_policy,
    why: clean(input.why, 1000),
    server_nonce: input.server_nonce,
    state: clean(input.state, 40),
  };
}

/** A connected computer without a time limit, from its files. */
export function loadConnection(computer_id?: string): Connection {
  const root = computersDir();
  const ids =
    computer_id != null
      ? [computer_id]
      : existsSync(root)
        ? readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
        : [];
  if (computer_id != null && !isValidUUID(computer_id)) {
    throw new Error("a computer id is a UUID");
  }
  const found = ids.filter(
    (id) => isValidUUID(id) && existsSync(join(root, id, "key.pem")),
  );
  if (found.length !== 1) {
    throw new Error(
      found.length === 0
        ? "no connected computer here (a time-limited one ends with its process: connect again)"
        : `several computers here; name one: ${found.join(", ")}`,
    );
  }
  const dir = join(root, found[0]);
  const c = readJson<any>(join(dir, "connection.json"));
  if (c == null) throw new Error("this computer's files are incomplete");
  const pem = readFileSync(join(dir, "key.pem"), "utf8");
  return {
    dir,
    origin: c.origin,
    computer_id: c.computer_id,
    name: c.name,
    key: keyPairFromPrivatePem(pem),
    duration: c.duration ?? null,
  };
}

export interface RunOptions {
  connection: Connection;
  io: ConnectorIO;
  signal?: AbortSignal;
  /** Tests: how to get a challenge and open a conat connection. */
  challenge?: () => Promise<LoginChallengeView>;
  openConat?: (auth: object) => Client;
  /** Log in again this long before the lease (15 min) ends. */
  sessionMs?: number;
  /** Tests: called once each session is subscribed. */
  onSession?: (session_id: string) => void;
}

/**
 * Run the daemon and keep a session to the home bay until stopped (or the
 * session's time is over).
 */
export async function runConnector(opts: RunOptions): Promise<void> {
  const { connection, io, signal } = opts;
  const store = DaemonStore.open(join(connection.dir, "state"));
  if (store == null) throw new Error("this computer has no daemon state");
  const clocks = systemClocks;
  const hubClock = new HubClock(clocks);
  const session = new SessionClock(clocks, {
    deadline_ms:
      connection.duration == null
        ? null
        : connection.duration.initial_seconds * 1000,
    max_ms:
      connection.duration == null
        ? null
        : connection.duration.max_seconds * 1000,
  });
  const daemon = new ComputerDaemon({
    stateDir: join(connection.dir, "state"),
    store,
    clocks,
    hubClock,
    session,
    workdir: homedir(),
    onError: (err) => io.log(`daemon: ${err}`),
  });
  daemon.start();
  const challenge =
    opts.challenge ??
    (() =>
      post<LoginChallengeView>(
        connection.origin,
        "session/challenge",
        {
          request: signChallengeRequest({
            certificate: store.certificate,
            key: connection.key,
          }),
        },
        signal,
      ));
  const openConat =
    opts.openConat ??
    ((auth: object) =>
      connect({
        address: connection.origin,
        noCache: true,
        reconnection: false,
        // A computer may not subscribe to _INBOX (and makes no requests).
        disableInbox: true,
        auth,
      } as any));
  let backoff = 1000;
  try {
    while (!signal?.aborted && !daemon.sessionEnded) {
      try {
        await oneSession({
          ...opts,
          store,
          daemon,
          hubClock,
          challenge,
          openConat,
        });
        backoff = 1000;
      } catch (err) {
        io.log(`connection: ${(err as Error).message ?? err}`);
        backoff = Math.min(backoff * 2, 60_000);
      }
      if (signal?.aborted || daemon.sessionEnded) break;
      await new Promise((r) => setTimeout(r, backoff * (0.5 + Math.random())));
    }
  } finally {
    daemon.stop();
  }
  if (daemon.sessionEnded) io.log("this computer's session has ended");
}

async function oneSession({
  connection,
  io,
  signal,
  store,
  daemon,
  hubClock,
  challenge,
  openConat,
  sessionMs = 14 * 60 * 1000,
  onSession,
}: RunOptions & {
  store: DaemonStore;
  daemon: ComputerDaemon;
  hubClock: HubClock;
  challenge: () => Promise<LoginChallengeView>;
  openConat: (auth: object) => Client;
}): Promise<void> {
  const c = await challenge();
  const login = signComputerLogin({
    challenge: c,
    certificate: store.certificate,
    key: connection.key,
  });
  const session_id = c.challenge_id;
  const client = openConat({ computer_login: login });
  let sub: Awaited<ReturnType<Client["subscribe"]>> | undefined;
  const end = () => sub?.close();
  const timer = setTimeout(end, sessionMs);
  signal?.addEventListener("abort", end);
  try {
    sub = await client.subscribe(
      computerOpSubject(connection.computer_id, session_id),
      { receiveLimits: OP_RECEIVE_LIMITS },
    );
    client.conn?.on?.("disconnect", end);
    io.log(`connected (@${connection.name})`);
    onSession?.(session_id);
    for await (const mesg of sub) {
      void answer({
        client,
        daemon,
        hubClock,
        computer_id: connection.computer_id,
        session_id,
        data: mesg.data,
      }).catch((err) => io.log(`answer: ${err}`));
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", end);
    sub?.close();
    client.close();
  }
}

async function answer({
  client,
  daemon,
  hubClock,
  computer_id,
  session_id,
  data,
}: {
  client: Client;
  daemon: ComputerDaemon;
  hubClock: HubClock;
  computer_id: string;
  session_id: string;
  data: unknown;
}): Promise<void> {
  const received_at = systemClocks.continuous();
  const op = data as Partial<ComputerOpMessage> | null;
  if (
    op == null ||
    op.v !== 1 ||
    !isSubjectToken(op.correlation) ||
    typeof op.reply_subject !== "string" ||
    // Only to a reply subject of this very session, ending in this
    // correlation (conat auth refuses anything else anyway).
    !computerSubjectAllowed(computer_id, session_id, op.reply_subject, "pub") ||
    !op.reply_subject.endsWith(`.${op.correlation}`) ||
    op.message == null
  ) {
    return;
  }
  if (typeof op.hub_now === "number") {
    hubClock.observe(op.hub_now - systemClocks.wall());
  }
  const reply = await daemon.handle({
    ticket: op.message.ticket,
    proof: op.message.proof,
    request: op.message.request,
    received_at,
  });
  const out: ComputerReplyMessage = {
    v: 1,
    correlation: op.correlation,
    reply,
  };
  await client.publish(op.reply_subject, out);
}
