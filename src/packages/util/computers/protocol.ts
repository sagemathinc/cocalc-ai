/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The signed objects of the computers protocol, with strict parsers, and the
// checks a daemon makes before it admits a ticket. Signatures are verified in
// @cocalc/backend/computers/crypto; everything here is pure.
// Plan: src/.agents/computers-plan-2026-10-11.md ("The ticket", "The daemon's
// checks", "Privacy fence across bays", "Enrollment and the daemon's
// identity").
//
// Every parser fails closed: an unknown type, version or field is an error,
// so a daemon never acts on something newer than it understands.

import { UNSAFE_LINE_CHARS } from "./canonical";
import { isValidUUID } from "@cocalc/util/misc";

export const COMPUTER_PROTOCOL_VERSION = 1;

/** Signed object kinds; also the domain-separation label of their signature. */
export const SIGNED_KINDS = {
  transcript: "pairing-transcript",
  certificate: "computer-certificate",
  attestation: "project-attestation",
  ticket: "computer-ticket",
  floors: "computer-floors",
  key_endorsement: "signing-key-endorsement",
  login: "computer-login",
  challenge_request: "computer-challenge-request",
} as const;

export interface SignedEnvelope<T> {
  /** Id of the signing key (a key fingerprint). */
  kid: string;
  payload: T;
  /** base64url signature over signingInput(kind, payload). */
  sig: string;
}

