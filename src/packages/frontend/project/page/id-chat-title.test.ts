jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => undefined },
  redux_name: () => "",
}));
jest.mock("@cocalc/frontend/agents/api", () => ({}));
jest.mock(
  "@cocalc/frontend/notifications/mentions/conversation-lookup",
  () => ({}),
);

import { idChatAgentTitle, isIdNamedChat } from "./id-chat-title";

const ID = "2b578cd7-136e-40f5-ba38-fb6cf1c0799f";

test("only chat files named by an id get a title instead of their name", () => {
  expect(
    isIdNamedChat(`/home/user/.local/share/cocalc/agents/${ID}.chat`),
  ).toBe(true);
  expect(isIdNamedChat(`${ID}.chat`)).toBe(true);
  expect(isIdNamedChat("team.chat")).toBe(false);
  expect(isIdNamedChat(`notes/${ID}.md`)).toBe(false);
});

test("an agent chat is named by its thread title, or the agent's @name", () => {
  const agents = [
    {
      name: "claude-1",
      path: `/home/user/.local/share/cocalc/agents/${ID}.chat`,
      thread_title: "Sagebrush engine",
      endpoint: { project_id: "p1" },
    },
    {
      name: "plain",
      path: "/home/user/.local/share/cocalc/agents/other.chat",
      endpoint: { project_id: "p1" },
    },
  ];
  expect(
    idChatAgentTitle(agents, "p1", `.local/share/cocalc/agents/${ID}.chat`),
  ).toBe("Sagebrush engine");
  expect(
    idChatAgentTitle(
      agents,
      "p1",
      "/home/user/.local/share/cocalc/agents/other.chat",
    ),
  ).toBe("@plain");
  expect(
    idChatAgentTitle(agents, "p2", `.local/share/cocalc/agents/${ID}.chat`),
  ).toBe(undefined);
});
