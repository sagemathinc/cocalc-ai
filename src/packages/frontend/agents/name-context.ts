import { redux, redux_name } from "@cocalc/frontend/app-framework";
import type { ChatActions } from "@cocalc/frontend/chat/actions";

export interface AgentNameContext {
  project_id: string;
  path: string;
  thread_id: string;
  thread_title?: string;
}

/** Only snapshot cached metadata. Never open a project or chat to enrich a name. */
export function cachedAgentNameContext(context: AgentNameContext): {
  project_title?: string;
  thread_title?: string;
} {
  const projectTitle = redux
    .getStore("projects")
    ?.getIn(["project_map", context.project_id, "title"]);
  const actions = context.thread_title
    ? undefined
    : (redux.getActions(redux_name(context.project_id, context.path)) as
        | ChatActions
        | undefined);
  const threadTitle =
    context.thread_title ??
    actions?.getThreadMetadata?.(context.thread_id, {
      threadId: context.thread_id,
    })?.name;
  return {
    ...(typeof projectTitle === "string" && projectTitle.trim()
      ? { project_title: projectTitle }
      : {}),
    ...(typeof threadTitle === "string" && threadTitle.trim()
      ? { thread_title: threadTitle }
      : {}),
  };
}
