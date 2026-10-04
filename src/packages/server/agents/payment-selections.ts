/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Agent payment selections: how each account pays for each of its agents.
// Rows live in the account's home bay, next to the credentials they
// reference, so every device and every kind of turn (human send, agent
// message, CLI, automation) sees the same choice.

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import {
  createAgentPaymentSelectionsClient,
  type AgentPaymentSelectionsApi,
  type AgentPaymentSelectionsResult,
} from "@cocalc/conat/inter-bay/agent-payment-selections";
import {
  MAX_AGENT_PAYMENT_BULK,
  MAX_AGENT_PAYMENT_SELECTIONS,
  agentPaymentDefaultKey,
  agentPaymentTargetKey,
  isAgentPaymentProvider,
  parseAgentPaymentSelection,
  validateAgentPaymentTarget,
  type AgentPaymentDefaults,
  type AgentPaymentProvider,
  type AgentPaymentSelection,
  type AgentPaymentSelectionRecord,
  type AgentPaymentTarget,
} from "@cocalc/util/ai/agent-payment-selection";
import { assertAccountWriteOnHomeBay } from "@cocalc/database/postgres/account-rehome-fence";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { assertProjectHostAgentTokenAccess } from "@cocalc/server/conat/api/project-host-token-auth";

const logger = getLogger("server:agents:payment-selections");

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
};

let db: () => Queryable = () => getPool();

/** Tests only. */
export function setPaymentSelectionsDbForTests(next?: () => Queryable) {
  db = next ?? (() => getPool());
}

interface Row {
  target_key: string;
  provider: string;
  project_id: string | null;
  path: string | null;
  thread_id: string | null;
  selection: unknown;
  title: string | null;
  updated_at: Date | string;
  last_used_at: Date | string | null;
}

const iso = (value: Date | string) => new Date(value).toISOString();

function parseRow(row: Row): AgentPaymentSelection | undefined {
  try {
    const selection = parseAgentPaymentSelection(row.selection);
    return selection.provider === row.provider ? selection : undefined;
  } catch (err) {
    logger.warn("ignoring invalid agent payment selection", {
      target_key: row.target_key,
      err: `${err}`,
    });
    return;
  }
}

function toResult(rows: Row[]): AgentPaymentSelectionsResult {
  const selections: AgentPaymentSelectionRecord[] = [];
  const defaults: AgentPaymentDefaults = {};
  for (const row of rows) {
    const selection = parseRow(row);
    if (!selection) continue;
    if (row.target_key.startsWith("default:")) {
      (defaults as any)[selection.provider] = selection;
      continue;
    }
    if (!row.project_id || !row.thread_id) continue;
    selections.push({
      project_id: row.project_id,
      thread_id: row.thread_id,
      ...(row.path ? { path: row.path } : {}),
      provider: selection.provider,
      selection,
      ...(row.title ? { title: row.title } : {}),
      updated_at: iso(row.updated_at),
      ...(row.last_used_at ? { last_used_at: iso(row.last_used_at) } : {}),
    });
  }
  return { selections, defaults };
}

function provider(value: unknown): AgentPaymentProvider {
  if (!isAgentPaymentProvider(value))
    throw new Error("invalid agent payment provider");
  return value;
}

function targets(value: unknown, max = MAX_AGENT_PAYMENT_BULK) {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("invalid agent payment targets");
  return value.map(validateAgentPaymentTarget);
}

function title(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 200)
    : null;
}

// Home-bay implementation. Every entry point rechecks that this bay is still
// the account's home, so a stale route cannot write to the wrong bay.
async function assertHome(account_id: string, home_bay_id: string) {
  requireUuid(account_id, "account_id");
  const home = await resolveAccountHomeBay({ account_id });
  if (
    home.home_bay_id !== getConfiguredBayId() ||
    home_bay_id !== home.home_bay_id
  )
    throw new Error("stale agent payment account home route");
}

