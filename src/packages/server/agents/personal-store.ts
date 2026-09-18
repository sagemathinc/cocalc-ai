import { createHash, randomUUID } from "node:crypto";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import {
  agentRpcSourceKey,
  isExternalAgentSource,
  validateAgentEndpoint,
  validateAgentRpcSource,
  type AgentEndpoint,
  type AgentRpcBroadcast,
  type AgentRpcBroadcastOutcome,
  type AgentRpcSource,
} from "@cocalc/conat/agents/rpc";
import {
  normalizeAgentName,
  PersonalAgentAuthorizationError,
  type AgentSession,
  type AgentSessionActivity,
  type AgentSessionAuthorization,
  type AgentSessionDeliveryMode,
  type AgentSessionDiscovery,
  type AgentSessionMember,
  type AgentSessionMemberLocator,
  type AgentSessionProposal,
  type CreateAgentSessionOptions,
  type NamedAgent,
  type NameAgentOptions,
  type PersonalMessagingControls,
  type ProposeAgentSessionOptions,
  type RetireNamedAgentOptions,
  type SetPersonalMessagingStateOptions,
  type UpdateAgentSessionOptions,
} from "@cocalc/conat/agents/personal";
import type { AgentStore } from "./store";
import { assertPersonalAccountAuthority } from "./personal-rehome";

const MAX_ACTIVE_SESSIONS = 100;
const MAX_RETAINED_SESSIONS = 1000;
const MAX_TITLE_LENGTH = 120;
const MAX_ACTIVITY_PER_ACCOUNT = 10_000;
const MAX_PENDING_PROPOSALS = 100;
const MAX_EXPANSIVE_MUTATIONS_PER_HOUR = 1_000;
const iso = (value: Date | string) => new Date(value).toISOString();
const same = (a: AgentEndpoint, b: AgentEndpoint) =>
  a.project_id === b.project_id && a.agent_id === b.agent_id;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

type Query = {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
};

export class PersonalAgentStore {
  constructor(
    private readonly db: AgentStore,
    private readonly identity: (
      account: string,
      endpoint: AgentEndpoint,
    ) => Promise<AgentIdentity>,
    private readonly principal: (
      source: AgentEndpoint,
      run_id: string,
    ) => Promise<string>,
    private readonly assertAuthority: (
      db: Query,
      account_id: string,
    ) => Promise<void> = assertPersonalAccountAuthority,
  ) {}

  async assertHome(account_id: string) {
    await this.db.transaction((db) => this.assertAuthority(db, account_id));
  }

  async endpoint(account: string, endpoint: AgentEndpoint) {
    validateAgentEndpoint(endpoint);
    const identity = await this.identity(account, endpoint);
    if (
      identity.disabled_at ||
      identity.project_id !== endpoint.project_id ||
      identity.agent_id !== endpoint.agent_id
    )
      throw new PersonalAgentAuthorizationError("agent_unavailable");
    return identity;
  }

  async controls(
    account: string,
    db: Query = this.db,
  ): Promise<PersonalMessagingControls> {
    return (
      (
        await db.query(
          "SELECT paused,generation FROM agent_personal_controls WHERE account_id=$1",
          [account],
        )
      ).rows[0] ?? { paused: false, generation: 0 }
    );
  }

