/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import {
  AGENT_FILE_GRANT_MODE,
  MAX_AGENT_FILE_GRANTS,
  normalizeAgentFileGrantRoots,
  type AgentFileGrant,
} from "@cocalc/conat/agents/file-grants";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";
import { withAgentIdentityOwner } from "./identity-routing";
import { agentStore } from "./store";
import { assertActor, assertAgent, assertRun } from "./access";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import {
  agentFileGrantSubject,
  type PreparedAgentFileGrant,
} from "@cocalc/conat/agents/file-grants";
import {
  resolveHostConnection,
  issueProjectHostFileGrantToken,
} from "@cocalc/server/conat/api/hosts";

type FileGrantLocator = {
  account_id: string;
  project_id: string;
  agent_id: string;
};

function normalizeRow(row: any): AgentFileGrant {
  return {
    ...row,
    roots: normalizeAgentFileGrantRoots(row.roots),
    mode: AGENT_FILE_GRANT_MODE,
  };
}

async function assertGrantActor(opts: FileGrantLocator) {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.project_id, "project_id");
  requireUuid(opts.agent_id, "agent_id");
  await assertActor(opts.account_id, opts.project_id);
  const identity = await agentStore().get(opts.agent_id);
  await assertAgent(identity);
  if (identity.project_id !== opts.project_id) {
    throw new Error("file grant source agent mismatch");
  }
  return identity;
}

export async function listFileGrantsLocal(
  opts: FileGrantLocator,
): Promise<AgentFileGrant[]> {
  await assertGrantActor(opts);
  const { rows } = await agentStore().query(
    `SELECT * FROM agent_file_grants
      WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
        AND revoked_at IS NULL
      ORDER BY updated_at DESC,grant_id`,
    [opts.account_id, opts.agent_id, opts.project_id],
  );
  return rows.map(normalizeRow);
}

export async function saveFileGrantLocal(
  opts: FileGrantLocator & { target_project_id: string; roots: string[] },
): Promise<AgentFileGrant> {
  await assertGrantActor(opts);
  requireUuid(opts.target_project_id, "target_project_id");
  if (opts.target_project_id === opts.project_id) {
    throw new Error("source and target projects must be different");
  }
  const roots = normalizeAgentFileGrantRoots(opts.roots);
  await assertProjectCollaboratorAccessAllowRemote({
    account_id: opts.account_id,
    project_id: opts.target_project_id,
  });
  return await agentStore().transaction(async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `agent-file-grants:${opts.account_id}:${opts.agent_id}`,
    ]);
    const existing = await sql.query(
      `SELECT 1 FROM agent_file_grants
        WHERE account_id=$1 AND agent_id=$2 AND target_project_id=$3`,
      [opts.account_id, opts.agent_id, opts.target_project_id],
    );
    if (!existing.rows[0]) {
      const count = await sql.query<{ count: string }>(
        `SELECT count(*) AS count FROM agent_file_grants
          WHERE account_id=$1 AND agent_id=$2 AND revoked_at IS NULL`,
        [opts.account_id, opts.agent_id],
      );
      if (Number(count.rows[0]?.count ?? 0) >= MAX_AGENT_FILE_GRANTS) {
        throw new Error(
          `at most ${MAX_AGENT_FILE_GRANTS} file grants per agent`,
        );
      }
    }
    const { rows } = await sql.query(
      `INSERT INTO agent_file_grants
        (grant_id,account_id,agent_id,source_project_id,target_project_id,roots,mode)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT(account_id,agent_id,target_project_id) DO UPDATE SET
         grant_id=EXCLUDED.grant_id,
         source_project_id=EXCLUDED.source_project_id,
         roots=EXCLUDED.roots,
         mode=EXCLUDED.mode,
         updated_at=now(),
         revoked_at=NULL
       RETURNING *`,
      [
        randomUUID(),
        opts.account_id,
        opts.agent_id,
        opts.project_id,
        opts.target_project_id,
        JSON.stringify(roots),
        AGENT_FILE_GRANT_MODE,
      ],
    );
    return normalizeRow(rows[0]);
  });
}

export async function revokeFileGrantLocal(
  opts: FileGrantLocator & { grant_id: string },
): Promise<void> {
  await assertGrantActor(opts);
  requireUuid(opts.grant_id, "grant_id");
  await agentStore().query(
    `UPDATE agent_file_grants SET revoked_at=COALESCE(revoked_at,now()),updated_at=now()
      WHERE grant_id=$1 AND account_id=$2 AND agent_id=$3 AND source_project_id=$4`,
    [opts.grant_id, opts.account_id, opts.agent_id, opts.project_id],
  );
}

