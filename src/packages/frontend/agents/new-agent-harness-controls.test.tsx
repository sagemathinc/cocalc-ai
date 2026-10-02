/** @jest-environment jsdom */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PROJECT_DOCS_OPEN_EVENT } from "@cocalc/frontend/docs/navigation";
import { useState } from "react";
import { fromJS } from "immutable";
import { useProjectSecrets } from "@cocalc/frontend/project/use-project-secrets";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { HarnessSessionSettings } from "@cocalc/util/ai/harness-controls";
import { qualifiedHarnessRuntime } from "@cocalc/frontend/chat/harness-profile";
import {
  NewAgentClaudeControls,
  NewAgentAcpControls,
} from "./new-agent-harness-controls";
import { discoverNewAgentHarness } from "./discover-new-agent-harness";

// rc-util's constant test ID aliases nested modal labels and Escape handlers.
jest.mock("@rc-component/util/lib/hooks/useId", () => ({
  __esModule: true,
  ...jest.requireActual("@rc-component/util/lib/hooks/useId"),
  default: (id?: string) => {
    const generated = require("react").useId();
    return id ?? generated;
  },
}));

jest.mock("./discover-new-agent-harness", () => ({
  discoverNewAgentHarness: jest.fn(),
}));
jest.mock("@cocalc/frontend/project/use-project-secrets", () => ({
  useProjectSecrets: jest.fn(),
}));

const controls = {
  version: 1,
  configOptions: [
    {
      id: "model",
      name: "Model",
      currentValue: "opus",
      recommendedValue: "opus",
      options: [
        { value: "opus", name: "Opus" },
        { value: "sonnet", name: "Sonnet" },
      ],
    },
    {
      id: "effort",
      name: "Effort",
      currentValue: "medium",
      recommendedValue: "medium",
      options: [
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ],
};
const props = {
  accountId: "account-a",
  projectId: "project-a",
  projectHome: "/home/user",
  cwd: "/home/user",
  settings: {},
  onSettings: jest.fn(),
  credential: {
    version: 1,
    provider: "anthropic",
    mode: "project-secret",
  } as const,
  credentials: [],
  credentialsLoaded: true,
  onCredential: jest.fn(),
  onCredentials: jest.fn(),
  onConnected: jest.fn(),
  assertCurrent: jest.fn(),
};
const result = {
  profile: qualifiedHarnessRuntime("claude-code", "/home/user").profile,
  controls,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginCancel",
    )
    .mockResolvedValue(undefined as any);
  jest.mocked(useProjectSecrets).mockReturnValue({
    secrets: [{ name: "ANTHROPIC_API_KEY" } as any],
    refresh: jest.fn(),
    setSecrets: jest.fn(),
  });
  jest.mocked(discoverNewAgentHarness).mockResolvedValue(result as any);
});

test("a revoked inherited credential asks for a connection without launching discovery", async () => {
  render(
    <NewAgentClaudeControls
      {...props}
      credential={{
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId: "00000000-0000-4000-8000-000000000001",
      }}
    />,
  );
  expect(await screen.findByText("Choose a Claude connection")).toBeTruthy();
  expect(discoverNewAgentHarness).not.toHaveBeenCalled();
  const settings = screen.getByRole("button", {
    name: "Configure Claude Code",
  });
  settings.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /previously selected Claude connection is unavailable/,
  );
  expect(
    screen.getByRole("combobox", { name: "Claude credential" }),
  ).toBeTruthy();
  expect(discoverNewAgentHarness).not.toHaveBeenCalled();
});

test("loading is not missing configuration and the composer keeps emails private", async () => {
  const { rerender } = render(
    <NewAgentClaudeControls {...props} credentialsLoaded={false} />,
  );
  expect(screen.getByText("Loading model")).toBeTruthy();
  const settings = screen.getByRole("button", {
    name: "Configure Claude Code",
  });
  expect(settings.textContent).toBe("");
  expect(settings.className).not.toContain("ant-btn-primary");
  expect(discoverNewAgentHarness).not.toHaveBeenCalled();
  const subscription = {
    version: 1,
    provider: "anthropic",
    mode: "account-subscription",
    credentialId: "00000000-0000-4000-8000-000000000001",
  } as const;
  rerender(
    <NewAgentClaudeControls
      {...props}
      credential={subscription}
      credentials={[
        {
          id: subscription.credentialId,
          kind: "claude-subscription-home-v1",
          metadata: {
            plan: "pro",
            cocalc_provider_identity: "subscriber@example.com",
          },
        } as any,
      ]}
    />,
  );
  await screen.findByRole("combobox", { name: "Claude Code Model" });
  expect(screen.getByText("Claude Pro - subscriber")).toBeTruthy();
  expect(document.body.textContent).not.toContain("subscriber@example.com");
  const user = userEvent.setup();
  settings.focus();
  await user.keyboard("{Enter}");
  const connectors = screen.getByRole("checkbox", {
    name: "Use my claude.ai connectors",
  });
  expect((connectors as HTMLInputElement).checked).toBe(true);
  connectors.focus();
  await user.keyboard(" ");
  expect(props.onCredential).toHaveBeenCalledWith({
    ...subscription,
    claudeAiConnectors: false,
  });
});

