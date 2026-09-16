import { randomUUID } from "node:crypto";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import {
  validateAgentEndpoint,
  validatePersonalApproval,
} from "@cocalc/conat/agents/rpc";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import {
  normalizeAgentName,
  PersonalAgentAuthorizationError,
} from "@cocalc/conat/agents/personal";
import type {
  NamedAgent,
  NameAgentOptions,
  PersonalConnection,
  PersonalMessagingControls,
  GrantPersonalConnectionOptions,
  SetPersonalConnectionStateOptions,
  SetPersonalMessagingStateOptions,
  PersonalConnectionRequest,
  PersonalConnectionRequestOptions,
} from "@cocalc/conat/agents/personal";
import type { AgentStore } from "./store";
import { assertPersonalAccountAuthority } from "./personal-rehome";

const iso = (value: Date | string) => new Date(value).toISOString();
const same = (a: AgentEndpoint, b: AgentEndpoint) =>
  a.project_id === b.project_id && a.agent_id === b.agent_id;
type Query = {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
};
type RequestSource = { source: AgentEndpoint; run_id: string };

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

  async observe(account: string, link_id: string, accepted: boolean) {
    requireUuid(link_id, "link_id");
    await this.locked(account, (db) =>
      db.query(
        `UPDATE agent_personal_grants SET last_attempt_at=now(),
      last_accepted_at=CASE WHEN $3 THEN now() ELSE last_accepted_at END WHERE account_id=$1 AND link_id=$2`,
        [account, link_id, accepted],
      ),
    );
  }

  private async locked<T>(
    account: string,
    fn: (db: Query, controls: PersonalMessagingControls) => Promise<T>,
  ): Promise<T> {
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

  async name(account: string, opts: NameAgentOptions): Promise<NamedAgent> {
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

  private connection(
    row: any,
    controls: PersonalMessagingControls,
  ): PersonalConnection {
    const status =
      row.revoked_at || row.generation < controls.generation
        ? "revoked"
        : row.paused || controls.paused
          ? "paused"
          : row.expires_at && new Date(row.expires_at).getTime() <= Date.now()
            ? "expired"
            : "active";
    return {
      link_id: row.link_id,
      source: {
        project_id: row.source_project_id,
        agent_id: row.source_agent_id,
      },
      target: {
        project_id: row.target_project_id,
        agent_id: row.target_agent_id,
      },
      approved_by: row.account_id,
      principal_account_id: row.account_id,
      reason: row.reason,
      allow_guidance: row.allow_guidance,
      direction_group_id: row.direction_group_id,
      approval_request_id: row.approval_request_id,
      generation: row.generation,
      paused: row.paused,
      status,
      created_at: iso(row.created_at),
      expires_at: row.expires_at ? iso(row.expires_at) : null,
      revoked_at: row.revoked_at ? iso(row.revoked_at) : null,
      last_attempt_at: row.last_attempt_at ? iso(row.last_attempt_at) : null,
      last_accepted_at: row.last_accepted_at ? iso(row.last_accepted_at) : null,
    };
  }

  private async decorate(account: string, links: PersonalConnection[]) {
    // Only read exact granted endpoints, never the principal's entire directory.
    for (const link of links)
      for (const side of ["source", "target"] as const) {
        const endpoint = link[side];
        const row = (
          await this.db.query(
            "SELECT * FROM agent_personal_names WHERE account_id=$1 AND project_id=$2 AND agent_id=$3 AND retired_at IS NULL",
            [account, endpoint.project_id, endpoint.agent_id],
          )
        ).rows[0];
        if (row) {
          link[`${side}_name`] = row.name;
          link[`${side}_named_agent`] = this.named(row);
        }
        if (side === "target") {
          link.target_retired_names = (
            await this.db.query(
              "SELECT name FROM agent_personal_names WHERE account_id=$1 AND project_id=$2 AND agent_id=$3 AND retired_at IS NOT NULL ORDER BY name",
              [account, endpoint.project_id, endpoint.agent_id],
            )
          ).rows.map((retired) => retired.name);
        }
      }
    return links;
  }

  async connections(
    account: string,
    source?: AgentEndpoint,
  ): Promise<PersonalConnection[]> {
    const controls = await this.controls(account);
    const rows = (
      await this.db.query(
        `SELECT * FROM agent_personal_grants WHERE account_id=$1
      AND ($2::uuid IS NULL OR (source_project_id=$2 AND source_agent_id=$3)) ORDER BY created_at DESC,link_id`,
        [account, source?.project_id ?? null, source?.agent_id ?? null],
      )
    ).rows;
    return this.decorate(
      account,
      rows.map((row) => this.connection(row, controls)),
    );
  }

  private approval(opts: GrantPersonalConnectionOptions) {
    validateAgentEndpoint(opts.source);
    validateAgentEndpoint(opts.target);
    validatePersonalApproval(opts);
    requireUuid(opts.approval_request_id, "approval_request_id");
    if (same(opts.source, opts.target))
      throw new Error("source and target must differ");
    return {
      source: {
        project_id: opts.source.project_id,
        agent_id: opts.source.agent_id,
      },
      target: {
        project_id: opts.target.project_id,
        agent_id: opts.target.agent_id,
      },
      reason: opts.reason.trim(),
      ttl_seconds: opts.ttl_seconds === undefined ? 86400 : opts.ttl_seconds,
      both_directions: opts.both_directions === true,
      allow_guidance: opts.allow_guidance === true,
    };
  }

  private async grantLocked(
    account: string,
    opts: GrantPersonalConnectionOptions,
    db: Query,
    controls: PersonalMessagingControls,
  ): Promise<PersonalConnection[]> {
    const approval = this.approval(opts);
    const prior = (
      await db.query(
        "SELECT * FROM agent_personal_grants WHERE account_id=$1 AND approval_request_id=$2 ORDER BY link_id",
        [account, opts.approval_request_id],
      )
    ).rows;
    if (prior.length) {
      // JSONB does not retain object-key order.
      const expected = JSON.stringify(approval);
      if (
        prior.some(
          (row) =>
            JSON.stringify(
              this.approval({
                ...row.approval,
                approval_request_id: opts.approval_request_id,
              }),
            ) !== expected,
        )
      )
        throw new Error("approval_request_conflict");
      return prior.map((row) => this.connection(row, controls));
    }
    const group = randomUUID();
    const expires =
      approval.ttl_seconds === null
        ? null
        : new Date(Date.now() + approval.ttl_seconds * 1000);
    const directions = [{ source: opts.source, target: opts.target }];
    if (approval.both_directions)
      directions.push({ source: opts.target, target: opts.source });
    const count = (
      await db.query(
        "SELECT count(*) AS count FROM agent_personal_grants WHERE account_id=$1",
        [account],
      )
    ).rows[0];
    if (+count.count + directions.length > 10_000)
      throw new Error("agent_connection_capacity");
    const links: PersonalConnection[] = [];
    for (const { source, target } of directions) {
      const row = (
        await db.query(
          `INSERT INTO agent_personal_grants(link_id,account_id,source_project_id,source_agent_id,target_project_id,target_agent_id,direction_group_id,approval_request_id,approval,reason,allow_guidance,generation,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            randomUUID(),
            account,
            source.project_id,
            source.agent_id,
            target.project_id,
            target.agent_id,
            group,
            opts.approval_request_id,
            approval,
            approval.reason,
            approval.allow_guidance,
            controls.generation,
            expires,
          ],
        )
      ).rows[0];
      links.push(this.connection(row, controls));
    }
    return links;
  }

  async grant(account: string, opts: GrantPersonalConnectionOptions) {
    this.approval(opts);
    await this.endpoint(account, opts.source);
    await this.endpoint(account, opts.target);
    return this.locked(account, async (db, controls) => {
      // Pending requests can only be approved by the typed resolver which also
      // checks the bound run. Ordinary grant IDs cannot impersonate that action.
      const pending = (
        await db.query(
          "SELECT request_id FROM agent_personal_requests WHERE request_id=$1",
          [opts.approval_request_id],
        )
      ).rows[0];
      if (pending) throw new Error("use resolvePersonalConnectionRequest");
      return this.grantLocked(account, opts, db, controls);
    });
  }

  async setConnection(
    account: string,
    opts: SetPersonalConnectionStateOptions,
  ) {
    requireUuid(opts.direction_group_id, "direction_group_id");
    if (!["paused", "active", "revoked"].includes(opts.state))
      throw new Error("invalid connection state");
    if (opts.state === "active") {
      const links = (await this.connections(account)).filter(
        (link) => link.direction_group_id === opts.direction_group_id,
      );
      for (const link of links) {
        await this.endpoint(account, link.source);
        await this.endpoint(account, link.target);
      }
    }
    return this.locked(account, async (db, controls) => {
      const rows = (
        await db.query(
          "SELECT * FROM agent_personal_grants WHERE account_id=$1 AND direction_group_id=$2",
          [account, opts.direction_group_id],
        )
      ).rows;
      if (!rows.length) throw new Error("connection_not_found");
      if (
        opts.state === "active" &&
        rows.some((r) => r.revoked_at || r.generation < controls.generation)
      )
        throw new Error("grant_revoked");
      const updated = (
        await db.query(
          `UPDATE agent_personal_grants SET paused=CASE WHEN $3='revoked' THEN paused ELSE $3='paused' END,
        revoked_at=CASE WHEN $3='revoked' THEN COALESCE(revoked_at,now()) ELSE revoked_at END WHERE account_id=$1 AND direction_group_id=$2 RETURNING *`,
          [account, opts.direction_group_id, opts.state],
        )
      ).rows;
      if (opts.state !== "active")
        await db.query(
          `UPDATE agent_personal_requests r SET state='invalidated'
        WHERE r.account_id=$1 AND r.state='pending' AND r.canonical_request_id IS NULL
        AND EXISTS (SELECT 1 FROM agent_personal_grants g WHERE g.account_id=$1 AND g.direction_group_id=$2 AND (
          (r.source_project_id=g.source_project_id AND r.source_agent_id=g.source_agent_id
           AND r.request->'target'->>'project_id'=g.target_project_id::text AND r.request->'target'->>'agent_id'=g.target_agent_id::text)
          OR (r.request->>'both_directions'='true' AND r.source_project_id=g.target_project_id AND r.source_agent_id=g.target_agent_id
           AND r.request->'target'->>'project_id'=g.source_project_id::text AND r.request->'target'->>'agent_id'=g.source_agent_id::text)))`,
          [account, opts.direction_group_id],
        );
      return updated.map((row) => this.connection(row, controls));
    });
  }

  async setControls(account: string, opts: SetPersonalMessagingStateOptions) {
    if (!["pause", "resume", "revoke_all"].includes(opts.action))
      throw new Error("invalid account control");
    return this.locked(account, async (db) => {
      if (opts.action !== "resume")
        await db.query(
          "UPDATE agent_personal_requests SET state='invalidated' WHERE account_id=$1 AND state='pending' AND canonical_request_id IS NULL",
          [account],
        );
      return (
        await db.query(
          `UPDATE agent_personal_controls
      SET paused=CASE WHEN $2='revoke_all' THEN paused ELSE $2='pause' END,
      generation=generation+CASE WHEN $2='revoke_all' THEN 1 ELSE 0 END WHERE account_id=$1 RETURNING paused,generation`,
          [account, opts.action],
        )
      ).rows[0] as PersonalMessagingControls;
    });
  }

  async links(account: string, source: AgentEndpoint) {
    await this.endpoint(account, source);
    const links = (await this.connections(account, source)).filter(
      (link) => link.status === "active",
    );
    const available: PersonalConnection[] = [];
    for (const link of links) {
      try {
        await this.endpoint(account, link.target);
        available.push(link);
      } catch {
        /* Unavailable authority is not a usable destination. */
      }
    }
    return available;
  }

  async check(
    account: string,
    source: AgentEndpoint,
    target: AgentEndpoint,
    guidance: boolean,
  ) {
    await this.endpoint(account, source);
    await this.endpoint(account, target);
    const active = await this.locked(account, async (db, controls) => {
      const rows = (
        await db.query(
          `SELECT * FROM agent_personal_grants WHERE account_id=$1 AND source_project_id=$2 AND source_agent_id=$3
        AND target_project_id=$4 AND target_agent_id=$5 AND (NOT $6::boolean OR allow_guidance) ORDER BY created_at DESC,link_id`,
          [
            account,
            source.project_id,
            source.agent_id,
            target.project_id,
            target.agent_id,
            guidance,
          ],
        )
      ).rows;
      const links = rows.map((row) => this.connection(row, controls));
      const active = links.find((link) => link.status === "active");
      if (active) return active;
      const status = links[0]?.status;
      throw new PersonalAgentAuthorizationError(
        status && status !== "active" ? `grant_${status}` : "approval_required",
      );
    });
    return (await this.decorate(account, [active]))[0];
  }

  private requestRow(row: any): PersonalConnectionRequest {
    return {
      ...row.request,
      request_id: row.request_id,
      account_id: row.account_id,
      source: {
        project_id: row.source_project_id,
        agent_id: row.source_agent_id,
      },
      run_id: row.run_id,
      generation: row.generation,
      state:
        row.state === "pending" &&
        new Date(row.expires_at).getTime() <= Date.now()
          ? "expired"
          : row.state,
      created_at: iso(row.created_at),
      expires_at: iso(row.expires_at),
      direction_group_id: row.direction_group_id ?? undefined,
    };
  }

  async requests(account: string) {
    // Ten new IDs/minute and a 15-minute lifetime bound active prompts below
    // 200. Keep actionable requests ahead of history, which remains inspectable
    // individually even when it falls out of this bounded account list.
    const rows = (
      await this.db.query(
        "SELECT * FROM agent_personal_requests WHERE account_id=$1 AND canonical_request_id IS NULL ORDER BY (state='pending' AND expires_at>now()) DESC,created_at DESC LIMIT 200",
        [account],
      )
    ).rows;
    return rows.map((row) => this.requestRow(row));
  }

  async readRequest(
    account: string,
    request_id: string,
    source?: RequestSource,
  ) {
    requireUuid(request_id, "request_id");
    let row = (
      await this.db.query(
        "SELECT * FROM agent_personal_requests WHERE account_id=$1 AND request_id=$2",
        [account, request_id],
      )
    ).rows[0];
    if (row?.canonical_request_id)
      row = (
        await this.db.query(
          "SELECT * FROM agent_personal_requests WHERE account_id=$1 AND request_id=$2 AND canonical_request_id IS NULL",
          [account, row.canonical_request_id],
        )
      ).rows[0];
    if (
      !row ||
      (source &&
        (row.source_project_id !== source.source.project_id ||
          row.source_agent_id !== source.source.agent_id ||
          row.run_id !== source.run_id))
    )
      throw new Error("connection_request_not_found");
    const result = this.requestRow(row);
    return row.request_id === request_id
      ? result
      : { ...result, request_id, canonical_request_id: row.request_id };
  }

  async request(
    account: string,
    opts: PersonalConnectionRequestOptions & RequestSource,
  ) {
    requireUuid(opts.request_id, "request_id");
    requireUuid(opts.run_id, "run_id");
    const canonical = this.approval({
      ...opts,
      approval_request_id: opts.request_id,
    });
    await this.endpoint(account, opts.source);
    await this.endpoint(account, opts.target);
    if ((await this.principal(opts.source, opts.run_id)) !== account)
      throw new Error("principal_mismatch");
    return this.locked(account, async (db, controls) => {
      let prior = (
        await db.query(
          "SELECT * FROM agent_personal_requests WHERE request_id=$1",
          [opts.request_id],
        )
      ).rows[0];
      if (prior?.canonical_request_id && prior.account_id === account)
        prior = (
          await db.query(
            "SELECT * FROM agent_personal_requests WHERE account_id=$1 AND request_id=$2 AND canonical_request_id IS NULL",
            [account, prior.canonical_request_id],
          )
        ).rows[0];
      if (prior) {
        if (
          prior.account_id !== account ||
          prior.source_project_id !== opts.source.project_id ||
          prior.source_agent_id !== opts.source.agent_id ||
          prior.run_id !== opts.run_id ||
          JSON.stringify(
            this.approval({
              ...prior.request,
              source: opts.source,
              approval_request_id: opts.request_id,
            }),
          ) !== JSON.stringify(canonical)
        )
          throw new Error("connection_request_conflict");
        return this.requestRow(prior);
      }
      if (
        (
          await db.query(
            "SELECT link_id FROM agent_personal_grants WHERE account_id=$1 AND approval_request_id=$2 LIMIT 1",
            [account, opts.request_id],
          )
        ).rows[0]
      )
        throw new Error("connection_request_conflict");
      if (controls.paused) throw new Error("grant_paused");
      const total = (
        await db.query(
          "SELECT count(*) AS count FROM agent_personal_requests WHERE account_id=$1",
          [account],
        )
      ).rows[0];
      if (+total.count >= 10_000)
        throw new Error("connection_request_capacity");
      const restriction = await this.requestRestriction(
        account,
        opts.source,
        opts.target,
        canonical.both_directions,
        db,
        controls,
      );
      if (restriction) throw new Error(restriction);
      const request = {
        target: canonical.target,
        reason: canonical.reason,
        ttl_seconds: canonical.ttl_seconds,
        both_directions: canonical.both_directions,
        allow_guidance: canonical.allow_guidance,
      };
      const pending = (
        await db.query(
          `SELECT * FROM agent_personal_requests WHERE account_id=$1 AND source_project_id=$2 AND source_agent_id=$3 AND run_id=$4 AND state='pending' AND expires_at>now() AND request=$5::jsonb AND generation=$6 AND canonical_request_id IS NULL LIMIT 1`,
          [
            account,
            opts.source.project_id,
            opts.source.agent_id,
            opts.run_id,
            request,
            controls.generation,
          ],
        )
      ).rows[0];
      const count = (
        await db.query(
          "SELECT count(*) AS n FROM agent_personal_requests WHERE account_id=$1 AND created_at>now()-interval '1 minute'",
          [account],
        )
      ).rows[0];
      if (+count.n >= 10) throw new Error("connection_request_rate_limited");
      if (pending) {
        // Preserve every submitted ID so a lost coalescing response remains
        // inspectable after the canonical request has been resolved/expired.
        await db.query(
          `INSERT INTO agent_personal_requests(request_id,canonical_request_id,account_id,source_project_id,source_agent_id,run_id,request,state,expires_at,generation)
          SELECT $1,request_id,account_id,source_project_id,source_agent_id,run_id,request,'pending',expires_at,generation FROM agent_personal_requests WHERE request_id=$2`,
          [opts.request_id, pending.request_id],
        );
        return this.requestRow(pending);
      }
      const row = (
        await db.query(
          `INSERT INTO agent_personal_requests(request_id,account_id,source_project_id,source_agent_id,run_id,request,state,expires_at,generation)
        VALUES($1,$2,$3,$4,$5,$6,'pending',now()+interval '15 minutes',$7) RETURNING *`,
          [
            opts.request_id,
            account,
            opts.source.project_id,
            opts.source.agent_id,
            opts.run_id,
            request,
            controls.generation,
          ],
        )
      ).rows[0];
      return this.requestRow(row);
    });
  }

  async resolveRequest(
    account: string,
    request_id: string,
    decision: "approve" | "deny",
  ) {
    if (!["approve", "deny"].includes(decision))
      throw new Error("invalid request decision");
    const request = await this.readRequest(account, request_id);
    request_id = request.canonical_request_id ?? request_id;
    let valid = true;
    if (decision === "approve" && request.state === "pending") {
      try {
        valid =
          (await this.principal(request.source, request.run_id)) === account;
        await this.endpoint(account, request.source);
        await this.endpoint(account, request.target);
      } catch {
        valid = false;
      }
    }
    return this.locked(account, async (db, controls) => {
      const row = (
        await db.query(
          "SELECT * FROM agent_personal_requests WHERE account_id=$1 AND request_id=$2",
          [account, request_id],
        )
      ).rows[0];
      const current = this.requestRow(row);
      if (current.state !== "pending") return current;
      if (
        decision === "approve" &&
        (current.generation !== controls.generation ||
          controls.paused ||
          (await this.requestRestriction(
            account,
            current.source,
            current.target,
            current.both_directions === true,
            db,
            controls,
          )))
      )
        valid = false;
      let group: string | null = null;
      const state =
        decision === "deny" ? "denied" : valid ? "approved" : "invalidated";
      if (state === "approved") {
        const grants = await this.grantLocked(
          account,
          { ...current, approval_request_id: request_id },
          db,
          controls,
        );
        group = grants[0].direction_group_id;
      }
      return this.requestRow(
        (
          await db.query(
            "UPDATE agent_personal_requests SET state=$3,direction_group_id=$4 WHERE account_id=$1 AND request_id=$2 RETURNING *",
            [account, request_id, state, group],
          )
        ).rows[0],
      );
    });
  }

  private async requestRestriction(
    account: string,
    source: AgentEndpoint,
    target: AgentEndpoint,
    both: boolean,
    db: Query,
    controls: PersonalMessagingControls,
  ): Promise<string | undefined> {
    const directions = [{ source, target }];
    if (both) directions.push({ source: target, target: source });
    for (const direction of directions) {
      const row = (
        await db.query(
          `SELECT * FROM agent_personal_grants WHERE account_id=$1 AND source_project_id=$2 AND source_agent_id=$3 AND target_project_id=$4 AND target_agent_id=$5 ORDER BY created_at DESC,link_id DESC LIMIT 1`,
          [
            account,
            direction.source.project_id,
            direction.source.agent_id,
            direction.target.project_id,
            direction.target.agent_id,
          ],
        )
      ).rows[0];
      const status = row && this.connection(row, controls).status;
      if (status === "paused" || status === "revoked") return `grant_${status}`;
    }
  }
}