export const OPERATION_KINDS = [
  "info",
  "notes",
  "exec",
  "run",
  "jobs",
  "logs",
  "kill",
  "ops",
  "put",
  "get",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** The hub's default for limits.concurrency (see ComputerTicket). */
export const DEFAULT_AGENT_CONCURRENCY = 4;

/** A ticket must be started within this long after it was issued. */
export const MAX_START_WINDOW_MS = 2 * 60 * 1000;
/** ... and within this long after the daemon received it (its own clock). */
export const LOCAL_START_MAX_MS = 60 * 1000;
/** How far ahead of the daemon's estimate of hub time a ticket may be dated. */
export const MAX_FUTURE_SKEW_MS = 30 * 1000;
/** Project-bay attestations live at most this long. */
export const MAX_ATTESTATION_MS = 30 * 1000;
/** No single operation runs longer than this (jobs: 30 days). */
export const MAX_RUNTIME_MS = 30 * 24 * 60 * 60 * 1000;

export class ProtocolError extends Error {}

export interface MachineInfo {
  hostname: string;
  os: string;
  arch: string;
  user: string;
}

/** Signed by the machine's signing key when it pairs. */
export interface PairingTranscript {
  type: "cocalc-computer-pairing";
  version: 1;
  site: string;
  cluster_id: string;
  request_id: string;
  account_id: string;
  /** Hash of the canonical, locally resolved policy (the ceiling P0). */
  policy_hash: string;
  signing_key: string;
  agreement_key: string;
  client_nonce: string;
  server_nonce: string;
  machine: MachineInfo;
}

/** Signed by the account's home bay; the computer's identity. Not a secret. */
export interface ComputerCertificate {
  type: "cocalc-computer-certificate";
  version: 1;
  site: string;
  cluster_id: string;
  computer_id: string;
  account_id: string;
  home_bay_id: string;
  home_epoch: number;
  signing_key: string;
  /** base64url DER (SPKI) of the signing public key. */
  signing_public_key: string;
  agreement_key: string;
  transcript_hash: string;
  ceiling_hash: string;
  not_before: number;
  not_after: number;
}

/** Signed by the project's bay: is this project eligible right now? */
export interface ProjectAttestation {
  type: "cocalc-project-attestation";
  version: 1;
  site: string;
  cluster_id: string;
  project_id: string;
  project_bay_id: string;
  eligible: boolean;
  privacy_epoch: number;
  account_id: string;
  home_bay_id: string;
  issued_at: number;
  not_after: number;
}

/**
 * Signed by a bay's previous key: its next key. A bay's first key is
 * accepted as is; every later key needs this, so the directory follows an
 * unbroken chain per bay.
 */
export interface SigningKeyEndorsement {
  type: "cocalc-computer-key-endorsement";
  version: 1;
  bay_id: string;
  kid: string;
  public_key: string;
  not_after: number;
}

/**
 * Signed by the computer's own key to log in to conat at its home bay, over
 * a single-use challenge from that bay. Nothing reusable is ever issued.
 */
export interface ComputerLogin {
  type: "cocalc-computer-login";
  version: 1;
  site: string;
  cluster_id: string;
  home_bay_id: string;
  home_epoch: number;
  computer_id: string;
  account_id: string;
  /** Canonical hash of the computer's certificate envelope. */
  certificate_hash: string;
  /** Fingerprint of the signing key (the envelope's kid too). */
  signing_key: string;
  audience: "conat";
  challenge_id: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
}

/**
 * Signed by the computer's key to ask for a login challenge, so nobody else
 * (e.g. someone who only learned the computer's id) can use up its
 * challenges.
 */
export interface ComputerChallengeRequest {
  type: "cocalc-computer-challenge-request";
  version: 1;
  site: string;
  cluster_id: string;
  home_bay_id: string;
  account_id: string;
  computer_id: string;
  issued_at: number;
  /** Single use: the home bay refuses a nonce it has seen. */
  nonce: string;
}

export function parseComputerChallengeRequest(
  input: unknown,
): ComputerChallengeRequest {
  const o = record(input, "challenge request");
  onlyKeys(
    o,
    [
      "type",
      "version",
      "site",
      "cluster_id",
      "home_bay_id",
      "account_id",
      "computer_id",
      "issued_at",
      "nonce",
    ],
    "challenge request",
  );
  literal(o.type, "cocalc-computer-challenge-request", "challenge.type");
  version(o.version);
  return {
    type: "cocalc-computer-challenge-request",
    version: 1,
    site: site(o.site),
    cluster_id: clusterId(o.cluster_id),
    home_bay_id: bayId(o.home_bay_id),
    account_id: uuid(o.account_id, "challenge.account_id"),
    computer_id: uuid(o.computer_id, "challenge.computer_id"),
    issued_at: time(o.issued_at, "challenge.issued_at"),
    nonce: nonce(o.nonce, "challenge.nonce"),
  };
}

/** A login transcript lives at most this long. */
export const MAX_LOGIN_MS = 60 * 1000;

/** Signed by the account's home bay: permission for exactly one operation. */
export interface ComputerTicket {
  type: "cocalc-computer-ticket";
  version: 1;
  ticket_id: string;
  operation_id: string;
  operation: OperationKind;
  request_hash: string;
  site: string;
  cluster_id: string;
  issuer_bay_id: string;
  home_epoch: number;
  computer_id: string;
  /** Audience: fingerprint of the computer's signing key. */
  computer_key: string;
  account_id: string;
  agent_id: string;
  /**
   * The agent network this computer serves. Membership is checked by the
   * home bay when it issues the ticket; removing a member, or pausing or
   * closing the network, bumps the computer's epoch (agent_networks.generation
   * is a uuid, not a counter, so it can't be a floor).
   */
  agent_network_id: string;
  source_project_id: string;
  attestation: SignedEnvelope<ProjectAttestation>;
  computer_epoch: number;
  policy_epoch: number;
  ceiling_hash: string;
  run_id: string;
  /** When the agent run expires; the ticket can't be started after it. */
  run_expires_at: number;
  /** base64url DER (SPKI) of the requester's per-request proof-of-possession key. */
  pop_key: string;
  issued_at: number;
  start_by: number;
  max_runtime_ms: number;
  limits: {
    max_bytes: number | null;
    /**
     * How many of this agent's operations may be active on the computer at
     * once, this one included: execs running, plus jobs starting, running
     * or queued (queued jobs count, so they can't pile up behind the limit).
     * The daemon enforces the smaller of this and its own hard limits.
     */
    concurrency: number;
  };
}

// ---------------------------------------------------------------- parsers

export function parsePairingTranscript(input: unknown): PairingTranscript {
  const o = record(input, "transcript");
  onlyKeys(
    o,
    [
      "type",
      "version",
      "site",
      "cluster_id",
      "request_id",
      "account_id",
      "policy_hash",
      "signing_key",
      "agreement_key",
      "client_nonce",
      "server_nonce",
      "machine",
    ],
    "transcript",
  );
  literal(o.type, "cocalc-computer-pairing", "transcript.type");
  version(o.version);
  if (o.signing_key === o.agreement_key) {
    throw new ProtocolError("signing and agreement keys must differ");
  }
  const m = record(o.machine, "transcript.machine");
  onlyKeys(m, ["hostname", "os", "arch", "user"], "transcript.machine");
  return {
    type: "cocalc-computer-pairing",
    version: 1,
    site: site(o.site),
    cluster_id: clusterId(o.cluster_id),
    request_id: requestId(o.request_id),
    account_id: uuid(o.account_id, "account_id"),
    policy_hash: hash(o.policy_hash, "policy_hash"),
    signing_key: fingerprint(o.signing_key, "signing_key"),
    agreement_key: fingerprint(o.agreement_key, "agreement_key"),
    client_nonce: nonce(o.client_nonce, "client_nonce"),
    server_nonce: nonce(o.server_nonce, "server_nonce"),
    machine: {
      hostname: label(m.hostname, "machine.hostname"),
      os: label(m.os, "machine.os"),
      arch: label(m.arch, "machine.arch"),
      user: label(m.user, "machine.user"),
    },
  };
}

export function parseComputerLogin(input: unknown): ComputerLogin {
  const o = record(input, "login");
  onlyKeys(
    o,
    [
      "type",
      "version",
      "site",
      "cluster_id",
      "home_bay_id",
      "home_epoch",
      "computer_id",
      "account_id",
      "certificate_hash",
      "signing_key",
      "audience",
      "challenge_id",
      "nonce",
      "issued_at",
      "expires_at",
    ],
    "login",
  );
  literal(o.type, "cocalc-computer-login", "login.type");
  version(o.version);
  literal(o.audience, "conat", "login.audience");
  const issued_at = time(o.issued_at, "login.issued_at");
  const expires_at = time(o.expires_at, "login.expires_at");
  if (expires_at <= issued_at || expires_at - issued_at > MAX_LOGIN_MS) {
    throw new ProtocolError(
      `a login lives more than 0 and at most ${MAX_LOGIN_MS} ms`,
    );
  }
  return {
    type: "cocalc-computer-login",
    version: 1,
    site: site(o.site),
    cluster_id: clusterId(o.cluster_id),
    home_bay_id: bayId(o.home_bay_id),
    home_epoch: epoch(o.home_epoch, "login.home_epoch"),
    computer_id: uuid(o.computer_id, "login.computer_id"),
    account_id: uuid(o.account_id, "login.account_id"),
    certificate_hash: hash(o.certificate_hash, "login.certificate_hash"),
    signing_key: fingerprint(o.signing_key, "login.signing_key"),
    audience: "conat",
    challenge_id: uuid(o.challenge_id, "login.challenge_id"),
    nonce: nonce(o.nonce, "login.nonce"),
    issued_at,
    expires_at,
  };
}

export function parseComputerCertificate(input: unknown): ComputerCertificate {
  const o = record(input, "certificate");
  onlyKeys(
    o,
    [
      "type",
      "version",
      "site",
      "cluster_id",
      "computer_id",
      "account_id",
      "home_bay_id",
      "home_epoch",
      "signing_key",
      "signing_public_key",
      "agreement_key",
      "transcript_hash",
      "ceiling_hash",
      "not_before",
      "not_after",
    ],
    "certificate",
  );
  literal(o.type, "cocalc-computer-certificate", "certificate.type");
  version(o.version);
  const not_before = time(o.not_before, "not_before");
  const not_after = time(o.not_after, "not_after");
  if (not_after <= not_before) {
    throw new ProtocolError("certificate validity is empty");
  }
  return {
    type: "cocalc-computer-certificate",
    version: 1,
    site: site(o.site),
    cluster_id: clusterId(o.cluster_id),
    computer_id: uuid(o.computer_id, "computer_id"),
    account_id: uuid(o.account_id, "account_id"),
    home_bay_id: bayId(o.home_bay_id),
    home_epoch: epoch(o.home_epoch, "home_epoch"),
    signing_key: fingerprint(o.signing_key, "signing_key"),
    signing_public_key: base64url(
      o.signing_public_key,
      "signing_public_key",
      4,
      200,
    ),
    agreement_key: fingerprint(o.agreement_key, "agreement_key"),
    transcript_hash: hash(o.transcript_hash, "transcript_hash"),
    ceiling_hash: hash(o.ceiling_hash, "ceiling_hash"),
    not_before,
    not_after,
  };
}

export function parseSigningKeyEndorsement(
  input: unknown,
): SigningKeyEndorsement {
  const o = record(input, "endorsement");
  onlyKeys(
    o,
    ["type", "version", "bay_id", "kid", "public_key", "not_after"],
    "endorsement",
  );
  literal(o.type, "cocalc-computer-key-endorsement", "endorsement.type");
  version(o.version);
  return {
    type: "cocalc-computer-key-endorsement",
    version: 1,
    bay_id: bayId(o.bay_id),
    kid: fingerprint(o.kid, "endorsement.kid"),
    public_key: base64url(o.public_key, "endorsement.public_key", 4, 200),
    not_after: time(o.not_after, "endorsement.not_after"),
  };
}

export function parseProjectAttestation(input: unknown): ProjectAttestation {
  const o = record(input, "attestation");
  onlyKeys(
    o,
    [
      "type",
      "version",
      "site",
      "cluster_id",
      "project_id",
      "project_bay_id",
      "eligible",
      "privacy_epoch",
      "account_id",
      "home_bay_id",
      "issued_at",
      "not_after",
    ],
    "attestation",
  );
  literal(o.type, "cocalc-project-attestation", "attestation.type");
  version(o.version);
  if (typeof o.eligible !== "boolean") {
    throw new ProtocolError("attestation.eligible must be a boolean");
  }
  const issued_at = time(o.issued_at, "issued_at");
  const not_after = time(o.not_after, "not_after");
  if (not_after <= issued_at || not_after - issued_at > MAX_ATTESTATION_MS) {
    throw new ProtocolError(
      `an attestation lives more than 0 and at most ${MAX_ATTESTATION_MS} ms`,
    );
  }
  return {
    type: "cocalc-project-attestation",
    version: 1,
    site: site(o.site),
    cluster_id: clusterId(o.cluster_id),
    project_id: uuid(o.project_id, "project_id"),
    project_bay_id: bayId(o.project_bay_id),
    eligible: o.eligible,
    privacy_epoch: epoch(o.privacy_epoch, "privacy_epoch"),
    account_id: uuid(o.account_id, "account_id"),
    home_bay_id: bayId(o.home_bay_id),
    issued_at,
    not_after,
  };
}

export function parseSignedEnvelope<T>(
  input: unknown,
  parsePayload: (payload: unknown) => T,
  where = "envelope",
): SignedEnvelope<T> {
  const o = record(input, where);
  onlyKeys(o, ["kid", "payload", "sig"], where);
  return {
    kid: fingerprint(o.kid, `${where}.kid`),
    payload: parsePayload(o.payload),
    sig: base64url(o.sig, `${where}.sig`, 86, 86),
  };
}

export function parseComputerTicket(input: unknown): ComputerTicket {
  const o = record(input, "ticket");
  onlyKeys(
    o,
    [
      "type",
      "version",
      "ticket_id",
      "operation_id",
      "operation",
      "request_hash",
      "site",
      "cluster_id",
      "issuer_bay_id",
      "home_epoch",
      "computer_id",
      "computer_key",
      "account_id",
      "agent_id",
      "agent_network_id",
      "source_project_id",
      "attestation",
      "computer_epoch",
      "policy_epoch",
      "ceiling_hash",
      "run_id",
      "run_expires_at",
      "pop_key",
      "issued_at",
      "start_by",
      "max_runtime_ms",
      "limits",
    ],
    "ticket",
  );
  literal(o.type, "cocalc-computer-ticket", "ticket.type");
  version(o.version);
  if (
    typeof o.operation !== "string" ||
    !(OPERATION_KINDS as readonly string[]).includes(o.operation)
  ) {
    throw new ProtocolError(`unknown operation '${String(o.operation)}'`);
  }
  const issued_at = time(o.issued_at, "issued_at");
  const start_by = time(o.start_by, "start_by");
  if (start_by < issued_at || start_by - issued_at > MAX_START_WINDOW_MS) {
    throw new ProtocolError("ticket start window is invalid");
  }
  const max_runtime_ms = epoch(o.max_runtime_ms, "max_runtime_ms");
  if (max_runtime_ms === 0 || max_runtime_ms > MAX_RUNTIME_MS) {
    throw new ProtocolError("ticket max_runtime_ms is out of range");
  }
  const limits = record(o.limits, "ticket.limits");
  onlyKeys(limits, ["max_bytes", "concurrency"], "ticket.limits");
  const max_bytes =
    limits.max_bytes === null ? null : epoch(limits.max_bytes, "max_bytes");
  const concurrency = epoch(limits.concurrency, "concurrency");
  if (concurrency === 0)
    throw new ProtocolError("concurrency must be positive");
  return {
    type: "cocalc-computer-ticket",
    version: 1,
    ticket_id: uuid(o.ticket_id, "ticket_id"),
    operation_id: uuid(o.operation_id, "operation_id"),
    operation: o.operation as OperationKind,
    request_hash: hash(o.request_hash, "request_hash"),
    site: site(o.site),
    cluster_id: clusterId(o.cluster_id),
    issuer_bay_id: bayId(o.issuer_bay_id),
    home_epoch: epoch(o.home_epoch, "home_epoch"),
    computer_id: uuid(o.computer_id, "computer_id"),
    computer_key: fingerprint(o.computer_key, "computer_key"),
    account_id: uuid(o.account_id, "account_id"),
    agent_id: uuid(o.agent_id, "agent_id"),
    agent_network_id: uuid(o.agent_network_id, "agent_network_id"),
    source_project_id: uuid(o.source_project_id, "source_project_id"),
    attestation: parseSignedEnvelope(
      o.attestation,
      parseProjectAttestation,
      "ticket.attestation",
    ),
    computer_epoch: epoch(o.computer_epoch, "computer_epoch"),
    policy_epoch: epoch(o.policy_epoch, "policy_epoch"),
    ceiling_hash: hash(o.ceiling_hash, "ceiling_hash"),
    run_id: uuid(o.run_id, "run_id"),
    run_expires_at: time(o.run_expires_at, "run_expires_at"),
    pop_key: base64url(o.pop_key, "pop_key", 4, 200),
    issued_at,
    start_by,
    max_runtime_ms,
    limits: { max_bytes, concurrency },
  };
}

// ------------------------------------------------------- daemon admission

/**
 * Signed by the computer's home bay and pushed on every change: the epochs
 * below which the daemon must refuse tickets. The daemon keeps the maximum of
 * each floor, so replaying an old push changes nothing.
 */
export interface ComputerFloors {
  type: "cocalc-computer-floors";
  version: 1;
  computer_id: string;
  home_epoch: number;
  computer_epoch: number;
  /** Privacy epoch floor per project id. */
  projects: Record<string, number>;
  issued_at: number;
}

/** At most this many per-project floors in one push. */
export const MAX_PROJECT_FLOORS = 1000;

export function parseComputerFloors(input: unknown): ComputerFloors {
  const o = record(input, "floors");
  onlyKeys(
    o,
    [
      "type",
      "version",
      "computer_id",
      "home_epoch",
      "computer_epoch",
      "projects",
      "issued_at",
    ],
    "floors",
  );
  literal(o.type, "cocalc-computer-floors", "floors.type");
  version(o.version);
  const projectsIn = record(o.projects, "floors.projects");
  const entries = Object.entries(projectsIn);
  if (entries.length > MAX_PROJECT_FLOORS) {
    throw new ProtocolError(
      `floors.projects has more than ${MAX_PROJECT_FLOORS} entries`,
    );
  }
  const projects: Record<string, number> = {};
  for (const [project_id, value] of entries) {
    projects[uuid(project_id, "floors.projects key")] = epoch(
      value,
      `floors.projects.${project_id}`,
    );
  }
  return {
    type: "cocalc-computer-floors",
    version: 1,
    computer_id: uuid(o.computer_id, "floors.computer_id"),
    home_epoch: epoch(o.home_epoch, "floors.home_epoch"),
    computer_epoch: epoch(o.computer_epoch, "floors.computer_epoch"),
    projects,
    issued_at: time(o.issued_at, "floors.issued_at"),
  };
}

/**
 * Raise the daemon's floors to a push: each floor becomes the larger of the
 * two, never smaller. `raised` says whether anything went up (queued work is
 * then cancelled and re-authorized).
 */
export function mergeFloors(
  current: DaemonState["floors"],
  pushed: Pick<ComputerFloors, "home_epoch" | "computer_epoch" | "projects">,
): { floors: DaemonState["floors"]; raised: boolean } {
  let raised = false;
  const up = (a: number, b: number) => {
    if (b > a) raised = true;
    return Math.max(a, b);
  };
  const projects = { ...current.projects };
  for (const [project_id, value] of Object.entries(pushed.projects)) {
    projects[project_id] = up(projects[project_id] ?? 0, value);
  }
  return {
    floors: {
      home_epoch: up(current.home_epoch, pushed.home_epoch),
      computer_epoch: up(current.computer_epoch, pushed.computer_epoch),
      projects,
    },
    raised,
  };
}

/** What the daemon persisted about itself; floors only ever increase. */
export interface DaemonState {
  site: string;
  cluster_id: string;
  computer_id: string;
  computer_key: string;
  account_id: string;
  home_bay_id: string;
  agent_network_id: string;
  ceiling_hash: string;
  policy_epoch: number;
  floors: {
    home_epoch: number;
    computer_epoch: number;
    /** privacy epoch floor per project id */
    projects: Record<string, number>;
  };
}

export interface AdmissionTiming {
  /** The daemon's estimate of hub time (local clock plus bounded offset). */
  hub_now: number;
  /** Local monotonic milliseconds between receiving the ticket and now. */
  since_receipt_ms: number;
}

/**
 * Every check the daemon makes on a ticket whose signature, and whose
 * attestation's signature (by the project's bay), were already verified.
 * Returns the reasons to refuse; an empty list admits the ticket.
 */
export function ticketRefusals(
  ticket: ComputerTicket,
  state: DaemonState,
  timing: AdmissionTiming,
): string[] {
  const refusals: string[] = [];
  const refuse = (reason: string) => refusals.push(reason);

  // Issuer and audience.
  if (ticket.site !== state.site || ticket.cluster_id !== state.cluster_id) {
    refuse("ticket is for another site");
  }
  if (ticket.issuer_bay_id !== state.home_bay_id) {
    refuse("ticket was not issued by this computer's home bay");
  }
  if (ticket.computer_id !== state.computer_id)
    refuse("ticket is for another computer");
  if (ticket.computer_key !== state.computer_key) {
    refuse("ticket is for another key of this computer");
  }
  if (ticket.account_id !== state.account_id)
    refuse("ticket is for another account");
  if (ticket.agent_network_id !== state.agent_network_id) {
    refuse("ticket is for another agent network");
  }

  // Policy: the ceiling is immutable; the effective policy must be current.
  if (ticket.ceiling_hash !== state.ceiling_hash)
    refuse("policy ceiling differs");
  if (ticket.policy_epoch !== state.policy_epoch) {
    refuse("ticket was issued for another effective policy");
  }

  // Floors: nothing older than what the daemon has been told.
  const f = state.floors;
  if (ticket.home_epoch < f.home_epoch) refuse("home bay epoch is stale");
  if (ticket.computer_epoch < f.computer_epoch)
    refuse("computer epoch is stale");

  // The project's bay says the project is eligible, until not_after.
  const a = ticket.attestation.payload;
  if (a.project_id !== ticket.source_project_id) {
    refuse("attestation is for another project");
  }
  if (!a.eligible) refuse("project is not eligible");
  if (a.site !== state.site || a.cluster_id !== state.cluster_id) {
    refuse("attestation is for another site");
  }
  if (
    a.account_id !== state.account_id ||
    a.home_bay_id !== state.home_bay_id
  ) {
    refuse("attestation is for another account");
  }
  const projectFloor = f.projects[a.project_id] ?? 0;
  if (a.privacy_epoch < projectFloor) refuse("project privacy epoch is stale");
  if (ticket.start_by > a.not_after) {
    refuse("ticket outlives the project attestation");
  }
  if (timing.hub_now > a.not_after) refuse("project attestation expired");

  // Time.
  if (ticket.start_by > ticket.run_expires_at) {
    refuse("ticket outlives the agent run");
  }
  if (ticket.issued_at > timing.hub_now + MAX_FUTURE_SKEW_MS) {
    refuse("ticket is dated in the future");
  }
  if (timing.hub_now > ticket.start_by) refuse("ticket start window passed");
  if (timing.since_receipt_ms > LOCAL_START_MAX_MS) {
    refuse("ticket waited too long on this computer");
  }
  return refusals;
}

/** A lease derived from an attestation never outlives it. */
export function leaseNotAfter(
  attestation: ProjectAttestation,
  requested: number,
): number {
  return Math.min(attestation.not_after, requested);
}

// ---------------------------------------------------------------- helpers

function record(value: unknown, where: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ProtocolError(`${where}: unknown field '${key}'`);
    }
  }
  for (const key of allowed) {
    if (!(key in obj)) throw new ProtocolError(`${where}: missing '${key}'`);
  }
}

