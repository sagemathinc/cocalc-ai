/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The hub's registration of the federated token broker (G3b design v3 §3):
a lease, not a flag.

- The broker heartbeats every 10 s over its authenticated fabric connection
  with an all-prerequisites ready state (identity verified, its database
  guards and roles, a fresh reference time, signing permission).
- The registration lasts 30 s after the last ready heartbeat, and is cleared
  at once on a heartbeat that isn't ready (e.g. identity_mismatch), on a
  second broker instance, or when the broker's connection is lost.
- The gate opens only while a registration is live AND the hub's own side
  is ready (the pinned JWKS served on every active bay, tokeninfo checks
  live; G3b-2 supplies the first, and until it does the hub isn't ready).

A heartbeat is a liveness signal only: the pinned JWKS and the check of every
issued token protect regardless of what a broker claims.
*/

import { isUuid } from "@cocalc/util/ai/federated-connectors";

export const BROKER_REGISTRATION_TTL_MS = 30_000;

export interface BrokerReadyState {
  identity: boolean;
  database: boolean;
  reference_time: boolean;
  signing: boolean;
}

export interface BrokerHeartbeat {
  /** Random per broker process; a different one while live is a duplicate. */
  instance_id: string;
  site_id: string;
  ready: BrokerReadyState;
}

export type BrokerRegistrationAlert =
  | "not_ready"
  | "duplicate_instance"
  | "transport_lost"
  | "signer_changed"
  | "expired";

const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

function isReady(ready: unknown): ready is BrokerReadyState {
  if (ready == null || typeof ready !== "object") return false;
  const r = ready as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  return (
    keys === "database,identity,reference_time,signing" &&
    r.identity === true &&
    r.database === true &&
    r.reference_time === true &&
    r.signing === true
  );
}

interface Live {
  instance_id: string;
  connection_id: string;
  site_id: string;
  expiresAt: number;
}

export class BrokerRegistration {
  private live: Live | undefined;
  private lastAlert: BrokerRegistrationAlert | undefined;

  constructor(
    private monotonicNow: () => number = () => performance.now(),
    private hubReady: () => boolean = () => false,
    private ttlMs = BROKER_REGISTRATION_TTL_MS,
  ) {}

  /**
   * A heartbeat from the broker on fabric connection `connection_id` (taken
   * from the authenticated connection, never from the message).
   */
  heartbeat(beat: unknown, connection_id: string): boolean {
    const b = beat as Partial<BrokerHeartbeat> | null;
    if (
      b == null ||
      typeof b.instance_id !== "string" ||
      !INSTANCE_ID_RE.test(b.instance_id) ||
      !isUuid(b.site_id) ||
      !isReady(b.ready)
    ) {
      this.clear("not_ready");
      return false;
    }
    const now = this.monotonicNow();
    const current = this.current(now);
    if (
      current != null &&
      (current.instance_id !== b.instance_id ||
        current.connection_id !== connection_id)
    ) {
      // Two brokers at once: neither is trusted.
      this.clear("duplicate_instance");
      return false;
    }
    this.live = {
      instance_id: b.instance_id,
      connection_id,
      site_id: b.site_id,
      expiresAt: now + this.ttlMs,
    };
    this.lastAlert = undefined;
    return true;
  }

  /** The broker's fabric connection closed. */
  transportLost(connection_id: string): void {
    if (this.live?.connection_id === connection_id) {
      this.clear("transport_lost");
    }
  }

  clear(alert: BrokerRegistrationAlert): void {
    this.live = undefined;
    this.lastAlert = alert;
  }

  private current(now = this.monotonicNow()): Live | undefined {
    if (this.live != null && now >= this.live.expiresAt) {
      this.clear("expired");
    }
    return this.live;
  }

  /** The registered broker, only while live and the hub's side is ready. */
  registered(): { site_id: string; connection_id: string } | undefined {
    const live = this.current();
    if (live == null || !this.hubReady()) return;
    return { site_id: live.site_id, connection_id: live.connection_id };
  }

  /** For admin health: OK/ALERT plus the last reason (no ids). */
  health(): { registered: boolean; alert?: BrokerRegistrationAlert } {
    const registered = this.registered() != null;
    return registered
      ? { registered }
      : { registered, ...(this.lastAlert ? { alert: this.lastAlert } : {}) };
  }
}
