import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  parseExternalAgentToken,
  validateExternalAgentApproval,
  validateExternalAgentLabel,
  type ExternalAgentInstallation,
  type ExternalAgentSource,
} from "@cocalc/conat/agents/external";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import {
  validateAgentEndpoint,
  type AgentEndpoint,
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

export type ExternalEnrollment = {
  installation_id: string;
  secret_hash: string;
  label: string;
  agent_id?: string;
  targets: AgentEndpoint[];
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
    private readonly validateTarget: (
      account: string,
      target: AgentEndpoint,
    ) => Promise<void>,
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
      destinations: row.destinations,
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
    const opts = {
      ...options,
      targets: options.targets.map((t) => ({ ...t })),
    };
    const approval = [
      opts.label.trim(),
      opts.agent_id ?? "",
      `${opts.ttl_seconds}`,
      ...opts.targets.map((t) => `${t.project_id}/${t.agent_id}`).sort(),
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
    for (const target of opts.targets)
      await this.validateTarget(account, target);
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
      const agent_id = opts.agent_id ?? randomUUID();
      if (opts.agent_id) {
        const existing = (
          await db.query(
            "SELECT agent_id FROM agent_external_identities WHERE account_id=$1 AND agent_id=$2 AND disabled_at IS NULL",
            [account, agent_id],
          )
        ).rows[0];
        if (!existing) throw new Error("external_identity_unavailable");
      } else
        await db.query(
          "INSERT INTO agent_external_identities(agent_id,account_id,label) VALUES($1,$2,$3)",
          [agent_id, account, opts.label.trim()],
        );
      const destinations = opts.targets.map((target) => ({
        target,
        link_id: randomUUID(),
      }));
      current();
      const row = (
        await db.query(
          `INSERT INTO agent_external_installations
        (installation_id,account_id,agent_id,label,secret_hash,state,generation,approval,destinations,expires_at)
        VALUES($1,$2,$3,$4,$5,'active',$6,$7::jsonb,$8::jsonb,$9) RETURNING *`,
          [
            opts.installation_id,
            account,
            agent_id,
            opts.label.trim(),
            opts.secret_hash,
            controls.generation,
            JSON.stringify(approval),
            JSON.stringify(destinations),
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
      const row = await this.active(db, account, installation, controls);
      if (row.secret_hash !== secret_hash)
        throw new Error("external_approval_conflict");
      return this.public(row);
    });
  }

  /** Trusted inter-bay admission recheck, not a public installation-ID login. */
  async check(account: string, installation: string, target: AgentEndpoint) {
    validateAgentEndpoint(target);
    const read = () =>
      this.locked(account, async (db, controls) => {
        const row = await this.active(db, account, installation, controls);
        const destination = row.destinations.find(
          (d) =>
            d.target.project_id === target.project_id &&
            d.target.agent_id === target.agent_id,
        );
        if (!destination) throw new Error("external_destination_not_approved");
        const source: ExternalAgentSource = {
          kind: "external",
          account_id: account,
          agent_id: row.agent_id,
          installation_id: installation,
        };
        return {
          source,
          destination,
          expires_at: new Date(row.expires_at).toISOString(),
        };
      });
    await read();
    await this.validateTarget(account, target);
    return read();
  }
}
