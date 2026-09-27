import {
  agentThreadResourceId,
  bindCollaborationAgent,
  matchesAgentIdentity,
} from "./collaboration-agent-identity";
import type { CollaborationAgentIdentity } from "./collaboration-agent-identity";
import type { CollaborationResource } from "./collaborators";

const identity: CollaborationAgentIdentity = {
  project_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "22222222-2222-4222-8222-222222222222",
  path: "/home/user/agent.chat",
  thread_id: "old",
};
const resource = (thread_id = "old", activity = 3): CollaborationResource => ({
  project_id: identity.project_id,
  kind: "agent",
  resource_id: agentThreadResourceId(thread_id),
  thread_id,
  chat_path: identity.path,
  title: thread_id,
  activity,
  created_at: 1,
  updated_at: activity,
  participant_ids: [],
});

test.each([false, true])(
  "successor selects one stable agent independent of source order (%s)",
  (reverse) => {
    const previous = bindCollaborationAgent(identity, [resource()]);
    const nextIdentity = {
      ...identity,
      thread_id: "new",
      conversation_history: [{ thread_id: "old" }],
    };
    const rows = [{ ...resource(), archived: true }, resource("new", 1)];
    const next = bindCollaborationAgent(
      nextIdentity,
      reverse ? rows.reverse() : rows,
      previous,
    );
    expect(next.resource).toMatchObject({
      resource_id: identity.agent_id,
      agent_id: identity.agent_id,
      thread_id: "new",
      title: "new",
      activity: 4,
    });
    expect(next.resource.archived).not.toBe(true);
    expect(next.agent_resource_ids).toEqual([
      "agent-thread:new",
      "agent-thread:old",
    ]);
    const stale = bindCollaborationAgent(
      nextIdentity,
      [resource("old", 999)],
      next,
    );
    expect(stale.resource).toMatchObject({
      thread_id: "new",
      activity: 4,
      title: "new",
    });
    expect(
      bindCollaborationAgent(nextIdentity, [resource("new", 2)], stale).resource
        .activity,
    ).toBe(5);
    const reset = bindCollaborationAgent(
      nextIdentity,
      [resource("new", 0)],
      stale,
    );
    expect(reset.agent_source_activity).toBe(1);
    expect(
      bindCollaborationAgent(nextIdentity, [resource("new", 2)], reset).resource
        .activity,
    ).toBe(5);
  },
);

test("a copied native thread/configuration never matches an existing identity", () => {
  expect(
    matchesAgentIdentity(
      {
        ...resource(),
        resource_id: "copy:opaque",
        agent_id: identity.agent_id,
      },
      identity,
    ),
  ).toBe(false);
  expect(
    matchesAgentIdentity(
      {
        ...resource(),
        chat_path: "/home/user/copied.chat",
        agent_id: identity.agent_id,
      },
      identity,
    ),
  ).toBe(false);
  expect(matchesAgentIdentity(resource("unnamed"), identity)).toBe(false);
});

test("historical-only snapshots preserve an already-current archived successor", () => {
  const nextIdentity = {
    ...identity,
    thread_id: "new",
    conversation_history: [{ thread_id: "old" }],
  };
  const current = bindCollaborationAgent(nextIdentity, [
    { ...resource("new"), archived: true },
  ]);
  const historical = bindCollaborationAgent(
    nextIdentity,
    [resource("old", 999)],
    current,
  );
  expect(historical.resource).toEqual(current.resource);
  expect(historical.agent_source_activity).toBe(current.agent_source_activity);
  const successor = bindCollaborationAgent(
    {
      ...nextIdentity,
      thread_id: "newer",
      conversation_history: [{ thread_id: "old" }, { thread_id: "new" }],
    },
    [resource("old")],
    historical,
  );
  expect(successor.resource).toMatchObject({
    thread_id: "newer",
    archived: false,
  });
});
