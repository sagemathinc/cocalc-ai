/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Requests to connect a computer, and device-first pairing. Runs at the
// account's home bay. Plan: src/.agents/computers-plan-2026-10-11.md ("How it
// looks to the human", "Enrollment and the daemon's identity").
//
// 1. An agent (or the owner) creates a request: a requested policy and a
//    non-secret request id. Nothing is allowed yet.
// 2. The machine fetches the request, resolves the policy locally, generates
//    its keys and submits a signed pairing transcript. The request becomes
//    "paired" and gets a pairing phrase derived from the transcript.
//    A second claimant invalidates the request; it never replaces the first.
// 3. The owner approves that transcript (fresh auth, checked by the RPC
//    layer). The home bay creates the computer and signs its certificate.
//    No secret is delivered: the daemon proves possession of its key later.

import { randomBytes, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import {
  parseComputerPolicy,
  parseRequestedPolicy,
  resolvedPolicyMismatches,
  type ComputerPolicy,
  type RequestedPolicy,
} from "@cocalc/util/computers/policy";
import {
  parseComputerCertificate,
  parsePairingTranscript,
  parseSignedEnvelope,
  SIGNED_KINDS,
  type ComputerCertificate,
  type PairingTranscript,
  type SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import {
  fingerprintOf,
  policyHash,
  randomNonce,
  signEnvelope,
  signingPublicKeyFromDer,
  transcriptHash,
  transcriptPairingPhrase,
  verifyEnvelope,
} from "@cocalc/backend/computers/crypto";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterId } from "@cocalc/server/cluster-config";
import { getBaySigningKey } from "./signing-keys";
import { computersSite } from "./site";

export const REQUEST_LIFETIME_MS = 15 * 60 * 1000;
export const MAX_OPEN_REQUESTS_PER_ACCOUNT = 10;
export const MAX_COMPUTERS_PER_ACCOUNT = 20;
/** Without a time limit, a certificate is renewed before this runs out. */
export const CERTIFICATE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WHY_LENGTH = 1000;

const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// Crockford-like alphabet: no I or O.
const REQUEST_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export class ComputerRequestError extends Error {}

export function newRequestId(): string {
  const bytes = randomBytes(10);
  let id = "R-";
  for (const b of bytes) id += REQUEST_ALPHABET[b % REQUEST_ALPHABET.length];
  return id;
}

export function computerName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new ComputerRequestError(
      "a computer name is 1-32 lowercase letters, digits and dashes, starting with a letter",
    );
  }
  return value;
}

export interface RequestedBy {
  agent_id: string;
  run_id: string;
  project_id: string;
  thread_id?: string | null;
}

export async function createComputerRequest({
  account_id,
  requested_by,
  name,
  requested_policy,
  why = "",
  now = Date.now(),
}: {
  account_id: string;
  requested_by?: RequestedBy;
  name: string;
  requested_policy: unknown;
  why?: string;
  now?: number;
}): Promise<{
  request_id: string;
  expires_at: number;
  policy: RequestedPolicy;
}> {
  requireUuid(account_id, "account_id");
  const alias = computerName(name);
  const policy = parseRequestedPolicy(requested_policy);
  if (typeof why !== "string" || why.length > MAX_WHY_LENGTH) {
    throw new ComputerRequestError("why must be at most 1000 characters");
  }
  if (requested_by) {
    requireUuid(requested_by.agent_id, "agent_id");
    requireUuid(requested_by.run_id, "run_id");
    requireUuid(requested_by.project_id, "project_id");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Serialize per account so the cap holds under concurrency.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `account_computer_requests:${account_id}`,
    ]);
    const network = await client.query(
      `SELECT state FROM agent_networks WHERE account_id=$1 AND agent_network_id=$2`,
      [account_id, policy.agent_network_id],
    );
    if (network.rows[0]?.state !== "active") {
      throw new ComputerRequestError(
        "no such active agent network on this account",
      );
    }
    const open = await client.query(
      `SELECT count(*)::int AS n FROM account_computer_requests
        WHERE account_id=$1 AND state IN ('pending','paired') AND expires_at > $2`,
      [account_id, new Date(now)],
    );
    if (open.rows[0].n >= MAX_OPEN_REQUESTS_PER_ACCOUNT) {
      throw new ComputerRequestError("too many open computer requests");
    }
    const request_id = newRequestId();
    const expires_at = now + REQUEST_LIFETIME_MS;
    await client.query(
      `INSERT INTO account_computer_requests
         (request_id, account_id, requested_by_agent_id, requested_by_run_id,
          source_project_id, thread_id, name, requested_policy, why, state,
          server_nonce, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$12)`,
      [
        request_id,
        account_id,
        requested_by?.agent_id ?? null,
        requested_by?.run_id ?? null,
        requested_by?.project_id ?? null,
        requested_by?.thread_id ?? null,
        alias,
        JSON.stringify(policy),
        why,
        randomNonce(),
        new Date(expires_at),
        new Date(now),
      ],
    );
    await client.query("COMMIT");
    return { request_id, expires_at, policy };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** What the machine needs to show the owner before pairing. Not secret. */
