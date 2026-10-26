/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { useState } from "react";
import { useChatEmbeddingOptions } from "@cocalc/frontend/chat/embedding-options";
import {
  agentMentionSuggestions,
  externalAgentMentionSuggestions,
} from "@cocalc/frontend/agents/mention-suggestions";
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
import { serializeComputerMention } from "@cocalc/util/computer-mentions";
import { useComputers } from "@cocalc/frontend/account/use-computers";
import { useComputersEnabled } from "@cocalc/frontend/account/computers-enabled";
import {
  computerState,
  isListed,
  STATE_LABEL,
} from "@cocalc/frontend/account/computer-state";
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
  const { allowAgentMentions, agentsOnly, states, source, postOnly } =
    useAgentMentionContext();
  const { selectedNetworkId } = useChatEmbeddingOptions();
  const settings = useTypedRedux("account", "other_settings");
  const { names: artifactNames } = useArtifactNames();
  const [expanded, setExpanded] = useState(false);
  const enabled = allowAgentMentions === true;
  const { directory } = useNamedAgents(enabled);
  const { directory: networkDirectory } = useAgentNetworks(enabled);
  const computersEnabled = useComputersEnabled() && enabled && !agentsOnly;
  const computers = useComputers(computersEnabled);

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
      const sourceEndpoint = directory?.agents.find(
        (agent) =>
          agent.endpoint.project_id === source?.projectId &&
          agent.path === source?.path &&
          agent.thread_id === source?.threadId,
      )?.endpoint;
      const external = enabled
        ? externalAgentMentionSuggestions({
            networks: networkDirectory?.networks ?? [],
            sourceEndpoint,
            selectedNetworkId,
            query,
            expanded,
            paused: networkDirectory?.controls.paused,
          })
        : { rows: [], hasMore: false };
      const externalAgents: Item[] = external.rows.map(
        ({ member, handle, account_id, group, connected, paused }) => ({
          value: serializeAgentMention({
            version: 1,
            naming_account_id: account_id,
            target: { ...member.source, kind: "external" },
            name: handle,
          }),
          group,
          search: `${handle} ${member.label}`.toLowerCase(),
          label: (
            <span
              title={
                postOnly
                  ? "Reference only; this post will not contact the agent."
                  : "Reference an agent on another site; mentioning does not send a message."
              }
            >
              <strong>@{handle}</strong>{" "}
              <Icon
                name="global"
                aria-label="Agent on another site"
                style={{ color: COLORS.GRAY_M }}
              />
              <div
                style={{
                  fontSize: "0.9em",
                  maxWidth: 360,
                  whiteSpace: "normal",
                }}
              >
                {member.label}
                {!member.available
                  ? " · Unavailable"
                  : states?.[member.source.agent_id]
                    ? ` · ${states[member.source.agent_id]}`
                    : paused
                      ? " · Communication paused"
                      : !connected
                        ? " · Not in a network with this agent"
                        : ""}
              </div>
            </span>
          ),
        }),
      );
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
        enabled && !agentsOnly && project_id
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
      const now = Date.now();
      const computerItems: Item[] = computersEnabled
        ? computers
            .filter((c) => isListed(c, now))
            .filter((c) => c.name.includes(query) || c.hostname.includes(query))
            .slice(0, 20)
            .map((c) => ({
              value: serializeComputerMention({
                version: 1,
                computer_id: c.computer_id,
                name: c.name,
              }),
              group: "Computers",
              search: `${c.name} ${c.hostname}`.toLowerCase(),
              label: (
                <span title="Reference your computer; it serves one project, which the project's host checks when the agent runs something there">
                  <strong>@{c.name}</strong>
                  <div style={{ fontSize: "0.9em" }}>
                    {c.machine_user}@{c.hostname} ·{" "}
                    {STATE_LABEL[computerState(c)]}
                  </div>
                </span>
              ),
            }))
        : [];
      return [
        ...computerItems,
        ...artifacts,
        ...agents,
        ...externalAgents,
        ...(enabled && !query && !expanded
          ? [
              {
                value: "show-all-agent-mentions",
                label:
                  suggestions.hasMore || external.hasMore
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
    computers,
    computersEnabled,
    expanded,
    postOnly,
    agentsOnly,
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
