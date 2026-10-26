import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  parseExternalAgentToken,
  validateExternalAgentApproval,
  validateExternalAgentLabel,
  type ExternalAgentDelivery,
  type ExternalAgentInboxAttachment,
  type ExternalAgentInboxMessage,
  type ExternalAgentInstallation,
  type ExternalAgentReservation,
  type ExternalAgentReservationOptions,
} from "@cocalc/conat/agents/external";
import {
  AGENT_ATTACHMENT_PROJECT_BYTES,
  validateAttachmentMetadata,
  validateAttachmentPayload,
  type AgentSnapshot,
  type AgentSnapshotMetadata,
} from "@cocalc/conat/agents/attachments";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import {
  agentRpcSourceKey,
  type AgentRpcSource,
} from "@cocalc/conat/agents/rpc";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import {
  ensureAccountSecurityStateReady,
  getAccountRevokedBeforeCached,
  isAccountBannedCached,
} from "@cocalc/server/accounts/security-state";
import {
  assertPersonalAccountAuthority,
  type PersonalAuthorityDb,
} from "./personal-rehome";
import type { AgentStore } from "./store";
import {
  externalInboxObjectKey,
  externalInboxObjects,
} from "./external-inbox-objects";

/** How long an inbox message is kept (as its INSERT says). */
const EXTERNAL_INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a reservation waits for its send. */
const EXTERNAL_INBOX_RESERVATION_MS = 10 * 60 * 1000;
/** How long a claimed reservation stays live while its send uploads. */
const EXTERNAL_INBOX_UPLOAD_LEASE_MS = 10 * 60 * 1000;

/**
 * UUIDs as the database returns them (lowercase): the sender may spell them
 * otherwise, and rows are compared with them.
 */
function canonicalIds<T extends object>(opts: T): T {
  const out: any = { ...opts };
  for (const field of [
    "account_id",
    "installation_id",
    "attempt_id",
    "agent_network_id",
    "network_generation",
    "reservation_id",
    "source_account_id",
  ])
    if (typeof out[field] === "string") out[field] = out[field].toLowerCase();
  return out;
}
/** What one account's external inboxes may hold and have reserved, together. */
export const EXTERNAL_INBOX_ACCOUNT_BYTES = AGENT_ATTACHMENT_PROJECT_BYTES;
/** Live reservations one account may have. */
const EXTERNAL_INBOX_RESERVATIONS = 64;
/**
 * What every account's files kept in this bay's database (no R2) may come
 * to, held and reserved: file data in a hub database is the exception, so it
 * stays small.
 */
export const EXTERNAL_INBOX_DB_BYTES = 1024 * 1024 * 1024;

/** Whether a reservation is for exactly this send (or this preparation). */
function boundTo(
  row: any,
  opts: {
    installation_id: string;
    attempt_id: string;
    agent_network_id: string;
    network_generation: string;
    source: AgentRpcSource;
    reservation_id?: string;
  },
  source_account_id: string | null,
  manifest: AgentSnapshotMetadata[],
): boolean {
  return (
    (opts.reservation_id === undefined ||
      row.reservation_id === opts.reservation_id) &&
    row.installation_id === opts.installation_id &&
    row.attempt_id === opts.attempt_id &&
    row.agent_network_id === opts.agent_network_id &&
    row.network_generation === opts.network_generation &&
    row.source_key === agentRpcSourceKey(opts.source) &&
    row.source_account_id === source_account_id &&
    sameManifest(row.manifest ?? [], manifest)
  );
}

function sameManifest(
  a: AgentSnapshotMetadata[],
  b: AgentSnapshotMetadata[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (file, i) =>
        file.name === b[i].name &&
        +file.size === b[i].size &&
        file.sha256 === b[i].sha256,
    )
  );
}

export type ExternalEnrollment = {
  installation_id: string;
  secret_hash: string;
  label: string;
  agent_id?: string;
  agent_network_id: string;
  ttl_seconds: number;
};
type Row = Omit<ExternalAgentInstallation, "created_at" | "expires_at"> & {
  secret_hash: string;
  generation: number;
  approval: string[];
  created_at: Date;
  expires_at: Date;
};
type Controls = { paused: boolean; generation: number };
type Hooks = {
  assertAuthority?: typeof assertPersonalAccountAuthority;
  freshAuth?: (account_id: string, session_hash: string) => Promise<void>;
  accountSecurity?: (account_id: string, issued_at?: Date) => Promise<void>;
};

async function accountSecurity(account: string, issued_at?: Date) {
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(account)) throw new Error("account_disabled");
  const revoked = getAccountRevokedBeforeCached(account);
  if (
    issued_at &&
    revoked &&
    issued_at.getTime() <= new Date(revoked).getTime()
  )
    throw new Error("external_credential_revoked");
}

