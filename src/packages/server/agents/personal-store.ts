import { createHash, randomUUID } from "node:crypto";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import {
  agentRpcSourceKey,
  isExternalAgentSource,
  validateAgentEndpoint,
  validateAgentRpcSource,
  validateAgentRpcTarget,
  type AgentEndpoint,
  type AgentRpcBroadcast,
  type AgentRpcBroadcastOutcome,
  type AgentRpcSource,
} from "@cocalc/conat/agents/rpc";
import {
  normalizeAgentName,
  PersonalAgentAuthorizationError,
  type AgentNetwork,
  type AgentNetworkActivity,
  type AgentNetworkAuthorization,
  type AgentNetworkDeliveryMode,
  type AgentNetworkDiscovery,
  type AgentNetworkMember,
  type AgentNetworkMemberLocator,
  type AgentNetworkProposal,
  type CreateAgentNetworkOptions,
  type NamedAgent,
  type NameAgentOptions,
  type PersonalMessagingControls,
  type ProposeAgentNetworkOptions,
  type RetireNamedAgentOptions,
  type SetPersonalMessagingStateOptions,
  type UpdateAgentNetworkOptions,
} from "@cocalc/conat/agents/personal";
import type { AgentStore } from "./store";
import { assertPersonalAccountAuthority } from "./personal-rehome";

