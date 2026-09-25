import { notificationAgentName } from "./notification-name";

const agents = [
  {
    name: "reviewer",
    endpoint: { project_id: "project-1", agent_id: "agent-1" },
    path: "/home/user/agent.chat",
    thread_id: "thread-1",
  },
] as any;

test("labels only an exact named-agent notification", () => {
  expect(
    notificationAgentName({
      agents,
      projectId: "project-1",
      path: "/home/user/agent.chat",
      threadId: "thread-1",
    }),
  ).toBe("@reviewer");
  expect(
    notificationAgentName({
      agents,
      projectId: "project-1",
      path: "/home/user/agent.chat",
      threadId: "other-thread",
    }),
  ).toBeUndefined();
});
