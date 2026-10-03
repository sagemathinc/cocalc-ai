/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { requireUuid } from "@cocalc/conat/agents/protocol";
import {
  parsePersonalUrl,
  personalUrlPath,
  projectLocation,
} from "@cocalc/util/personal-urls";
import type {
  ResolvedPersonalUrl,
  PersonalUrlTarget,
} from "@cocalc/util/personal-urls";
import { normalizeAlias } from "@cocalc/util/people";
import { isProjectCollaboratorRole } from "@cocalc/util/project-access";
import { resolveUsernameOwner, authorizeAdmin } from "./accounts/usernames";
import { lookupPersonalUrlAlias } from "./personal-url-aliases";
import { resolveProjectReferenceForMemberAllowRemote } from "./conat/project-remote-access";
import { getIdentity } from "./agents/api";
import { getEntry } from "./artifacts/catalog-api";
import { peopleApi } from "./people/api";

/** Resolve labels under their owner, but resources under the actual viewer. */
export async function resolvePersonalUrl({
  account_id,
  url,
  inspect = false,
}: {
  account_id: string;
  url: string;
  inspect?: boolean;
}): Promise<ResolvedPersonalUrl> {
  requireUuid(account_id, "account_id");
  if (inspect) await authorizeAdmin(account_id);
  const parsed = parsePersonalUrl(url);
  if (!parsed.alias) throw Error("A personal URL must identify an alias");
  const alias = normalizeAlias(parsed.alias);
  if (alias == null) throw Error("A personal URL must identify an alias");
  const owner = await resolveUsernameOwner(parsed.owner);
  const result: ResolvedPersonalUrl = {
    owner,
    kind: parsed.kind,
    alias,
    canonical_path: personalUrlPath(
      owner.username ?? owner.account_id,
      parsed.kind,
      alias,
    ),
    status: "unavailable",
    ...(parsed.rest
      ? { rest: parsed.rest, location: projectLocation(parsed.rest) }
      : {}),
  };
  // Existing person nicknames are private settings, not published directories.
  if (parsed.kind === "people" && account_id !== owner.account_id && !inspect)
    return result;
  const target = await lookupPersonalUrlAlias({
    owner_account_id: owner.account_id,
    kind: parsed.kind,
    alias,
  });
  if (!target) return result;
  if (inspect) return { ...result, status: "inspection", target };
  if (target.kind === "person")
    return { ...result, status: "resolved", target };
  const reference = await resolveProjectReferenceForMemberAllowRemote({
    account_id,
    project_id: target.project_id,
  });
  if (!isProjectCollaboratorRole(reference?.users?.[account_id]?.group))
    return {
      ...result,
      status: "access-denied",
      project_id: target.project_id,
    };
  const resolved = await resolveTarget(account_id, target);
  return resolved
    ? { ...result, status: "resolved", target: resolved }
    : result;
}

async function resolveTarget(
  account_id: string,
  target: PersonalUrlTarget,
): Promise<PersonalUrlTarget | null> {
  switch (target.kind) {
    case "agent": {
      const agent = await getIdentity({
        account_id,
        project_id: target.project_id,
        agent_id: target.agent_id,
      });
      return { ...target, chat_path: agent.path, thread_id: agent.thread_id };
    }
    case "artifact": {
      const entry = await getEntry({
        account_id,
        project_id: target.project_id,
        entry_id: target.entry_id,
      });
      return entry
        ? {
            ...target,
            chat_path: entry.chat_path,
            thread_id: entry.item.thread_id,
            artifact_id: entry.item.artifact_id,
          }
        : null;
    }
    case "conversation": {
      const conversation = await peopleApi.getConversation({
        account_id,
        project_id: target.project_id,
        conversation_id: target.conversation_id,
      });
      return conversation ? { ...target, chat_path: conversation.path } : null;
    }
    case "person":
    case "project":
      return target;
  }
}
