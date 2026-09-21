import React from "react";
const { act, create } = require("react-test-renderer");
import { Alert } from "react-native";
import { router } from "expo-router";
import AgentDetailsScreen from "../app/agent-details";
import { getActiveSiteSession } from "../cocalc/session-registry";

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({
    profile: "profile",
    agentId: "agent",
    projectId: "project",
  }),
  useFocusEffect: (callback: () => void) =>
    require("react").useEffect(callback, [callback]),
}));
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: jest.fn(),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: any;
let api: any;
const identity = {
  project_id: "project",
  agent_id: "agent",
  path: "agent.chat",
  thread_id: "current",
  conversation_history: [
    { thread_id: "past", ended_at: "2026-09-20T12:00:00Z" },
  ],
};
const agent = {
  name: "research",
  description: "Research helper",
  endpoint: { project_id: "project", agent_id: "agent" },
  path: "agent.chat",
  thread_id: "current",
};
const button = (name: string) =>
  renderer.root.findAll(
    (node: any) =>
      node.type === "Pressable" &&
      node.props.accessibilityRole === "button" &&
      node.props.accessibilityLabel === name,
  )[0];
beforeEach(() => {
  jest.clearAllMocks();
  api = {
    listNamedAgents: jest.fn().mockResolvedValue({ agents: [agent] }),
    getIdentity: jest.fn().mockResolvedValue(identity),
    nameAgent: jest.fn().mockResolvedValue({ ...agent, name: "renamed" }),
    startFreshConversation: jest
      .fn()
      .mockResolvedValue({ ...identity, thread_id: "fresh" }),
  };
  jest
    .mocked(getActiveSiteSession)
    .mockResolvedValue({ hubApi: { agent: api } } as any);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});
it("saves a normalized name and description through the existing authority path", async () => {
  await act(async () => {
    renderer = create(<AgentDetailsScreen />);
  });
  await act(async () =>
    renderer.root
      .findByProps({ accessibilityLabel: "Agent name" })
      .props.onChangeText("Renamed"),
  );
  await act(async () => button("Save agent details").props.onPress());
  expect(api.nameAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      endpoint: agent.endpoint,
      name: "renamed",
      description: "Research helper",
    }),
  );
});
it("requires confirmation and preserves the expected current thread when starting fresh", async () => {
  await act(async () => {
    renderer = create(<AgentDetailsScreen />);
  });
  await act(async () => button("Start fresh conversation").props.onPress());
  expect(api.startFreshConversation).not.toHaveBeenCalled();
  const controls = jest.mocked(Alert.alert).mock.calls[0][2]!;
  expect(controls[0].style).toBe("cancel");
  await act(async () => controls[1].onPress!());
  expect(api.startFreshConversation).toHaveBeenCalledWith({
    project_id: "project",
    agent_id: "agent",
    expected_thread_id: "current",
  });
  expect(router.replace).toHaveBeenCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({
        thread: "fresh",
        chatPath: "agent.chat",
      }),
    }),
  );
});
it("opens history without changing the agent identity", async () => {
  await act(async () => {
    renderer = create(<AgentDetailsScreen />);
  });
  await act(async () =>
    button(
      `Open conversation ended ${new Date(identity.conversation_history[0].ended_at).toLocaleString()}`,
    ).props.onPress(),
  );
  expect(router.push).toHaveBeenCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({ thread: "past" }),
    }),
  );
  expect(api.startFreshConversation).not.toHaveBeenCalled();
  expect(api.nameAgent).not.toHaveBeenCalled();
});

it("keeps an uncertain fresh transition on the details screen for reconciliation", async () => {
  api.startFreshConversation.mockRejectedValueOnce(new Error("timeout"));
  await act(async () => {
    renderer = create(<AgentDetailsScreen />);
  });
  await act(async () => button("Start fresh conversation").props.onPress());
  await act(async () =>
    jest.mocked(Alert.alert).mock.calls[0][2]![1].onPress!(),
  );
  expect(router.replace).not.toHaveBeenCalled();
  expect(
    renderer.root.findByProps({ accessibilityRole: "alert" }).props.children,
  ).toContain("Reload agent details");
  expect(api.startFreshConversation).toHaveBeenCalledTimes(1);
});
