import { useEffect } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { redux } from "@cocalc/frontend/app-framework";
import { replace_url } from "@cocalc/frontend/history";
import { getPageUrlPath } from "@cocalc/frontend/page-routing";
import { usePersonalUrlOwner } from "@cocalc/frontend/personal-url-owner";
import { resolvePersonalUrl } from "@cocalc/frontend/personal-url-navigation";
import { parsePersonalUrl } from "@cocalc/util/personal-urls";

export function useWorkspaceRoute({
  active,
  activeAgentId,
  selected,
}: {
  active: boolean;
  activeAgentId?: string;
  selected?: NamedAgent;
}) {
  const owner = usePersonalUrlOwner(selected?.account_id);
  useEffect(() => {
    if (!active || !activeAgentId || activeAgentId === "new" || !selected)
      return;
    // A qualified route was already resolved by the viewer-authorized RPC.
    // Directory refreshes must not rewrite it into the viewer's namespace.
    const page = redux.getStore("page");
    const personalUrl = page?.get("personal_url");
    let routeOwner = owner;
    if (personalUrl) {
      if (page?.get("personal_url_owner_account_id") !== selected.account_id)
        return;
      const route = parsePersonalUrl(personalUrl);
      if (route.kind !== "agents") return;
      if (route.alias === selected.name && (!owner || route.owner === owner))
        return;
      routeOwner = owner ?? route.owner;
    }
    if (
      activeAgentId !== selected.endpoint.agent_id ||
      redux.getStore("page")?.get("active_agent_name") !== selected.name
    ) {
      redux.getActions("page").setState({
        active_agent_id: selected.endpoint.agent_id,
        active_agent_name: selected.name,
      });
    }
    if (routeOwner) {
      const url = getPageUrlPath({
        page: "agents",
        agent_id: selected.name,
        owner: routeOwner,
      });
      // Clear old URL metadata before replacing it, then bind the new address.
      redux.getActions("page").setState({ personal_url: undefined });
      replace_url(url);
      void resolvePersonalUrl(url, true);
    }
  }, [
    active,
    activeAgentId,
    selected?.endpoint.agent_id,
    selected?.name,
    owner,
  ]);
}
