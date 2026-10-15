/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What the daemon remembers about itself: its identity and certificate, the
// policy ceiling and effective policy, the bay keys it trusts, and its
// floors. Written durably; floors and the key directory's generation only
// ever go up, so replaying an old push or an old file can't revive anything.
// The computer's private key is NOT here (see the CLI's key storage).
// Plan: src/.agents/computers-plan-2026-10-11.md ("The daemon's checks").

import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import {
  MAX_FUTURE_SKEW_MS,
  mergeFloors,
  parseComputerCertificate,
  parseComputerFloors,
  parseComputerState,
  parseSignedEnvelope,
  SIGNED_KINDS,
  type ComputerCertificate,
  type ComputerEndReason,
  type ComputerFloors,
  type ComputerState,
  type DaemonState,
  type SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import {
  parseComputerPolicy,
  policyWideningReasons,
  type ComputerPolicy,
} from "@cocalc/util/computers/policy";
import {
  canonicalHash,
  fingerprintOf,
  policyHash,
  signingPublicKeyFromDer,
  verifyEnvelope,
} from "../crypto";
import { ensurePrivateDir, readJson, writeDurableJson } from "./durable";

export interface TrustedKey {
  kid: string;
  bay_id: string;
  public_key: string;
  not_after: number;
}

export interface PersistedDaemon {
  version: 1;
  state: DaemonState;
  ceiling: ComputerPolicy;
  effective_policy: ComputerPolicy;
  certificate: SignedEnvelope<ComputerCertificate>;
  directory: { generation: number; keys: TrustedKey[] };
  /** Set (for good) when the home bay ended this computer. */
  ended?: { reason: ComputerEndReason } | null;
  /**
   * The hard lease's last renewal: the (hub) time of the newest signed
   * state applied, and the same moment on this boot's clock where the OS
   * has one, so a wall-clock jump can't stretch the lease.
   */
  renewal?: LeaseRenewal;
}

export interface LeaseRenewal {
  at: number;
  boot?: { boot_id: string; since_boot_ms: number } | null;
}

export class DaemonStateError extends Error {}

export class DaemonStore {
  private data: PersistedDaemon;
  private readonly path: string;
  private keyCache = new Map<string, KeyObject>();

  private constructor(dir: string, data: PersistedDaemon) {
    this.path = join(dir, "daemon.json");
    this.data = data;
  }

  /**
   * At pairing: the certificate must be signed by a key in the directory
   * that belongs to the certificate's home bay, and it must match the
   * computer's own key and the approved ceiling.
   */
  static create(
    dir: string,
    init: {
      certificate: unknown;
      ceiling: unknown;
      directory: TrustedKey[];
      computer_key: string;
      agent_network_id: string;
      now?: number;
    },
  ): DaemonStore {
    ensurePrivateDir(dir);
    const certificate = parseSignedEnvelope(
      init.certificate,
      parseComputerCertificate,
      "certificate",
    );
    const c = certificate.payload;
    const ceiling = parseComputerPolicy(init.ceiling);
    const now = init.now ?? Date.now();
    const directory = { generation: 0, keys: init.directory.map(trustedKey) };
    const signer = directory.keys.find(
      (k) => k.kid === certificate.kid && k.bay_id === c.home_bay_id,
    );
    if (
      signer == null ||
      !verifyEnvelope(SIGNED_KINDS.certificate, certificate, (kid) =>
        kid === signer.kid
          ? signingPublicKeyFromDer(signer.public_key)
          : undefined,
      )
    ) {
      throw new DaemonStateError(
        "the certificate is not signed by the computer's home bay",
      );
    }
    if (c.signing_key !== init.computer_key) {
      throw new DaemonStateError("the certificate is for another key");
    }
    if (c.ceiling_hash !== policyHash(ceiling)) {
      throw new DaemonStateError("the certificate is for another policy");
    }
    if (c.not_after <= now) {
      throw new DaemonStateError("the certificate has expired");
    }
    const data: PersistedDaemon = {
      version: 1,
      state: {
        site: c.site,
        cluster_id: c.cluster_id,
        computer_id: c.computer_id,
        computer_key: c.signing_key,
        account_id: c.account_id,
        home_bay_id: c.home_bay_id,
        agent_network_id: init.agent_network_id,
        ceiling_hash: c.ceiling_hash,
        policy_epoch: 0,
        floors: { home_epoch: c.home_epoch, computer_epoch: 0, projects: {} },
      },
      ceiling,
      effective_policy: ceiling,
      certificate,
      directory,
      // Pairing is contact: the lease runs from now.
      renewal: { at: now, boot: null },
    };
    const store = new DaemonStore(dir, data);
    store.save();
    return store;
  }

  static open(dir: string): DaemonStore | undefined {
    const data = readJson<PersistedDaemon>(join(dir, "daemon.json"));
    if (data == null) return undefined;
    if (data.version !== 1) {
      throw new DaemonStateError("unknown daemon state version");
    }
    return new DaemonStore(dir, data);
  }

  get state(): DaemonState {
    return this.data.state;
  }

  get effectivePolicy(): ComputerPolicy {
    return this.data.effective_policy;
  }

  get certificate(): SignedEnvelope<ComputerCertificate> {
    return this.data.certificate;
  }

  private save(): void {
    writeDurableJson(this.path, this.data);
  }

  /**
   * A trusted key with this kid that belongs to this bay and hasn't expired
   * (by the daemon's estimate of hub time).
   */
  trustedKey(
    kid: string,
    bay_id: string,
    hubNow: number,
  ): KeyObject | undefined {
    const entry = this.data.directory.keys.find(
      (k) => k.kid === kid && k.bay_id === bay_id && k.not_after > hubNow,
    );
    if (entry == null) return undefined;
    let key = this.keyCache.get(kid);
    if (key == null) {
      key = signingPublicKeyFromDer(entry.public_key);
      this.keyCache.set(kid, key);
    }
    return key;
  }

  /**
   * A floors push from the home bay. Returns whether any floor went up (the
   * caller then cancels queued work, which is re-authorized at dispatch).
   */
  applyFloors(envelope: unknown, hubNow: number): { raised: boolean } {
    const env = parseSignedEnvelope(envelope, parseComputerFloors, "floors");
    const key = this.trustedKey(env.kid, this.state.home_bay_id, hubNow);
    if (
      key == null ||
      !verifyEnvelope(SIGNED_KINDS.floors, env, (kid) =>
        kid === env.kid ? key : undefined,
      )
    ) {
      throw new DaemonStateError("floors are not signed by the home bay");
    }
    const pushed: ComputerFloors = env.payload;
    if (pushed.computer_id !== this.state.computer_id) {
      throw new DaemonStateError("floors are for another computer");
    }
    const { floors, raised } = mergeFloors(this.state.floors, pushed);
    if (raised) {
      this.data.state = { ...this.state, floors };
      this.save();
    }
    return { raised };
  }

  /** The hard lease's last renewal (pairing, then each signed state). */
  get renewal(): LeaseRenewal {
    return (
      this.data.renewal ?? { at: this.data.certificate.payload.not_before }
    );
  }

  /** The home bay ended this computer for good (persisted), or null. */
  get ended(): PersistedDaemon["ended"] {
    return this.data.ended ?? null;
  }

  /**
   * A state snapshot from the home bay (signed by a current key of the home
   * bay, for this computer), applied in ONE durable write:
   * - floors are raised to the componentwise maximum;
   * - `ended` is terminal;
   * - the policy applies only with a newer epoch and only if it is at most
   *   both the current effective policy and the ceiling (computed here).
   * Restrictions always apply. A widening policy is refused (an error after
   * the write), so a bad policy can never block a revocation. The caller
   * then reconciles every job against the result, whether or not anything
   * changed: a crash between this write and the side effects is repaired by
   * the next replay or start.
   */
  applyState(
    envelope: unknown,
    hubNow: number,
    boot?: { boot_id: string; since_boot_ms: number } | null,
  ): { state: ComputerState; envelope_hash: string } {
    const env = parseSignedEnvelope(envelope, parseComputerState, "state");
    const key = this.trustedKey(env.kid, this.state.home_bay_id, hubNow);
    if (
      key == null ||
      !verifyEnvelope(SIGNED_KINDS.state, env, (kid) =>
        kid === env.kid ? key : undefined,
      )
    ) {
      throw new DaemonStateError("the state is not signed by the home bay");
    }
    const state = env.payload;
    if (state.computer_id !== this.state.computer_id) {
      throw new DaemonStateError("the state is for another computer");
    }
    const { floors } = mergeFloors(this.state.floors, {
      home_epoch: state.home_epoch,
      computer_epoch: state.computer_epoch,
      projects: state.project_floors,
    });
    let widening: string[] = [];
    let policy = this.data.effective_policy;
    let policy_epoch = this.state.policy_epoch;
    if (state.policy_epoch > policy_epoch) {
      widening = [
        ...policyWideningReasons(state.policy, this.data.effective_policy),
        ...policyWideningReasons(state.policy, this.data.ceiling),
      ];
      if (widening.length === 0) {
        policy = state.policy;
        policy_epoch = state.policy_epoch;
      }
    }
    // Contact renews the hard lease to the state's own signed time, and only
    // if that time is not beyond the hub clock (plus the protocol's skew).
    // So replaying a state, even a future-dated one, never moves the lease
    // twice. (Its restrictions apply whatever its time.)
    const renewal =
      state.issued_at > this.renewal.at &&
      state.issued_at <= hubNow + MAX_FUTURE_SKEW_MS
        ? {
            at: state.issued_at,
            boot:
              boot == null
                ? null
                : {
                    boot_id: boot.boot_id,
                    since_boot_ms:
                      boot.since_boot_ms - (hubNow - state.issued_at),
                  },
          }
        : this.renewal;
    this.data = {
      ...this.data,
      state: { ...this.state, floors, policy_epoch },
      effective_policy: policy,
      ended: this.data.ended ?? state.ended ?? null,
      renewal,
    };
    this.save();
    if (widening.length > 0) {
      throw new DaemonStateError(
        `the state's policy would widen this computer's policy: ${widening.join("; ")}`,
      );
    }
    return { state, envelope_hash: canonicalHash(envelope) };
  }

  /**
   * Replace the trusted key directory. Only a newer generation is accepted,
   * so an old directory can't be replayed to revive a removed key. (Stage 1
   * receives it from the home bay over the daemon's authenticated channel.)
   */
  applyDirectory(generation: number, keys: TrustedKey[]): boolean {
    if (
      !Number.isSafeInteger(generation) ||
      generation <= this.data.directory.generation
    ) {
      return false;
    }
    this.data.directory = { generation, keys: keys.map(trustedKey) };
    this.keyCache.clear();
    this.save();
    return true;
  }
}

function trustedKey(k: TrustedKey): TrustedKey {
  // Refuse anything that isn't an Ed25519 key hashing to its kid.
  if (fingerprintOf(signingPublicKeyFromDer(k.public_key)) !== k.kid) {
    throw new DaemonStateError("a trusted key does not match its kid");
  }
  if (typeof k.bay_id !== "string" || !k.bay_id) {
    throw new DaemonStateError("a trusted key needs its bay");
  }
  if (!Number.isSafeInteger(k.not_after)) {
    throw new DaemonStateError("a trusted key needs not_after");
  }
  return {
    kid: k.kid,
    bay_id: k.bay_id,
    public_key: k.public_key,
    not_after: k.not_after,
  };
}