const MAX_ACTIVE_NETWORKS = 100;
const MAX_RETAINED_NETWORKS = 1000;
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

  private validateTitle(title: string) {
    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.trim().length > MAX_TITLE_LENGTH
    )
      throw new Error("invalid_network_title");
    return title.trim();
  }

  private validateDelivery(value?: string): AgentNetworkDeliveryMode {
    if (value === undefined) return "queued";
    if (value !== "queued" && value !== "live")
      throw new Error("invalid_delivery_mode");
    return value;
  }

  private validateLocator(locator: AgentNetworkMemberLocator) {
    if (locator.kind === "registered") validateAgentEndpoint(locator.endpoint);
    else {
      requireUuid(locator.agent_id, "external agent_id");
      requireUuid(locator.installation_id, "external installation_id");
    }
  }

  private locatorKey(locator: AgentNetworkMemberLocator) {
    return locator.kind === "registered"
      ? `registered/${locator.endpoint.project_id}/${locator.endpoint.agent_id}`
      : `external/${locator.agent_id}/${locator.installation_id}`;
  }

  private validateMemberList(
    members: AgentNetworkMemberLocator[],
    memberLimit: number,
  ) {
    if (!Array.isArray(members) || members.length < 2)
      throw new Error("agent_network_requires_two_members");
    if (members.length > Math.min(memberLimit, 64))
      throw new Error(`agent_network_member_limit_reached:${memberLimit}`);
    const seen = new Set<string>();
    for (const member of members) {
      this.validateLocator(member);
      const key = this.locatorKey(member);
      if (seen.has(key)) throw new Error("duplicate_network_member");
      seen.add(key);
    }
  }

  private async validateRegisteredMember(
    account: string,
    member: AgentNetworkMemberLocator,
  ) {
    if (member.kind !== "registered") return;
    await this.endpoint(account, member.endpoint);
    await this.assertRegisteredName(this.db, account, member.endpoint);
  }

  private async assertRegisteredName(
    db: Query,
    account: string,
    endpoint: AgentEndpoint,
  ) {
    const named = (
      await db.query(
        "SELECT 1 FROM agent_personal_names WHERE account_id=$1 AND project_id=$2 AND agent_id=$3 AND retired_at IS NULL",
        [account, endpoint.project_id, endpoint.agent_id],
      )
    ).rows[0];
    if (!named) throw new Error("network_member_not_named");
  }

  private async validateMembers(
    account: string,
    members: AgentNetworkMemberLocator[],
    memberLimit: number,
  ) {
    this.validateMemberList(members, memberLimit);
    for (const member of members)
      await this.validateRegisteredMember(account, member);
  }

  private proposal(row: any): AgentNetworkProposal {
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
      agent_network_id: row.agent_network_id,
    };
  }

  async proposeNetwork(
    account: string,
    source: AgentRpcSource,
    run_id: string | undefined,
    options: ProposeAgentNetworkOptions,
    memberLimit: number,
  ): Promise<AgentNetworkProposal> {
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
          "SELECT * FROM agent_network_proposals WHERE account_id=$1 AND proposal_id=$2",
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
          `SELECT count(*) AS count FROM agent_network_proposals
           WHERE account_id=$1 AND state='pending' AND expires_at>now()`,
          [account],
        )
      ).rows[0].count;
      if (pending >= MAX_PENDING_PROPOSALS)
        throw new Error("proposal_capacity_reached");
      const recent = +(
        await db.query(
          `SELECT count(*) AS count FROM agent_network_proposals
           WHERE account_id=$1 AND created_at>now()-interval '1 hour'`,
          [account],
        )
      ).rows[0].count;
      if (recent >= 100) throw new Error("proposal_rate_limited");
      const row = (
        await db.query(
          `INSERT INTO agent_network_proposals
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
  ): Promise<AgentNetworkProposal[]> {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    await this.db.query(
      `UPDATE agent_network_proposals SET state='expired',resolved_at=now()
       WHERE account_id=$1 AND state='pending' AND expires_at<=now()`,
      [account],
    );
    return (
      await this.db.query(
        `SELECT * FROM agent_network_proposals WHERE account_id=$1
         ORDER BY created_at DESC LIMIT $2`,
        [account, bounded],
      )
    ).rows.map((row) => this.proposal(row));
  }

  async getProposal(account: string, proposal_id: string) {
    requireUuid(proposal_id, "proposal_id");
    const row = (
      await this.db.query(
        "SELECT * FROM agent_network_proposals WHERE account_id=$1 AND proposal_id=$2",
        [account, proposal_id],
      )
    ).rows[0];
    if (!row) throw new Error("network_proposal_not_found");
    if (
      row.state !== "pending" ||
      new Date(row.expires_at).getTime() <= Date.now()
    )
      throw new Error("network_proposal_not_pending");
    return this.proposal(row);
  }

  async finishProposal(
    account: string,
    proposal_id: string,
    state: "approved" | "rejected",
    agent_network_id?: string,
  ) {
    requireUuid(proposal_id, "proposal_id");
    if (agent_network_id) requireUuid(agent_network_id, "agent_network_id");
    const row = (
      await this.db.query(
        `UPDATE agent_network_proposals
         SET state=$3,resolved_at=now(),agent_network_id=$4
         WHERE account_id=$1 AND proposal_id=$2 AND state='pending'
         RETURNING *`,
        [account, proposal_id, state, agent_network_id ?? null],
      )
    ).rows[0];
    if (!row) throw new Error("network_proposal_not_pending");
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
    authorizations?: AgentNetworkAuthorization[];
  }> {
    requireUuid(broadcast.agent_network_id, "agent_network_id");
    requireUuid(broadcast.broadcast_id, "broadcast_id");
    await this.authenticateSource(account, source, run_id);
    for (const target of broadcast.targets) validateAgentRpcTarget(target);
    const binding_hash = digest({
      source: agentRpcSourceKey(source),
      agent_network_id: broadcast.agent_network_id,
      targets: broadcast.targets.map(agentRpcSourceKey),
      body: broadcast.body,
    });
    const snapshot = await this.locked(account, async (db, controls) => {
      const authorizations = await this.authorizationSnapshot(
        db,
        controls,
        account,
        broadcast.agent_network_id,
        source,
        broadcast.targets,
      );
      const existing = (
        await db.query(
          `SELECT binding_hash,state,outcome FROM agent_network_broadcasts
           WHERE account_id=$1 AND broadcast_id=$2`,
          [account, broadcast.broadcast_id],
        )
      ).rows[0];
      if (existing) {
        if (existing.binding_hash !== binding_hash)
          throw new Error("broadcast_idempotency_conflict");
        return {
          existing: true as const,
          claimed: false,
          binding_hash,
          ...(existing.state === "complete" && existing.outcome
            ? { outcome: existing.outcome }
            : {}),
        };
      }
      return {
        existing: false as const,
        authorizations,
        account_generation: controls.generation,
        network_generation: authorizations[0].network_generation,
        delivery_mode: authorizations[0].delivery_mode,
      };
    });
    if (snapshot.existing) return snapshot;

    // Project/account identity checks may route across bays. Never perform
    // them while holding the account-home controls or network row locks.
    for (const target of broadcast.targets)
      if (!isExternalAgentSource(target)) await this.endpoint(account, target);

    return this.locked(account, async (db, controls) => {
      if (
        controls.paused ||
        controls.generation !== snapshot.account_generation
      )
        throw new PersonalAgentAuthorizationError("network_stale");
      const row = await this.lockedNetwork(
        db,
        account,
        broadcast.agent_network_id,
      );
      if (
        row.state !== "active" ||
        row.generation !== snapshot.network_generation ||
        row.delivery_mode !== snapshot.delivery_mode
      )
        throw new PersonalAgentAuthorizationError("network_stale");
      const existing = (
        await db.query(
          `SELECT binding_hash,state,outcome FROM agent_network_broadcasts
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
        `INSERT INTO agent_network_broadcasts
         (account_id,broadcast_id,agent_network_id,source,binding_hash,state)
         VALUES($1,$2,$3,$4,$5,'pending')`,
        [
          account,
          broadcast.broadcast_id,
          broadcast.agent_network_id,
          source,
          binding_hash,
        ],
      );
      return {
        claimed: true,
        binding_hash,
        authorizations: snapshot.authorizations,
      };
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
        `UPDATE agent_network_broadcasts
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
        "SELECT binding_hash,agent_network_id FROM agent_network_mutations WHERE account_id=$1 AND request_id=$2",
        [account, request_id],
      )
    ).rows[0];
    if (!row) return undefined;
    if (row.binding_hash !== binding_hash)
      throw new Error("network_mutation_idempotency_conflict");
    return row.agent_network_id;
  }

  private async recordMutation(
    db: Query,
    account: string,
    request_id: string,
    binding_hash: string,
    agent_network_id: string,
  ) {
    await db.query(
      "INSERT INTO agent_network_mutations(account_id,request_id,binding_hash,agent_network_id) VALUES($1,$2,$3,$4)",
      [account, request_id, binding_hash, agent_network_id],
    );
    await db.query(
      `DELETE FROM agent_network_mutations WHERE account_id=$1 AND request_id IN
       (SELECT request_id FROM agent_network_mutations WHERE account_id=$1 ORDER BY created_at DESC OFFSET 10000)`,
      [account],
    );
  }

  private async assertExpansiveMutationRate(db: Query, account: string) {
    const recent = +(
      await db.query(
        `SELECT count(*) AS count FROM agent_network_mutations
         WHERE account_id=$1 AND created_at>now()-interval '1 hour'`,
        [account],
      )
    ).rows[0].count;
    if (recent >= MAX_EXPANSIVE_MUTATIONS_PER_HOUR)
      throw new Error("agent_network_mutation_rate_limited");
  }

  private async insertMember(
    db: Query,
    account: string,
    agent_network_id: string,
    member: AgentNetworkMemberLocator,
  ) {
    if (member.kind === "registered") {
      await db.query(
        `INSERT INTO agent_network_members
         (agent_network_id,member_kind,member_id,registered_agent_id,project_id,added_by)
         VALUES($1,'registered',$2,$2,$3,$4)`,
        [
          agent_network_id,
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
           AND agent_network_id=$4 AND state='active' AND expires_at>now()`,
        [account, member.installation_id, member.agent_id, agent_network_id],
      )
    ).rows[0];
    if (!installation) throw new Error("external_identity_unavailable");
    await db.query(
      `INSERT INTO agent_network_members
       (agent_network_id,member_kind,member_id,external_agent_id,installation_id,added_by)
       VALUES($1,'external',$2,$2,$3,$4)`,
      [agent_network_id, member.agent_id, member.installation_id, account],
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

  private async network(
    db: Query,
    account: string,
    row: any,
  ): Promise<AgentNetwork> {
    const members: AgentNetworkMember[] = [];
    for (const memberRow of (
      await db.query(
        "SELECT * FROM agent_network_members WHERE agent_network_id=$1 ORDER BY added_at,member_id",
        [row.agent_network_id],
      )
    ).rows)
      members.push(await this.member(db, account, memberRow));
    return {
      agent_network_id: row.agent_network_id,
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

  private async networkById(account: string, agent_network_id: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM agent_networks WHERE account_id=$1 AND agent_network_id=$2",
        [account, agent_network_id],
      )
    ).rows[0];
    if (!row) throw new Error("agent_network_not_found");
    return this.network(this.db, account, row);
  }

  async networks(account: string, limit = 100, cursor?: string) {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const values: unknown[] = [account, bounded + 1];
    let cursorSql = "";
    if (cursor) {
      const [updated, id] = Buffer.from(cursor, "base64url")
        .toString()
        .split("/");
      requireUuid(id, "network cursor");
      if (!Number.isFinite(+updated)) throw new Error("invalid_network_cursor");
      values.push(new Date(+updated), id);
      cursorSql = "AND (updated_at,agent_network_id)<($3,$4)";
    }
    const rows = (
      await this.db.query(
        `SELECT * FROM agent_networks WHERE account_id=$1 ${cursorSql}
         ORDER BY updated_at DESC,agent_network_id DESC LIMIT $2`,
        values,
      )
    ).rows;
    const page = rows.slice(0, bounded);
    const networks: AgentNetwork[] = [];
    for (const row of page)
      networks.push(await this.network(this.db, account, row));
    const last = page[page.length - 1];
    const active_count = +(
      await this.db.query(
        "SELECT count(*) AS count FROM agent_networks WHERE account_id=$1 AND state<>'closed'",
        [account],
      )
    ).rows[0].count;
    return {
      networks,
      active_count,
      next_cursor:
        rows.length > bounded && last
          ? Buffer.from(
              `${new Date(last.updated_at).getTime()}/${last.agent_network_id}`,
            ).toString("base64url")
          : undefined,
    };
  }

  async createNetwork(
    account: string,
    options: CreateAgentNetworkOptions,
    memberLimit: number,
    fresh = false,
  ): Promise<AgentNetwork> {
    requireUuid(options.request_id, "request_id");
    const title = this.validateTitle(options.title);
    const delivery = this.validateDelivery(options.delivery_mode);
    await this.assertHome(account);
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
    const agent_network_id = await this.locked(
      account,
      async (db, controls) => {
        if (controls.paused) throw new Error("messaging_paused");
        const replay = await this.replay(
          db,
          account,
          options.request_id,
          binding,
        );
        if (replay) return replay;
        await this.assertExpansiveMutationRate(db, account);
        const counts = (
          await db.query(
            `SELECT count(*) AS retained,
             count(*) FILTER(WHERE state<>'closed') AS active
           FROM agent_networks WHERE account_id=$1`,
            [account],
          )
        ).rows[0];
        if (+counts.retained >= MAX_RETAINED_NETWORKS)
          throw new Error("agent_network_history_capacity");
        if (+counts.active >= MAX_ACTIVE_NETWORKS)
          throw new Error("agent_network_capacity");
        const created = randomUUID();
        for (const member of options.members)
          if (member.kind === "registered")
            await this.assertRegisteredName(db, account, member.endpoint);
        await db.query(
          `INSERT INTO agent_networks
           (agent_network_id,account_id,title,state,delivery_mode,generation,created_by)
           VALUES($1,$2,$3,'active',$4,$5,$2)`,
          [created, account, title, delivery, randomUUID()],
        );
        for (const member of options.members)
          await this.insertMember(db, account, created, member);
        await this.recordMutation(
          db,
          account,
          options.request_id,
          binding,
          created,
        );
        return created;
      },
    );
    return this.networkById(account, agent_network_id);
  }

  private async lockedNetwork(db: Query, account: string, id: string) {
    requireUuid(id, "agent_network_id");
    const row = (
      await db.query(
        "SELECT * FROM agent_networks WHERE account_id=$1 AND agent_network_id=$2 FOR UPDATE",
        [account, id],
      )
    ).rows[0];
    if (!row) throw new Error("agent_network_not_found");
    return row;
  }

  async updateNetwork(
    account: string,
    options: UpdateAgentNetworkOptions,
    memberLimit: number,
    fresh = false,
  ): Promise<AgentNetwork> {
    requireUuid(options.request_id, "request_id");
    requireUuid(options.agent_network_id, "agent_network_id");
    if ("member" in options) this.validateLocator(options.member);
    const normalized = {
      ...options,
      ...(options.action === "set-title"
        ? { title: this.validateTitle(options.title) }
        : {}),
    };
    const binding = this.mutationBinding("update", normalized);
    let validatedGeneration: string | undefined;
    if (
      options.action === "add-member" &&
      options.member.kind === "registered"
    ) {
      await this.assertHome(account);
      const row = (
        await this.db.query(
          "SELECT generation,state FROM agent_networks WHERE account_id=$1 AND agent_network_id=$2",
          [account, options.agent_network_id],
        )
      ).rows[0];
      if (!row) throw new Error("agent_network_not_found");
      if (row.state === "closed") throw new Error("agent_network_closed");
      validatedGeneration = row.generation;
      await this.validateRegisteredMember(account, options.member);
    }
    const agent_network_id = await this.locked(
      account,
      async (db, controls) => {
        const replay = await this.replay(
          db,
          account,
          options.request_id,
          binding,
        );
        if (replay) return replay;
        const row = await this.lockedNetwork(
          db,
          account,
          options.agent_network_id,
        );
        if (validatedGeneration && row.generation !== validatedGeneration)
          throw new PersonalAgentAuthorizationError("network_stale");
        if (row.state === "closed") throw new Error("agent_network_closed");
        if (
          options.action === "add-member" ||
          options.action === "resume" ||
          options.action === "set-title" ||
          (options.action === "set-delivery" &&
            options.delivery_mode === "live")
        )
          await this.assertExpansiveMutationRate(db, account);
        const activeMembers = (
          await db.query(
            "SELECT * FROM agent_network_members WHERE agent_network_id=$1 AND removed_at IS NULL FOR UPDATE",
            [row.agent_network_id],
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
          if (activeMembers.length >= Math.min(memberLimit, 64))
            throw new Error(
              `agent_network_member_limit_reached:${memberLimit}`,
            );
          const memberId =
            options.member.kind === "registered"
              ? options.member.endpoint.agent_id
              : options.member.agent_id;
          if (
            activeMembers.some(
              (member) =>
                member.member_kind === options.member.kind &&
                member.member_id === memberId,
            )
          )
            throw new Error("duplicate_network_member");
          if (options.member.kind === "registered")
            await this.assertRegisteredName(
              db,
              account,
              options.member.endpoint,
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
            row.agent_network_id,
            options.member,
          );
        } else if (options.action === "remove-member") {
          const memberId =
            options.member.kind === "registered"
              ? options.member.endpoint.agent_id
              : options.member.agent_id;
          const result = await db.query(
            `UPDATE agent_network_members SET removed_at=now()
           WHERE agent_network_id=$1 AND member_kind=$2 AND member_id=$3 AND removed_at IS NULL RETURNING member_id`,
            [row.agent_network_id, options.member.kind, memberId],
          );
          if (!result.rows.length)
            throw new Error("agent_network_member_not_found");
          if (activeMembers.length - 1 < 2)
            throw new Error("agent_network_requires_two_members");
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
            `UPDATE agent_networks SET title=$3,state=$4,delivery_mode=$5,
             generation=$6,updated_at=now(),closed_at=CASE WHEN $4='closed' THEN now() ELSE closed_at END
           WHERE account_id=$1 AND agent_network_id=$2 RETURNING *`,
            [
              account,
              row.agent_network_id,
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
          row.agent_network_id,
        );
        return updated.agent_network_id;
      },
    );
    return this.networkById(account, agent_network_id);
  }

  private findMember(members: AgentNetworkMember[], source: AgentRpcSource) {
    return members.find((member) =>
      isExternalAgentSource(source)
        ? member.kind === "external" &&
          member.source.agent_id === source.agent_id &&
          member.source.installation_id === source.installation_id &&
          member.source.account_id === source.account_id
        : member.kind === "registered" && same(member.endpoint, source),
    );
  }

  private async authenticateSource(
    account: string,
    source: AgentRpcSource,
    run_id?: string,
  ) {
    validateAgentRpcSource(source, run_id);
    if (isExternalAgentSource(source)) {
      if (source.account_id !== account)
        throw new PersonalAgentAuthorizationError("principal_mismatch");
      const active = (
        await this.db.query(
          `SELECT 1 FROM agent_external_installations i
           JOIN agent_external_identities e USING(agent_id)
           WHERE i.account_id=$1 AND i.agent_id=$2 AND i.installation_id=$3
             AND i.state='active' AND i.expires_at>now()
             AND e.disabled_at IS NULL`,
          [account, source.agent_id, source.installation_id],
        )
      ).rows[0];
      if (!active)
        throw new PersonalAgentAuthorizationError("agent_unavailable");
      return;
    }
    requireUuid(run_id, "run_id");
    if ((await this.principal(source, run_id!)) !== account)
      throw new PersonalAgentAuthorizationError("principal_mismatch");
    await this.endpoint(account, source);
  }

  private async authorizationMembers(
    db: Query,
    account: string,
    agent_network_id: string,
    principals: AgentRpcSource[],
  ): Promise<AgentNetworkMember[]> {
    const memberIds = [...new Set(principals.map(({ agent_id }) => agent_id))];
    const rows = (
      await db.query(
        `SELECT m.*,
                n.name AS registered_name,
                n.metadata AS registered_metadata,
                i.label AS external_label,
                i.state AS external_state,
                i.expires_at AS external_expires_at,
                e.disabled_at AS external_disabled_at
         FROM agent_network_members m
         LEFT JOIN agent_personal_names n
           ON m.member_kind='registered' AND n.account_id=$2
          AND n.project_id=m.project_id AND n.agent_id=m.registered_agent_id
          AND n.retired_at IS NULL
         LEFT JOIN agent_external_installations i
           ON m.member_kind='external' AND i.account_id=$2
          AND i.agent_id=m.external_agent_id
          AND i.installation_id=m.installation_id
          AND i.agent_network_id=m.agent_network_id
         LEFT JOIN agent_external_identities e
           ON e.agent_id=m.external_agent_id AND e.account_id=$2
         WHERE m.agent_network_id=$1 AND m.removed_at IS NULL
           AND m.member_id=ANY($3::uuid[])
         ORDER BY m.added_at,m.member_id`,
        [agent_network_id, account, memberIds],
      )
    ).rows;
    return rows.map((row) => {
      if (row.member_kind === "registered") {
        return {
          kind: "registered" as const,
          member_id: row.member_id,
          endpoint: {
            project_id: row.project_id,
            agent_id: row.registered_agent_id,
          },
          name: row.registered_name,
          project_title: row.registered_metadata?.project_title,
          thread_title: row.registered_metadata?.thread_title,
          available: !!row.registered_name,
          added_at: iso(row.added_at),
          removed_at: null,
        };
      }
      return {
        kind: "external" as const,
        member_id: row.member_id,
        source: {
          kind: "external" as const,
          account_id: account,
          agent_id: row.external_agent_id,
          installation_id: row.installation_id,
        },
        label: row.external_label ?? "External agent",
        available:
          row.external_state === "active" &&
          !row.external_disabled_at &&
          new Date(row.external_expires_at ?? 0).getTime() > Date.now(),
        added_at: iso(row.added_at),
        removed_at: null,
      };
    });
  }

  private async authorizationSnapshot(
    db: Query,
    controls: PersonalMessagingControls,
    account: string,
    agent_network_id: string,
    source: AgentRpcSource,
    targets: AgentRpcSource[],
  ): Promise<AgentNetworkAuthorization[]> {
    if (controls.paused)
      throw new PersonalAgentAuthorizationError("network_paused");
    const row = await this.lockedNetwork(db, account, agent_network_id);
    if (row.state === "closed")
      throw new PersonalAgentAuthorizationError("network_closed");
    if (row.state !== "active")
      throw new PersonalAgentAuthorizationError("network_paused");
    const members = await this.authorizationMembers(
      db,
      account,
      agent_network_id,
      [source, ...targets],
    );
    const sourceMember = this.findMember(members, source);
    if (!sourceMember?.available)
      throw new PersonalAgentAuthorizationError("not_a_member");
    return targets.map((target) => {
      const targetMember = this.findMember(members, target);
      if (
        !targetMember?.available ||
        sourceMember.member_id === targetMember.member_id
      )
        throw new PersonalAgentAuthorizationError("not_a_member");
      return {
        agent_network_id,
        network_title: row.title,
        network_generation: row.generation,
        account_generation: controls.generation,
        account_id: account,
        delivery_mode: row.delivery_mode,
        source: sourceMember,
        target: targetMember,
      };
    });
  }

  async checkNetwork(
    account: string,
    agent_network_id: string,
    source: AgentRpcSource,
    run_id: string | undefined,
    target: AgentRpcSource,
  ): Promise<AgentNetworkAuthorization> {
    requireUuid(agent_network_id, "agent_network_id");
    await this.authenticateSource(account, source, run_id);
    if (!isExternalAgentSource(target)) await this.endpoint(account, target);
    return this.locked(account, async (db, controls) => {
      return (
        await this.authorizationSnapshot(
          db,
          controls,
          account,
          agent_network_id,
          source,
          [target],
        )
      )[0];
    });
  }

  async discover(
    account: string,
    source: AgentRpcSource,
    run_id?: string,
  ): Promise<AgentNetworkDiscovery> {
    if (!isExternalAgentSource(source)) {
      requireUuid(run_id, "run_id");
      if ((await this.principal(source, run_id!)) !== account)
        throw new PersonalAgentAuthorizationError("principal_mismatch");
    }
    const rows = (
      await this.db.query(
        `SELECT DISTINCT s.* FROM agent_networks s
         JOIN agent_network_members m USING(agent_network_id)
         WHERE s.account_id=$1 AND s.state='active' AND m.removed_at IS NULL
           AND ((m.member_kind='registered' AND m.registered_agent_id=$2)
             OR (m.member_kind='external' AND m.external_agent_id=$2))
         ORDER BY s.updated_at DESC LIMIT 100`,
        [account, source.agent_id],
      )
    ).rows;
    const networks: AgentNetwork[] = [];
    for (const row of rows)
      networks.push(await this.network(this.db, account, row));
    const peers = new Map<string, AgentNetworkDiscovery["peers"][number]>();
    for (const network of networks)
      for (const member of network.members) {
        if (this.findMember([member], source)) continue;
        const key =
          member.kind === "registered"
            ? `registered/${member.endpoint.project_id}/${member.endpoint.agent_id}`
            : agentRpcSourceKey(member.source);
        const current = peers.get(key) ?? { member, networks: [] };
        current.networks.push({
          agent_network_id: network.agent_network_id,
          title: network.title,
          delivery_mode: network.delivery_mode,
          generation: network.generation,
        });
        peers.set(key, current);
      }
    return { peers: [...peers.values()] };
  }

  async observeActivity(account: string, activity: AgentNetworkActivity) {
    requireUuid(activity.attempt_id, "attempt_id");
    await this.locked(account, async (db) => {
      await db.query(
        `INSERT INTO agent_network_activity
         (attempt_id,account_id,agent_network_id,network_generation,source_member_id,target_member_id,configured_delivery,effective_delivery,outcome,observed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(attempt_id) DO UPDATE SET
           effective_delivery=EXCLUDED.effective_delivery,outcome=EXCLUDED.outcome,observed_at=EXCLUDED.observed_at`,
        [
          activity.attempt_id,
          account,
          activity.agent_network_id,
          activity.network_generation,
          activity.source_member_id,
          activity.target_member_id,
          activity.configured_delivery,
          activity.effective_delivery,
          activity.outcome,
          new Date(activity.observed_at),
        ],
      );
      await db.query(
        `DELETE FROM agent_network_activity WHERE account_id=$1 AND attempt_id IN
         (SELECT attempt_id FROM agent_network_activity WHERE account_id=$1 ORDER BY observed_at DESC OFFSET $2)`,
        [account, MAX_ACTIVITY_PER_ACCOUNT],
      );
    });
  }

  async activity(account: string, agent_network_id: string, limit = 100) {
    requireUuid(agent_network_id, "agent_network_id");
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    return (
      await this.db.query(
        `SELECT * FROM agent_network_activity WHERE account_id=$1 AND agent_network_id=$2
         ORDER BY observed_at DESC LIMIT $3`,
        [account, agent_network_id, bounded],
      )
    ).rows.map((row) => ({ ...row, observed_at: iso(row.observed_at) }));
  }

  async inspectActivity(
    account: string,
    agent_network_id: string,
    attempt_id: string,
  ): Promise<AgentNetworkActivity | undefined> {
    requireUuid(agent_network_id, "agent_network_id");
    requireUuid(attempt_id, "attempt_id");
    const row = (
      await this.db.query(
        `SELECT * FROM agent_network_activity
         WHERE account_id=$1 AND agent_network_id=$2 AND attempt_id=$3`,
        [account, agent_network_id, attempt_id],
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
          "UPDATE agent_networks SET state='closed',generation=$2,updated_at=now(),closed_at=now() WHERE account_id=$1 AND state<>'closed'",
          [account, randomUUID()],
        );
      return row;
    });
  }
}