test("new Claude agent exposes real model/effort controls and keeps both first-turn choices", async () => {
  let selected: HarnessSessionSettings = {};
  function Composer() {
    const [settings, setSettings] = useState<HarnessSessionSettings>({});
    selected = settings;
    return (
      <NewAgentClaudeControls
        {...props}
        settings={settings}
        onSettings={setSettings}
      />
    );
  }
  render(<Composer />);
  const model = await screen.findByRole("combobox", {
    name: "Claude Code Model",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Opus")).toBeTruthy();
  expect(screen.getByText("Medium")).toBeTruthy();
  expect(screen.queryByText(/Default/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Connect Claude Pro/Max" }),
  ).toBeNull();
  expect(screen.queryByText(/Experimental Claude Pro/)).toBeNull();
  const user = userEvent.setup();
  await user.click(model);
  fireEvent.keyDown(model, { key: "ArrowDown", keyCode: 40 });
  fireEvent.keyDown(model, { key: "Enter", keyCode: 13 });
  const effort = screen.getByRole("combobox", { name: "Claude Code Effort" });
  await user.click(effort);
  fireEvent.keyDown(effort, { key: "ArrowDown", keyCode: 40 });
  fireEvent.keyDown(effort, { key: "Enter", keyCode: 13 });
  expect(selected).toEqual({
    configOptions: [
      { id: "model", value: "sonnet" },
      { id: "effort", value: "high" },
    ],
  });
  expect(discoverNewAgentHarness).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("combobox", { name: /Mode$/ })).toBeNull();
});

test("saved default selections display the adapter's concrete recommendations", async () => {
  render(
    <NewAgentClaudeControls
      {...props}
      settings={{
        configOptions: [
          { id: "model", value: "default" },
          { id: "effort", value: "default" },
        ],
      }}
    />,
  );
  await screen.findByRole("combobox", { name: "Claude Code Model" });
  expect(screen.getByText("Opus")).toBeTruthy();
  expect(screen.getByText("Medium")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Default|default/);
});

test("unresolved model defaults keep an honest compact label", async () => {
  jest.mocked(discoverNewAgentHarness).mockResolvedValue({
    ...result,
    controls: {
      configOptions: [
        {
          id: "model",
          name: "Model",
          currentValue: "default",
          options: [{ value: "default", name: "Default (recommended)" }],
        },
      ],
    },
  } as any);
  render(<NewAgentClaudeControls {...props} />);
  await screen.findByRole("combobox", { name: "Claude Code Model" });
  expect(screen.getByText("Default")).toBeTruthy();
  expect(screen.queryByText("Default (recommended)")).toBeNull();
});

test("Claude setup opens from the keyboard, contains connection details, and restores focus", async () => {
  render(<NewAgentClaudeControls {...props} />);
  await screen.findByRole("combobox", { name: "Claude Code Model" });
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Configure Claude Code" });
  trigger.focus();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Configure Claude Code" });
  expect(
    screen.getByRole("combobox", { name: "Claude credential" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Connect Claude Pro/Max" }),
  ).toBeTruthy();
  const opened = jest.fn((event: Event) => event.preventDefault());
  window.addEventListener(PROJECT_DOCS_OPEN_EVENT, opened);
  try {
    const link = screen.getByRole("link", {
      name: "Claude Code setup, security model, and billing",
    });
    await user.click(link);
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      projectId: "project-a",
      slug: "ai/claude-code",
    });
  } finally {
    window.removeEventListener(PROJECT_DOCS_OPEN_EVENT, opened);
  }
  expect(
    screen.getByText("Connection and credential details").closest("details")
      ?.open,
  ).toBe(false);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("Claude does not claim missing configuration before a project is selected", async () => {
  render(<NewAgentClaudeControls {...props} projectId={undefined} />);
  expect(discoverNewAgentHarness).not.toHaveBeenCalled();
  const trigger = screen.getByRole("button", { name: "Configure Claude Code" });
  expect(trigger.className).not.toContain("ant-btn-primary");
  await userEvent.setup().click(trigger);
  expect(screen.getByText(/Select a project before connecting/)).toBeTruthy();
});

test("credential changes discard in-flight discovery without closing configuration", async () => {
  let finish!: (value: any) => void;
  jest.mocked(discoverNewAgentHarness).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { rerender } = render(<NewAgentClaudeControls {...props} />);
  await waitFor(() => expect(discoverNewAgentHarness).toHaveBeenCalledTimes(1));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Configure Claude Code" }));
  rerender(
    <NewAgentClaudeControls
      {...props}
      credential={{
        version: 1,
        provider: "anthropic",
        mode: "account-api-key",
        credentialId: "key-b",
      }}
      credentials={[{ id: "key-b", kind: "anthropic-api-key" } as any]}
    />,
  );
  await act(async () =>
    finish({ ...result, controls: { version: 1, configOptions: [] } }),
  );
  await screen.findByRole("combobox", { name: "Claude Code Model" });
  expect(discoverNewAgentHarness).toHaveBeenCalledTimes(2);
  expect(
    screen.getByRole("dialog", { name: "Configure Claude Code" }),
  ).toBeTruthy();
  expect(
    jest.mocked(discoverNewAgentHarness).mock.calls[1][0].credential,
  ).toMatchObject({ credentialId: "key-b" });
});

test("directory edits discover only the settled profile and tolerate incomplete paths", async () => {
  const { rerender } = render(
    <NewAgentClaudeControls {...props} cwd="relative" />,
  );
  expect(screen.getByText("Choose an absolute working directory")).toBeTruthy();
  expect(discoverNewAgentHarness).not.toHaveBeenCalled();
  rerender(<NewAgentClaudeControls {...props} cwd="/home/user/a" />);
  jest.mocked(discoverNewAgentHarness).mockResolvedValueOnce({
    ...result,
    profile: { ...result.profile, cwd: "/home/user/abc" },
  } as any);
  rerender(<NewAgentClaudeControls {...props} cwd="/home/user/abc" />);
  await screen.findByRole("combobox", { name: "Claude Code Model" });
  expect(discoverNewAgentHarness).toHaveBeenCalledTimes(1);
  expect(
    jest.mocked(discoverNewAgentHarness).mock.calls[0][0].runtime.profile.cwd,
  ).toBe("/home/user/abc");
});

test("custom ACP fields are hidden in a keyboard-accessible configuration dialog", async () => {
  const onCreate = jest.fn();
  const onChange = jest.fn();
  render(
    <NewAgentAcpControls
      draft={{ id: "", revision: "", executable: "", args: "" }}
      onChange={onChange}
      cwd="/home/user"
      onCreate={onCreate}
    />,
  );
  expect(screen.queryByRole("textbox", { name: "Harness name" })).toBeNull();
  const trigger = screen.getByRole("button", { name: "Configure ACP harness" });
  expect(trigger.className).toContain("ant-btn-primary");
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Configure ACP harness" });
  await user.type(screen.getByRole("textbox", { name: "Harness name" }), "x");
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "x" }));
  await user.click(
    screen.getByRole("button", { name: "Create and configure first" }),
  );
  expect(onCreate).toHaveBeenCalledTimes(1);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("first-use Claude offers connection instead of runtime errors or project-secret payment", async () => {
  jest.mocked(useProjectSecrets).mockReturnValue({
    secrets: [],
    refresh: jest.fn(),
    setSecrets: jest.fn(),
  });
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockResolvedValue({
      id: "first-login",
      state: "pending",
      verificationUrl: "https://claude.com/oauth/authorize",
    } as any);
  try {
    render(<NewAgentClaudeControls {...props} />);
    const user = userEvent.setup();
    const button = screen.getByRole("button", {
      name: "Connect Claude Pro/Max",
    });
    expect(screen.queryByText(/Model unavailable|Project secret/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(discoverNewAgentHarness).not.toHaveBeenCalled();
    await user.click(button);
    expect(
      screen.getByRole("dialog", { name: "Connect Claude Pro/Max" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Claude sign-in" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("combobox", { name: "Claude credential" }),
    ).toBeNull();
    expect(
      screen.queryByText(/Experimental preview|Runtime details/),
    ).toBeNull();
    expect(discoverNewAgentHarness).not.toHaveBeenCalled();
  } finally {
    start.mockRestore();
  }
});

test.each([
  null,
  [{ name: "ANTHROPIC_API_KEY" }],
  fromJS([{ name: "ANTHROPIC_API_KEY" }]),
])(
  "unknown or configured project-key metadata retains discovery and real errors (%s)",
  async (secrets) => {
    jest.mocked(useProjectSecrets).mockReturnValue({
      secrets: secrets as any,
      refresh: jest.fn(),
      setSecrets: jest.fn(),
    });
    jest
      .mocked(discoverNewAgentHarness)
      .mockRejectedValue(Error("Runtime unavailable"));
    render(<NewAgentClaudeControls {...props} />);
    expect(
      await screen.findByRole("button", { name: "Model unavailable - retry" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveTextContent("Runtime unavailable");
    expect(
      screen.queryByRole("button", { name: "Connect Claude Pro/Max" }),
    ).toBeNull();
  },
);

test("selecting the newly connected subscription replaces onboarding with model discovery", async () => {
  jest.mocked(useProjectSecrets).mockReturnValue({
    secrets: [],
    refresh: jest.fn(),
    setSecrets: jest.fn(),
  });
  const { rerender } = render(<NewAgentClaudeControls {...props} />);
  expect(
    screen.getByRole("button", { name: "Connect Claude Pro/Max" }),
  ).toBeTruthy();
  rerender(
    <NewAgentClaudeControls
      {...props}
      credential={{
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId: "new-connection",
      }}
      credentials={[
        { id: "new-connection", kind: "claude-subscription-home-v1" } as any,
      ]}
    />,
  );
  expect(
    await screen.findByRole("combobox", { name: "Claude Code Model" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Connect Claude Pro/Max" }),
  ).toBeNull();
  expect(discoverNewAgentHarness).toHaveBeenCalledWith(
    expect.objectContaining({
      credential: expect.objectContaining({ credentialId: "new-connection" }),
    }),
  );
});

test("first-use setup retains project API-key entry and account API-key selection", async () => {
  jest.mocked(useProjectSecrets).mockReturnValue({
    secrets: [],
    refresh: jest.fn(),
    setSecrets: jest.fn(),
  });
  render(
    <NewAgentClaudeControls
      {...props}
      credentials={[
        {
          id: "key-a",
          kind: "anthropic-api-key",
          metadata: { label: "My API key" },
        } as any,
      ]}
    />,
  );
  const user = userEvent.setup();
  expect(
    screen.getByRole("button", { name: "Connect Claude Pro/Max" }),
  ).toBeEnabled();
  await user.click(
    screen.getByRole("button", { name: "Configure Claude Code" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Configure Claude Code" });
  const credentialSelect = within(dialog).getByRole("combobox", {
    name: "Claude credential",
  });
  await user.click(credentialSelect);
  expect(screen.getByRole("option", { name: /My API key/ })).toBeTruthy();
  await user.click(within(dialog).getByText("Payment method"));
  await user.click(
    within(dialog).getByRole("button", {
      name: "Set ANTHROPIC_API_KEY project secret",
    }),
  );
  const keyDialog = screen.getByRole("dialog", {
    name: "Claude Code project API key",
  });
  expect(within(keyDialog).getByLabelText("ANTHROPIC_API_KEY")).toBeEnabled();
  expect(
    within(keyDialog).getByRole("button", { name: "Save key" }),
  ).toBeDisabled();
});

test("adding a project API key resumes discovery without changing the selected credential", async () => {
  const metadata = {
    secrets: [] as any[],
    refresh: jest.fn(),
    setSecrets: jest.fn(),
  };
  jest.mocked(useProjectSecrets).mockReturnValue(metadata);
  const { rerender } = render(<NewAgentClaudeControls {...props} />);
  expect(
    screen.getByRole("button", { name: "Connect Claude Pro/Max" }),
  ).toBeEnabled();
  metadata.secrets = [{ name: "ANTHROPIC_API_KEY" }];
  rerender(<NewAgentClaudeControls {...props} />);
  await screen.findByRole("combobox", { name: "Claude Code Model" });
  expect(props.onCredential).not.toHaveBeenCalled();
  expect(discoverNewAgentHarness).toHaveBeenCalledWith(
    expect.objectContaining({ credential: props.credential }),
  );
});

test("successful first-use sign-in closes its modal and focuses the surviving settings control", async () => {
  jest.useFakeTimers();
  jest.mocked(useProjectSecrets).mockReturnValue({
    secrets: [],
    refresh: jest.fn(),
    setSecrets: jest.fn(),
  });
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockResolvedValue({
      id: "focus-login",
      state: "pending",
      verificationUrl: "https://claude.com/oauth/authorize",
    } as any);
  const status = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStatus",
    )
    .mockResolvedValue({
      id: "focus-login",
      state: "completed",
      credentialId: "subscription-a",
    } as any);
  function Composer() {
    const [credentialId, setCredentialId] = useState("");
    return (
      <NewAgentClaudeControls
        {...props}
        credential={
          credentialId
            ? {
                version: 1,
                provider: "anthropic",
                mode: "account-subscription",
                credentialId,
              }
            : props.credential
        }
        credentials={
          credentialId
            ? [{ id: credentialId, kind: "claude-subscription-home-v1" } as any]
            : []
        }
        onConnected={async (id) => {
          setCredentialId(id);
        }}
      />
    );
  }
  try {
    render(<Composer />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.click(
      screen.getByRole("button", { name: "Connect Claude Pro/Max" }),
    );
    screen.getByRole("textbox", { name: "Claude sign-in code" }).focus();
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Configure Claude Code" }),
    ).toHaveFocus();
    expect(
      webapp_client.conat_client.hub.projects.claudeSubscriptionLoginCancel,
    ).not.toHaveBeenCalled();
  } finally {
    start.mockRestore();
    status.mockRestore();
    jest.useRealTimers();
  }
});

test("a delayed sign-in callback does not steal focus after switching projects", async () => {
  jest.useFakeTimers();
  jest.mocked(useProjectSecrets).mockReturnValue({
    secrets: [],
    refresh: jest.fn(),
    setSecrets: jest.fn(),
  });
  const start = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStart",
    )
    .mockResolvedValue({
      id: "old-project-login",
      state: "pending",
      verificationUrl: "https://claude.com/oauth/authorize",
    } as any);
  const status = jest
    .spyOn(
      webapp_client.conat_client.hub.projects,
      "claudeSubscriptionLoginStatus",
    )
    .mockResolvedValue({
      id: "old-project-login",
      state: "completed",
      credentialId: "subscription-a",
    } as any);
  let finish!: () => void;
  const onConnected = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const { rerender } = render(
      <NewAgentClaudeControls {...props} onConnected={onConnected} />,
    );
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.click(
      screen.getByRole("button", { name: "Connect Claude Pro/Max" }),
    );
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(onConnected).toHaveBeenCalledWith("subscription-a");
    rerender(
      <NewAgentClaudeControls
        {...props}
        projectId="project-b"
        onConnected={onConnected}
      />,
    );
    const newTrigger = screen.getByRole("button", {
      name: "Connect Claude Pro/Max",
    });
    newTrigger.focus();
    await act(async () => finish());
    expect(newTrigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    start.mockRestore();
    status.mockRestore();
    jest.useRealTimers();
  }
});

test("a selected subscription can be named, disconnected or reconnected from the new-agent dialog", async () => {
  const id = "00000000-0000-4000-8000-000000000009";
  const revoke = jest
    .spyOn(webapp_client.conat_client.hub.system, "revokeExternalCredential")
    .mockResolvedValue({ revoked: true } as any);
  const onCredential = jest.fn();
  const onCredentials = jest.fn();
  render(
    <NewAgentClaudeControls
      {...props}
      credential={{
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId: id,
      }}
      credentials={[
        {
          id,
          kind: "claude-subscription-home-v1",
          revoked: null,
          metadata: {
            authentication: "claude-oauth-token",
            expires_at: "2027-10-02T00:00:00.000Z",
          },
        } as any,
      ]}
      onCredential={onCredential}
      onCredentials={onCredentials}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Configure Claude Code" }),
  );
  await screen.findByRole("dialog", { name: "Configure Claude Code" });
  expect(screen.getByRole("button", { name: /Name$/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Reconnect$/ })).toBeTruthy();
  expect(screen.getByText(/Long-lived token, expires/)).toBeTruthy();
  // A long-lived token cannot load claude.ai connectors.
  expect(screen.queryByText("Use my claude.ai connectors")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  // The confirmation's own Disconnect button.
  const confirm = await screen.findAllByRole("button", { name: "Disconnect" });
  await user.click(confirm[confirm.length - 1]);
  await waitFor(() =>
    expect(onCredential).toHaveBeenCalledWith({
      version: 1,
      provider: "anthropic",
      mode: "project-secret",
    }),
  );
  expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ id }));
  const update = onCredentials.mock.calls[0][0];
  expect(update([{ id }, { id: "other" }])).toEqual([{ id: "other" }]);
  revoke.mockRestore();
});
