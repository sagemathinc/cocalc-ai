/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Routing for conversations. Shared records live on the project's owning bay
// and personal state (pins, read markers) on the account's home bay. The
// conversation list is built on the home bay with one request per owning bay.

import { requireUuid } from "@cocalc/conat/agents/protocol";
import type { PeopleApi } from "@cocalc/conat/hub/api/people";
import {
  createInterBayPeopleClient,
  type InterBayPeopleApi,
} from "@cocalc/conat/inter-bay/people";
import getPool from "@cocalc/database/pool";
import {
  createConversationRecord,
  getConversation,
  getPersonalStates,
  latestMentions,
  listConversationsForProjects,
  mentionKey,
  listPersonalStates,
  markConversationRead,
  removeConversation,
  renameConversation,
  resolveAlias,
  setPersonalState,
  touchConversation,
} from "@cocalc/database/postgres/people";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  DEFAULT_PERSONAL_STATE,
  MAX_LISTED_PROJECTS,
  assertPeopleStateKind,
  type Conversation,
  type ListedConversation,
  type PersonalState,
} from "@cocalc/util/people";

const logger = getLogger("server:people");

function remote(bay_id: string): InterBayPeopleApi {
  return createInterBayPeopleClient({
    client: getInterBayFabricClient(),
    bay_id,
  });
}

function local(bay_id: string): boolean {
  return bay_id === getConfiguredBayId();
}

async function owner(project_id: string): Promise<InterBayPeopleApi> {
  requireUuid(project_id, "project_id");
  const bay = await resolveProjectBay(project_id);
  if (!bay) throw Error("project not found");
  return local(bay.bay_id) ? peopleControl : remote(bay.bay_id);
}

