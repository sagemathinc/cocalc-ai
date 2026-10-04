/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Which accounts named an agent, kept in the agent's project bay so identity
// changes (fresh conversation, appearance, runtime, disable) reach exactly
// those accounts' name books, which then update their browsers.

import getLogger from "@cocalc/backend/logger";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import { assertActor } from "./access";
import { withAgentIdentityOwner } from "./identity-routing";
import { identitySnapshot } from "./personal-store";
import { agentStore } from "./store";

const logger = getLogger("server:agents:identity-watchers");
const MAX_WATCHERS_PER_AGENT = 10_000;

export interface WatchIdentityRequest {
  account_id: string;
  project_id: string;
  agent_id: string;
  watching: boolean;
}

/** Routed to the agent's project bay. */
export async function watchIdentity(opts: WatchIdentityRequest): Promise<void> {
  const request = {
    account_id: opts.account_id,
    project_id: opts.project_id,
    agent_id: opts.agent_id,
    watching: !!opts.watching,
  };
  await withAgentIdentityOwner({
    project_id: opts.project_id,
    local: () => watchIdentityLocal(request),
    remote: (api, route) => api.watch({ ...request, route }),
  });
}

export async function watchIdentityLocal(
  opts: WatchIdentityRequest,
): Promise<void> {
  requireUuid(opts.account_id, "account_id");
  requireUuid(opts.project_id, "project_id");
  requireUuid(opts.agent_id, "agent_id");
  const db = agentStore();
  if (!opts.watching) {
    await db.query(
      "DELETE FROM agent_identity_watchers WHERE agent_id=$1 AND account_id=$2",
      [opts.agent_id, opts.account_id],
    );
    return;
  }
  const identity = await db.get(opts.agent_id);
  if (identity.project_id !== opts.project_id)
    throw new Error("agent identity does not belong to the requested project");
  // Naming already required project access; a watch must not outlive it.
  await assertActor(opts.account_id, opts.project_id);
  await db.query(
    `INSERT INTO agent_identity_watchers(agent_id,account_id,project_id)
     SELECT $1,$2,$3 WHERE (SELECT count(*) FROM agent_identity_watchers WHERE agent_id=$1) < $4
     ON CONFLICT(agent_id,account_id) DO NOTHING`,
    [opts.agent_id, opts.account_id, opts.project_id, MAX_WATCHERS_PER_AGENT],
  );
}

/**
 * Push an agent's current identity to every account that named it. Best
 * effort and asynchronous to the change itself; the name books' background
 * repair reconciles anything that fails here.
 */
export async function notifyIdentityWatchers(agent_id: string): Promise<void> {
  try {
    const db = agentStore();
    const identity = await db.get(agent_id);
    const accounts = (
      await db.query<{ account_id: string }>(
        "SELECT account_id FROM agent_identity_watchers WHERE agent_id=$1",
        [agent_id],
      )
    ).rows.map((row) => row.account_id);
    if (accounts.length === 0) return;
    const snapshot = identitySnapshot(identity);
    const endpoint = { project_id: identity.project_id, agent_id };
    const { withPersonalHome } = await import("./personal");
    await Promise.all(
      accounts.map((account_id) =>
        withPersonalHome(account_id, {
          action: "identityChanged",
          options: { endpoint, snapshot },
        }).catch((err) =>
          logger.debug("could not notify an agent's watcher", {
            agent_id,
            err: `${err}`,
          }),
        ),
      ),
    );
  } catch (err) {
    logger.warn("could not notify agent identity watchers", {
      agent_id,
      err: `${err}`,
    });
  }
}
