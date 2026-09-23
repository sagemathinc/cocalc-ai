import React from "react";
const { act, create } = require("react-test-renderer");
import NewAgentScreen from "./new-agent";
import { router } from "expo-router";
import { createNamedAgent } from "../agents/create";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { openProjectHost } from "../cocalc/site-session";
import { fsClient } from "@cocalc/conat/files/fs";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ profile: "site" }),
}));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "test-uuid") }));
jest.mock("@cocalc/chat-client", () => ({
  createRemoteHeadlessChatClient: jest.fn(() => ({})),
}));
jest.mock("../agents/create", () => ({ createNamedAgent: jest.fn() }));
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: jest.fn(),
}));
jest.mock("../cocalc/site-session", () => ({ openProjectHost: jest.fn() }));
jest.mock("@cocalc/conat/files/fs", () => ({ fsClient: jest.fn(() => ({})) }));
jest.mock("../ui/palette", () => ({
  usePalette: () => ({
    page: "white",
    text: "black",
    secondary: "gray",
    muted: "gray",
    inset: "white",
    controlBorder: "gray",
    danger: "red",
    link: "blue",
    border: "gray",
  }),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function control(renderer: any, role: string, name: string) {
  return renderer.root.find(
    (node: any) =>
      node.props.accessibilityRole === role &&
      node.props.accessibilityLabel === name,
  );
}

it("lets a user name an agent, choose a project, and open its new chat", async () => {
  const project = {
    project_id: "project-id",
    title: "Math notes",
    host_id: "host-id",
  };
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    profile: { account_id: "account-id" },
    hubApi: {
      projects: { listAccountProjectWindow: async () => [project] },
      agent: {},
    },
  } as any);
  jest.mocked(openProjectHost).mockResolvedValue({
    client: { call: () => ({}) },
  } as any);
  jest
    .mocked(createNamedAgent)
    .mockResolvedValue({ agent_id: "agent-id" } as any);
  let renderer: any;
  await act(async () => {
    renderer = create(<NewAgentScreen />);
  });
  expect(control(renderer, "button", "Create agent").props.disabled).toBe(true);
  await act(async () => {
    control(renderer, "button", "Choose project").props.onPress();
  });
  await act(async () => {
    control(renderer, "button", "Select Math notes").props.onPress();
  });
  expect(control(renderer, "button", "Create agent").props.disabled).toBe(
    false,
  );
  await act(async () => {
    renderer.root
      .find((node: any) => node.props.accessibilityLabel === "Agent name")
      .props.onChangeText("Research");
  });
  await act(async () => {
    control(renderer, "button", "Create agent").props.onPress();
  });
  expect(createNamedAgent).toHaveBeenCalledWith(
    expect.objectContaining({ name: "research", projectTitle: "Math notes" }),
  );
  expect(fsClient).toHaveBeenCalledWith(
    expect.objectContaining({ subject: "fs.project-project-id" }),
  );
  expect(router.replace).toHaveBeenCalledWith(
    expect.objectContaining({
      pathname: "/project/[projectId]/chat",
      params: expect.objectContaining({ projectId: "project-id" }),
    }),
  );
  await act(async () => renderer.unmount());
});