async function home(account_id: string): Promise<InterBayPeopleApi> {
  requireUuid(account_id, "account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id) throw Error("account home unavailable");
  return local(home_bay_id) ? peopleControl : remote(home_bay_id);
}

async function assertOwner(project_id: string): Promise<void> {
  requireUuid(project_id, "project_id");
  const bay = await resolveProjectBay(project_id);
  if (!bay || !local(bay.bay_id)) throw Error("stale project route");
}

async function assertHome(account_id: string): Promise<void> {
  requireUuid(account_id, "account_id");
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  if (!home_bay_id || !local(home_bay_id)) {
    throw Error("stale account-home route");
  }
}

// Only bookkeeping for the actor; failure must not fail their action.
async function markReadBestEffort(
  account_id: string,
  c: Conversation,
): Promise<void> {
  try {
    await (
      await home(account_id)
    ).markRead({
      account_id,
      project_id: c.project_id,
      conversation_id: c.conversation_id,
      read_through: c.last_activity,
    });
  } catch (err) {
    logger.debug("markRead failed", { err: `${err}` });
  }
}

export function mergeListed(
  records: Conversation[],
  states: Map<string, Partial<PersonalState>>,
): ListedConversation[] {
  const seen = new Set<string>();
  const result: ListedConversation[] = [];
  for (const record of records) {
    if (seen.has(record.conversation_id)) continue;
    seen.add(record.conversation_id);
    const state = states.get(record.conversation_id);
    result.push({
      ...record,
      ...DEFAULT_PERSONAL_STATE,
      pinned: state?.pinned ?? false,
      alias: state?.alias ?? null,
      following: state?.following ?? false,
      muted: state?.muted ?? false,
      last_read: state?.last_read ?? null,
    });
  }
  return result.sort((a, b) => b.last_activity - a.last_activity);
}

/** Trusted inter-bay entrypoint. Each method checks it is the authority. */
export const peopleControl: InterBayPeopleApi = {
  async listForProjects({ account_id, project_ids }) {
    requireUuid(account_id, "account_id");
    const { rows } = await getPool().query(
      `SELECT project_id FROM projects
       WHERE project_id = ANY($1::uuid[])
         AND COALESCE(owning_bay_id, $2) = $2`,
      [project_ids.slice(0, MAX_LISTED_PROJECTS), getConfiguredBayId()],
    );
    return await listConversationsForProjects({
      account_id,
      project_ids: rows.map((row) => row.project_id),
    });
  },

  async getRecord(opts) {
    await assertOwner(opts.project_id);
    return await getConversation(opts);
  },

  async createRecord({ account_id, project_id, path, title }) {
    await assertOwner(project_id);
    return await createConversationRecord({
      account_id,
      project_id,
      path,
      title,
    });
  },

  async touch(opts) {
    await assertOwner(opts.project_id);
    return await touchConversation(opts);
  },

  async rename(opts) {
    await assertOwner(opts.project_id);
    return await renameConversation(opts);
  },

  async remove(opts) {
    await assertOwner(opts.project_id);
    await removeConversation(opts);
  },

  async listConversations({ account_id }) {
    await assertHome(account_id!);
    const { rows } = await getPool().query(
      `SELECT project_id, owning_bay_id FROM account_project_index
       WHERE account_id = $1
       ORDER BY last_activity_at DESC NULLS LAST
       LIMIT $2`,
      [account_id, MAX_LISTED_PROJECTS],
    );
    const byBay = new Map<string, string[]>();
    for (const { project_id, owning_bay_id } of rows) {
      const bay_id = owning_bay_id || getConfiguredBayId();
      byBay.set(bay_id, [...(byBay.get(bay_id) ?? []), project_id]);
    }
    const results = await Promise.allSettled(
      [...byBay].map(([bay_id, project_ids]) =>
        (local(bay_id) ? peopleControl : remote(bay_id)).listForProjects({
          account_id: account_id!,
          project_ids,
        }),
      ),
    );
    const records: Conversation[] = [];
    let unavailable_bays = 0;
    for (const result of results) {
      if (result.status === "fulfilled") records.push(...result.value);
      else {
        unavailable_bays += 1;
        logger.debug("listForProjects failed", { err: `${result.reason}` });
      }
    }
    const states = await getPersonalStates({
      account_id: account_id!,
      kind: "conversation",
      target_ids: records.map((c) => c.conversation_id),
    });
    const mentions = await latestMentions({
      account_id: account_id!,
      project_ids: [...new Set(records.map((c) => c.project_id))],
    });
    const conversations = mergeListed(records, states).map((c) => ({
      ...c,
      mentioned_at: mentions.get(mentionKey(c.project_id, c.path)) ?? null,
    }));
    return { conversations, unavailable_bays };
  },

  async markRead(opts) {
    await assertHome(opts.account_id!);
    requireUuid(opts.project_id, "project_id");
    requireUuid(opts.conversation_id, "conversation_id");
    await markConversationRead({ ...opts, account_id: opts.account_id! });
  },

  async setState({ account_id, kind, target_id, project_id, patch }) {
    await assertHome(account_id!);
    assertPeopleStateKind(kind);
    requireUuid(target_id, "target_id");
    if (project_id != null) requireUuid(project_id, "project_id");
    return await setPersonalState({
      account_id: account_id!,
      kind,
      target_id,
      project_id,
      patch: patch ?? {},
    });
  },

  async listStates({ account_id, kind }) {
    await assertHome(account_id!);
    return await listPersonalStates({
      account_id: account_id!,
      kind: assertPeopleStateKind(kind),
    });
  },

  async resolveAlias({ account_id, kind, alias }) {
    await assertHome(account_id!);
    return await resolveAlias({
      account_id: account_id!,
      kind: assertPeopleStateKind(kind),
      alias,
    });
  },
};

/** Browser-facing hub API; account_id is bound by the auth policy. */
export const peopleApi: PeopleApi = {
  async listConversations({ account_id }) {
    return await (await home(account_id!)).listConversations({ account_id });
  },

  async getConversation({ account_id, project_id, conversation_id }) {
    return await (
      await owner(project_id)
    ).getRecord({ account_id: account_id!, project_id, conversation_id });
  },

  async addConversation({ account_id, project_id, path, title }) {
    const c = await (
      await owner(project_id)
    ).createRecord({ account_id: account_id!, project_id, path, title });
    await markReadBestEffort(account_id!, c);
    return c;
  },

  async touchConversation({ account_id, project_id, path }) {
    const c = await (
      await owner(project_id)
    ).touch({ account_id: account_id!, project_id, path });
    if (c == null) return {};
    await markReadBestEffort(account_id!, c);
    return { conversation_id: c.conversation_id };
  },

  async renameConversation({ account_id, project_id, conversation_id, title }) {
    return await (
      await owner(project_id)
    ).rename({ account_id: account_id!, project_id, conversation_id, title });
  },

  async removeConversation({ account_id, project_id, conversation_id }) {
    await (
      await owner(project_id)
    ).remove({ account_id: account_id!, project_id, conversation_id });
  },

  async markRead(opts) {
    await (await home(opts.account_id!)).markRead(opts);
  },

  async setState(opts) {
    return await (await home(opts.account_id!)).setState(opts);
  },

  async listStates(opts) {
    return await (await home(opts.account_id!)).listStates(opts);
  },

  async resolveAlias(opts) {
    return await (await home(opts.account_id!)).resolveAlias(opts);
  },
};
