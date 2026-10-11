const mockRedux: any = {};
jest.mock("@cocalc/frontend/app-framework", () => ({ redux: mockRedux }));
const mockInitChat = jest.fn();
jest.mock("@cocalc/frontend/chat/register", () => ({
  initChat: (...args: any[]) => mockInitChat(...args),
}));
const mockQualifiedRuntime = jest.fn();
jest.mock("@cocalc/frontend/chat/harness-profile", () => ({
  qualifiedHarnessRuntime: (...args: any[]) => mockQualifiedRuntime(...args),
}));
const mockListCredentials = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: {
          listExternalCredentials: (...args: any[]) =>
            mockListCredentials(...args),
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
}));
jest.mock("@cocalc/frontend/chat/harness-credential-selection", () => ({
  readHarnessCredentialSelection: jest.fn(),
  writeHarnessCredentialSelection: jest.fn(),
}));
jest.mock("./agent-subscription-selection", () => ({
  readAgentSubscriptionSelection: jest.fn(),
  writeAgentSubscriptionSelection: jest.fn(),
}));

import {
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "@cocalc/frontend/chat/harness-credential-selection";
import { readAgentSubscriptionSelection } from "./agent-subscription-selection";
import {
  findSensorReview,
  reviewerOf,
  reviewerOptions,
  reviewVerdict,
  startSensorReview,
  sensorReviewChatPath,
  sensorReviewPrompt,
  sensorReviewThreadName,
} from "./sensor-review";

const spec = {
  kind: "script",
  title: "New issues",
  purpose: "Wake me for new issues.",
  language: "python",
  script: "print('hi')\n# ```` fences inside the script\n",
  schedule: { kind: "interval", minutes: 30 },
  timeout_seconds: 60,
  max_wakes_per_day: 24,
  uses: ["github"],
} as any;

test("the reviewer gets fixed instructions, the exact spec and the script", () => {
  const prompt = sensorReviewPrompt(spec);
  expect(prompt).toMatch(/clean context/);
  expect(prompt).toMatch(/Do not run the script/);
  expect(prompt).toContain('"uses": [\n    "github"\n  ]');
  expect(prompt).toContain("print('hi')");
  expect(prompt).toMatch(/^Verdict: Do not approve$/m);
});

test("the verdict comes from the first line only", () => {
  expect(reviewVerdict("Verdict: Looks safe\n- fine")).toBe("safe");
  expect(reviewVerdict("Verdict: Has concerns\n")).toBe("concerns");
  expect(reviewVerdict("Verdict: Do not approve")).toBe("reject");
  expect(reviewVerdict("I think it looks safe")).toBeUndefined();
  expect(reviewVerdict("")).toBeUndefined();
});

test("reviews live in a chat of their own, one thread per exact spec", () => {
  expect(sensorReviewChatPath("p", "s1")).toBe(
    "/home/user/.local/share/cocalc/sensor-reviews/s1.chat",
  );
  expect(sensorReviewThreadName("New issues", "abcdef0123456789")).toBe(
    "Review: New issues (spec abcdef012345)",
  );
});

test("finds the newest review of the spec and the reviewer's reply", () => {
  const name = sensorReviewThreadName("New issues", "abcdef0123456789");
  const actions = {
    listThreadConfigRows: () => [
      { thread_id: "old", name, date: "2026-10-10T18:00:00.000Z" },
      { thread_id: "new", name, date: "2026-10-10T19:00:00.000Z" },
      { thread_id: "other", name: "Review: x (spec 999)", date: "z" },
    ],
    getMessagesInThread: (thread_id: string) =>
      thread_id === "new"
        ? [
            { sender_id: "me", history: [{ content: "prompt" }] },
            {
              sender_id: "openai-codex-agent",
              generating: false,
              history: [{ content: "Verdict: Has concerns\n- it posts data" }],
            },
          ]
        : [],
    getThreadMetadata: () => ({ acp_config: { model: "gpt-6-luna" } }),
  } as any;
  expect(
    findSensorReview(actions, "New issues", "abcdef0123456789", "me"),
  ).toEqual({
    thread_id: "new",
    text: "Verdict: Has concerns\n- it posts data",
    generating: false,
    verdict: "concerns",
    reviewer: "Codex · gpt-6-luna",
  });
  expect(findSensorReview(actions, "New issues", "000", "me")).toBeUndefined();
});

const claudeRuntime = {
  version: 1,
  kind: "acp",
  profile: { version: 2, kind: "acp", id: "claude-code", cwd: "/home/user" },
  settings: {
    modeId: "default",
    configOptions: [
      { id: "model", value: "opus[1m]" },
      { id: "effort", value: "high" },
      { id: "fast", value: "on" },
    ],
  },
};

test("the default reviewer is the agent's own model", () => {
  expect(reviewerOf({ acp_config: { model: "gpt-6-luna" } })).toEqual({
    value: "codex:gpt-6-luna",
    label: "Codex · gpt-6-luna",
  });
  expect(reviewerOf({ agent_runtime: claudeRuntime })).toEqual({
    value: "claude:opus[1m]",
    label: "Claude · opus[1m]",
  });
  // Claude with no model chosen runs the newest Opus.
  expect(
    reviewerOf({ agent_runtime: { ...claudeRuntime, settings: {} } }).label,
  ).toBe("Claude · Opus");
  expect(
    reviewerOf({ agent_runtime: { profile: { id: "my-harness" } } }).value,
  ).toBe("same");
  const options = reviewerOptions(
    { value: "codex:gpt-6-luna", label: "Codex · gpt-6-luna" },
    "watcher",
  );
  expect(options[0]).toEqual({
    value: "codex:gpt-6-luna",
    label: "Codex · gpt-6-luna (same as @watcher)",
  });
  expect(
    options.filter(({ value }) => value === "codex:gpt-6-luna"),
  ).toHaveLength(1);
  expect(options.map(({ label }) => label)).toContain("Claude · Sonnet");
});

describe("starting a review", () => {
  const agent = {
    name: "watcher",
    path: "/home/user/.local/share/cocalc/agents/a.chat",
    thread_id: "agent-thread",
    endpoint: { project_id: "p", agent_id: "a" },
  } as any;
  const sensorRow = { project_id: "p", sensor_id: "s1" } as any;
  let settings: any;
  let review: any;

  beforeEach(() => {
    jest.clearAllMocks();
    // The agent's chat is open in its tab: its actions are the editor's.
    const agentChat = {
      syncdb: { get_state: () => "ready" },
      getThreadMetadata: () => settings,
    };
    review = {
      syncdb: { get_state: () => "ready", save: jest.fn() },
      createEmptyThread: jest.fn(() => "review-thread"),
      setCodexConfig: jest.fn(),
      reserveChatSendIdentity: jest.fn(() => ({ id: "x" })),
      sendChat: jest.fn(() => true),
      save_to_disk: jest.fn(),
    };
    mockRedux.getEditorActions = (_: string, path: string) =>
      path === agent.path ? { getChatActions: () => agentChat } : undefined;
    mockRedux.getProjectActions = () => ({
      fs: () => ({ exists: async () => true }),
      ensureContainingDirectoryExists: jest.fn(),
    });
    mockInitChat.mockReturnValue(review);
  });

  const start = (reviewer?: string) =>
    startSensorReview({
      agent,
      sensor: sensorRow,
      spec,
      hash: "abcdef0123456789",
      account_id: "me",
      reviewer,
    });

  test("uses the open agent chat and its own instance of the review chat", async () => {
    settings = {
      acp_config: { model: "gpt-6-luna", reasoning: "high", sessionId: "s" },
    };
    (readAgentSubscriptionSelection as jest.Mock).mockReturnValue("sub-1");
    await start();
    // Never a second registration of the agent's chat (the old "already
    // exists" error); the review chat is opened under its own key.
    expect(mockInitChat).toHaveBeenCalledTimes(1);
    expect(mockInitChat).toHaveBeenCalledWith(
      "p",
      "/home/user/.local/share/cocalc/sensor-reviews/s1.chat",
      { instanceKey: "sensor-review" },
    );
    const codexConfig = {
      model: "gpt-6-luna",
      reasoning: "high",
      sessionMode: "read-only",
    };
    expect(review.createEmptyThread).toHaveBeenCalledWith({
      name: "Review: New issues (spec abcdef012345)",
      threadAgent: { mode: "codex", model: "gpt-6-luna", codexConfig },
    });
    expect(review.sendChat).toHaveBeenCalledWith(
      expect.objectContaining({ acpConfigOverride: codexConfig }),
    );
  });

  test("a Codex agent's script can be reviewed by Claude", async () => {
    settings = { acp_config: { model: "gpt-6-luna" } };
    mockQualifiedRuntime.mockReturnValue({ kind: "acp", fresh: true });
    mockListCredentials.mockResolvedValue([
      { id: "c1", kind: "claude-subscription-home-v1", revoked: false },
    ]);
    await start("claude:sonnet");
    expect(mockQualifiedRuntime).toHaveBeenCalledWith(
      "claude-code",
      "/home/user",
      { configOptions: [{ id: "model", value: "sonnet" }] },
    );
    expect(review.createEmptyThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadAgent: { mode: "acp", runtime: { kind: "acp", fresh: true } },
      }),
    );
    expect(writeHarnessCredentialSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        threadKey: "review-thread",
        credential: expect.objectContaining({
          mode: "account-subscription",
          credentialId: "c1",
        }),
      }),
    );
  });

  test("a Claude agent's review keeps its harness with another model", async () => {
    settings = { agent_runtime: claudeRuntime };
    const credential = { mode: "account-api-key", credentialId: "k" };
    (readHarnessCredentialSelection as jest.Mock).mockReturnValue(credential);
    await start("claude:haiku");
    const runtime =
      review.createEmptyThread.mock.calls[0][0].threadAgent.runtime;
    expect(runtime.profile).toEqual(claudeRuntime.profile);
    // Fast mode belonged to the agent's model.
    expect(runtime.settings.configOptions).toEqual([
      { id: "effort", value: "high" },
      { id: "model", value: "haiku" },
    ]);
    expect(readHarnessCredentialSelection).toHaveBeenCalledWith(
      expect.objectContaining({ threadKey: "agent-thread" }),
    );
    expect(writeHarnessCredentialSelection).toHaveBeenCalledWith(
      expect.objectContaining({ threadKey: "review-thread", credential }),
    );
  });

  test("a Claude agent's script can be reviewed by Codex", async () => {
    settings = { agent_runtime: claudeRuntime };
    await start("codex:gpt-6-sol");
    expect(review.createEmptyThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadAgent: {
          mode: "codex",
          model: "gpt-6-sol",
          codexConfig: { model: "gpt-6-sol", sessionMode: "read-only" },
        },
      }),
    );
  });
});
