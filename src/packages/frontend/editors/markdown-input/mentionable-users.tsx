/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { useState } from "react";
import { useChatEmbeddingOptions } from "@cocalc/frontend/chat/embedding-options";
import { agentMentionSuggestions } from "@cocalc/frontend/agents/mention-suggestions";
import {
  MY_AGENTS_ORGANIZATION_SETTING,
  normalizeAgentWorkspaceOrganization,
} from "@cocalc/frontend/agents/workspace-organization";
import { Icon } from "@cocalc/frontend/components/icon";
import { redux, useMemo, useTypedRedux } from "@cocalc/frontend/app-framework";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { displayNameFromUserRecord } from "@cocalc/frontend/users/display-name";
import { isValidUUID, timestamp_cmp, trunc_middle } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import {
  ALL_PROJECT_COLLABORATORS_MENTION_ID,
  getMentionAllAccountIds,
} from "./mention-all";
import type { Item } from "./complete";
import {
  namedAgentReference,
  useNamedAgents,
  useAgentNetworks,
} from "@cocalc/frontend/agents/api";
import { useAgentMentionContext } from "@cocalc/frontend/agents/mention-context";
import { serializeAgentMention } from "@cocalc/util/agent-mentions";
import { serializeArtifactMention } from "@cocalc/util/artifact-mentions";
import { useArtifactNames } from "@cocalc/frontend/agents/artifact-names";

interface Opts {
  avatarUserSize?: number;
  avatarLLMSize?: number;
}

export function useMentionableUsers(): (
  search: string | undefined,
  opts?: Opts,
) => Item[] {
  const { project_id } = useProjectContext();
  const user_map = useTypedRedux("users", "user_map");
  const { allowAgentMentions, states, source, postOnly } =
    useAgentMentionContext();
  const { selectedNetworkId } = useChatEmbeddingOptions();
  const settings = useTypedRedux("account", "other_settings");
  const { names: artifactNames } = useArtifactNames();
  const [expanded, setExpanded] = useState(false);
  const enabled = allowAgentMentions === true;
  const { directory } = useNamedAgents(enabled);
  const { directory: networkDirectory } = useAgentNetworks(enabled);

  return useMemo(() => {
    return (search: string | undefined, opts?: Opts) => {
      const query = search?.toLowerCase() ?? "";
      const suggestions = agentMentionSuggestions({
        agents: enabled ? (directory?.agents ?? []) : [],
        networks: networkDirectory?.networks ?? [],
        source,
        selectedNetworkId,
        query,
        expanded,
        paused: networkDirectory?.controls.paused,
        activity: normalizeAgentWorkspaceOrganization(
          settings?.get?.(MY_AGENTS_ORGANIZATION_SETTING),
        ).lastOpened,
      });
      const agents: Item[] = suggestions.rows.map(
        ({ agent, group, connected, paused }) => ({
          value: serializeAgentMention(namedAgentReference(agent)),
          group,
          search:
            `${agent.name} ${agent.description ?? ""} ${agent.thread_title ?? ""} ${agent.project_title ?? ""}`.toLowerCase(),
          label: (
            <span
              title={
                postOnly
                  ? "Reference only; this post will not contact the agent."
                  : "Reference agent; mentioning does not send a message."
              }
            >
              <strong>@{agent.name}</strong>
              <div
                style={{
                  fontSize: "0.9em",
                  maxWidth: 360,
                  whiteSpace: "normal",
                }}
              >
                {agent.description || agent.thread_title || agent.project_title}
                {!agent.available
                  ? " · Unavailable"
                  : states?.[agent.endpoint.agent_id]
                    ? ` · ${states[agent.endpoint.agent_id]}`
                    : paused
                      ? " · Communication paused"
                      : !connected
                        ? " · Connection required"
                        : ""}
              </div>
            </span>
          ),
        }),
      );
      const artifacts: Item[] =
        enabled && project_id
          ? artifactNames
              .filter((item) => item.active && item.project_id === project_id)
              .filter((item) => item.name.includes(query))
              .slice(0, 20)
              .map((item) => ({
                value: serializeArtifactMention({
                  version: 1,
                  project_id: item.project_id,
                  entry_id: item.entry_id,
                  name: item.name,
                }),
                group: "Artifacts",
                search: item.name,
                label: (
                  <span title="Reference artifact in this project">
                    @{item.name}
                  </span>
                ),
              }))
          : [];
      return [
        ...artifacts,
        ...agents,
        ...(enabled && !query && !expanded
          ? [
              {
                value: "show-all-agent-mentions",
                label: suggestions.hasMore
                  ? "Search all agents…"
                  : "Browse all agents…",
                onSelect: () => setExpanded(true),
              },
            ]
          : []),
        ...mentionableUsers({
          search,
          project_id,
          user_map,
          opts,
        }).map((item) => ({ ...item, group: "People" })),
      ];
    };
  }, [
    project_id,
    user_map,
    directory,
    states,
    enabled,
    networkDirectory,
    source,
    selectedNetworkId,
    settings,
    artifactNames,
    expanded,
    postOnly,
  ]);
}

interface Props {
  search: string | undefined;
  project_id: string;
  user_map?: any;
  opts?: Opts;
}

function unresolvedUserLabel(account_id: string): string {
  if (!isValidUUID(account_id)) {
    return account_id;
  }
  return `User ${account_id.slice(0, 8)}`;
}

function userRecordFromMap(user_map: any, account_id: string): any {
  return user_map?.get?.(account_id) ?? user_map?.[account_id];
}

function mentionDisplayName(account_id: string, user_map: any): string {
  const fromMap = displayNameFromUserRecord(
    userRecordFromMap(user_map, account_id),
  ).trim();
  if (fromMap) {
    return fromMap;
  }
  return (
    redux.getStore("users").get_name(account_id)?.trim() ??
    unresolvedUserLabel(account_id)
  );
}

export function mentionableUsers({
  search,
  project_id,
  user_map,
  opts,
}: Props): Item[] {
  const { avatarUserSize = 24 } = opts ?? {};

  const users = redux
    .getStore("projects")
    .getIn(["project_map", project_id, "users"]);

  const last_active = redux
    .getStore("projects")
    .getIn(["project_map", project_id, "last_active"]);

  const my_account_id = redux.getStore("account")?.get("account_id");

  const projectUsers: {
    account_id: string;
    last_active: Date | undefined;
  }[] = [];
  for (const [account_id] of users ?? []) {
    projectUsers.push({
      account_id,
      last_active: last_active?.get(account_id),
    });
  }
  projectUsers.sort((a, b) => {
    if (a.account_id === my_account_id) {
      return 1;
    }
    if (b.account_id === my_account_id) {
      return -1;
    }
    return timestamp_cmp(a, b, "last_active");
  });

  const mentions: Item[] = [];
  if (getMentionAllAccountIds(project_id).length > 0) {
    mentions.push({
      value: ALL_PROJECT_COLLABORATORS_MENTION_ID,
      label: (
        <span>
          <Icon name="users" style={{ color: COLORS.GRAY_M }} /> All
          collaborators
        </span>
      ),
      search: "all collaborators everyone everybody",
    });
  }

  for (const { account_id } of projectUsers) {
    const fullname = mentionDisplayName(account_id, user_map);
    const searchText = `${fullname} ${account_id}`.toLowerCase();
    if (search != null && searchText.indexOf(search) === -1) continue;
    mentions.push({
      value: account_id,
      label: (
        <span>
          <Avatar account_id={account_id} size={avatarUserSize} />{" "}
          {trunc_middle(fullname, 64)}
        </span>
      ),
      search: searchText,
    });
  }

  return mentions;
}
