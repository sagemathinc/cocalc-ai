import { redux } from "@cocalc/frontend/app-framework";
import { personalAgentApi } from "./api";

// Only notifications opened from the Agents surface should stay in that surface.
export async function openAgentNotification(
  project: string,
  path: string,
  thread?: string,
): Promise<boolean> {
  if (!thread || redux.getStore("page")?.get("active_top_tab") !== "agents")
    return false;
  const { agents } = await personalAgentApi().listNamedAgents({});
  const agent = agents.find(
    (agent) =>
      agent.endpoint.project_id === project &&
      agent.path === path &&
      agent.thread_id === thread,
  );
  if (!agent) return false;
  if (redux.getStore("page")?.get("active_top_tab") !== "agents") return false;
  const page = redux.getActions("page");
  page.setState({
    active_agent_id: agent.endpoint.agent_id,
    active_agent_name: agent.name,
  });
  await page.set_active_tab("agents");
  return true;
}
