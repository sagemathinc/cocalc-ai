import React from "react";
const { act, create } = require("react-test-renderer");
import { useAgentAppearance } from "./use-appearance";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";
import { openProjectHost } from "../cocalc/site-session";
import AsyncStorage from "@react-native-async-storage/async-storage";
const close = jest.fn();
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
  },
}));
jest.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void) =>
    require("react").useEffect(callback, [callback]),
}));
jest.mock("@cocalc/chat-client", () => ({
  AgentSessionIndex: class {
    subscribe(callback: (rows: unknown[]) => void) {
      callback([
        {
          chat_path: "correct.chat",
          thread_key: "thread",
          title: "My theme",
          thread_color: "#123456",
          thread_image: "11111111-1111-4111-8111-111111111111",
        },
        {
          chat_path: "different.chat",
          thread_key: "thread",
          title: "Wrong theme",
        },
      ]);
    }
    async open() {}
    close() {
      close();
    }
  },
}));
jest.mock("@cocalc/chat-client/named-agents", () => ({
  resolveNamedAgentHost: jest.fn(async () => "host"),
}));
jest.mock("../cocalc/site-session", () => ({
  openProjectHost: jest.fn(async () => ({ client: {} })),
}));
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: async () => ({
    profile: { account_id: "account", canonical_app_url: "https://site" },
    hubApi: {},
  }),
}));
jest.mock("../preview/fixtures", () => ({ isPreviewProfile: () => false }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const agents = [
  {
    endpoint: { agent_id: "agent", project_id: "project" },
    path: "correct.chat",
    thread_id: "thread",
  },
] as any;
let latest: any;
function Probe() {
  latest = useAgentAppearance("profile", agents);
  return null;
}
it("matches appearance by project, chat, and thread and releases the index", async () => {
  let renderer: any;
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(resolveNamedAgentHost).toHaveBeenCalledWith({}, "account", "project");
  expect(openProjectHost).toHaveBeenCalledWith(expect.anything(), {
    project_id: "project",
    host_id: "host",
  });
  expect(latest.appearances.agent.title).toBe("My theme");
  expect(latest.appearances.agent.thread_image).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(latest.siteUrl).toBe("https://site");
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    "cocalc.mobile.agent-appearance.v1.profile",
    expect.stringContaining("11111111-1111-4111-8111-111111111111"),
  );
  await act(async () => renderer.unmount());
  expect(close).toHaveBeenCalled();
  jest.mocked(resolveNamedAgentHost).mockClear();
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(latest.appearances.agent.title).toBe("My theme");
  expect(resolveNamedAgentHost).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
