import React from "react";
const { act, create } = require("react-test-renderer");
import { HarnessSettings } from "./harness-settings";
import { agentName } from "./agent-name";
import { getActiveSiteSession } from "../cocalc/session-registry";
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: jest.fn(),
}));
jest.mock("../preview/fixtures", () => ({ isPreviewProfile: () => false }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: any;
const find = (label: string) =>
  renderer.root.findAll(
    (n: any) => n.type === "Pressable" && n.props.accessibilityLabel === label,
  )[0];
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

const runtime = {
  version: 1,
  kind: "acp",
  profile: {
    version: 2,
    kind: "acp",
    id: "claude-code",
    revision: "0.93.0",
    cwd: "/home/user",
    executionPolicy: "full-access",
    credentialMode: "project-managed",
  },
  settings: { configOptions: [{ id: "model", value: "sonnet" }] },
} as any;
const controls = {
  configOptions: [
    {
      id: "model",
      name: "Model",
      currentValue: "default",
      options: [
        { value: "sonnet", name: "Sonnet" },
        { value: "opus", name: "Opus" },
      ],
    },
    {
      id: "effort",
      name: "Effort",
      currentValue: "medium",
      options: [
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ],
};

function session(setPaymentSelections = jest.fn()) {
  jest.mocked(getActiveSiteSession).mockResolvedValue({
    hubApi: {
      system: {
        listExternalCredentials: async () => [
          {
            id: "sub-1",
            kind: "claude-subscription-home-v1",
            metadata: { label: "Max plan" },
          },
          {
            id: "old",
            kind: "claude-subscription-home-v1",
            revoked: "2026-10-01",
          },
          { id: "key-1", kind: "anthropic-api-key", metadata: {} },
        ],
      },
      agent: {
        getPaymentSelections: async () => ({
          selections: [
            {
              project_id: "project",
              thread_id: "t",
              provider: "claude-code",
              selection: {
                version: 1,
                provider: "claude-code",
                mode: "account-subscription",
                credential_id: "sub-1",
              },
            },
          ],
          defaults: {},
        }),
        setPaymentSelections,
      },
    },
  } as any);
  return setPaymentSelections;
}

it("names Claude agents and keeps Codex as the default", () => {
  expect(agentName({ agent_runtime: runtime })).toBe("Claude");
  expect(agentName({})).toBe("Codex");
});

it("shows Claude's reported choices and the stored subscription, and saves only what changed", async () => {
  const setPaymentSelections = session();
  const updateHarnessSettings = jest.fn().mockResolvedValue(undefined);
  const close = jest.fn();
  await act(async () => {
    renderer = create(
      <HarnessSettings
        profile="p"
        project="project"
        thread="t"
        runtime={runtime}
        controls={controls}
        client={{ updateHarnessSettings }}
        onClose={close}
      />,
    );
  });
  // Saved choice wins over the reported current value; others use it.
  expect(find("Sonnet").props.accessibilityState.selected).toBe(true);
  expect(find("Medium").props.accessibilityState.selected).toBe(true);
  expect(
    find("Claude subscription: Max plan").props.accessibilityState.selected,
  ).toBe(true);
  // A revoked credential is not offered.
  expect(find("Anthropic API key")).toBeDefined();
  expect(
    renderer.root.findAll(
      (n: any) =>
        n.type === "Pressable" &&
        `${n.props.accessibilityLabel}`.startsWith("Claude subscription"),
    ),
  ).toHaveLength(1);

  await act(async () => find("Opus").props.onPress());
  await act(async () => find("High").props.onPress());
  await act(async () => find("Save agent settings").props.onPress());
  expect(updateHarnessSettings).toHaveBeenCalledWith({
    thread_id: "t",
    settings: {
      configOptions: [
        { id: "model", value: "opus" },
        { id: "effort", value: "high" },
      ],
    },
  });
  expect(setPaymentSelections).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});

it("saves a changed payment choice as the agent's claude-code selection", async () => {
  const setPaymentSelections = session();
  const updateHarnessSettings = jest.fn();
  await act(async () => {
    renderer = create(
      <HarnessSettings
        profile="p"
        project="project"
        thread="t"
        runtime={runtime}
        controls={controls}
        client={{ updateHarnessSettings }}
        onClose={() => {}}
      />,
    );
  });
  await act(async () => find("Anthropic API key").props.onPress());
  await act(async () => find("Save agent settings").props.onPress());
  expect(setPaymentSelections).toHaveBeenLastCalledWith({
    targets: [{ project_id: "project", thread_id: "t" }],
    provider: "claude-code",
    selection: {
      version: 1,
      provider: "claude-code",
      mode: "account-api-key",
      credential_id: "key-1",
    },
  });
  expect(updateHarnessSettings).not.toHaveBeenCalled();

  await act(async () =>
    find("Account default for Claude agents").props.onPress(),
  );
  await act(async () => find("Save agent settings").props.onPress());
  expect(setPaymentSelections).toHaveBeenLastCalledWith({
    targets: [{ project_id: "project", thread_id: "t" }],
    provider: "claude-code",
    selection: null,
  });
});

it("explains where the choices come from before Claude has run", async () => {
  session();
  await act(async () => {
    renderer = create(
      <HarnessSettings
        profile="p"
        project="project"
        thread="t"
        runtime={runtime}
        client={{ updateHarnessSettings: jest.fn() }}
        onClose={() => {}}
      />,
    );
  });
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("reports its models");
});

it("describes payment as admission resolves it, including the project-secret fallback", () => {
  const { describeClaudePayment } = require("./claude-payment");
  const credentials = [
    { id: "sub-1", kind: "claude-subscription-home-v1", label: "Max plan" },
  ];
  expect(describeClaudePayment({ credentials })).toBe(
    "Project ANTHROPIC_API_KEY",
  );
  expect(
    describeClaudePayment({
      credentials,
      selection: { version: 1, provider: "claude-code", mode: "default" },
      fallback: {
        version: 1,
        provider: "claude-code",
        mode: "account-subscription",
        credential_id: "sub-1",
      },
    }),
  ).toBe("Claude subscription: Max plan");
  expect(
    describeClaudePayment({
      credentials,
      selection: {
        version: 1,
        provider: "claude-code",
        mode: "account-api-key",
        credential_id: "gone",
      },
    }),
  ).toBe("Disconnected credential");
});

it("keeps a stored connectors preference when the same subscription is chosen again", async () => {
  const setPaymentSelections = session();
  const get = jest.fn(async () => ({
    selections: [
      {
        project_id: "project",
        thread_id: "t",
        provider: "claude-code",
        selection: {
          version: 1,
          provider: "claude-code",
          mode: "account-subscription",
          credential_id: "sub-1",
          claude_ai_connectors: false,
        },
      },
    ],
    defaults: {},
  }));
  const current = await (getActiveSiteSession as jest.Mock)();
  current.hubApi.agent.getPaymentSelections = get;
  jest.mocked(getActiveSiteSession).mockResolvedValue(current);
  await act(async () => {
    renderer = create(
      <HarnessSettings
        profile="p"
        project="project"
        thread="t"
        runtime={runtime}
        controls={controls}
        client={{ updateHarnessSettings: jest.fn() }}
        onClose={() => {}}
      />,
    );
  });
  // Switch away and back, then save.
  await act(async () => find("Anthropic API key").props.onPress());
  await act(async () => find("Claude subscription: Max plan").props.onPress());
  await act(async () => find("Save agent settings").props.onPress());
  expect(setPaymentSelections).not.toHaveBeenCalled();
});
