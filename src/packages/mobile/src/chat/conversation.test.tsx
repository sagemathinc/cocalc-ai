import React from "react";
const { act, create } = require("react-test-renderer");
import ChatScreen from "../app/project/[projectId]/chat";
import { createRemoteHeadlessChatClient } from "@cocalc/chat-client";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";
import { ensureProjectRunning } from "../cocalc/project-runtime";
import {
  clearChatDraftIfUnchanged,
  loadChatDraft,
  saveChatDraft,
} from "./drafts";

let mockTranscript: (text: string) => void;
jest.mock("../speech/use-speech", () => ({
  useSpeech: (
    _profile: string,
    _project: string,
    _path: string,
    _thread: string,
    receive: (text: string) => void,
  ) => {
    mockTranscript = receive;
    return { state: { phase: "idle" }, controller: {} };
  },
}));
jest.mock("expo-router/react-navigation", () => ({
  useHeaderHeight: () => 116,
}));
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({
    projectId: "project",
    profile: "profile",
    chatPath: "agent.chat",
    thread: "thread",
    title: "Research",
  }),
}));
jest.mock("@cocalc/chat-client", () => ({
  createRemoteHeadlessChatClient: jest.fn(),
}));
jest.mock("@cocalc/chat-client/named-agents", () => ({
  resolveNamedAgentHost: jest.fn(),
}));
jest.mock("../cocalc/project-runtime", () => ({
  ensureProjectRunning: jest.fn(),
}));
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: async () => ({
    profile: { account_id: "account" },
    hubApi: {},
  }),
  peekActiveSiteSession: () => undefined,
}));
jest.mock("../cocalc/site-session", () => ({
  openProjectHost: async () => ({ client: {} }),
}));
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => {} },
}));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn() }));
jest.mock("./drafts", () => ({
  clearChatDraftIfUnchanged: jest.fn(),
  loadChatDraft: jest.fn(),
  saveChatDraft: jest.fn(),
}));
jest.mock("./markdown", () => ({ Markdown: "Markdown" }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).requestAnimationFrame = (callback: () => void) =>
  setTimeout(callback, 0);
(globalThis as any).cancelAnimationFrame = clearTimeout;

let renderer: any;
let client: any;
const button = (label: string) =>
  renderer.root.findAll(
    (node: any) =>
      node.type === "Pressable" &&
      node.props.accessibilityRole === "button" &&
      node.props.accessibilityLabel === label,
  )[0];
const input = () =>
  renderer.root.findByProps({ accessibilityLabel: "Message Codex" });

beforeEach(() => {
  jest.clearAllMocks();
  const snapshot = {
    revision: 1,
    ready: true,
    connection: "connected",
    messages: [],
    threads: [{ thread_id: "thread", agent_kind: "acp", state: "running" }],
    message_window: { limit: 30, has_older: true },
  };
  client = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    open: jest.fn(),
    close: jest.fn(),
    sendToExistingCodexThread: jest.fn(),
    sendGuidanceToCodexThread: jest.fn(),
    interrupt: jest.fn(),
    loadOlderMessages: jest.fn(),
  };
  jest.mocked(createRemoteHeadlessChatClient).mockReturnValue(client);
  jest.mocked(resolveNamedAgentHost).mockResolvedValue("current-host");
  jest.mocked(loadChatDraft).mockResolvedValue("saved draft");
  jest.mocked(saveChatDraft).mockResolvedValue();
  jest.mocked(clearChatDraftIfUnchanged).mockResolvedValue();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

it("opens and reads earlier messages without starting compute, then starts only on send", async () => {
  await act(async () => {
    renderer = create(<ChatScreen />);
  });
  expect(input().props.value).toBe("saved draft");
  expect(ensureProjectRunning).not.toHaveBeenCalled();
  expect(resolveNamedAgentHost).toHaveBeenCalledWith({}, "account", "project");
  await act(async () => button("Load earlier messages").props.onPress());
  expect(client.loadOlderMessages).toHaveBeenCalledWith(60);
  expect(ensureProjectRunning).not.toHaveBeenCalled();
  await act(async () => button("Send message to Codex").props.onPress());
  expect(ensureProjectRunning).toHaveBeenCalledTimes(1);
  expect(client.sendToExistingCodexThread).toHaveBeenCalledWith({
    thread_id: "thread",
    text: "saved draft",
  });
  expect(input().props.value).toBe("");
});

it("restores without overwriting storage, persists edits immediately, and separates guidance", async () => {
  await act(async () => {
    renderer = create(<ChatScreen />);
  });
  expect(saveChatDraft).not.toHaveBeenCalled();
  await act(async () =>
    input().props.onChangeText("Please focus on the table"),
  );
  expect(saveChatDraft).toHaveBeenLastCalledWith(
    expect.objectContaining({ threadId: "thread", profileId: "profile" }),
    "Please focus on the table",
  );
  await act(async () =>
    button("Send guidance to running agent").props.onPress(),
  );
  expect(client.sendGuidanceToCodexThread).toHaveBeenCalledWith({
    thread_id: "thread",
    text: "Please focus on the table",
  });
  expect(client.sendToExistingCodexThread).not.toHaveBeenCalled();
});

it("retains a draft when submission acknowledgement is unknown", async () => {
  client.sendToExistingCodexThread.mockRejectedValue(new Error("timeout"));
  await act(async () => {
    renderer = create(<ChatScreen />);
  });
  await act(async () => button("Send message to Codex").props.onPress());
  expect(input().props.value).toBe("saved draft");
  expect(saveChatDraft).not.toHaveBeenCalled();
  expect(
    renderer.root.findByProps({ accessibilityRole: "alert" }).props.children,
  ).toBe("timeout");
});

it("keeps the transcript and draft through backgrounding and reconnects without starting compute", async () => {
  const { AppState } = require("react-native");
  let changeState!: (state: string) => void;
  const listener = jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_event: any, callback: any) => {
      changeState = callback;
      return { remove() {} };
    });
  const original = client.getSnapshot();
  original.messages = [
    {
      message_id: "result",
      role: "agent",
      content: "An existing result",
      generating: false,
    },
  ];
  const resumedSnapshot = { ...original, revision: 2 };
  const replacement = { ...client, getSnapshot: () => resumedSnapshot };
  await act(async () => {
    renderer = create(<ChatScreen />);
  });
  await act(async () => input().props.onChangeText("Continue with this"));
  await act(async () => changeState("background"));
  expect(client.close).toHaveBeenCalled();
  expect(
    renderer.root.findAllByProps({ value: "An existing result" }).length,
  ).toBeGreaterThan(0);
  expect(input().props.value).toBe("Continue with this");
  expect(button("Send message to Codex").props.disabled).toBe(true);
  jest.mocked(createRemoteHeadlessChatClient).mockReturnValue(replacement);
  await act(async () => changeState("active"));
  expect(createRemoteHeadlessChatClient).toHaveBeenCalledTimes(2);
  expect(input().props.value).toBe("Continue with this");
  expect(ensureProjectRunning).not.toHaveBeenCalled();
  listener.mockRestore();
});

it("appends dictation to the latest edited draft and never sends automatically", async () => {
  await act(async () => {
    renderer = create(<ChatScreen />);
  });
  await act(async () => input().props.onChangeText("Please investigate:"));
  await act(async () => mockTranscript("the failing build"));
  expect(input().props.value).toBe("Please investigate: the failing build");
  expect(saveChatDraft).toHaveBeenLastCalledWith(
    expect.anything(),
    "Please investigate: the failing build",
  );
  expect(client.sendToExistingCodexThread).not.toHaveBeenCalled();
  expect(ensureProjectRunning).not.toHaveBeenCalled();
});
