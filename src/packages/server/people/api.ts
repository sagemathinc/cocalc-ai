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
  listSharedWork,
  listProjectAgents,
  getAgentAccess,
  setAgentAccess,
  setAgentAppearance,
  markConversationRead,
  refreshConversationActivity,
  removeConversation,
  renameConversation,
  resolveAlias,
  setPersonalState,
  touchConversation,
} from "@cocalc/database/postgres/people";
import { getLogger } from "@cocalc/backend/logger";
import { resolveProjectReferenceForMemberAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { isProjectCollaboratorRole } from "@cocalc/util/project-access";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { listCollabInvites } from "@cocalc/server/projects/collaborators";
import type { ProjectCollabInviteRow } from "@cocalc/conat/hub/api/projects";
import {
  DEFAULT_PERSONAL_STATE,
  MAX_LISTED_PROJECTS,
  assertPeopleStateKind,
  type Conversation,
  type ListedConversation,
  type PersonalState,
  type SharedWork,
  type ProjectAgent,
} from "@cocalc/util/people";

const logger = getLogger("server:people");
const MAX_INVITES = 500;

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

// The given projects that this bay owns.
async function ownedHere(project_ids: string[]): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT project_id FROM projects
     WHERE project_id = ANY($1::uuid[])
       AND COALESCE(owning_bay_id, $2) = $2`,
    [project_ids.slice(0, MAX_LISTED_PROJECTS), getConfiguredBayId()],
  );
  return rows.map((row) => row.project_id);
}

// This account's projects grouped by owning bay (home bay only).
async function projectsByBay(
  account_id: string,
): Promise<Map<string, string[]>> {
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
  return byBay;
}

/** Trusted inter-bay entrypoint. Each method checks it is the authority. */
export const peopleControl: InterBayPeopleApi = {
  async listForProjects({ account_id, project_ids }) {
    requireUuid(account_id, "account_id");
    return await listConversationsForProjects({
      account_id,
      project_ids: await ownedHere(project_ids),
    });
  },

  async sharedWorkForProjects({ viewer_id, person_id, project_ids }) {
    requireUuid(viewer_id, "viewer_id");
    requireUuid(person_id, "person_id");
    return await listSharedWork({
      viewer_id,
      person_id,
      project_ids: await ownedHere(project_ids),
    });
  },

  async agentsForProjects({ viewer_id, project_ids }) {
    requireUuid(viewer_id, "viewer_id");
    return await listProjectAgents({
      viewer_id,
      project_ids: await ownedHere(project_ids),
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

  async sentInvites({ account_id, status, limit }) {
    requireUuid(account_id, "account_id");
    return await listCollabInvites({
      account_id,
      direction: "outbound",
      status,
      limit: Math.min(MAX_INVITES, limit),
    });
  },

  async getAgentAccess(opts) {
    await assertOwner(opts.project_id);
    requireUuid(opts.agent_id, "agent_id");
    return await getAgentAccess({ ...opts, account_id: opts.account_id! });
  },

  async setAgentAccess(opts) {
    await assertOwner(opts.project_id);
    requireUuid(opts.agent_id, "agent_id");
    await setAgentAccess({ ...opts, account_id: opts.account_id! });
  },

  async setAgentAppearance(opts) {
    await assertOwner(opts.project_id);
    requireUuid(opts.agent_id, "agent_id");
    await setAgentAppearance({ ...opts, account_id: opts.account_id! });
  },

  async refresh(opts) {
    await assertOwner(opts.project_id);
    return await refreshConversationActivity(opts);
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
    const byBay = await projectsByBay(account_id!);
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

  async listInvites({ account_id, direction, status }) {
    await assertHome(account_id!);
    // This bay: received (with the cross-bay inbox) or sent for local projects.
    const invites: ProjectCollabInviteRow[] = await listCollabInvites({
      account_id: account_id!,
      direction: direction === "inbound" ? "inbound" : "outbound",
      status,
      limit: MAX_INVITES,
    });
    let unavailable_bays = 0;
    if (direction === "outbound") {
      // Sent invites live with their project; ask every other bay that owns
      // one of this account's projects.
      const others = [...(await projectsByBay(account_id!)).keys()].filter(
        (bay_id) => !local(bay_id),
      );
      const results = await Promise.allSettled(
        others.map((bay_id) =>
          remote(bay_id).sentInvites({
            account_id: account_id!,
            status,
            limit: MAX_INVITES,
          }),
        ),
      );
      for (const result of results) {
        if (result.status === "fulfilled") invites.push(...result.value);
        else unavailable_bays += 1;
      }
    }
    const seen = new Set<string>();
    const unique = invites.filter((invite) => {
      if (seen.has(invite.invite_id)) return false;
      seen.add(invite.invite_id);
      return true;
    });
    unique.sort(
      (a, b) => new Date(b.created).valueOf() - new Date(a.created).valueOf(),
    );
    return { invites: unique.slice(0, MAX_INVITES), unavailable_bays };
  },

  async listSharedWork({ account_id, person_id }) {
    await assertHome(account_id!);
    requireUuid(person_id, "person_id");
    const byBay = await projectsByBay(account_id!);
    const results = await Promise.allSettled(
      [...byBay].map(([bay_id, project_ids]) =>
        (local(bay_id) ? peopleControl : remote(bay_id)).sharedWorkForProjects({
          viewer_id: account_id!,
          person_id,
          project_ids,
        }),
      ),
    );
    const work = {
      agents: [] as SharedWork["agents"],
      artifacts: [] as SharedWork["artifacts"],
    };
    let unavailable_bays = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        work.agents.push(...result.value.agents);
        work.artifacts.push(...result.value.artifacts);
      } else {
        unavailable_bays += 1;
      }
    }
    work.agents.sort((a, b) => b.created_at - a.created_at);
    work.artifacts.sort((a, b) => b.created_at - a.created_at);
    return { ...work, unavailable_bays };
  },

  async listAgents({ account_id }) {
    await assertHome(account_id!);
    const byBay = await projectsByBay(account_id!);
    const results = await Promise.allSettled(
      [...byBay].map(([bay_id, project_ids]) =>
        (local(bay_id) ? peopleControl : remote(bay_id)).agentsForProjects({
          viewer_id: account_id!,
          project_ids,
        }),
      ),
    );
    const agents: ProjectAgent[] = [];
    let unavailable_bays = 0;
    for (const result of results) {
      if (result.status === "fulfilled") agents.push(...result.value);
      else unavailable_bays += 1;
    }
    agents.sort((a, b) => b.created_at - a.created_at);
    return { agents, unavailable_bays };
  },

  async setState({ account_id, kind, target_id, project_id, patch }) {
    await assertHome(account_id!);
    assertPeopleStateKind(kind);
    requireUuid(target_id, "target_id");
    if (project_id != null) requireUuid(project_id, "project_id");
    let reclaimAliasFrom: { target_id: string; project_id: string } | undefined;
    if (kind === "conversation" && patch?.alias) {
      const binding = await resolveAlias({
        account_id: account_id!,
        kind,
        alias: patch.alias,
      });
      if (binding?.project_id && binding.target_id !== target_id) {
        // A missing local row proves nothing: the project may be remote.
        // Routing/transport failures must leave the alias reserved.
        // Only reclaim this account's alias; other accounts do so on reuse.
        const record = await (
          await owner(binding.project_id)
        ).getRecord({
          account_id: account_id!,
          project_id: binding.project_id,
          conversation_id: binding.target_id,
        });
        if (record == null) {
          reclaimAliasFrom = { ...binding, project_id: binding.project_id };
        }
      }
    }
    return await setPersonalState({
      account_id: account_id!,
      kind,
      target_id,
      project_id,
      patch: patch ?? {},
      reclaimAliasFrom,
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

  async refreshConversation({ account_id, project_id, path, activity }) {
    const c = await (
      await owner(project_id)
    ).refresh({ account_id: account_id!, project_id, path, activity });
    return c == null ? {} : { conversation_id: c.conversation_id };
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

  async listSharedWork(opts) {
    return await (await home(opts.account_id!)).listSharedWork(opts);
  },

  async listAgents(opts) {
    return await (await home(opts.account_id!)).listAgents(opts);
  },

  async getAgentAccess(opts) {
    return await (await owner(opts.project_id)).getAgentAccess(opts);
  },

  async listInvites(opts) {
    return await (await home(opts.account_id!)).listInvites(opts);
  },

  async setAgentAccess(opts) {
    await (await owner(opts.project_id)).setAgentAccess(opts);
  },

  async setAgentAppearance(opts) {
    await (await owner(opts.project_id)).setAgentAppearance(opts);
  },

  async setState(opts) {
    // A project alias is a public name for that project under your username,
    // so only its collaborators may give it one.
    if (opts.kind === "project" && opts.patch?.alias) {
      requireUuid(opts.target_id, "target_id");
      const reference = await resolveProjectReferenceForMemberAllowRemote({
        account_id: opts.account_id!,
        project_id: opts.target_id,
      });
      if (
        !isProjectCollaboratorRole(reference?.users?.[opts.account_id!]?.group)
      )
        throw Error("Only collaborators on a project can give it an alias");
    }
    return await (await home(opts.account_id!)).setState(opts);
  },

  async listStates(opts) {
    return await (await home(opts.account_id!)).listStates(opts);
  },

  async resolveAlias(opts) {
    return await (await home(opts.account_id!)).resolveAlias(opts);
  },
};
