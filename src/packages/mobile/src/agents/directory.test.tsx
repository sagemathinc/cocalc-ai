import React from "react";
const { act, create } = require("react-test-renderer");
import AgentsScreen from "../app/agents";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { router } from "expo-router";
import { MY_AGENTS_ORGANIZATION_SETTING } from "@cocalc/chat-client/agent-organization";

jest.mock("./use-appearance", () => ({
  useAgentAppearance: () => ({ appearances: {}, siteUrl: "" }),
}));
jest.mock("./avatar", () => ({ AgentAvatar: "AgentAvatar" }));
jest.mock("react-native-draggable-flatlist", () => ({
  __esModule: true,
  default: require("react-native").FlatList,
}));
jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
  Link: "Link",
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ profile: "profile" }),
  useFocusEffect: (callback: () => void) =>
    require("react").useEffect(callback, [callback]),
}));
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: jest.fn(),
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const named = (id: string, available = true) => ({
  account_id: "account",
  name: id,
  endpoint: { agent_id: id, project_id: "project" },
  path: "chat.chat",
  thread_id: "thread",
  available,
  updated_at: "2026-09-21",
});
let renderer: any;
let query: jest.Mock;
let list: jest.Mock;
const button = (name: string) =>
  renderer.root.findAll(
    (node: any) =>
      node.type === "Pressable" &&
      node.props.accessibilityRole === "button" &&
      node.props.accessibilityLabel === name,
  )[0];

beforeEach(() => {
  jest.clearAllMocks();
  query = jest.fn().mockResolvedValue({
    accounts: [{ account_id: "account", other_settings: {} }],
  });
  list = jest.fn().mockResolvedValue({
    enabled: true,
    agents: [named("Research"), named("Writing"), named("Unavailable", false)],
  });
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    profile: { account_id: "account" },
    hubApi: { db: { userQuery: query }, agent: { listNamedAgents: list } },
  } as any);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

it("opens a registered agent directly from an accessible control without listing projects", async () => {
  await act(async () => {
    renderer = create(<AgentsScreen />);
  });
  expect(button("Open Research")).toBeDefined();
  expect(
    button("Open Unavailable, unavailable").props.accessibilityState.disabled,
  ).toBe(true);
  await act(async () => button("Open Research").props.onPress());
  expect(router.push).toHaveBeenCalledWith({
    pathname: "/project/[projectId]/chat",
    params: {
      profile: "profile",
      projectId: "project",
      chatPath: "chat.chat",
      thread: "thread",
      title: "Research",
    },
  });
});

it("filters by the named search input and pins through the shared account setting", async () => {
  await act(async () => {
    renderer = create(<AgentsScreen />);
  });
  const input = renderer.root.findByProps({
    accessibilityLabel: "Search agents",
  });
  await act(async () => input.props.onChangeText("research"));
  expect(button("Open Writing")).toBeUndefined();
  await act(async () => button("Pin Research").props.onPress());
  expect(button("Unpin Research")).toBeDefined();
  expect(
    query.mock.calls.at(-1)[0].query.accounts.other_settings[
      MY_AGENTS_ORGANIZATION_SETTING
    ].pinned,
  ).toBe('["Research"]');
});

it("keeps failed saves visible and does not falsely show a pinned agent", async () => {
  await act(async () => {
    renderer = create(<AgentsScreen />);
  });
  query.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Pin Research").props.onPress());
  expect(button("Pin Research")).toBeDefined();
  expect(
    renderer.root.findByProps({ accessibilityRole: "alert" }).props.children,
  ).toContain("offline");
});

it("restores a hidden agent without creating a separate mobile directory", async () => {
  query.mockResolvedValue({
    accounts: [
      {
        account_id: "account",
        other_settings: {
          [MY_AGENTS_ORGANIZATION_SETTING]: { hidden: '["Research"]' },
        },
      },
    ],
  });
  await act(async () => {
    renderer = create(<AgentsScreen />);
  });
  expect(button("Open Research")).toBeUndefined();
  await act(async () => button("Show hidden agents").props.onPress());
  expect(button("Restore Research")).toBeDefined();
  await act(async () => button("Restore Research").props.onPress());
  expect(
    query.mock.calls.at(-1)[0].query.accounts.other_settings[
      MY_AGENTS_ORGANIZATION_SETTING
    ].hidden,
  ).toBe("[]");
  await act(async () => button("Show active agents").props.onPress());
  expect(button("Open Research")).toBeDefined();
});

it("changes shared ordering and offers accessible reordering controls", async () => {
  await act(async () => {
    renderer = create(<AgentsScreen />);
  });
  await act(async () => button("Use custom agent order").props.onPress());
  expect(
    query.mock.calls.at(-1)[0].query.accounts.other_settings[
      MY_AGENTS_ORGANIZATION_SETTING
    ].mode,
  ).toBe("custom");
  await act(async () => button("Reorder agents").props.onPress());
  await act(async () => button("Move Research down").props.onPress());
  const saved = JSON.parse(
    query.mock.calls.at(-1)[0].query.accounts.other_settings[
      MY_AGENTS_ORGANIZATION_SETTING
    ].custom,
  );
  expect(saved.indexOf("Research")).toBeGreaterThan(
    saved.indexOf("Unavailable"),
  );
  await act(async () => button("Group agents by project").props.onPress());
  expect(
    query.mock.calls.at(-1)[0].query.accounts.other_settings[
      MY_AGENTS_ORGANIZATION_SETTING
    ].groupByProject,
  ).toBe(true);
});