export const paymentSelectionsHome: AgentPaymentSelectionsApi = {
  async get(opts) {
    await assertHome(opts.account_id, opts.home_bay_id);
    const keys = targets(opts.targets).map(agentPaymentTargetKey);
    const { rows } = await db().query(
      `SELECT * FROM agent_payment_selections
        WHERE account_id=$1 AND (target_key=ANY($2::text[]) OR target_key LIKE 'default:%')`,
      [opts.account_id, keys],
    );
    if (opts.touch && keys.length > 0)
      await db().query(
        `UPDATE agent_payment_selections SET last_used_at=now()
          WHERE account_id=$1 AND target_key=ANY($2::text[])`,
        [opts.account_id, keys],
      );
    return toResult(rows);
  },

  async list(opts) {
    await assertHome(opts.account_id, opts.home_bay_id);
    const limit = Math.max(
      1,
      Math.min(MAX_AGENT_PAYMENT_SELECTIONS, Math.floor(opts.limit ?? 1000)),
    );
    const filter = opts.provider == null ? undefined : provider(opts.provider);
    const { rows } = await db().query(
      `SELECT * FROM agent_payment_selections
        WHERE account_id=$1 AND ($2::text IS NULL OR provider=$2)
        ORDER BY target_key LIKE 'default:%' DESC, updated_at DESC
        LIMIT $3`,
      [opts.account_id, filter ?? null, limit + 2],
    );
    return toResult(rows);
  },

  async set(opts) {
    await assertHome(opts.account_id, opts.home_bay_id);
    await assertAccountWriteOnHomeBay({
      db: db(),
      account_id: opts.account_id,
      action: "change agent payment selections",
    });
    const selection =
      opts.selection === null
        ? null
        : parseAgentPaymentSelection(opts.selection);
    const list = targets(opts.targets ?? []);
    const titles = (opts.targets ?? []).map((t) => title((t as any)?.title));
    const defaults = (opts.defaults ?? []).map(provider);
    if (defaults.length > 2) throw new Error("invalid agent payment defaults");
    if (selection && defaults.some((p) => p !== selection.provider))
      throw new Error("agent payment default provider mismatch");
    if (selection?.mode === "default" && defaults.length > 0)
      throw new Error("an account default cannot follow itself");
    let updated = 0;
    if (selection === null) {
      const only = opts.provider === undefined ? null : provider(opts.provider);
      const keys = [
        ...list.map(agentPaymentTargetKey),
        ...defaults.map(agentPaymentDefaultKey),
      ];
      if (keys.length > 0) {
        const { rows } = await db().query(
          `DELETE FROM agent_payment_selections
            WHERE account_id=$1 AND target_key=ANY($2::text[])
              AND ($3::text IS NULL OR provider=$3) RETURNING target_key`,
          [opts.account_id, keys, only],
        );
        updated = rows.length;
      }
      publishChangedAgents(opts.account_id, list);
      return { updated };
    }
    const count = +(
      await db().query(
        "SELECT count(*) AS count FROM agent_payment_selections WHERE account_id=$1",
        [opts.account_id],
      )
    ).rows[0].count;
    if (count + list.length > MAX_AGENT_PAYMENT_SELECTIONS)
      throw new Error("agent payment selection capacity reached");
    const conflict = opts.only_if_absent
      ? "DO NOTHING"
      : "DO UPDATE SET selection=EXCLUDED.selection, path=COALESCE(EXCLUDED.path, agent_payment_selections.path), title=COALESCE(EXCLUDED.title, agent_payment_selections.title), updated_at=now()";
    const value = JSON.stringify(selection);
    for (let i = 0; i < list.length; i++) {
      const target = list[i];
      const { rows } = await db().query(
        `INSERT INTO agent_payment_selections
           (account_id,target_key,provider,project_id,path,thread_id,selection,title,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,now())
         ON CONFLICT(account_id,target_key,provider) ${conflict} RETURNING target_key`,
        [
          opts.account_id,
          agentPaymentTargetKey(target),
          selection.provider,
          target.project_id,
          target.path ?? null,
          target.thread_id,
          value,
          titles[i],
        ],
      );
      updated += rows.length;
    }
    for (const p of defaults) {
      const { rows } = await db().query(
        `INSERT INTO agent_payment_selections
           (account_id,target_key,provider,selection,updated_at)
         VALUES($1,$2,$3,$4::jsonb,now())
         ON CONFLICT(account_id,target_key,provider) ${conflict} RETURNING target_key`,
        [opts.account_id, agentPaymentDefaultKey(p), p, value],
      );
      updated += rows.length;
    }
    publishChangedAgents(opts.account_id, list);
    return { updated };
  },

  async copy(opts) {
    await assertHome(opts.account_id, opts.home_bay_id);
    await assertAccountWriteOnHomeBay({
      db: db(),
      account_id: opts.account_id,
      action: "change agent payment selections",
    });
    const from = validateAgentPaymentTarget(opts.from);
    const to = validateAgentPaymentTarget(opts.to);
    const { rows } = await db().query(
      `INSERT INTO agent_payment_selections
         (account_id,target_key,provider,project_id,path,thread_id,selection,title,updated_at)
       SELECT account_id,$3,provider,$4,COALESCE($5,path),$6,selection,title,now()
         FROM agent_payment_selections WHERE account_id=$1 AND target_key=$2
       ON CONFLICT(account_id,target_key,provider) DO NOTHING RETURNING target_key`,
      [
        opts.account_id,
        agentPaymentTargetKey(from),
        agentPaymentTargetKey(to),
        to.project_id,
        to.path ?? null,
        to.thread_id,
      ],
    );
    if (rows.length > 0) publishChangedAgents(opts.account_id, [to]);
    return { copied: rows.length > 0 };
  },

  async resolve(opts) {
    await assertHome(opts.account_id, opts.home_bay_id);
    const target = validateAgentPaymentTarget(opts.target);
    const p = provider(opts.provider);
    const { rows } = await db()
      .query(
        `UPDATE agent_payment_selections SET last_used_at=now()
        WHERE account_id=$1 AND target_key=$2 AND provider=$3`,
        [opts.account_id, agentPaymentTargetKey(target), p],
      )
      .then(async () =>
        db().query(
          `SELECT * FROM agent_payment_selections
          WHERE account_id=$1 AND target_key=ANY($2::text[]) AND provider=$3`,
          [
            opts.account_id,
            [agentPaymentTargetKey(target), agentPaymentDefaultKey(p)],
            p,
          ],
        ),
      );
    const result = toResult(rows);
    return {
      ...(result.selections[0]
        ? { selection: result.selections[0].selection }
        : {}),
      ...(result.defaults[p] ? { default: result.defaults[p] } : {}),
    };
  },
};

