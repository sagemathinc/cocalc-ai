/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The endpoints a machine calls (/api/v2/computers/*): pairing, then a host
// token every few minutes. Pairing grants nothing by itself: the owner
// approves with fresh auth. The request id is not secret, so these are
// rate-limited per address, and a second claim invalidates the request.
// Design: src/.agents/computers-direct-host-2026-10-16.md.

import type {
  HostConnection,
  PairingClaim,
  PairingStatus,
} from "@cocalc/util/computers/api";
import { OperationError } from "@cocalc/util/computers/operations";
import getLogger from "@cocalc/backend/logger";
import {
  ComputerRequestError,
  claimComputerRequest,
  getPairingStatus,
  getPairingView,
} from "./requests";
import {
  ComputerRevokedError,
  ComputerUnavailableError,
  connectComputer,
} from "./computers";
import { assertComputersEnabled } from "./enabled";

const logger = getLogger("server:computers:pairing-http");

/** Per address, per minute. */
export const PAIRING_READS_PER_MINUTE = 120;
export const PAIRING_CLAIMS_PER_MINUTE = 10;
export const CONNECTS_PER_MINUTE = 60;
const MAX_TRACKED_ADDRESSES = 10_000;

type Kind = "read" | "claim" | "connect";
const LIMITS: Record<Kind, number> = {
  read: PAIRING_READS_PER_MINUTE,
  claim: PAIRING_CLAIMS_PER_MINUTE,
  connect: CONNECTS_PER_MINUTE,
};
const windows = new Map<string, { start: number } & Record<Kind, number>>();

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
        throw new ComputerUnavailableError("too many requests; try again");
      }
    }
    w = { start: now, read: 0, claim: 0, connect: 0 };
    windows.set(key, w);
  }
  if (w[kind] >= LIMITS[kind]) {
    throw new ComputerUnavailableError(
      "too many requests from this address; try again in a minute",
    );
  }
  w[kind] += 1;
}

export function resetPairingRateLimitForTesting(): void {
  windows.clear();
}

export type PairingResult<T> =
  | T
  | { error: string; revoked?: true; transient?: true };

/** Errors a caller may see; anything else is logged and reported generically. */
function publicError(err: unknown): {
  error: string;
  revoked?: true;
  transient?: true;
} {
  if (err instanceof ComputerRevokedError) {
    return { error: err.message, revoked: true };
  }
  if (err instanceof ComputerUnavailableError) {
    return { error: err.message, transient: true };
  }
  if (err instanceof ComputerRequestError || err instanceof OperationError) {
    return { error: err.message };
  }
  logger.warn("computer request failed", err);
  return { error: "that failed; try again", transient: true };
}

export async function pairingView(
  params: { request_id?: unknown },
  address: string,
  now = Date.now(),
): Promise<PairingResult<Awaited<ReturnType<typeof getPairingView>>>> {
  try {
    admit(address, "read", now);
    await assertComputersEnabled();
    return await getPairingView(`${params.request_id ?? ""}`, now);
  } catch (err) {
    return publicError(err);
  }
}

export async function pairingClaim(
  params: { request_id?: unknown; machine?: unknown },
  address: string,
  now = Date.now(),
): Promise<PairingResult<PairingClaim>> {
  try {
    admit(address, "claim", now);
    await assertComputersEnabled();
    return await claimComputerRequest({
      request_id: `${params.request_id ?? ""}`,
      machine: params.machine,
      now,
    });
  } catch (err) {
    return publicError(err);
  }
}

export async function pairingStatus(
  params: { request_id?: unknown; secret?: unknown },
  address: string,
  now = Date.now(),
): Promise<PairingResult<PairingStatus>> {
  try {
    admit(address, "read", now);
    return await getPairingStatus({
      request_id: `${params.request_id ?? ""}`,
      secret: params.secret,
      now,
    });
  } catch (err) {
    return publicError(err);
  }
}

/** A paired computer asks where to connect (its project's host). */
export async function computerConnect(
  params: { computer_id?: unknown; token?: unknown },
  address: string,
  now = Date.now(),
): Promise<PairingResult<HostConnection>> {
  try {
    admit(address, "connect", now);
    return await connectComputer({
      computer_id: params.computer_id,
      token: params.token,
      now,
    });
  } catch (err) {
    return publicError(err);
  }
}

export function requestAddress(req: any): string {
  return `${req?.ip ?? req?.socket?.remoteAddress ?? "unknown"}`.trim();
}
