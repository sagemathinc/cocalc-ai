import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import type { ChatThreadConfigRecord } from "@cocalc/chat";
import {
  acquireChatSyncDB,
  releaseChatSyncDB,
  type ImmerDB,
} from "@cocalc/chat/server";
import { conatWithProjectRoutingForAccount } from "@cocalc/server/conat/route-client";
import type { Client } from "@cocalc/conat/core/client";

export async function withAgentChat<T>(
  agent: Pick<
    AgentIdentity,
    "project_id" | "path" | "thread_id" | "created_by"
  >,
  fn: (
    db: ImmerDB,
    thread: ChatThreadConfigRecord,
    rows: any[],
    client: Client,
  ) => Promise<T>,
): Promise<T> {
  const client = conatWithProjectRoutingForAccount({
    account_id: agent.created_by,
  });
  const db = await acquireChatSyncDB({
    client,
    project_id: agent.project_id,
    path: agent.path,
    readyTimeoutMs: 20_000,
  });
  try {
    const values = db.get();
    const rows = Array.isArray(values) ? values : (values?.toJS?.() ?? []);
    const thread = rows.find(
      (r) =>
        r.event === "chat-thread-config" && r.thread_id === agent.thread_id,
    );
    if (!thread || thread.agent_kind !== "acp" || thread.archived)
      throw new Error("an existing non-archived Codex thread is required");
    return await fn(db, thread, rows, client);
  } finally {
    await releaseChatSyncDB(agent.project_id, agent.path);
  }
}
