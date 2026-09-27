/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  CollaborationPersonalState,
  CollaborationResource,
} from "@cocalc/util/collaborators";
import {
  boundedText,
  integer,
  transaction,
  uuid,
} from "@cocalc/database/postgres/collaborators-common";
import {
  AGENT_ORGANIZATION_SETTING,
  agentPinnedIds,
  collaborationArtifactPin,
  legacyCollaborationPersonalState,
  clearCollaborationAgentFallback,
  reconcileCollaborationArtifactPersonalState,
} from "@cocalc/database/postgres/collaborators-personal";
import {
  getCollaborationPersonalState,
  setCollaborationPersonalState,
} from "@cocalc/database/postgres/collaborators-discovery";
import { personalLibraryApi } from "@cocalc/server/artifacts/personal-library-api";
import { clearPersonalLibraryAlias } from "@cocalc/server/artifacts/personal-library-store";
import { nameAgent, retireNamedAgent } from "@cocalc/server/agents/personal";
import { getIdentity } from "@cocalc/server/agents/api";
import { assertPersonalAccountAuthority } from "@cocalc/server/agents/personal-rehome";

export async function collaborationPersonalState(
  account_id: string,
  resource: CollaborationResource,
) {
  return legacyCollaborationPersonalState(
    account_id,
    resource,
    await getCollaborationPersonalState(account_id, resource),
  );
}

export async function updateCollaborationPersonalState(
  account_id: string,
  resource: CollaborationResource,
  patch: Partial<CollaborationPersonalState>,
) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw Error("invalid personal state patch");
  for (const field of Object.keys(patch))
    if (
      !["alias", "collected", "following", "muted", "read_through"].includes(
        field,
      )
    )
      throw Error("invalid personal state field");
  if (patch.alias !== undefined) boundedText(patch.alias, "alias", 128, true);
  for (const field of ["collected", "following", "muted"] as const)
    if (patch[field] !== undefined && typeof patch[field] !== "boolean")
      throw Error(`invalid ${field}`);
  if (
    patch.read_through !== undefined &&
    integer(patch.read_through, "read_through") > resource.activity
  )
    throw Error("read marker exceeds current source activity");
  if (
    resource.kind === "conversation" ||
    (resource.kind === "agent" && !resource.agent_id)
  )
    return setCollaborationPersonalState(account_id, resource, patch, resource);

  if (resource.kind === "artifact") {
    await reconcileCollaborationArtifactPersonalState(account_id, [resource]);
    if (patch.alias !== undefined) {
      if (!resource.entry_id)
        throw Error("Artifact has no verified catalog entry");
      if (!patch.alias.trim())
        await clearPersonalLibraryAlias({
          account_id,
          project_id: resource.project_id,
          entry_id: resource.entry_id,
        });
      else
        await personalLibraryApi.name({
          account_id,
          project_id: resource.project_id,
          entry_id: resource.entry_id,
          name: patch.alias,
        });
    }
    if (patch.collected !== undefined) {
      if (!resource.artifact_id) throw Error("Artifact has no native identity");
      await personalLibraryApi.setPinned({
        account_id,
        pin_key: collaborationArtifactPin(resource),
        pinned: patch.collected,
      });
    }
  } else if (patch.alias !== undefined || patch.collected !== undefined) {
    uuid(resource.agent_id, "existing agent identity");
    const endpoint = {
      project_id: resource.project_id,
      agent_id: resource.agent_id,
    };
    const identity = await getIdentity({ account_id, ...endpoint });
    if (
      identity.path !== resource.chat_path ||
      identity.thread_id !== resource.thread_id
    )
      throw Error("Agent identity no longer matches this conversation");
    if (patch.alias !== undefined) {
      if (patch.alias.trim())
        await nameAgent({
          account_id,
          endpoint,
          name: patch.alias,
          thread_title: resource.title,
        });
      else await retireNamedAgent({ account_id, endpoint });
    }
    if (patch.collected !== undefined)
      await transaction(async (db) => {
        await assertPersonalAccountAuthority(db, account_id);
        const row = (
          await db.query(
            "SELECT other_settings->$2 AS organization FROM accounts WHERE account_id=$1 FOR UPDATE",
            [account_id, AGENT_ORGANIZATION_SETTING],
          )
        ).rows[0];
        const organization =
          row?.organization &&
          typeof row.organization === "object" &&
          !Array.isArray(row.organization)
            ? row.organization
            : {};
        const pins = agentPinnedIds(organization.pinned).filter(
          (id) => id !== resource.agent_id,
        );
        if (patch.collected) {
          if (pins.length >= 500) throw Error("Agent pin limit reached");
          pins.push(resource.agent_id!);
        }
        // Preserve every unrelated workspace preference and use the existing
        // scalar-encoded list representation shared by web and native clients.
        await db.query(
          "UPDATE accounts SET other_settings=jsonb_set(COALESCE(other_settings,'{}'),ARRAY[$2::text],$3::jsonb) WHERE account_id=$1",
          [
            account_id,
            AGENT_ORGANIZATION_SETTING,
            JSON.stringify({ ...organization, pinned: JSON.stringify(pins) }),
          ],
        );
      });
  }
  if (
    resource.kind === "agent" &&
    resource.agent_id &&
    (patch.alias !== undefined || patch.collected !== undefined)
  )
    await clearCollaborationAgentFallback(account_id, resource, {
      alias: patch.alias !== undefined,
      collected: patch.collected !== undefined,
    });
  const { alias: _alias, collected: _collected, ...attention } = patch;
  await setCollaborationPersonalState(
    account_id,
    resource,
    attention,
    resource,
  );
  return collaborationPersonalState(account_id, resource);
}