export async function authorizeFileGrantReadLocal(opts: {
  account_id: string;
  host_id: string;
  source_project_id: string;
  target_project_id: string;
  grant_id: string;
  agent_id: string;
  run_id: string;
}): Promise<{ read_policy: ProjectViewerReadPolicy }> {
  for (const [name, value] of Object.entries(opts)) requireUuid(value, name);
  const run = await agentStore().activeRun(opts.agent_id, opts.run_id);
  if (
    run.account_id !== opts.account_id ||
    run.project_id !== opts.source_project_id
  ) {
    throw new Error("file grant run binding mismatch");
  }
  await assertRun(run);
  const { rows } = await agentStore().query(
    `SELECT * FROM agent_file_grants
      WHERE grant_id=$1 AND account_id=$2 AND agent_id=$3
        AND source_project_id=$4 AND target_project_id=$5
        AND mode='read' AND revoked_at IS NULL`,
    [
      opts.grant_id,
      opts.account_id,
      opts.agent_id,
      opts.source_project_id,
      opts.target_project_id,
    ],
  );
  if (!rows[0]) throw new Error("file grant is unavailable or revoked");
  const target = await assertProjectCollaboratorAccessAllowRemote({
    account_id: opts.account_id,
    project_id: opts.target_project_id,
  });
  if (target.host_id !== opts.host_id) {
    throw new Error("file grant target host changed");
  }
  const roots = normalizeAgentFileGrantRoots(rows[0].roots);
  return {
    read_policy: {
      rules: roots.flatMap((root) =>
        root
          ? [
              { action: "include" as const, path: root },
              { action: "include" as const, path: `${root}/**` },
            ]
          : [{ action: "include" as const, path: "." }],
      ),
    },
  };
}

export async function prepareAgentFileGrant({
  account_id,
  source_project_id,
  agent_id,
  run_id,
  grant_id,
  target_project_id,
}: {
  account_id: string;
  source_project_id: string;
  agent_id: string;
  run_id: string;
  grant_id?: string;
  target_project_id?: string;
}): Promise<PreparedAgentFileGrant> {
  const { rows } = await agentStore().query(
    `SELECT * FROM agent_file_grants
      WHERE account_id=$1 AND agent_id=$2 AND source_project_id=$3
        AND revoked_at IS NULL
        AND ($4::uuid IS NULL OR grant_id=$4)
        AND ($5::uuid IS NULL OR target_project_id=$5)
      LIMIT 1`,
    [
      account_id,
      agent_id,
      source_project_id,
      grant_id ?? null,
      target_project_id ?? null,
    ],
  );
  if (!rows[0]) throw new Error("file grant is unavailable or revoked");
  const grant = normalizeRow(rows[0]);
  const target = await assertProjectCollaboratorAccessAllowRemote({
    account_id,
    project_id: grant.target_project_id,
  });
  if (!target.host_id)
    throw new Error("file grant target has no assigned host");
  await authorizeFileGrantReadLocal({
    account_id,
    host_id: target.host_id,
    source_project_id,
    target_project_id: grant.target_project_id,
    grant_id: grant.grant_id,
    agent_id,
    run_id,
  });
  const binding = {
    account_id,
    target_project_id: grant.target_project_id,
    source_project_id,
    grant_id: grant.grant_id,
    agent_id,
    run_id,
  };
  const [connection, issued] = await Promise.all([
    resolveHostConnection({
      account_id,
      host_id: target.host_id,
      project_id: grant.target_project_id,
    }),
    issueProjectHostFileGrantToken({
      account_id,
      host_id: target.host_id,
      project_id: grant.target_project_id,
      file_grant: binding,
    }),
  ]);
  return {
    version: 1,
    grant,
    subject: agentFileGrantSubject(binding),
    connection,
    token: issued.token,
    expires_at: issued.expires_at,
  };
}

export const listFileGrants: AgentApi["listFileGrants"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  return withAgentIdentityOwner({
    project_id: opts.project_id!,
    local: () => listFileGrantsLocal(opts as FileGrantLocator),
    remote: (api, route) => api.listFileGrants({ ...opts, ...route } as any),
  });
};

export const saveFileGrant: AgentApi["saveFileGrant"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  return withAgentIdentityOwner({
    project_id: opts.project_id!,
    local: () => saveFileGrantLocal(opts as any),
    remote: (api, route) => api.saveFileGrant({ ...opts, ...route } as any),
  });
};

export const revokeFileGrant: AgentApi["revokeFileGrant"] = async (opts) => {
  requireUuid(opts.account_id, "account_id");
  return withAgentIdentityOwner({
    project_id: opts.project_id!,
    local: () => revokeFileGrantLocal(opts as any),
    remote: (api, route) => api.revokeFileGrant({ ...opts, ...route } as any),
  });
};

export const authorizeFileGrantRead: AgentApi["authorizeFileGrantRead"] =
  async (opts) => {
    requireUuid(opts.account_id, "account_id");
    requireUuid(opts.host_id, "host_id");
    return withAgentIdentityOwner({
      project_id: opts.source_project_id,
      local: () => authorizeFileGrantReadLocal(opts as any),
      remote: (api, route) =>
        api.authorizeFileGrantRead({
          ...opts,
          project_id: opts.source_project_id,
          ...route,
        } as any),
    });
  };
