import { useEffect } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { redux } from "@cocalc/frontend/app-framework";
import { set_url } from "@cocalc/frontend/history";
import { getPageUrlPath } from "@cocalc/frontend/page-routing";

export function useWorkspaceRoute({
  active,
  activeAgentId,
  selected,
}: {
  active: boolean;
  activeAgentId?: string;
  selected?: NamedAgent;
}) {
  useEffect(() => {
    if (!active || !activeAgentId || activeAgentId === "new" || !selected)
      return;
    if (
      activeAgentId !== selected.endpoint.agent_id ||
      redux.getStore("page")?.get("active_agent_name") !== selected.name
    ) {
      redux.getActions("page").setState({
        active_agent_id: selected.endpoint.agent_id,
        active_agent_name: selected.name,
      });
    }
    if (activeAgentId !== selected.name) {
      set_url(getPageUrlPath({ page: "agents", agent_id: selected.name }));
    }
  }, [active, activeAgentId, selected?.endpoint.agent_id, selected?.name]);
}