function literal(value: unknown, expected: string, where: string): void {
  if (value !== expected)
    throw new ProtocolError(`${where} must be ${expected}`);
}

function version(value: unknown): void {
  if (value !== COMPUTER_PROTOCOL_VERSION) {
    throw new ProtocolError(`unsupported protocol version ${String(value)}`);
  }
}

function uuid(value: unknown, where: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw new ProtocolError(`${where} must be a UUID`);
  }
  return value.toLowerCase();
}

function epoch(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolError(`${where} must be a non-negative integer`);
  }
  return value;
}

function time(value: unknown, where: string): number {
  const t = epoch(value, where);
  if (t < Date.UTC(2026, 0, 1) || t > Date.UTC(2200, 0, 1)) {
    throw new ProtocolError(`${where} is not a plausible time`);
  }
  return t;
}

const FINGERPRINT = /^sha256:[A-Za-z0-9_-]{43}$/;

export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT.test(value);
}

function fingerprint(value: unknown, where: string): string {
  if (!isFingerprint(value)) {
    throw new ProtocolError(`${where} must be a sha256 fingerprint`);
  }
  return value;
}

function hash(value: unknown, where: string): string {
  return fingerprint(value, where);
}

function nonce(value: unknown, where: string): string {
  // 32 random bytes, base64url without padding.
  return base64url(value, where, 43, 43);
}