  private async locked<T>(
    account: string,
    fn: (db: Query, controls: PersonalMessagingControls) => Promise<T>,
  ): Promise<T> {
    requireUuid(account, "account_id");
    return this.db.transaction(async (db) => {
      await this.assertAuthority(db, account);
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

  private named(row: any, available = true): NamedAgent {
    return {
      ...row.metadata,
      account_id: row.account_id,
      name: row.name,
      endpoint: { project_id: row.project_id, agent_id: row.agent_id },
      available,
      updated_at: iso(row.updated_at),
    };
  }

  async names(account: string): Promise<NamedAgent[]> {
    const rows = (
      await this.db.query(
        "SELECT * FROM agent_personal_names WHERE account_id=$1 AND retired_at IS NULL ORDER BY name",
        [account],
      )
    ).rows;
    const result: NamedAgent[] = [];
    for (const row of rows) {
      const named = this.named(row);
      try {
        await this.endpoint(account, named.endpoint);
      } catch {
        named.available = false;
      }
      result.push(named);
    }
    return result;
  }

  async name(
    account: string,
    opts: NameAgentOptions,
    maxActive = Number.POSITIVE_INFINITY,
  ): Promise<NamedAgent> {
    const name = normalizeAgentName(opts.name);
    const identity = await this.endpoint(account, opts.endpoint);
    for (const key of ["description", "project_title", "thread_title"] as const)
      if (
        opts[key] !== undefined &&
        (typeof opts[key] !== "string" || opts[key].length > 500)
      )
        throw new Error(`invalid ${key}`);
    const metadata = {
      path: identity.path,
      thread_id: identity.thread_id,
      description: opts.description,
      project_title: opts.project_title,
      thread_title: opts.thread_title,
    };
    return this.locked(account, async (db) => {
      const currentForEndpoint = (
        await db.query(
          "SELECT name FROM agent_personal_names WHERE account_id=$1 AND project_id=$2 AND agent_id=$3 AND retired_at IS NULL",
          [account, opts.endpoint.project_id, opts.endpoint.agent_id],
        )
      ).rows[0];
      const previous = (
        await db.query(
          "SELECT * FROM agent_personal_names WHERE account_id=$1 AND name=$2",
          [account, name],
        )
      ).rows[0];
      if (
        previous &&
        (previous.project_id !== opts.endpoint.project_id ||
          previous.agent_id !== opts.endpoint.agent_id)
      )
        throw new Error("name_reserved");
      if (!currentForEndpoint) {
        const active = +(
          await db.query(
            "SELECT count(*) AS count FROM agent_personal_names WHERE account_id=$1 AND retired_at IS NULL",
            [account],
          )
        ).rows[0].count;
        if (active >= maxActive)
          throw new Error(`named_agent_limit_reached:${active}:${maxActive}`);
      }
      if (!previous) {
        const count = (
          await db.query(
            "SELECT count(*) AS count FROM agent_personal_names WHERE account_id=$1",
            [account],
          )
        ).rows[0];
        if (+count.count >= 1000) throw new Error("agent_name_capacity");
      }
      await db.query(
        "UPDATE agent_personal_names SET retired_at=now(),updated_at=now() WHERE account_id=$1 AND project_id=$2 AND agent_id=$3 AND retired_at IS NULL AND name<>$4",
        [account, opts.endpoint.project_id, opts.endpoint.agent_id, name],
      );
      const row = (
        await db.query(
          `INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,name) DO UPDATE SET metadata=EXCLUDED.metadata,retired_at=NULL,updated_at=now() RETURNING *`,
          [
            account,
            name,
            opts.endpoint.project_id,
            opts.endpoint.agent_id,
            metadata,
          ],
        )
      ).rows[0];
      return this.named(row);
    });
  }

  async retire(account: string, opts: RetireNamedAgentOptions): Promise<void> {
    validateAgentEndpoint(opts.endpoint);
    await this.locked(account, async (db) => {
      await db.query(
        "UPDATE agent_personal_names SET retired_at=now(),updated_at=now() WHERE account_id=$1 AND project_id=$2 AND agent_id=$3 AND retired_at IS NULL",
        [account, opts.endpoint.project_id, opts.endpoint.agent_id],
      );
    });
  }

  async resolveName(account: string, value: string): Promise<NamedAgent> {
    const name = normalizeAgentName(value);
    const row = (
      await this.db.query(
        "SELECT * FROM agent_personal_names WHERE account_id=$1 AND name=$2",
        [account, name],
      )
    ).rows[0];
    if (!row) throw new Error("name_not_found");
    if (row.retired_at) {
      const current = (
        await this.db.query(
          "SELECT name FROM agent_personal_names WHERE account_id=$1 AND project_id=$2 AND agent_id=$3 AND retired_at IS NULL",
          [account, row.project_id, row.agent_id],
        )
      ).rows[0];
      throw new Error(`name_renamed:${current?.name ?? ""}`);
    }
    await this.endpoint(account, {
      project_id: row.project_id,
      agent_id: row.agent_id,
    });
    return this.named(row);
  }

  private validateTitle(title?: string) {
    if (title === undefined) return undefined;
    if (typeof title !== "string" || title.trim().length > MAX_TITLE_LENGTH)
      throw new Error("invalid_session_title");
    return title.trim() || undefined;
  }

  private validateDelivery(value?: string): AgentSessionDeliveryMode {
    if (value === undefined) return "queued";
    if (value !== "queued" && value !== "live")
      throw new Error("invalid_delivery_mode");
    return value;
  }

  private validateLocator(locator: AgentSessionMemberLocator) {
    if (locator.kind === "registered") validateAgentEndpoint(locator.endpoint);
    else {
      requireUuid(locator.agent_id, "external agent_id");
      requireUuid(locator.installation_id, "external installation_id");
    }
  }

  private locatorKey(locator: AgentSessionMemberLocator) {
    return locator.kind === "registered"
      ? `registered/${locator.endpoint.project_id}/${locator.endpoint.agent_id}`
      : `external/${locator.agent_id}/${locator.installation_id}`;
  }

  private async validateMembers(
    account: string,
    members: AgentSessionMemberLocator[],
    memberLimit: number,
  ) {
    if (!Array.isArray(members) || members.length < 2)
      throw new Error("agent_session_requires_two_members");
    if (members.length > Math.min(memberLimit, 64))
      throw new Error(`agent_session_member_limit_reached:${memberLimit}`);
    const seen = new Set<string>();
    for (const member of members) {
      this.validateLocator(member);
      const key = this.locatorKey(member);
      if (seen.has(key)) throw new Error("duplicate_session_member");
      seen.add(key);
      if (member.kind === "registered") {
        await this.endpoint(account, member.endpoint);
        const named = (
          await this.db.query(
            "SELECT 1 FROM agent_personal_names WHERE account_id=$1 AND project_id=$2 AND agent_id=$3 AND retired_at IS NULL",
            [account, member.endpoint.project_id, member.endpoint.agent_id],
          )
        ).rows[0];
        if (!named) throw new Error("session_member_not_named");
      }
    }
  }

  private proposal(row: any): AgentSessionProposal {
    return {
      proposal_id: row.proposal_id,
      account_id: row.account_id,
      source: row.source,
      title: row.title,
      delivery_mode: row.delivery_mode,
      members: row.members,
      reason: row.reason,
      state: row.state,
      created_at: iso(row.created_at),
      expires_at: iso(row.expires_at),
      resolved_at: row.resolved_at ? iso(row.resolved_at) : null,
      agent_session_id: row.agent_session_id,
    };
  }

  async proposeSession(
    account: string,
    source: AgentRpcSource,
    run_id: string | undefined,
    options: ProposeAgentSessionOptions,
    memberLimit: number,
  ): Promise<AgentSessionProposal> {
    requireUuid(options.proposal_id, "proposal_id");
    validateAgentRpcSource(source, run_id);
    if (isExternalAgentSource(source)) {
      const active = (
        await this.db.query(
          `SELECT 1 FROM agent_external_installations
           WHERE account_id=$1 AND agent_id=$2 AND installation_id=$3
             AND state='active' AND expires_at>now()`,
          [account, source.agent_id, source.installation_id],
        )
      ).rows[0];
      if (!active) throw new Error("external_identity_unavailable");
    } else {
      if ((await this.principal(source, run_id!)) !== account)
        throw new PersonalAgentAuthorizationError("principal_mismatch");
      await this.endpoint(account, source);
    }
    const title = this.validateTitle(options.title);
    const delivery_mode = this.validateDelivery(options.delivery_mode);
    if (
      options.reason !== undefined &&
      (typeof options.reason !== "string" || options.reason.length > 500)
    )
      throw new Error("invalid_proposal_reason");
    await this.validateMembers(account, options.members, memberLimit);
    const sourcePresent = options.members.some((member) =>
      member.kind === "registered"
        ? !isExternalAgentSource(source) && same(member.endpoint, source)
        : isExternalAgentSource(source) &&
          member.agent_id === source.agent_id &&
          member.installation_id === source.installation_id,
    );
    if (!sourcePresent) throw new Error("proposal_must_include_source");
    const binding = digest({
      source: agentRpcSourceKey(source),
      title,
      delivery_mode,
      members: options.members.map((x) => this.locatorKey(x)).sort(),
      reason: options.reason?.trim() || undefined,
    });
    return this.locked(account, async (db, controls) => {
      if (controls.paused) throw new Error("messaging_paused");
      const existing = (
        await db.query(
          "SELECT * FROM agent_session_proposals WHERE account_id=$1 AND proposal_id=$2",
          [account, options.proposal_id],
        )
      ).rows[0];
      if (existing) {
        if (existing.binding_hash !== binding)
          throw new Error("proposal_idempotency_conflict");
        return this.proposal(existing);
      }
      const pending = +(
        await db.query(
          `SELECT count(*) AS count FROM agent_session_proposals
           WHERE account_id=$1 AND state='pending' AND expires_at>now()`,
          [account],
        )
      ).rows[0].count;
      if (pending >= MAX_PENDING_PROPOSALS)
        throw new Error("proposal_capacity_reached");
      const recent = +(
        await db.query(
          `SELECT count(*) AS count FROM agent_session_proposals
           WHERE account_id=$1 AND created_at>now()-interval '1 hour'`,
          [account],
        )
      ).rows[0].count;
      if (recent >= 100) throw new Error("proposal_rate_limited");
      const row = (
        await db.query(
          `INSERT INTO agent_session_proposals
           (proposal_id,account_id,source,title,delivery_mode,members,reason,binding_hash,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '7 days') RETURNING *`,
          [
            options.proposal_id,
            account,
            source,
            title,
            delivery_mode,
            options.members,
            options.reason?.trim() || null,
            binding,
          ],
        )
      ).rows[0];
      return this.proposal(row);
    });
  }

  async proposals(
    account: string,
    limit = 100,
  ): Promise<AgentSessionProposal[]> {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    await this.db.query(
      `UPDATE agent_session_proposals SET state='expired',resolved_at=now()
       WHERE account_id=$1 AND state='pending' AND expires_at<=now()`,
      [account],
    );
    return (
      await this.db.query(
        `SELECT * FROM agent_session_proposals WHERE account_id=$1
         ORDER BY created_at DESC LIMIT $2`,
        [account, bounded],
      )
    ).rows.map((row) => this.proposal(row));
  }

  async getProposal(account: string, proposal_id: string) {
    requireUuid(proposal_id, "proposal_id");
    const row = (
      await this.db.query(
        "SELECT * FROM agent_session_proposals WHERE account_id=$1 AND proposal_id=$2",
        [account, proposal_id],
      )
    ).rows[0];
    if (!row) throw new Error("session_proposal_not_found");
    if (
      row.state !== "pending" ||
      new Date(row.expires_at).getTime() <= Date.now()
    )
      throw new Error("session_proposal_not_pending");
    return this.proposal(row);
  }

  async finishProposal(
    account: string,
    proposal_id: string,
    state: "approved" | "rejected",
    agent_session_id?: string,
  ) {
    requireUuid(proposal_id, "proposal_id");
    if (agent_session_id) requireUuid(agent_session_id, "agent_session_id");
    const row = (
      await this.db.query(
        `UPDATE agent_session_proposals
         SET state=$3,resolved_at=now(),agent_session_id=$4
         WHERE account_id=$1 AND proposal_id=$2 AND state='pending'
         RETURNING *`,
        [account, proposal_id, state, agent_session_id ?? null],
      )
    ).rows[0];
    if (!row) throw new Error("session_proposal_not_pending");
    return this.proposal(row);
  }

  async beginBroadcast(
    account: string,
    source: AgentRpcSource,
    run_id: string | undefined,
    broadcast: AgentRpcBroadcast,
  ): Promise<{
    claimed: boolean;
    binding_hash: string;
    outcome?: AgentRpcBroadcastOutcome;
  }> {
    for (const target of broadcast.targets)
      await this.checkSession(
        account,
        broadcast.agent_session_id,
        source,
        run_id,
        target,
      );
    const binding_hash = digest({
      source: agentRpcSourceKey(source),
      agent_session_id: broadcast.agent_session_id,
      targets: broadcast.targets.map(agentRpcSourceKey),
      body: broadcast.body,
    });
    return this.locked(account, async (db, controls) => {
      if (controls.paused) throw new Error("messaging_paused");
      const existing = (
        await db.query(
          `SELECT binding_hash,state,outcome FROM agent_session_broadcasts
           WHERE account_id=$1 AND broadcast_id=$2`,
          [account, broadcast.broadcast_id],
        )
      ).rows[0];
      if (existing) {
        if (existing.binding_hash !== binding_hash)
          throw new Error("broadcast_idempotency_conflict");
        return {
          claimed: false,
          binding_hash,
          ...(existing.state === "complete" && existing.outcome
            ? { outcome: existing.outcome }
            : {}),
        };
      }
      await db.query(
        `INSERT INTO agent_session_broadcasts
         (account_id,broadcast_id,agent_session_id,source,binding_hash,state)
         VALUES($1,$2,$3,$4,$5,'pending')`,
        [
          account,
          broadcast.broadcast_id,
          broadcast.agent_session_id,
          source,
          binding_hash,
        ],
      );
      return { claimed: true, binding_hash };
    });
  }

  async finishBroadcast(
    account: string,
    broadcast_id: string,
    binding_hash: string,
    outcome: AgentRpcBroadcastOutcome,
  ) {
    requireUuid(broadcast_id, "broadcast_id");
    const row = (
      await this.db.query(
        `UPDATE agent_session_broadcasts
         SET state='complete',outcome=$4,updated_at=now()
         WHERE account_id=$1 AND broadcast_id=$2 AND binding_hash=$3
         RETURNING broadcast_id`,
        [account, broadcast_id, binding_hash, outcome],
      )
    ).rows[0];
    if (!row) throw new Error("broadcast_binding_unavailable");
  }

  private mutationBinding(action: string, options: unknown) {
    return digest([action, options]);
  }

  private async replay(
    db: Query,
    account: string,
    request_id: string,
    binding_hash: string,
  ): Promise<string | undefined> {
    requireUuid(request_id, "request_id");
    const row = (
      await db.query(
        "SELECT binding_hash,agent_session_id FROM agent_session_mutations WHERE account_id=$1 AND request_id=$2",
        [account, request_id],
      )
    ).rows[0];
    if (!row) return undefined;
    if (row.binding_hash !== binding_hash)
      throw new Error("session_mutation_idempotency_conflict");
    return row.agent_session_id;
  }

  private async recordMutation(
    db: Query,
    account: string,
    request_id: string,
    binding_hash: string,
    agent_session_id: string,
  ) {
    await db.query(
      "INSERT INTO agent_session_mutations(account_id,request_id,binding_hash,agent_session_id) VALUES($1,$2,$3,$4)",
      [account, request_id, binding_hash, agent_session_id],
    );
    await db.query(
      `DELETE FROM agent_session_mutations WHERE account_id=$1 AND request_id IN
       (SELECT request_id FROM agent_session_mutations WHERE account_id=$1 ORDER BY created_at DESC OFFSET 10000)`,
      [account],
    );
  }

  private async assertExpansiveMutationRate(db: Query, account: string) {
    const recent = +(
      await db.query(
        `SELECT count(*) AS count FROM agent_session_mutations
         WHERE account_id=$1 AND created_at>now()-interval '1 hour'`,
        [account],
      )
    ).rows[0].count;
    if (recent >= MAX_EXPANSIVE_MUTATIONS_PER_HOUR)
      throw new Error("agent_session_mutation_rate_limited");
  }

  private async insertMember(
    db: Query,
    account: string,
    agent_session_id: string,
    member: AgentSessionMemberLocator,
  ) {
    if (member.kind === "registered") {
      await db.query(
        `INSERT INTO agent_session_members
         (agent_session_id,member_kind,member_id,registered_agent_id,project_id,added_by)
         VALUES($1,'registered',$2,$2,$3,$4)`,
        [
          agent_session_id,
          member.endpoint.agent_id,
          member.endpoint.project_id,
          account,
        ],
      );
      return;
    }
    const installation = (
      await db.query(
        `SELECT * FROM agent_external_installations
         WHERE account_id=$1 AND installation_id=$2 AND agent_id=$3
           AND agent_session_id=$4 AND state='active' AND expires_at>now()`,
        [account, member.installation_id, member.agent_id, agent_session_id],
      )
    ).rows[0];
    if (!installation) throw new Error("external_identity_unavailable");
    await db.query(
      `INSERT INTO agent_session_members
       (agent_session_id,member_kind,member_id,external_agent_id,installation_id,added_by)
       VALUES($1,'external',$2,$2,$3,$4)`,
      [agent_session_id, member.agent_id, member.installation_id, account],
    );
  }

  private async member(db: Query, account: string, row: any) {
    if (row.member_kind === "registered") {
      const namedRow = (
        await db.query(
          `SELECT * FROM agent_personal_names
           WHERE account_id=$1 AND project_id=$2 AND agent_id=$3 AND retired_at IS NULL`,
          [account, row.project_id, row.registered_agent_id],
        )
      ).rows[0];
      let available = !!namedRow;
      if (available)
        try {
          await this.endpoint(account, {
            project_id: row.project_id,
            agent_id: row.registered_agent_id,
          });
        } catch {
          available = false;
        }
      return {
        kind: "registered" as const,
        member_id: row.member_id,
        endpoint: {
          project_id: row.project_id,
          agent_id: row.registered_agent_id,
        },
        name: namedRow?.name,
        project_title: namedRow?.metadata?.project_title,
        thread_title: namedRow?.metadata?.thread_title,
        available,
        added_at: iso(row.added_at),
        removed_at: row.removed_at ? iso(row.removed_at) : null,
      };
    }
    const external = (
      await db.query(
        `SELECT i.*,e.disabled_at FROM agent_external_installations i
         JOIN agent_external_identities e USING(agent_id)
         WHERE i.account_id=$1 AND i.installation_id=$2 AND i.agent_id=$3`,
        [account, row.installation_id, row.external_agent_id],
      )
    ).rows[0];
    return {
      kind: "external" as const,
      member_id: row.member_id,
      source: {
        kind: "external" as const,
        account_id: account,
        agent_id: row.external_agent_id,
        installation_id: row.installation_id,
      },
      label: external?.label ?? "External agent",
      available:
        !!external &&
        !external.disabled_at &&
        external.state === "active" &&
        new Date(external.expires_at).getTime() > Date.now(),
      added_at: iso(row.added_at),
      removed_at: row.removed_at ? iso(row.removed_at) : null,
    };
  }

  private async session(
    db: Query,
    account: string,
    row: any,
  ): Promise<AgentSession> {
    const members: AgentSessionMember[] = [];
    for (const memberRow of (
      await db.query(
        "SELECT * FROM agent_session_members WHERE agent_session_id=$1 ORDER BY added_at,member_id",
        [row.agent_session_id],
      )
    ).rows)
      members.push(await this.member(db, account, memberRow));
    return {
      agent_session_id: row.agent_session_id,
      account_id: row.account_id,
      title: row.title,
      state: row.state,
      delivery_mode: row.delivery_mode,
      generation: row.generation,
      created_by: row.created_by,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      closed_at: row.closed_at ? iso(row.closed_at) : null,
      members,
    };
  }

  async sessions(account: string, limit = 100, cursor?: string) {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const values: unknown[] = [account, bounded + 1];
    let cursorSql = "";
    if (cursor) {
      const [updated, id] = Buffer.from(cursor, "base64url")
        .toString()
        .split("/");
      requireUuid(id, "session cursor");
      if (!Number.isFinite(+updated)) throw new Error("invalid_session_cursor");
      values.push(new Date(+updated), id);
      cursorSql = "AND (updated_at,agent_session_id)<($3,$4)";
    }
    const rows = (
      await this.db.query(
        `SELECT * FROM agent_sessions WHERE account_id=$1 ${cursorSql}
         ORDER BY updated_at DESC,agent_session_id DESC LIMIT $2`,
        values,
      )
    ).rows;
    const page = rows.slice(0, bounded);
    const sessions: AgentSession[] = [];
    for (const row of page)
      sessions.push(await this.session(this.db, account, row));
    const last = page[page.length - 1];
    const active_count = +(
      await this.db.query(
        "SELECT count(*) AS count FROM agent_sessions WHERE account_id=$1 AND state<>'closed'",
        [account],
      )
    ).rows[0].count;
    return {
      sessions,
      active_count,
      next_cursor:
        rows.length > bounded && last
          ? Buffer.from(
              `${new Date(last.updated_at).getTime()}/${last.agent_session_id}`,
            ).toString("base64url")
          : undefined,
    };
  }

  async createSession(
    account: string,
    options: CreateAgentSessionOptions,
    memberLimit: number,
    fresh = false,
  ): Promise<AgentSession> {
    requireUuid(options.request_id, "request_id");
    const title = this.validateTitle(options.title);
    const delivery = this.validateDelivery(options.delivery_mode);
    await this.validateMembers(account, options.members, memberLimit);
    const projects = new Set(
      options.members
        .filter((x) => x.kind === "registered")
        .map((x) => x.kind === "registered" && x.endpoint.project_id),
    );
    if (
      (projects.size > 1 || (delivery === "live" && projects.size > 1)) &&
      !fresh
    )
      throw new Error("fresh_auth_required");
    const binding = this.mutationBinding("create", {
      title,
      delivery,
      members: options.members.map((x) => this.locatorKey(x)).sort(),
    });
    return this.locked(account, async (db, controls) => {
      if (controls.paused) throw new Error("messaging_paused");
      const replay = await this.replay(
        db,
        account,
        options.request_id,
        binding,
      );
      if (replay) {
        const row = (
          await db.query(
            "SELECT * FROM agent_sessions WHERE account_id=$1 AND agent_session_id=$2",
            [account, replay],
          )
        ).rows[0];
        return this.session(db, account, row);
      }
      await this.assertExpansiveMutationRate(db, account);
      const counts = (
        await db.query(
          `SELECT count(*) AS retained,
             count(*) FILTER(WHERE state<>'closed') AS active
           FROM agent_sessions WHERE account_id=$1`,
          [account],
        )
      ).rows[0];
      if (+counts.retained >= MAX_RETAINED_SESSIONS)
        throw new Error("agent_session_history_capacity");
      if (+counts.active >= MAX_ACTIVE_SESSIONS)
        throw new Error("agent_session_capacity");
      const agent_session_id = randomUUID();
      const row = (
        await db.query(
          `INSERT INTO agent_sessions
           (agent_session_id,account_id,title,state,delivery_mode,generation,created_by)
           VALUES($1,$2,$3,'active',$4,$5,$2) RETURNING *`,
          [agent_session_id, account, title, delivery, randomUUID()],
        )
      ).rows[0];
      for (const member of options.members)
        await this.insertMember(db, account, agent_session_id, member);
      await this.recordMutation(
        db,
        account,
        options.request_id,
        binding,
        agent_session_id,
      );
      return this.session(db, account, row);
    });
  }

  private async lockedSession(db: Query, account: string, id: string) {
    requireUuid(id, "agent_session_id");
    const row = (
      await db.query(
        "SELECT * FROM agent_sessions WHERE account_id=$1 AND agent_session_id=$2 FOR UPDATE",
        [account, id],
      )
    ).rows[0];
    if (!row) throw new Error("agent_session_not_found");
    return row;
  }

  async updateSession(
    account: string,
    options: UpdateAgentSessionOptions,
    memberLimit: number,
    fresh = false,
  ): Promise<AgentSession> {
    requireUuid(options.request_id, "request_id");
    requireUuid(options.agent_session_id, "agent_session_id");
    if ("member" in options) this.validateLocator(options.member);
    const normalized = {
      ...options,
      ...(options.action === "set-title"
        ? { title: this.validateTitle(options.title) }
        : {}),
    };
    const binding = this.mutationBinding("update", normalized);
    return this.locked(account, async (db, controls) => {
      const replay = await this.replay(
        db,
        account,
        options.request_id,
        binding,
      );
      if (replay) {
        const row = await this.lockedSession(db, account, replay);
        return this.session(db, account, row);
      }
      const row = await this.lockedSession(
        db,
        account,
        options.agent_session_id,
      );
      if (row.state === "closed") throw new Error("agent_session_closed");
      if (
        options.action === "add-member" ||
        options.action === "resume" ||
        options.action === "set-title" ||
        (options.action === "set-delivery" && options.delivery_mode === "live")
      )
        await this.assertExpansiveMutationRate(db, account);
      const activeMembers = (
        await db.query(
          "SELECT * FROM agent_session_members WHERE agent_session_id=$1 AND removed_at IS NULL FOR UPDATE",
          [row.agent_session_id],
        )
      ).rows;
      const projectSet = new Set(
        activeMembers
          .filter((x) => x.member_kind === "registered")
          .map((x) => x.project_id),
      );
      if (options.action === "resume" && projectSet.size > 1 && !fresh)
        throw new Error("fresh_auth_required");
      if (
        options.action === "set-delivery" &&
        options.delivery_mode === "live" &&
        row.delivery_mode !== "live" &&
        projectSet.size > 1 &&
        !fresh
      )
        throw new Error("fresh_auth_required");
      if (options.action === "add-member") {
        await this.validateMembers(
          account,
          [
            ...activeMembers.map((x) =>
              x.member_kind === "registered"
                ? ({
                    kind: "registered",
                    endpoint: {
                      project_id: x.project_id,
                      agent_id: x.registered_agent_id,
                    },
                  } as const)
                : ({
                    kind: "external",
                    agent_id: x.external_agent_id,
                    installation_id: x.installation_id,
                  } as const),
            ),
            options.member,
          ],
          memberLimit,
        );
        if (
          options.member.kind === "registered" &&
          projectSet.size > 0 &&
          !projectSet.has(options.member.endpoint.project_id) &&
          !fresh
        )
          throw new Error("fresh_auth_required");
        await this.insertMember(
          db,
          account,
          row.agent_session_id,
          options.member,
        );
      } else if (options.action === "remove-member") {
        const memberId =
          options.member.kind === "registered"
            ? options.member.endpoint.agent_id
            : options.member.agent_id;
        const result = await db.query(
          `UPDATE agent_session_members SET removed_at=now()
           WHERE agent_session_id=$1 AND member_kind=$2 AND member_id=$3 AND removed_at IS NULL RETURNING member_id`,
          [row.agent_session_id, options.member.kind, memberId],
        );
        if (!result.rows.length)
          throw new Error("agent_session_member_not_found");
        if (activeMembers.length - 1 < 2)
          throw new Error("agent_session_requires_two_members");
      } else if (options.action === "pause") {
        row.state = "paused";
      } else if (options.action === "resume") {
        if (controls.paused) throw new Error("messaging_paused");
        row.state = "active";
      } else if (options.action === "close") {
        row.state = "closed";
      } else if (options.action === "set-delivery") {
        row.delivery_mode = this.validateDelivery(options.delivery_mode);
      } else if (options.action === "set-title") {
        row.title = this.validateTitle(options.title);
      }
      const updated = (
        await db.query(
          `UPDATE agent_sessions SET title=$3,state=$4,delivery_mode=$5,
             generation=$6,updated_at=now(),closed_at=CASE WHEN $4='closed' THEN now() ELSE closed_at END
           WHERE account_id=$1 AND agent_session_id=$2 RETURNING *`,
          [
            account,
            row.agent_session_id,
            row.title,
            row.state,
            row.delivery_mode,
            randomUUID(),
          ],
        )
      ).rows[0];
      await this.recordMutation(
        db,
        account,
        options.request_id,
        binding,
        row.agent_session_id,
      );
      return this.session(db, account, updated);
    });
  }

  private findMember(members: AgentSessionMember[], source: AgentRpcSource) {
    return members.find((member) =>
      isExternalAgentSource(source)
        ? member.kind === "external" &&
          member.source.agent_id === source.agent_id &&
          member.source.installation_id === source.installation_id &&
          member.source.account_id === source.account_id
        : member.kind === "registered" && same(member.endpoint, source),
    );
  }

  async checkSession(
    account: string,
    agent_session_id: string,
    source: AgentRpcSource,
    run_id: string | undefined,
    target: AgentRpcSource,
  ): Promise<AgentSessionAuthorization> {
    requireUuid(agent_session_id, "agent_session_id");
    if (!isExternalAgentSource(source)) {
      requireUuid(run_id, "run_id");
      if ((await this.principal(source, run_id!)) !== account)
        throw new PersonalAgentAuthorizationError("principal_mismatch");
    } else if (source.account_id !== account) {
      throw new PersonalAgentAuthorizationError("principal_mismatch");
    }
    return this.locked(account, async (db, controls) => {
      if (controls.paused)
        throw new PersonalAgentAuthorizationError("session_paused");
      const row = await this.lockedSession(db, account, agent_session_id);
      if (row.state === "closed")
        throw new PersonalAgentAuthorizationError("session_closed");
      if (row.state !== "active")
        throw new PersonalAgentAuthorizationError("session_paused");
      const session = await this.session(db, account, row);
      const sourceMember = this.findMember(session.members, source);
      const targetMember = this.findMember(session.members, target);
      if (
        !sourceMember ||
        !targetMember ||
        sourceMember.removed_at ||
        targetMember.removed_at ||
        !sourceMember.available ||
        !targetMember.available ||
        sourceMember.member_id === targetMember.member_id
      )
        throw new PersonalAgentAuthorizationError("not_a_member");
      return {
        agent_session_id,
        session_generation: row.generation,
        account_generation: controls.generation,
        account_id: account,
        delivery_mode: row.delivery_mode,
        source: sourceMember,
        target: targetMember,
      };
    });
  }

  async discover(
    account: string,
    source: AgentRpcSource,
    run_id?: string,
  ): Promise<AgentSessionDiscovery> {
    if (!isExternalAgentSource(source)) {
      requireUuid(run_id, "run_id");
      if ((await this.principal(source, run_id!)) !== account)
        throw new PersonalAgentAuthorizationError("principal_mismatch");
    }
    const rows = (
      await this.db.query(
        `SELECT DISTINCT s.* FROM agent_sessions s
         JOIN agent_session_members m USING(agent_session_id)
         WHERE s.account_id=$1 AND s.state='active' AND m.removed_at IS NULL
           AND ((m.member_kind='registered' AND m.registered_agent_id=$2)
             OR (m.member_kind='external' AND m.external_agent_id=$2))
         ORDER BY s.updated_at DESC LIMIT 100`,
        [account, source.agent_id],
      )
    ).rows;
    const sessions: AgentSession[] = [];
    for (const row of rows)
      sessions.push(await this.session(this.db, account, row));
    const peers = new Map<string, AgentSessionDiscovery["peers"][number]>();
    for (const session of sessions)
      for (const member of session.members) {
        if (this.findMember([member], source)) continue;
        const key =
          member.kind === "registered"
            ? `registered/${member.endpoint.project_id}/${member.endpoint.agent_id}`
            : agentRpcSourceKey(member.source);
        const current = peers.get(key) ?? { member, sessions: [] };
        current.sessions.push({
          agent_session_id: session.agent_session_id,
          title: session.title,
          delivery_mode: session.delivery_mode,
          generation: session.generation,
        });
        peers.set(key, current);
      }
    return { peers: [...peers.values()] };
  }

  async observeActivity(account: string, activity: AgentSessionActivity) {
    requireUuid(activity.attempt_id, "attempt_id");
    await this.locked(account, async (db) => {
      await db.query(
        `INSERT INTO agent_session_activity
         (attempt_id,account_id,agent_session_id,session_generation,source_member_id,target_member_id,configured_delivery,effective_delivery,outcome,observed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(attempt_id) DO UPDATE SET
           effective_delivery=EXCLUDED.effective_delivery,outcome=EXCLUDED.outcome,observed_at=EXCLUDED.observed_at`,
        [
          activity.attempt_id,
          account,
          activity.agent_session_id,
          activity.session_generation,
          activity.source_member_id,
          activity.target_member_id,
          activity.configured_delivery,
          activity.effective_delivery,
          activity.outcome,
          new Date(activity.observed_at),
        ],
      );
      await db.query(
        `DELETE FROM agent_session_activity WHERE account_id=$1 AND attempt_id IN
         (SELECT attempt_id FROM agent_session_activity WHERE account_id=$1 ORDER BY observed_at DESC OFFSET $2)`,
        [account, MAX_ACTIVITY_PER_ACCOUNT],
      );
    });
  }

  async activity(account: string, agent_session_id: string, limit = 100) {
    requireUuid(agent_session_id, "agent_session_id");
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    return (
      await this.db.query(
        `SELECT * FROM agent_session_activity WHERE account_id=$1 AND agent_session_id=$2
         ORDER BY observed_at DESC LIMIT $3`,
        [account, agent_session_id, bounded],
      )
    ).rows.map((row) => ({ ...row, observed_at: iso(row.observed_at) }));
  }

  async inspectActivity(
    account: string,
    agent_session_id: string,
    attempt_id: string,
  ): Promise<AgentSessionActivity | undefined> {
    requireUuid(agent_session_id, "agent_session_id");
    requireUuid(attempt_id, "attempt_id");
    const row = (
      await this.db.query(
        `SELECT * FROM agent_session_activity
         WHERE account_id=$1 AND agent_session_id=$2 AND attempt_id=$3`,
        [account, agent_session_id, attempt_id],
      )
    ).rows[0];
    return row ? { ...row, observed_at: iso(row.observed_at) } : undefined;
  }

  async setControls(account: string, opts: SetPersonalMessagingStateOptions) {
    if (!["pause", "resume", "revoke_all"].includes(opts.action))
      throw new Error("invalid messaging control");
    return this.locked(account, async (db, controls) => {
      const generation =
        opts.action === "revoke_all"
          ? controls.generation + 1
          : controls.generation;
      const paused = opts.action !== "resume";
      const row = (
        await db.query(
          "UPDATE agent_personal_controls SET paused=$2,generation=$3 WHERE account_id=$1 RETURNING paused,generation",
          [account, paused, generation],
        )
      ).rows[0];
      if (opts.action === "revoke_all")
        await db.query(
          "UPDATE agent_sessions SET state='closed',generation=$2,updated_at=now(),closed_at=now() WHERE account_id=$1 AND state<>'closed'",
          [account, randomUUID()],
        );
      return row;
    });
  }
}
