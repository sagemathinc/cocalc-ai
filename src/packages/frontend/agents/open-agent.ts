import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";

export async function openAgentThread(target: {
  project_id: string;
  path: string;
  thread_id: string;
}): Promise<void> {
  await ensureProjectReduxRuntime();
  const actions = redux.getProjectActions(target.project_id);
  if (!actions) throw new Error("Unable to open this agent's project");
  await actions.open_file({
    path: target.path,
    foreground: true,
    foreground_project: true,
    fragmentId: { thread: target.thread_id },
  });
}