/** Account-home approved authority only. Enrollment adapters must bind the
 * challenge ID and secret hash before approval; never accept an arbitrary
 * agent-supplied source, cookie, or native-run identity as an external login. */
export class ExternalAgentStore {
  constructor(
    private readonly db: AgentStore,
    private readonly hooks: Hooks = {},
  ) {}

  private async locked<T>(
    account: string,
    fn: (db: PersonalAuthorityDb, controls: Controls) => Promise<T>,
  ) {
    requireUuid(account, "account_id");
    await (this.hooks.accountSecurity ?? accountSecurity)(account);
    return this.db.transaction(async (db) => {
      await (this.hooks.assertAuthority ?? assertPersonalAccountAuthority)(
        db,
        account,
      );
      await db.query(
        "INSERT INTO agent_personal_controls(account_id) VALUES($1) ON CONFLICT DO NOTHING",
        [account],
      );
      const controls = (
        await db.query(
          "SELECT paused,generation FROM agent_personal_controls WHERE account_id=$1 FOR UPDATE",
          [account],
        )
      ).rows[0];
      return fn(db, controls);
    });
  }

  private public(row: Row): ExternalAgentInstallation {
    return {
      installation_id: row.installation_id,
      account_id: row.account_id,
      agent_id: row.agent_id,
      label: row.label,
      state: row.state,
      created_at: new Date(row.created_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      agent_network_id: row.agent_network_id,
    };
  }

  private async row(
    db: PersonalAuthorityDb,
    account: string,
    installation: string,
  ): Promise<Row> {
    requireUuid(installation, "installation_id");
    const row = (
      await db.query(
        "SELECT * FROM agent_external_installations WHERE account_id=$1 AND installation_id=$2",
        [account, installation],
      )
    ).rows[0];
    if (!row) throw new Error("external_installation_not_found");
    return row;
  }

  async list(account: string) {
    return this.locked(account, async (db) =>
      (
        await db.query(
          `SELECT * FROM agent_external_installations WHERE account_id=$1
       ORDER BY (state='active' AND expires_at>now()) DESC,created_at DESC LIMIT 1000`,
          [account],
        )
      ).rows.map((row) => this.public(row)),
    );
  }

  async enroll(
    account: string,
    session_hash: string,
    options: ExternalEnrollment,
    approvalDeadline?: number,
  ) {
    const current = () => {
      if (
        approvalDeadline !== undefined &&
        (!Number.isFinite(approvalDeadline) || Date.now() >= approvalDeadline)
      )
        throw new Error("external login challenge expired");
    };
    current();
    validateExternalAgentApproval(options);
    validateExternalAgentLabel(options.label);
    if (
      typeof options.secret_hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(options.secret_hash)
    )
      throw new Error("invalid external secret hash");
    const opts = { ...options };
    const approval = [
      opts.label.trim(),
      opts.agent_id ?? "",
      `${opts.ttl_seconds}`,
      opts.agent_network_id,
    ];
    // The default is the first-party cookie-backed fresh-auth gate. Network
    // adapters must never substitute an agent-controlled approval timestamp.
    const freshAuth =
      this.hooks.freshAuth ??
      (async (account_id, session_hash) => {
        await requireDangerousSessionAuth({
          account_id,
          session_hash,
          require_second_factor: "if_enabled",
          allow_actor_impersonation: false,
        });
      });
    await freshAuth(account, session_hash);
    return this.locked(account, async (db, controls) => {
      current();
      if (controls.paused) throw new Error("messaging_paused");
      const previous = (
        await db.query(
          "SELECT * FROM agent_external_installations WHERE installation_id=$1",
          [opts.installation_id],
        )
      ).rows[0] as Row | undefined;
      if (previous) {
        if (
          previous.account_id !== account ||
          previous.secret_hash !== opts.secret_hash ||
          JSON.stringify(previous.approval) !== JSON.stringify(approval)
        )
          throw new Error("external_approval_conflict");
        // Repeated browser submissions cannot extend expiry or revive a revoke.
        return this.public(
          await this.active(db, account, opts.installation_id, controls),
        );
      }
      const { rows } = await db.query(
        "SELECT count(*) AS count FROM agent_external_installations WHERE account_id=$1 AND state='active' AND expires_at>now()",
        [account],
      );
      if (+rows[0].count >= 1000)
        throw new Error("external_installation_capacity");
      const retained = (
        await db.query(
          "SELECT count(*) AS count FROM agent_external_installations WHERE account_id=$1",
          [account],
        )
      ).rows[0];
      if (+retained.count >= 10_000)
        throw new Error("external_installation_history_capacity");
      const agent_id = opts.agent_id ?? randomUUID();
      if (opts.agent_id) {
        const existing = (
          await db.query(
            "SELECT agent_id FROM agent_external_identities WHERE account_id=$1 AND agent_id=$2 AND disabled_at IS NULL",
            [account, agent_id],
          )
        ).rows[0];
        if (!existing) throw new Error("external_identity_unavailable");
      } else {
        const identities = (
          await db.query(
            "SELECT count(*) AS count FROM agent_external_identities WHERE account_id=$1",
            [account],
          )
        ).rows[0];
        if (+identities.count >= 10_000)
          throw new Error("external_identity_capacity");
        await db.query(
          "INSERT INTO agent_external_identities(agent_id,account_id,label) VALUES($1,$2,$3)",
          [agent_id, account, opts.label.trim()],
        );
      }
      current();
      const row = (
        await db.query(
          `INSERT INTO agent_external_installations
        (installation_id,account_id,agent_id,label,secret_hash,state,generation,approval,agent_network_id,expires_at)
        VALUES($1,$2,$3,$4,$5,'active',$6,$7::jsonb,$8,$9) RETURNING *`,
          [
            opts.installation_id,
            account,
            agent_id,
            opts.label.trim(),
            opts.secret_hash,
            controls.generation,
            JSON.stringify(approval),
            opts.agent_network_id,
            new Date(Date.now() + opts.ttl_seconds * 1000),
          ],
        )
      ).rows[0];
      current();
      return this.public(row);
    });
  }

  /** Restrictive actions require the account session but never fresh elevation. */
  async revoke(account: string, installation: string) {
    return this.locked(account, async (db) => {
      await this.row(db, account, installation);
      await db.query(
        "UPDATE agent_external_installations SET state='revoked' WHERE account_id=$1 AND installation_id=$2",
        [account, installation],
      );
    });
  }

  async disable(account: string, agent_id: string) {
    requireUuid(agent_id, "agent_id");
    return this.locked(account, async (db) => {
      await db.query(
        "UPDATE agent_external_identities SET disabled_at=COALESCE(disabled_at,now()) WHERE account_id=$1 AND agent_id=$2",
        [account, agent_id],
      );
    });
  }

  private async active(
    db: PersonalAuthorityDb,
    account: string,
    installation: string,
    controls: Controls,
  ) {
    const row = await this.row(db, account, installation);
    if (row.state !== "active" || row.expires_at.getTime() <= Date.now())
      throw new Error("external_credential_inactive");
    if (controls.paused || controls.generation !== row.generation)
      throw new Error("external_credential_revoked_or_paused");
    const identity = (
      await db.query(
        "SELECT agent_id FROM agent_external_identities WHERE account_id=$1 AND agent_id=$2 AND disabled_at IS NULL",
        [account, row.agent_id],
      )
    ).rows[0];
    if (!identity) throw new Error("external_identity_unavailable");
    await (this.hooks.accountSecurity ?? accountSecurity)(
      account,
      row.created_at,
    );
    // The credential may expire while the asynchronous checks are running.
    if (row.expires_at.getTime() <= Date.now())
      throw new Error("external_credential_inactive");
    return row;
  }

  async authenticate(token: string) {
    const { account_id, installation_id, secret } =
      parseExternalAgentToken(token);
    return this.locked(account_id, async (db, controls) => {
      const row = await this.active(db, account_id, installation_id, controls);
      const expected = Buffer.from(row.secret_hash, "hex");
      const actual = createHash("sha256").update(secret).digest();
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error("invalid external agent credential");
      return this.public(row);
    });
  }

  /** Trusted sealed-service lookup; never an installation-ID login endpoint. */
  async activeInstallation(account: string, installation: string) {
    return this.locked(account, async (db, controls) =>
      this.public(await this.active(db, account, installation, controls)),
    );
  }

  /** Only the trusted origin bay, after validating the challenge poll secret,
   * may use its immutable credential hash to inspect enrollment completion. */
  async enrollmentStatus(
    account: string,
    installation: string,
    secret_hash: string,
  ) {
    if (typeof secret_hash !== "string" || !/^[a-f0-9]{64}$/.test(secret_hash))
      throw new Error("invalid external secret hash");
    return this.locked(account, async (db, controls) => {
      requireUuid(installation, "installation_id");
      const rows = (
        await db.query(
          "SELECT installation_id FROM agent_external_installations WHERE account_id=$1 AND installation_id=$2",
          [account, installation],
        )
      ).rows;
      if (!rows.length) return null;
      // The secret hash is fixed at enrollment: check it before saying
      // anything about the installation's state (e.g. inactive).
      if (
        (await this.row(db, account, installation)).secret_hash !== secret_hash
      )
        throw new Error("external_approval_conflict");
      const row = await this.active(db, account, installation, controls);
      return this.public(row);
    });
  }

  async enqueue(opts: {
    account_id: string;
    installation_id: string;
    attempt_id: string;
    agent_network_id: string;
    network_generation: string;
    source: AgentRpcSource;
    source_account_id?: string;
    body: string;
    attachments?: AgentSnapshot[];
    reservation_id?: string;
  }): Promise<ExternalAgentInboxMessage> {
    opts = canonicalIds(opts);
    requireUuid(opts.attempt_id, "attempt_id");
    // Optional while bays upgrade: an older sender's bay does not send it,
    // and its message is still delivered (but never inspectable).
    if (opts.source_account_id != null)
      requireUuid(opts.source_account_id, "source_account_id");
    const source_account_id = opts.source_account_id?.toLowerCase() ?? null;
    const attachments = opts.attachments ?? [];
    const manifest = attachments.map(({ name, size, sha256 }) => ({
      name,
      size,
      sha256,
    }));
    if (attachments.length) {
      // The same limits as for any network member, and the content must be
      // what the manifest says.
      validateAttachmentPayload(
        { kind: "snapshots", files: manifest },
        attachments,
      );
      for (const file of attachments)
        if (
          createHash("sha256").update(file.data).digest("hex") !== file.sha256
        )
          throw new Error("external_inbox_attachment_mismatch");
    }
    requireUuid(opts.agent_network_id, "agent_network_id");
    requireUuid(opts.network_generation, "network_generation");
    if (opts.reservation_id != null)
      requireUuid(opts.reservation_id, "reservation_id");
    if (
      typeof opts.body !== "string" ||
      !opts.body.trim() ||
      Buffer.byteLength(opts.body, "utf8") > 32768
    )
      throw new Error("invalid external inbox body");
    // First, before any bytes are stored: the same attempt again is answered
    // from what is stored (nothing is uploaded again), and new files need
    // the reservation made for exactly them.
    const admitted = await this.locked(
      opts.account_id,
      async (db, controls) => {
        await this.activeInNetwork(db, opts, controls);
        const existing = await this.existingMessage(
          db,
          opts,
          source_account_id,
          manifest,
        );
        if (existing) return { existing };
        if (!attachments.length) return {};
        const reservation = await this.reservationFor(db, opts);
        if (
          !reservation ||
          !boundTo(reservation, opts, source_account_id, manifest) ||
          new Date(reservation.expires_at).getTime() <= Date.now()
        )
          throw new Error("external_inbox_attachment_unreserved");
        // Claimed for this send while it uploads: still counted against the
        // bounds (its lease keeps it live), never released by a cancel, and
        // no second send of the attempt uploads meanwhile.
        if (reservation.claim_id != null)
          throw new Error("external_inbox_attachment_in_progress");
        const claim_id = randomUUID();
        await db.query(
          `UPDATE agent_external_inbox_reservations
           SET claim_id=$2,
               expires_at=GREATEST(expires_at,now()+($3 * interval '1 millisecond'))
           WHERE reservation_id=$1`,
          [
            reservation.reservation_id,
            claim_id,
            EXTERNAL_INBOX_UPLOAD_LEASE_MS,
          ],
        );
        return {
          storage: reservation.storage as "r2" | "postgres",
          claim_id,
        };
      },
    );
    if (admitted.existing) return admitted.existing;
    try {
      return await this.store(opts, admitted, source_account_id, manifest);
    } catch (error) {
      // The send failed: its claim goes, so that a retry may use the
      // reservation while it lasts.
      if (admitted.claim_id)
        await this.locked(opts.account_id, (db) =>
          db.query(
            "UPDATE agent_external_inbox_reservations SET claim_id=NULL WHERE reservation_id=$1 AND claim_id=$2",
            [opts.reservation_id, admitted.claim_id],
          ),
        ).catch(() => {});
      throw error;
    }
  }

  /** Uploads (with R2) and stores a send admitted by enqueue. */
  private async store(
    opts: {
      account_id: string;
      installation_id: string;
      attempt_id: string;
      agent_network_id: string;
      network_generation: string;
      source: AgentRpcSource;
      body: string;
      attachments?: AgentSnapshot[];
      reservation_id?: string;
    },
    admitted: { storage?: "r2" | "postgres"; claim_id?: string },
    source_account_id: string | null,
    manifest: AgentSnapshotMetadata[],
  ): Promise<ExternalAgentInboxMessage> {
    const attachments = opts.attachments ?? [];
    // Then the reserved bytes go to the object store, outside the account's
    // lock (they may be large), and the rows say only where. Nothing uploaded
    // is removed here: every object goes with its day
    // (removeExpiredExternalInboxObjects).
    let keys: string[] | undefined;
    if (admitted.storage === "r2") {
      const objects = await externalInboxObjects("write");
      if (!objects)
        throw new Error("external_inbox_attachment_storage_unavailable");
      const expires_at = Date.now() + EXTERNAL_INBOX_RETENTION_MS;
      keys = attachments.map((file, idx) =>
        externalInboxObjectKey({
          account_id: opts.account_id,
          attempt_id: opts.attempt_id,
          idx,
          sha256: file.sha256,
          expires_at,
        }),
      );
      for (const [idx, file] of attachments.entries())
        await objects.put(
          keys[idx],
          Buffer.from(
            file.data.buffer,
            file.data.byteOffset,
            file.data.byteLength,
          ),
        );
    }
    // Last, the message, consuming the reservation (its room becomes the
    // files'); a concurrent send of the same attempt stored it already.
    return this.locked(opts.account_id, async (db, controls) => {
      await this.activeInNetwork(db, opts, controls);
      const existing = await this.existingMessage(
        db,
        opts,
        source_account_id,
        manifest,
      );
      if (existing) return existing;
      if (attachments.length) {
        // Only with this send's claim, while its lease lasts: past it the
        // room stopped being counted, and the files would exceed the bounds.
        const consumed = (
          await db.query(
            `DELETE FROM agent_external_inbox_reservations
             WHERE reservation_id=$1 AND account_id=$2 AND claim_id=$3
               AND expires_at>now()
             RETURNING *`,
            [opts.reservation_id, opts.account_id, admitted.claim_id],
          )
        ).rows[0];
        if (
          !consumed ||
          !boundTo(consumed, opts, source_account_id, manifest) ||
          consumed.storage !== admitted.storage
        )
          throw new Error("external_inbox_attachment_unreserved");
      }
      const pending = (
        await db.query(
          `SELECT count(*) AS count FROM agent_external_inbox
           WHERE account_id=$1 AND installation_id=$2 AND state='pending' AND expires_at>now()`,
          [opts.account_id, opts.installation_id],
        )
      ).rows[0];
      if (+pending.count >= 1000) throw new Error("external_inbox_capacity");
      const row = (
        await db.query(
          `INSERT INTO agent_external_inbox
           (message_id,attempt_id,account_id,installation_id,agent_network_id,
            network_generation,source,source_account_id,body,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,now()+interval '7 days') RETURNING *`,
          [
            randomUUID(),
            opts.attempt_id,
            opts.account_id,
            opts.installation_id,
            opts.agent_network_id,
            opts.network_generation,
            JSON.stringify(opts.source),
            source_account_id,
            opts.body,
          ],
        )
      ).rows[0];
      for (const [idx, file] of attachments.entries())
        await db.query(
          `INSERT INTO agent_external_inbox_attachments
           (message_id,idx,account_id,installation_id,name,size,sha256,data,r2_key,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            row.message_id,
            idx,
            opts.account_id,
            opts.installation_id,
            file.name,
            file.size,
            file.sha256,
            keys
              ? null
              : Buffer.from(
                  file.data.buffer,
                  file.data.byteOffset,
                  file.data.byteLength,
                ),
            keys?.[idx] ?? null,
            row.expires_at,
          ],
        );
      await db.query(
        "DELETE FROM agent_external_inbox WHERE account_id=$1 AND expires_at<=now()",
        [opts.account_id],
      );
      await db.query(
        "DELETE FROM agent_external_inbox_attachments WHERE account_id=$1 AND expires_at<=now()",
        [opts.account_id],
      );
      return this.publicInbox(row, attachments.length ? manifest : undefined);
    });
  }

  /**
   * Reserves room for one attempt's files before their bytes move
   * (prepare-attachments): the installation must be active in that network,
   * and the files must fit what the account may hold, counting what it holds
   * and what is reserved. Files kept in Postgres must also fit this bay's
   * bound for them. Preparing the same attempt again returns the same
   * reservation; anything else for it is a conflict.
   */
  async reserve(
    opts: ExternalAgentReservationOptions,
  ): Promise<ExternalAgentReservation> {
    opts = canonicalIds(opts);
    for (const field of [
      "installation_id",
      "attempt_id",
      "agent_network_id",
      "network_generation",
      "source_account_id",
    ] as const)
      requireUuid(opts[field], field);
    validateAttachmentMetadata({ kind: "snapshots", files: opts.manifest });
    const manifest = opts.manifest.map(({ name, size, sha256 }) => ({
      name,
      size,
      sha256,
    }));
    const bytes = manifest.reduce((sum, file) => sum + file.size, 0);
    const source_account_id = opts.source_account_id.toLowerCase();
    const storage = (await externalInboxObjects("write")) ? "r2" : "postgres";
    return this.locked(opts.account_id, async (db, controls) => {
      await this.activeInNetwork(db, opts, controls);
      const sent = await this.existingMessage(
        db,
        { ...opts, body: undefined },
        source_account_id,
        manifest,
      );
      if (sent)
        // Already stored: the send is answered from it, and needs no room.
        return {
          reservation_id: sent.message_id,
          expires_at: Date.now() + EXTERNAL_INBOX_RESERVATION_MS,
        };
      const prior = await this.reservationFor(db, opts);
      if (prior) {
        const live = new Date(prior.expires_at).getTime() > Date.now();
        if (live && boundTo(prior, opts, source_account_id, manifest))
          return {
            reservation_id: prior.reservation_id,
            expires_at: new Date(prior.expires_at).getTime(),
          };
        if (live) throw new Error("external_inbox_idempotency_conflict");
        await db.query(
          "DELETE FROM agent_external_inbox_reservations WHERE reservation_id=$1",
          [prior.reservation_id],
        );
      }
      const used = (
        await db.query(
          `SELECT
             (SELECT COALESCE(SUM(size),0) FROM agent_external_inbox_attachments
              WHERE account_id=$1 AND expires_at>now()) AS held,
             (SELECT COALESCE(SUM(bytes),0) FROM agent_external_inbox_reservations
              WHERE account_id=$1 AND expires_at>now()) AS reserved,
             (SELECT count(*) FROM agent_external_inbox_reservations
              WHERE account_id=$1 AND expires_at>now()) AS reservations`,
          [opts.account_id],
        )
      ).rows[0];
      if (
        +used.held + +used.reserved + bytes > EXTERNAL_INBOX_ACCOUNT_BYTES ||
        +used.reservations >= EXTERNAL_INBOX_RESERVATIONS
      )
        throw new Error("external_inbox_attachment_capacity");
      if (storage === "postgres") {
        // Every account's files on this bay's database: one at a time.
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('agent-external-inbox-db-bytes',0))",
        );
        const inDb = (
          await db.query(
            `SELECT
               (SELECT COALESCE(SUM(size),0) FROM agent_external_inbox_attachments
                WHERE data IS NOT NULL AND expires_at>now()) AS held,
               (SELECT COALESCE(SUM(bytes),0) FROM agent_external_inbox_reservations
                WHERE storage='postgres' AND expires_at>now()) AS reserved`,
          )
        ).rows[0];
        if (+inDb.held + +inDb.reserved + bytes > EXTERNAL_INBOX_DB_BYTES)
          throw new Error("external_inbox_attachment_capacity");
      }
      const row = (
        await db.query(
          `INSERT INTO agent_external_inbox_reservations
           (reservation_id,account_id,installation_id,attempt_id,agent_network_id,
            network_generation,source_key,source_account_id,manifest,bytes,storage,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,now()+($12 * interval '1 millisecond'))
           RETURNING reservation_id,expires_at`,
          [
            randomUUID(),
            opts.account_id,
            opts.installation_id,
            opts.attempt_id,
            opts.agent_network_id,
            opts.network_generation,
            agentRpcSourceKey(opts.source),
            source_account_id,
            JSON.stringify(manifest),
            bytes,
            storage,
            EXTERNAL_INBOX_RESERVATION_MS,
          ],
        )
      ).rows[0];
      return {
        reservation_id: row.reservation_id,
        expires_at: new Date(row.expires_at).getTime(),
      };
    });
  }

  /** The sender gives up its reservation (cancel-attachments). */
  async release(opts: {
    account_id: string;
    installation_id: string;
    attempt_id: string;
    reservation_id: string;
    source: AgentRpcSource;
    source_account_id: string;
  }): Promise<boolean> {
    opts = canonicalIds(opts);
    requireUuid(opts.reservation_id, "reservation_id");
    requireUuid(opts.attempt_id, "attempt_id");
    requireUuid(opts.source_account_id, "source_account_id");
    return this.locked(opts.account_id, async (db) => {
      const result = await db.query(
        `DELETE FROM agent_external_inbox_reservations
         WHERE reservation_id=$1 AND account_id=$2 AND installation_id=$3
           AND attempt_id=$4 AND source_key=$5 AND source_account_id=$6
           AND claim_id IS NULL
         RETURNING reservation_id`,
        [
          opts.reservation_id,
          opts.account_id,
          opts.installation_id,
          opts.attempt_id,
          agentRpcSourceKey(opts.source),
          opts.source_account_id.toLowerCase(),
        ],
      );
      return result.rows.length > 0;
    });
  }

  /** The installation is active, and in the network the sender used. */
  private async activeInNetwork(
    db: PersonalAuthorityDb,
    opts: {
      account_id: string;
      installation_id: string;
      agent_network_id: string;
    },
    controls: Controls,
  ) {
    const installation = await this.active(
      db,
      opts.account_id,
      opts.installation_id,
      controls,
    );
    if (installation.agent_network_id !== opts.agent_network_id)
      throw new Error("external_network_mismatch");
  }

  /**
   * The message already stored for this attempt, when it is this one (the
   * same sender, target and content); a conflict when it is not. Without a
   * body (a reservation), the body is not compared.
   */
  private async existingMessage(
    db: PersonalAuthorityDb,
    opts: {
      account_id: string;
      installation_id: string;
      attempt_id: string;
      agent_network_id: string;
      network_generation: string;
      source: AgentRpcSource;
      body?: string;
    },
    source_account_id: string | null,
    manifest: AgentSnapshotMetadata[],
  ): Promise<ExternalAgentInboxMessage | undefined> {
    const existing = (
      await db.query(
        "SELECT * FROM agent_external_inbox WHERE account_id=$1 AND attempt_id=$2",
        [opts.account_id, opts.attempt_id],
      )
    ).rows[0];
    if (!existing) return undefined;
    if (
      existing.installation_id !== opts.installation_id ||
      existing.agent_network_id !== opts.agent_network_id ||
      existing.network_generation !== opts.network_generation ||
      (opts.body !== undefined && existing.body !== opts.body) ||
      (existing.source_account_id != null &&
        existing.source_account_id !== source_account_id) ||
      agentRpcSourceKey(existing.source) !== agentRpcSourceKey(opts.source)
    )
      throw new Error("external_inbox_idempotency_conflict");
    const stored = await this.manifests(db, [existing.message_id]);
    if (!sameManifest(stored.get(existing.message_id) ?? [], manifest))
      throw new Error("external_inbox_idempotency_conflict");
    return this.publicInbox(existing, stored.get(existing.message_id));
  }

  /** The reservation held for this attempt, if any (live or not). */
  private async reservationFor(
    db: PersonalAuthorityDb,
    opts: { account_id: string; attempt_id: string },
  ) {
    return (
      await db.query(
        "SELECT * FROM agent_external_inbox_reservations WHERE account_id=$1 AND attempt_id=$2",
        [opts.account_id, opts.attempt_id],
      )
    ).rows[0];
  }

  /** The attachment manifests of these messages, in order. */
  private async manifests(
    db: PersonalAuthorityDb,
    message_ids: string[],
  ): Promise<Map<string, AgentSnapshotMetadata[]>> {
    const byMessage = new Map<string, AgentSnapshotMetadata[]>();
    if (!message_ids.length) return byMessage;
    const rows = (
      await db.query(
        `SELECT message_id,name,size,sha256 FROM agent_external_inbox_attachments
         WHERE message_id = ANY($1::uuid[]) ORDER BY message_id,idx`,
        [message_ids],
      )
    ).rows;
    for (const row of rows) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push({ name: row.name, size: +row.size, sha256: row.sha256 });
      byMessage.set(row.message_id, list);
    }
    return byMessage;
  }

  private publicInbox(
    row: any,
    attachments?: AgentSnapshotMetadata[],
  ): ExternalAgentInboxMessage {
    return {
      message_id: row.message_id,
      attempt_id: row.attempt_id,
      agent_network_id: row.agent_network_id,
      source: row.source,
      body: row.body,
      created_at: new Date(row.created_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      ...(attachments?.length ? { attachments } : {}),
    };
  }

  /**
   * Pending messages, oldest first. With includeAcknowledged, acknowledged
   * ones too (each with its state), until they expire: acknowledging must not
   * be the only chance to read a message.
   */
  async inbox(
    account: string,
    installation: string,
    limit = 50,
    { includeAcknowledged = false }: { includeAcknowledged?: boolean } = {},
  ) {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.locked(account, async (db, controls) => {
      await this.active(db, account, installation, controls);
      const rows = (
        await db.query(
          `SELECT * FROM agent_external_inbox
           WHERE account_id=$1 AND installation_id=$2 AND expires_at>now()
             AND ($4 OR state='pending')
           ORDER BY created_at,message_id LIMIT $3`,
          [account, installation, bounded, includeAcknowledged],
        )
      ).rows;
      const manifests = await this.manifests(
        db,
        rows.map((row) => row.message_id),
      );
      return rows.map((row) => {
        const message = this.publicInbox(row, manifests.get(row.message_id));
        return includeAcknowledged
          ? {
              ...message,
              state:
                row.state === "acknowledged"
                  ? ("acknowledged" as const)
                  : ("pending" as const),
              ...(row.acknowledged_at
                ? {
                    acknowledged_at: new Date(
                      row.acknowledged_at,
                    ).toISOString(),
                  }
                : {}),
            }
          : message;
      });
    });
  }

  /** One file of one of this installation's messages (read or not). */
  async attachment(
    account: string,
    installation: string,
    message_id: string,
    index: number,
  ): Promise<ExternalAgentInboxAttachment> {
    requireUuid(message_id, "message_id");
    const { row, count } = await this.locked(account, async (db, controls) => {
      await this.active(db, account, installation, controls);
      const rows = (
        await db.query(
          `SELECT idx,name,size,sha256,data,r2_key FROM agent_external_inbox_attachments
             WHERE account_id=$1 AND installation_id=$2 AND message_id=$3 AND expires_at>now()
             ORDER BY idx`,
          [account, installation, message_id],
        )
      ).rows;
      const row = rows.find((row) => +row.idx === index);
      if (!row) throw new Error("external_inbox_attachment_not_found");
      return { row, count: rows.length };
    });
    // From the object store after the lock: the file may be large.
    let data: Buffer | undefined = row.data ?? undefined;
    if (data == null && row.r2_key)
      data = await (await externalInboxObjects("read"))?.get(row.r2_key);
    if (
      data == null ||
      createHash("sha256").update(data).digest("hex") !== row.sha256
    )
      throw new Error("external_inbox_attachment_unavailable");
    return {
      message_id,
      index,
      count,
      name: row.name,
      size: +row.size,
      sha256: row.sha256,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
  }

  async acknowledge(account: string, installation: string, message_id: string) {
    requireUuid(message_id, "message_id");
    return this.locked(account, async (db, controls) => {
      await this.active(db, account, installation, controls);
      const result = await db.query(
        `UPDATE agent_external_inbox
         SET state='acknowledged',acknowledged_at=COALESCE(acknowledged_at,now())
         WHERE account_id=$1 AND installation_id=$2 AND message_id=$3
           AND expires_at>now()
         RETURNING *`,
        [account, installation, message_id],
      );
      if (!result.rows.length)
        throw new Error("external_inbox_message_not_found");
      // The message itself too: a caller that acknowledges without having
      // read it (a failed parse, a cut-off output) still gets it once.
      return {
        acknowledged: true as const,
        message_id,
        message: this.publicInbox(result.rows[0]),
      };
    });
  }

  /**
   * For the sender: whether its message is still unread (pending) or was
   * read (acknowledged), and when. Null when no such unexpired message is
   * held, or it is not this sender's (the same source and the same
   * authenticated account): never tells one sender about another's.
   */
  async delivery(
    account: string,
    installation: string,
    attempt_id: string,
    agent_network_id: string,
    source: AgentRpcSource,
    source_account_id: string,
  ): Promise<ExternalAgentDelivery | null> {
    requireUuid(installation, "installation_id");
    requireUuid(attempt_id, "attempt_id");
    requireUuid(agent_network_id, "agent_network_id");
    requireUuid(source_account_id, "source_account_id");
    return this.locked(account, async (db) => {
      // UUIDs compare in SQL, so their case does not matter. A row from a
      // sender's bay that predates source_account_id (NULL) never matches.
      const row = (
        await db.query(
          `SELECT * FROM agent_external_inbox
           WHERE account_id=$1 AND attempt_id=$2 AND installation_id=$3
             AND agent_network_id=$4 AND source_account_id=$5
             AND expires_at>now()`,
          [
            account,
            attempt_id,
            installation,
            agent_network_id,
            source_account_id,
          ],
        )
      ).rows[0];
      if (!row || agentRpcSourceKey(row.source) !== agentRpcSourceKey(source))
        return null;
      return {
        state: row.state === "acknowledged" ? "acknowledged" : "pending",
        created_at: new Date(row.created_at).toISOString(),
        expires_at: new Date(row.expires_at).toISOString(),
        ...(row.acknowledged_at
          ? { acknowledged_at: new Date(row.acknowledged_at).toISOString() }
          : {}),
      };
    });
  }
}