export interface PairingView {
  site: string;
  cluster_id: string;
  request_id: string;
  account_id: string;
  name: string;
  requested_policy: RequestedPolicy;
  why: string;
  server_nonce: string;
  state: string;
  expires_at: number;
}

export async function getPairingView(
  request_id: string,
  now = Date.now(),
): Promise<PairingView> {
  const row = await loadRequest(request_id);
  if (row == null) throw new ComputerRequestError("no such computer request");
  return {
    site: await computersSite(),
    cluster_id: getConfiguredClusterId(),
    request_id: row.request_id,
    account_id: row.account_id,
    name: row.name,
    requested_policy: parseRequestedPolicy(row.requested_policy),
    why: row.why,
    server_nonce: row.server_nonce,
    state:
      new Date(row.expires_at).valueOf() <= now && isOpen(row.state)
        ? "expired"
        : row.state,
    expires_at: new Date(row.expires_at).valueOf(),
  };
}

/**
 * The machine's pairing transcript. It must be signed by the key it names,
 * for this site, cluster, request, account and nonce, with a resolved policy
 * that matches the request. A second claimant invalidates the request.
 */
export async function submitPairing({
  request_id,
  transcript: envelopeInput,
  signing_public_key,
  resolved_policy,
  now = Date.now(),
}: {
  request_id: string;
  transcript: unknown;
  signing_public_key: string;
  resolved_policy: unknown;
  now?: number;
}): Promise<{ pairing_phrase: string; transcript_hash: string }> {
  const envelope = parseSignedEnvelope(
    envelopeInput,
    parsePairingTranscript,
    "transcript",
  );
  const t = envelope.payload;
  const signingKey = signingPublicKeyFromDer(signing_public_key);
  const fp = fingerprintOf(signingKey);
  if (fp !== t.signing_key || fp !== envelope.kid) {
    throw new ComputerRequestError(
      "transcript is not signed by the key it names",
    );
  }
  if (
    !verifyEnvelope(SIGNED_KINDS.transcript, envelope, (kid) =>
      kid === fp ? signingKey : undefined,
    )
  ) {
    throw new ComputerRequestError("transcript signature is invalid");
  }
  const resolved = parseComputerPolicy(resolved_policy);
  if (policyHash(resolved) !== t.policy_hash) {
    throw new ComputerRequestError(
      "transcript does not match the resolved policy",
    );
  }
  if (
    t.site !== (await computersSite()) ||
    t.cluster_id !== getConfiguredClusterId()
  ) {
    throw new ComputerRequestError("transcript is for another site");
  }
  if (t.request_id !== request_id) {
    throw new ComputerRequestError("transcript is for another request");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM account_computer_requests WHERE request_id=$1 FOR UPDATE`,
      [request_id],
    );
    const row = rows[0];
    if (row == null) throw new ComputerRequestError("no such computer request");
    if (new Date(row.expires_at).valueOf() <= now) {
      throw new ComputerRequestError(
        "this computer request expired; make a new one",
      );
    }
    if (row.state === "paired") {
      // Someone else already paired: never replace the first key. The owner
      // is told there were multiple claimants and makes a new request.
      await client.query(
        `UPDATE account_computer_requests
            SET state='invalidated', claimants=claimants+1, updated_at=$2
          WHERE request_id=$1`,
        [request_id, new Date(now)],
      );
      await client.query("COMMIT");
      throw new ComputerRequestError(
        "another computer already claimed this request; it is now invalid, make a new one",
      );
    }
    if (row.state !== "pending") {
      throw new ComputerRequestError(`this computer request is ${row.state}`);
    }
    if (
      t.account_id !== row.account_id ||
      t.server_nonce !== row.server_nonce
    ) {
      throw new ComputerRequestError("transcript does not match this request");
    }
    const mismatches = resolvedPolicyMismatches(
      parseRequestedPolicy(row.requested_policy),
      resolved,
    );
    if (mismatches.length > 0) {
      throw new ComputerRequestError(
        `the resolved policy differs from the request: ${mismatches.join("; ")}`,
      );
    }
    const hash = transcriptHash(t);
    const phrase = transcriptPairingPhrase(t);
    await client.query(
      `UPDATE account_computer_requests
          SET state='paired', transcript=$2, transcript_hash=$3, pairing_phrase=$4,
              resolved_policy=$5, claimants=claimants+1, updated_at=$6
        WHERE request_id=$1`,
      [
        request_id,
        JSON.stringify({ ...envelope, signing_public_key }),
        hash,
        phrase,
        JSON.stringify(resolved),
        new Date(now),
      ],
    );
    await client.query("COMMIT");
    return { pairing_phrase: phrase, transcript_hash: hash };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface ApprovedComputer {
  computer_id: string;
  certificate: SignedEnvelope<ComputerCertificate>;
  policy: ComputerPolicy;
}

/**
 * The owner approves a paired request (the RPC layer checks fresh auth and
 * that the caller is account_id). The approval binds the transcript hash the
 * owner was shown.
 */
export async function approveComputerRequest({
  account_id,
  request_id,
  transcript_hash,
  now = Date.now(),
}: {
  account_id: string;
  request_id: string;
  transcript_hash: string;
  now?: number;
}): Promise<ApprovedComputer> {
  requireUuid(account_id, "account_id");
  // Get the signing key before the transaction: it may need its own query.
  const signer = await getBaySigningKey();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `account_computers:${account_id}`,
    ]);
    const { rows } = await client.query(
      `SELECT * FROM account_computer_requests WHERE request_id=$1 FOR UPDATE`,
      [request_id],
    );
    const row = rows[0];
    if (row == null || row.account_id !== account_id) {
      throw new ComputerRequestError("no such computer request");
    }
    if (row.state !== "paired") {
      throw new ComputerRequestError(`this computer request is ${row.state}`);
    }
    if (new Date(row.expires_at).valueOf() <= now) {
      throw new ComputerRequestError(
        "this computer request expired; make a new one",
      );
    }
    if (row.transcript_hash !== transcript_hash) {
      throw new ComputerRequestError(
        "the computer changed since you saw it; look again",
      );
    }
    const count = await client.query(
      `SELECT count(*)::int AS n FROM account_computers
        WHERE account_id=$1 AND tombstoned_at IS NULL`,
      [account_id],
    );
    if (count.rows[0].n >= MAX_COMPUTERS_PER_ACCOUNT) {
      throw new ComputerRequestError("too many computers on this account");
    }
    const taken = await client.query(
      `SELECT 1 FROM account_computers
        WHERE account_id=$1 AND name=$2 AND tombstoned_at IS NULL`,
      [account_id, row.name],
    );
    if (taken.rows.length > 0) {
      throw new ComputerRequestError(
        `a computer named ${row.name} already exists`,
      );
    }
    const envelope = row.transcript as SignedEnvelope<PairingTranscript> & {
      signing_public_key: string;
    };
    const transcript = parsePairingTranscript(envelope.payload);
    const policy = parseComputerPolicy(row.resolved_policy);
    const computer_id = randomUUID();
    const deadline =
      policy.duration == null
        ? null
        : now + policy.duration.initial_seconds * 1000;
    const max_deadline =
      policy.duration == null ? null : now + policy.duration.max_seconds * 1000;
    const home_bay_id = getConfiguredBayId();
    const home_epoch = 0;
    const certificate = signEnvelope(
      SIGNED_KINDS.certificate,
      parseComputerCertificate({
        type: "cocalc-computer-certificate",
        version: 1,
        site: transcript.site,
        cluster_id: transcript.cluster_id,
        computer_id,
        account_id,
        home_bay_id,
        home_epoch,
        signing_key: transcript.signing_key,
        signing_public_key: envelope.signing_public_key,
        agreement_key: transcript.agreement_key,
        transcript_hash: row.transcript_hash,
        ceiling_hash: policyHash(policy),
        not_before: now,
        not_after: max_deadline ?? now + CERTIFICATE_LIFETIME_MS,
      }),
      signer,
    );
    await client.query(
      `INSERT INTO account_computers
         (computer_id, account_id, name, hostname, os, arch, machine_user, mode,
          agent_network_id, policy_ceiling, ceiling_hash, effective_policy,
          policy_epoch, epoch, home_bay_id, home_epoch, signing_key,
          signing_public_key, agreement_key, transcript_hash, certificate,
          request_id, origin, deadline, max_deadline, notes_history,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,0,1,$12,$13,$14,$15,$16,
               $17,$18,$19,'user',$20,$21,'[]'::jsonb,$22,$22)`,
      [
        computer_id,
        account_id,
        row.name,
        transcript.machine.hostname,
        transcript.machine.os,
        transcript.machine.arch,
        transcript.machine.user,
        policy.mode,
        policy.agent_network_id,
        JSON.stringify(policy),
        policyHash(policy),
        home_bay_id,
        home_epoch,
        transcript.signing_key,
        envelope.signing_public_key,
        transcript.agreement_key,
        row.transcript_hash,
        JSON.stringify(certificate),
        request_id,
        deadline == null ? null : new Date(deadline),
        max_deadline == null ? null : new Date(max_deadline),
        new Date(now),
      ],
    );
    await client.query(
      `UPDATE account_computer_requests
          SET state='approved', computer_id=$2, approved_by=$3, approved_at=$4, updated_at=$4
        WHERE request_id=$1`,
      [request_id, computer_id, account_id, new Date(now)],
    );
    await client.query("COMMIT");
    return { computer_id, certificate, policy };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function declineComputerRequest({
  account_id,
  request_id,
  now = Date.now(),
}: {
  account_id: string;
  request_id: string;
  now?: number;
}): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE account_computer_requests SET state='declined', updated_at=$3
      WHERE request_id=$1 AND account_id=$2 AND state IN ('pending','paired')`,
    [request_id, account_id, new Date(now)],
  );
  if (!rowCount)
    throw new ComputerRequestError("no open computer request to decline");
}

/** Mark open requests past their expiry; returns how many. */
export async function expireComputerRequests(
  now = Date.now(),
): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE account_computer_requests SET state='expired', updated_at=$1
      WHERE state IN ('pending','paired') AND expires_at <= $1`,
    [new Date(now)],
  );
  return rowCount ?? 0;
}

async function loadRequest(request_id: string): Promise<any | undefined> {
  if (
    typeof request_id !== "string" ||
    !/^R-[0-9A-HJ-NP-Z]{10}$/.test(request_id)
  ) {
    throw new ComputerRequestError("malformed computer request id");
  }
  const { rows } = await getPool().query(
    `SELECT * FROM account_computer_requests WHERE request_id=$1`,
    [request_id],
  );
  return rows[0];
}

function isOpen(state: string): boolean {
  return state === "pending" || state === "paired";
}

function requireUuid(value: unknown, where: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw new ComputerRequestError(`${where} must be a UUID`);
  }
  return value;
}