/** Attach this account's payment selections to its named agents (home bay). */
export async function loadAgentPayments(
  account_id: string,
  agents: import("@cocalc/conat/agents/personal").NamedAgent[],
): Promise<void> {
  const keyOf = (agent: {
    endpoint: { project_id: string };
    thread_id: string;
  }) =>
    agentPaymentTargetKey({
      project_id: agent.endpoint.project_id,
      thread_id: agent.thread_id,
    });
  const keys = agents.filter((agent) => agent.thread_id).map(keyOf);
  if (keys.length === 0) return;
  const { rows } = await db().query(
    "SELECT * FROM agent_payment_selections WHERE account_id=$1 AND target_key=ANY($2::text[])",
    [account_id, keys],
  );
  const records = toResult(rows).selections;
  for (const agent of agents) {
    const mine = records.filter(
      (record) =>
        record.project_id === agent.endpoint.project_id &&
        record.thread_id === agent.thread_id,
    );
    if (mine.length > 0) agent.payment = mine;
    else delete agent.payment;
  }
}

// Agents page cards show payment; push changed agents to the account's browsers.
function publishChangedAgents(
  account_id: string,
  threads: { project_id: string; thread_id: string }[],
) {
  void import("./named-agent-feed")
    .then(({ publishNamedAgentsForThreads }) =>
      publishNamedAgentsForThreads(account_id, threads),
    )
    .catch((err) =>
      logger.debug("could not publish agent payment change", { err: `${err}` }),
    );
}

async function withHome<T>(
  account_id: string,
  fn: (api: AgentPaymentSelectionsApi, home_bay_id: string) => Promise<T>,
): Promise<T> {
  requireUuid(account_id, "account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw new Error("account home unavailable");
  const api =
    home_bay_id === getConfiguredBayId()
      ? paymentSelectionsHome
      : createAgentPaymentSelectionsClient({
          client: getInterBayFabricClient(),
          bay_id: home_bay_id,
        });
  return await fn(api, home_bay_id);
}

// Hub API. Reads and writes need the account's own session: these methods are
// not on the agent-credential allowlist, so an agent cannot repoint how it is
// paid. A selection only ever applies to its own account's turns, and the
// host checks credential ownership at admission.

export const getPaymentSelections: AgentApi["getPaymentSelections"] = async (
  opts,
) => {
  const account_id = opts.account_id!;
  const list = targets(opts.targets);
  return withHome(account_id, (api, home_bay_id) =>
    api.get({ account_id, home_bay_id, targets: list, touch: !!opts.touch }),
  );
};

export const listPaymentSelections: AgentApi["listPaymentSelections"] = async (
  opts,
) => {
  const account_id = opts.account_id!;
  return withHome(account_id, (api, home_bay_id) =>
    api.list({
      account_id,
      home_bay_id,
      provider: opts.provider,
      limit: opts.limit,
    }),
  );
};

export const setPaymentSelections: AgentApi["setPaymentSelections"] = async (
  opts,
) => {
  const account_id = opts.account_id!;
  return withHome(account_id, (api, home_bay_id) =>
    api.set({
      account_id,
      home_bay_id,
      targets: opts.targets,
      defaults: opts.defaults,
      selection: opts.selection,
      provider: opts.provider,
      only_if_absent: opts.only_if_absent,
    }),
  );
};

export const copyPaymentSelection: AgentApi["copyPaymentSelection"] = async (
  opts,
) => {
  const account_id = opts.account_id!;
  return withHome(account_id, (api, home_bay_id) =>
    api.copy({ account_id, home_bay_id, from: opts.from, to: opts.to }),
  );
};

// Host acting for an account: only for a project the host serves and the
// account collaborates on, checked on the project's bay before routing home.
export const resolvePaymentSelection: AgentApi["resolvePaymentSelection"] =
  async (opts) => {
    const target = validateAgentPaymentTarget({
      project_id: opts.project_id,
      thread_id: opts.thread_id,
    });
    await assertProjectHostAgentTokenAccess({
      host_id: opts.host_id!,
      account_id: opts.account_id!,
      project_id: target.project_id,
    });
    const account_id = opts.account_id!;
    return withHome(account_id, (api, home_bay_id) =>
      api.resolve({
        account_id,
        home_bay_id,
        target,
        provider: provider(opts.provider),
      }),
    );
  };

export type { AgentPaymentTarget };
