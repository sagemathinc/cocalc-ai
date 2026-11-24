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
- Each connection's entry lasts 30 s after its last ready heartbeat, and is
  removed at once on a heartbeat that isn't ready (e.g. identity_mismatch)
  or on that connection's server-derived transport loss (v3.4.2).
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
  | "contested"
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

interface Entry {
  instance_id: string;
  site_id: string;
  /** Arrival order (a strict total order, even within one clock tick). */
  order: number;
  /** Monotonic time of the last heartbeat (for the TTL only). */
  lastBeat: number;
}

/**
 * Keyed by the broker's connection id (design v3.4.2 §3; it replaces v3's
 * "a second connection is refused and alerted"): registered iff exactly one
 * live connection. Two or more live is a contest: never registered, and
 * removing one never picks a winner while two or more remain. A heartbeat
 * from a connection that was live before another appeared proves overlap:
 * duplicate_instance, counted once per incident. No ids leave this class.
 */
export class BrokerRegistration {
  private entries = new Map<string, Entry>();
  private lastAlert: BrokerRegistrationAlert | undefined;
  private inIncident = false;
  private duplicateIncidents = 0;
  private arrivals = 0;

  constructor(
    private monotonicNow: () => number = () => performance.now(),
    private hubReady: () => boolean = () => false,
    private ttlMs = BROKER_REGISTRATION_TTL_MS,
  ) {}

  private prune(now: number): void {
    for (const [id, e] of this.entries) {
      if (now - e.lastBeat >= this.ttlMs) {
        this.entries.delete(id);
        if (this.entries.size === 0) this.lastAlert = "expired";
      }
    }
    if (this.entries.size < 2) this.inIncident = false;
  }

  /**
   * A heartbeat from the broker on connection `connection_id` (from the
   * authenticated stamp, never from the message).
   */
  heartbeat(beat: unknown, connection_id: string): boolean {
    const now = this.monotonicNow();
    this.prune(now);
    const b = beat as Partial<BrokerHeartbeat> | null;
    const existing = this.entries.get(connection_id);
    if (
      b == null ||
      typeof b.instance_id !== "string" ||
      !INSTANCE_ID_RE.test(b.instance_id) ||
      !isUuid(b.site_id) ||
      !isReady(b.ready) ||
      (existing != null && existing.instance_id !== b.instance_id)
    ) {
      this.entries.delete(connection_id);
      this.lastAlert = "not_ready";
      this.prune(now);
      return false;
    }
    if (existing != null) {
      // Overlap: this connection keeps beating after a later one appeared.
      for (const [id, e] of this.entries) {
        if (id !== connection_id && e.order > existing.order) {
          if (!this.inIncident) {
            this.inIncident = true;
            this.duplicateIncidents += 1;
          }
          this.lastAlert = "duplicate_instance";
          break;
        }
      }
      existing.lastBeat = now;
      existing.site_id = b.site_id;
    } else {
      this.entries.set(connection_id, {
        instance_id: b.instance_id,
        site_id: b.site_id,
        order: ++this.arrivals,
        lastBeat: now,
      });
    }
    return this.entries.size === 1;
  }

  /** The server-derived loss of one broker connection (§2). */
  transportLost(connection_id: string): void {
    if (this.entries.delete(connection_id)) {
      if (this.entries.size === 0) this.lastAlert = "transport_lost";
    }
    this.prune(this.monotonicNow());
  }

  /** Clears every connection (e.g. the signer record changed). */
  clear(alert: BrokerRegistrationAlert): void {
    this.entries.clear();
    this.inIncident = false;
    this.lastAlert = alert;
  }

  /** The registered broker: exactly one live connection, hub side ready. */
  registered(): { site_id: string; connection_id: string } | undefined {
    this.prune(this.monotonicNow());
    if (this.entries.size !== 1 || !this.hubReady()) return;
    const [[connection_id, e]] = this.entries;
    return { site_id: e.site_id, connection_id };
  }

  /** For admin health: OK/ALERT, the last reason and counts (no ids). */
  health(): {
    registered: boolean;
    alert?: BrokerRegistrationAlert;
    live_connections: number;
    duplicate_incidents: number;
  } {
    const registered = this.registered() != null;
    const counts = {
      live_connections: this.entries.size,
      duplicate_incidents: this.duplicateIncidents,
    };
    if (registered) return { registered, ...counts };
    const alert =
      this.entries.size > 1
        ? this.inIncident
          ? "duplicate_instance"
          : "contested"
        : this.lastAlert;
    return { registered, ...(alert ? { alert } : {}), ...counts };
  }
}
