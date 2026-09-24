import { redux } from "@cocalc/frontend/app-framework";
import { personalAgentApi } from "./api";
import { closedLibraryState } from "./library-navigation";

export async function openAgentNotification(
  project: string,
  path: string,
  thread?: string,
): Promise<boolean> {
  if (!thread) return false;
  const { agents } = await personalAgentApi().listNamedAgents({});
  const agent = agents.find(
    (agent) =>
      agent.endpoint.project_id === project &&
      agent.path === path &&
      agent.thread_id === thread,
  );
  if (!agent) return false;
  const page = redux.getActions("page");
  page.setState({
    ...closedLibraryState,
    active_agent_id: agent.endpoint.agent_id,
    active_agent_name: agent.name,
  });
  await page.set_active_tab("agents");
  return true;
}
