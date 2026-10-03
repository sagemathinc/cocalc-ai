/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The other people who have this agent in their agents, in its header. Like
// chat avatars, only *other* people are shown, so a personal agent shows
// nothing at all.

import { useEffect, useState } from "react";
import { Tooltip } from "antd";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import { redux } from "@cocalc/frontend/app-framework";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { personalAgentApi } from "./api";

const MAX_SHOWN = 5;
const cache = new Map<string, string[]>();

export function AgentParticipants({ endpoint }: { endpoint: AgentEndpoint }) {
  const key = `${endpoint.project_id}/${endpoint.agent_id}`;
  const [ids, setIds] = useState<string[]>(() => cache.get(key) ?? []);
  useEffect(() => {
    let canceled = false;
    setIds(cache.get(key) ?? []);
    void personalAgentApi()
      .listAgentParticipants({ endpoint })
      .then(({ account_ids }) => {
        cache.set(key, account_ids);
        if (!canceled) setIds(account_ids);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [key]);
  if (ids.length === 0) return null;
  const users = redux.getStore("users");
  const names = ids.map(
    (id) => (users?.get_name?.(id) as string | undefined) ?? "a collaborator",
  );
  return (
    <>
      <span aria-hidden="true">·</span>
      <Tooltip title={`Also in this agent: ${names.join(", ")}`}>
        <span
          role="group"
          aria-label={`Also in this agent: ${names.join(", ")}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
        >
          {ids.slice(0, MAX_SHOWN).map((id) => (
            <Avatar key={id} account_id={id} size={18} no_tooltip />
          ))}
          {ids.length > MAX_SHOWN && (
            <span style={{ fontSize: 12 }}>+{ids.length - MAX_SHOWN}</span>
          )}
        </span>
      </Tooltip>
    </>
  );
}