function base64url(
  value: unknown,
  where: string,
  min: number,
  max: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new ProtocolError(`${where} must be base64url`);
  }
  return value;
}

function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^R-[0-9A-HJ-NP-Z]{10}$/.test(value)) {
    throw new ProtocolError("request_id is malformed");
  }
  return value;
}

/** A cluster id is a label ("standalone" for single-bay sites). */
// Cluster and bay ids are configured labels (e.g. "ci-mb-fe5Y7t", "bay-0").
const LABEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function clusterId(value: unknown): string {
  if (typeof value !== "string" || !LABEL_ID.test(value)) {
    throw new ProtocolError("cluster id is malformed");
  }
  return value;
}

function bayId(value: unknown): string {
  if (typeof value !== "string" || !LABEL_ID.test(value)) {
    throw new ProtocolError("bay id is malformed");
  }
  return value;
}

function label(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    UNSAFE_LINE_CHARS.test(value)
  ) {
    throw new ProtocolError(`${where} must be a short printable string`);
  }
  return value;
}

/**
 * The exact origin a computer is paired with: lowercase https scheme and
 * host, an explicit non-default port only, no path, query or credentials.
 * (http is accepted only for localhost, for development.)
 */
export function site(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError("site must be a URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProtocolError("site must be a URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ProtocolError("site must use https");
  }
  if (
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new ProtocolError(
      "site must be an origin, without path or credentials",
    );
  }
  const normalized = url.origin;
  if (value !== normalized && value !== `${normalized}/`) {
    throw new ProtocolError(`site must be written as ${normalized}`);
  }
  return normalized;
}
