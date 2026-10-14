/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The unauthenticated pairing endpoints the machine calls while it pairs
// (/api/v2/computers/pairing/*). Nothing here grants access: the owner still
// approves the transcript with fresh auth. The request id is not secret, so
// these are rate-limited per address, and a second claimant invalidates the
// request instead of replacing the first key.
// Plan: src/.agents/computers-plan-2026-10-11.md ("Enrollment").

import type { PairingStatus, PairingView } from "@cocalc/util/computers/api";
import { CanonicalEncodingError } from "@cocalc/util/computers/canonical";
import { ProtocolError } from "@cocalc/util/computers/protocol";
import { PolicyError } from "@cocalc/util/computers/policy";
import getLogger from "@cocalc/backend/logger";
import {
  ComputerRequestError,
  getPairingStatus,
  getPairingView,
  submitPairing,
} from "./requests";
import {
  ComputerSessionError,
  createLoginChallenge,
  type LoginChallenge,
  type LoginEnded,
} from "./sessions";
import { assertComputersEnabled } from "./enabled";

const logger = getLogger("server:computers:pairing-http");

/** Per address, per minute: reads (view and status polling) and claims. */
export const PAIRING_READS_PER_MINUTE = 120;
export const PAIRING_SUBMITS_PER_MINUTE = 10;
const MAX_TRACKED_ADDRESSES = 10_000;

type Kind = "read" | "submit";
const windows = new Map<
  string,
  { start: number; read: number; submit: number }
>();

function admit(address: string, kind: Kind, now: number): void {
  const key = address || "unknown";
  let w = windows.get(key);
  if (w == null || now - w.start >= 60_000) {
    if (w == null && windows.size >= MAX_TRACKED_ADDRESSES) {
      for (const [k, v] of windows) {
        if (now - v.start >= 60_000) windows.delete(k);
      }
      // Still full of live windows: refuse rather than grow without bound.
      if (windows.size >= MAX_TRACKED_ADDRESSES) {
        throw new ComputerRequestError("too many pairing attempts; try again");
      }
    }
    w = { start: now, read: 0, submit: 0 };
    windows.set(key, w);
  }
  const limit =
    kind === "read" ? PAIRING_READS_PER_MINUTE : PAIRING_SUBMITS_PER_MINUTE;
  if (w[kind] >= limit) {
    throw new ComputerRequestError(
      "too many pairing attempts from this address; try again in a minute",
    );
  }
  w[kind] += 1;
}

export function resetPairingRateLimitForTesting(): void {
  windows.clear();
}

/** Errors a caller may see; anything else is logged and reported generically. */
function publicError(err: unknown): { error: string } {
  if (
    err instanceof ComputerRequestError ||
    err instanceof ComputerSessionError ||
    err instanceof ProtocolError ||
    err instanceof CanonicalEncodingError ||
    err instanceof PolicyError
  ) {
    return { error: err.message };
  }
  logger.warn("pairing request failed", err);
  return { error: "pairing failed; try again" };
}

export type PairingResult<T> = T | { error: string };

export async function pairingView(
  params: { request_id?: unknown },
  address: string,
  now = Date.now(),
): Promise<PairingResult<PairingView>> {
  try {
    admit(address, "read", now);
    await assertComputersEnabled();
    return await getPairingView(`${params.request_id ?? ""}`, now);
  } catch (err) {
    return publicError(err);
  }
}

export async function pairingSubmit(
  params: {
    request_id?: unknown;
    transcript?: unknown;
    signing_public_key?: unknown;
    resolved_policy?: unknown;
  },
  address: string,
  now = Date.now(),
): Promise<PairingResult<{ pairing_phrase: string; transcript_hash: string }>> {
  try {
    admit(address, "submit", now);
    await assertComputersEnabled();
    return await submitPairing({
      request_id: `${params.request_id ?? ""}`,
      transcript: params.transcript,
      signing_public_key: `${params.signing_public_key ?? ""}`,
      resolved_policy: params.resolved_policy,
      now,
    });
  } catch (err) {
    return publicError(err);
  }
}

export async function pairingStatus(
  params: { request_id?: unknown; transcript_hash?: unknown },
  address: string,
  now = Date.now(),
): Promise<PairingResult<PairingStatus>> {
  try {
    admit(address, "read", now);
    await assertComputersEnabled();
    return await getPairingStatus({
      request_id: `${params.request_id ?? ""}`,
      transcript_hash: `${params.transcript_hash ?? ""}`,
      now,
    });
  } catch (err) {
    return publicError(err);
  }
}

/**
 * A connected computer asks for a login challenge (see sessions.ts). An
 * ended computer is told so (signed) even with the site's switch off.
 */
export async function sessionChallenge(
  params: { request?: unknown },
  address: string,
  now = Date.now(),
): Promise<PairingResult<LoginChallenge | LoginEnded>> {
  try {
    admit(address, "submit", now);
    return await createLoginChallenge(params.request, now, {
      assertEnabled: assertComputersEnabled,
    });
  } catch (err) {
    return publicError(err);
  }
}

export function requestAddress(req: any): string {
  return `${req?.ip ?? req?.socket?.remoteAddress ?? "unknown"}`.trim();
}
