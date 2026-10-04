/** @jest-environment jsdom */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PROJECT_DOCS_OPEN_EVENT } from "@cocalc/frontend/docs/navigation";
import { useState } from "react";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { harnessSessionControls } from "@cocalc/util/ai/harness-controls";
import {
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "../harness-credential-selection";
import {
  claudeCredentialTrustWarning,
  HarnessProfileFields,
  HarnessRuntimeSummary,
  HarnessRuntimeControl,
  harnessRuntimeFromDraft,
  qualifiedHarnessRuntime,
} from "../harness-profile";

const draft = {
  id: "Pi",
  revision: "0.86.1",
  executable: "/home/user/bin/pi-acp",
  args: "--flag\nvalue with spaces",
};

const accountStore = {
  get: () => "account-a",
  getIn: () => "account-a",
  on: jest.fn(),
  removeListener: jest.fn(),
};

jest.mock("../claude-subscription-connect", () => ({
  ClaudeSubscriptionConnect: ({
    onConnected,
    leadingActions,
    trailingActions,
  }) => (
    <>
      {leadingActions}
      {trailingActions}
      <button
        onClick={() => onConnected("00000000-0000-4000-8000-000000000002")}
      >
        Complete subscription sign-in
      </button>
    </>
  ),
}));

test("reconnecting selects the returned subscription and updates new-agent defaults", async () => {
  const getStore = jest
    .spyOn(redux, "getStore")
    .mockReturnValue(accountStore as any);
  const list = jest
    .spyOn(webapp_client.conat_client.hub.system, "listExternalCredentials")
    .mockResolvedValue([]);
  writeHarnessCredentialSelection({
    accountId: "account-a",
    projectId: "project-a",
    threadKey: "thread-a",
    credential: {
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId: "00000000-0000-4000-8000-000000000001",
      claudeAiConnectors: false,
    },
  });
  try {
    render(
      <HarnessRuntimeSummary
        runtime={qualifiedHarnessRuntime("claude-code", "/home/user")}
        projectId="project-a"
        threadKey="thread-a"
      />,
    );
    await screen.findByRole("alert");
    const button = screen.getByRole("button", {
      name: "Complete subscription sign-in",
    });
    button.focus();
    await userEvent.setup().keyboard("{Enter}");
    const expected = {
      mode: "account-subscription",
      credentialId: "00000000-0000-4000-8000-000000000002",
      claudeAiConnectors: false,
    };
    expect(
      readHarnessCredentialSelection({
        accountId: "account-a",
        projectId: "project-a",
        threadKey: "thread-a",
      }),
    ).toMatchObject(expected);
    expect(
      readHarnessCredentialSelection({
        accountId: "account-a",
        forNewAgent: true,
      }),
    ).toMatchObject(expected);
    expect(document.activeElement).toBe(button);
  } finally {
    list.mockRestore();
    getStore.mockRestore();
    localStorage.clear();
  }
});

test("qualified Claude profiles contain only trusted catalog identity", () => {
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  expect(runtime.profile).toEqual({
    version: 2,
    kind: "acp",
    id: "claude-code",
    revision: "0.85.1",
    cwd: "/home/user",
    executionPolicy: "full-access",
    credentialMode: "project-managed",
  });
  expect(runtime.profile).not.toHaveProperty("executable");
});

test("qualified runtime preserves first-turn model and effort separately from its profile", () => {
  const settings = {
    configOptions: [
      { id: "model", value: "sonnet" },
      { id: "effort", value: "high" },
    ],
  };
  const runtime = qualifiedHarnessRuntime(
    "claude-code",
    "/home/user",
    settings,
  );
  expect(runtime.settings).toEqual(settings);
  expect(runtime.profile).toEqual(
    qualifiedHarnessRuntime("claude-code", "/home/user").profile,
  );
  expect(runtime).not.toHaveProperty("harness_credential");
});

test("Claude project-key warning is shown only in its focused dialog", async () => {
  render(
    <HarnessRuntimeSummary
      runtime={qualifiedHarnessRuntime("claude-code", "/home/user")}
      projectId="project-a"
      threadKey="thread-a"
    />,
  );
  expect(
    screen.queryByText(/project secret can be read, copied, or used/),
  ).toBeNull();
  expect(claudeCredentialTrustWarning("account-api-key")).toMatch(
    /does not expose the account-stored key value.*reading or copying/,
  );
  expect(claudeCredentialTrustWarning("account-api-key")).toMatch(
    /project code can use the key through Claude's active relay/,
  );
  expect(
    screen.getByRole("combobox", { name: "Claude credential" }),
  ).toBeTruthy();
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Manage project secret" }),
  );
  expect(await screen.findByText("Claude Code project API key")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(
    screen.getByText(/project secret can be read, copied, or used/),
  ).toBeTruthy();
  expect(screen.getByLabelText("ANTHROPIC_API_KEY")).toBeTruthy();
});

test("Claude account-key selection links to the shared security model by keyboard", async () => {
  const getStore = jest
    .spyOn(redux, "getStore")
    .mockReturnValue(accountStore as any);
  localStorage.setItem(
    "cocalc:acp-harness-credential:v1:account-a:project-a:thread-a",
    "account-api-key:00000000-0000-4000-8000-000000000001",
  );
  try {
    render(
      <HarnessRuntimeSummary
        runtime={qualifiedHarnessRuntime("claude-code", "/home/user")}
        projectId="project-a"
        threadKey="thread-a"
      />,
    );
    const link = screen.getByRole("link", {
      name: "Claude Code preview: setup, security model, and billing",
    });
    expect(link.getAttribute("href")).toMatch(/\/docs\/ai\/claude-code$/);
    link.focus();
    expect(document.activeElement).toBe(link);
    const opened = jest.fn((event: Event) => event.preventDefault());
    window.addEventListener(PROJECT_DOCS_OPEN_EVENT, opened);
    try {
      await userEvent.setup().keyboard("{Enter}");
      expect(opened).toHaveBeenCalledTimes(1);
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
        projectId: "project-a",
        slug: "ai/claude-code",
      });
      expect(link.getAttribute("target")).toBeNull();
    } finally {
      window.removeEventListener(PROJECT_DOCS_OPEN_EVENT, opened);
    }
    await userEvent.setup().tab({ shift: true });
    await userEvent.setup().tab();
    expect(document.activeElement).toBe(link);
  } finally {
    getStore.mockRestore();
    localStorage.clear();
  }
});

test("Claude subscription selection exposes an explicit disconnect action", () => {
  const getStore = jest
    .spyOn(redux, "getStore")
    .mockReturnValue(accountStore as any);
  localStorage.setItem(
    "cocalc:acp-harness-credential:v1:account-a:project-a:thread-a",
    "account-subscription:00000000-0000-4000-8000-000000000001",
  );
  try {
    render(
      <HarnessRuntimeSummary
        runtime={qualifiedHarnessRuntime("claude-code", "/home/user")}
        projectId="project-a"
        threadKey="thread-a"
      />,
    );
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(
      screen.getByRole("link", {
        name: /Claude Code preview: setup, security model, and billing/,
      }),
    ).toBeTruthy();
  } finally {
    getStore.mockRestore();
    localStorage.clear();
  }
});

test("Claude subscription shows the verified billing account and plan", async () => {
  const getStore = jest
    .spyOn(redux, "getStore")
    .mockReturnValue(accountStore as any);
  const list = jest
    .spyOn(webapp_client.conat_client.hub.system, "listExternalCredentials")
    .mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "claude-subscription-home-v1",
        revoked: null,
        metadata: {
          plan: "max",
          cocalc_provider_identity: "subscriber@example.com",
        },
      },
    ] as any);
  localStorage.setItem(
    "cocalc:acp-harness-credential:v1:account-a:project-a:thread-a",
    "account-subscription:00000000-0000-4000-8000-000000000001",
  );
  try {
    render(
      <HarnessRuntimeSummary
        runtime={qualifiedHarnessRuntime("claude-code", "/home/user")}
        projectId="project-a"
        threadKey="thread-a"
      />,
    );
    expect(
      await screen.findByText("Claude Max - subscriber@example.com"),
    ).toBeTruthy();
  } finally {
    list.mockRestore();
    getStore.mockRestore();
    localStorage.clear();
  }
});

test("existing harness settings explain limitations before capability discovery", async () => {
  render(
    <HarnessRuntimeControl
      compact
      runtime={harnessRuntimeFromDraft(draft, "/home/user")}
    />,
  );
  const user = userEvent.setup();
  await user.tab();
  const trigger = screen.getByRole("button", { name: "ACP: Pi settings" });
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "ACP harness settings" });
  expect(
    screen.getByText(
      /Text and image prompts\. Live guidance works when the harness advertises it/,
    ),
  ).toBeTruthy();
  expect(screen.getByText(/Automations are not supported yet/)).toBeTruthy();
  expect(
    screen.getByText(/CoCalc does not pause for per-tool approval/),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("advertised model selector supports keyboard selection for future submissions", async () => {
  const runtime = harnessRuntimeFromDraft(draft, "/home/user");
  const longModelName =
    "customer/private-model-with-a-very-long-unbroken-version-and-configuration-name-2026";
  const onSettings = jest.fn();
  const reported = {
    profile: runtime.profile,
    controls: harnessSessionControls({
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "fast",
          options: [
            { value: "fast", name: longModelName },
            { value: "deep", name: "Deep" },
          ],
        },
      ],
    }),
  };
  const { rerender } = render(
    <HarnessRuntimeSummary
      runtime={runtime}
      reported={reported}
      onSettings={onSettings}
    />,
  );
  const user = userEvent.setup();
  const selector = screen.getByRole("combobox", { name: "Model" });
  await user.click(selector);
  expect(
    await screen.findByRole("option", { name: longModelName }),
  ).toBeTruthy();
  await screen.findByRole("option", { name: "Deep" });
  // rc-select reads legacy keyCode, which user-event/jsdom leaves at zero.
  fireEvent.keyDown(selector, { key: "ArrowDown", keyCode: 40 });
  fireEvent.keyDown(selector, { key: "Enter", keyCode: 13 });
  expect(onSettings).toHaveBeenCalledWith({
    configOptions: [{ id: "model", value: "deep" }],
  });
  expect(screen.getByText(/next submitted turn/)).toBeTruthy();
  rerender(
    <HarnessRuntimeSummary
      runtime={runtime}
      reported={{
        ...reported,
        profile: { ...runtime.profile, revision: "different" },
      }}
      onSettings={onSettings}
    />,
  );
  expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
});

test("profile fields have visible labels and support keyboard editing", async () => {
  function Form() {
    const [value, setValue] = useState(draft);
    return <HarnessProfileFields value={value} onChange={setValue} />;
  }
  render(<Form />);
  expect(
    screen.getByText(/Live guidance works when the harness advertises it/),
  ).toBeTruthy();
  expect(screen.getByText(/otherwise messages queue/)).toBeTruthy();
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Harness name" }),
  );
  await user.keyboard("{End} test");
  expect(
    (screen.getByRole("textbox", { name: "Harness name" }) as HTMLInputElement)
      .value,
  ).toBe("Pi test");
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Installed version / revision" }),
  );
  expect(
    screen.getByRole("textbox", { name: "Executable (absolute project path)" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("textbox", {
      name: "Arguments (one per line, no shell quoting)",
    }),
  ).toBeTruthy();
});

test("discovery is explicit, keyboard accessible and does not select a model", async () => {
  const runtime = harnessRuntimeFromDraft(draft, "/home/user");
  const onSettings = jest.fn();
  const onDiscover = jest.fn(async () => ({
    profile: runtime.profile,
    controls: {
      configOptions: [
        {
          id: "model",
          name: "Model",
          currentValue: "local",
          options: [{ value: "local", name: "Local" }],
        },
      ],
    },
  }));
  const { rerender } = render(
    <HarnessRuntimeSummary
      runtime={runtime}
      onSettings={onSettings}
      onDiscover={onDiscover}
    />,
  );
  expect(onDiscover).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.tab();
  const button = screen.getByRole("button", {
    name: "Load model and mode options",
  });
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("combobox", { name: "Model" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("");
  expect(onSettings).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button);
  rerender(
    <HarnessRuntimeSummary
      runtime={{
        ...runtime,
        settings: { configOptions: [{ id: "model", value: "local" }] },
      }}
      onSettings={onSettings}
      onDiscover={onDiscover}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("");
  expect(document.activeElement).toBe(button);
});

const claudeControls = {
  configOptions: [
    {
      id: "mode",
      name: "Mode",
      currentValue: "manual",
      options: [{ value: "manual", name: "Manual" }],
    },
    {
      id: "model",
      name: "Model",
      currentValue: "opus",
      options: [
        { value: "opus", name: "Opus 5.5" },
        { value: "sonnet", name: "Sonnet" },
      ],
    },
    {
      id: "effort",
      name: "Effort",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "high", name: "High" },
      ],
    },
    {
      id: "fast",
      name: "Fast mode",
      currentValue: "off",
      options: [
        { value: "off", name: "Off" },
        { value: "on", name: "On" },
      ],
    },
  ],
};

test("Claude speed uses compact Standard/Fast buttons and keeps refresh beside models", async () => {
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  const change = jest.fn();
  render(
    <HarnessRuntimeSummary
      runtime={runtime}
      reported={{ profile: runtime.profile, controls: claudeControls }}
      onSettings={change}
      onDiscover={jest.fn(async () => ({
        profile: runtime.profile,
        controls: claudeControls,
      }))}
    />,
  );
  const standard = screen.getByRole("radio", { name: "Standard" });
  const fast = screen.getByRole("radio", { name: "Fast" });
  expect(standard).toBeChecked();
  fast.focus();
  await userEvent.setup().keyboard(" ");
  expect(change).toHaveBeenCalledWith(
    expect.objectContaining({
      configOptions: expect.arrayContaining([{ id: "fast", value: "on" }]),
    }),
  );
  expect(screen.queryByRole("combobox", { name: "Fast mode" })).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  expect(screen.queryByText("Harness options loaded")).toBeNull();
  expect(screen.queryByText("Credentials")).toBeNull();
  expect(screen.queryByText("Launch policy")).toBeNull();
  expect(
    screen.getByText("Claude integration version (ACP adapter)"),
  ).toBeTruthy();
});

test("an unavailable saved model remains explicit and can be replaced from the discovered catalog", async () => {
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  const onSettings = jest.fn();
  const onDiscover = jest.fn(async () => ({
    profile: runtime.profile,
    controls: claudeControls,
  }));
  function Composer() {
    const [settings, setSettings] = useState({
      configOptions: [{ id: "model", value: "claude-opus-4-1" }],
    });
    return (
      <HarnessRuntimeControl
        compact
        runtime={{ ...runtime, settings }}
        onDiscover={onDiscover}
        onSettings={(next) => {
          onSettings(next);
          setSettings(next as typeof settings);
        }}
      />
    );
  }
  render(<Composer />);
  const model = await screen.findByRole("combobox", {
    name: "Claude Code Model",
  });
  expect(screen.getByText("claude-opus-4-1 (unavailable)")).toBeTruthy();
  expect(model.getAttribute("aria-invalid")).toBe("true");
  expect(onSettings).not.toHaveBeenCalled();
  model.focus();
  fireEvent.keyDown(model, { key: "ArrowDown", keyCode: 40 });
  await screen.findByRole("option", { name: "Opus 5.5" });
  fireEvent.keyDown(model, { key: "ArrowDown", keyCode: 40 });
  fireEvent.keyDown(model, { key: "Enter", keyCode: 13 });
  await waitFor(() =>
    expect(onSettings).toHaveBeenCalledWith({
      configOptions: [{ id: "model", value: "opus" }],
    }),
  );
  await waitFor(() =>
    expect(model.getAttribute("aria-expanded")).toBe("false"),
  );
  expect(model.parentElement?.textContent).toBe("Opus 5.5");
  expect(model.getAttribute("aria-invalid")).not.toBe("true");
  expect(document.activeElement).toBe(model);
});

test("discovery errors remove nested Error prefixes and leave retry available", async () => {
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  const onDiscover = jest
    .fn()
    .mockRejectedValueOnce(Error("Error: Error: Connection unavailable"))
    .mockResolvedValueOnce({
      profile: runtime.profile,
      controls: claudeControls,
    });
  render(
    <HarnessRuntimeControl
      compact
      runtime={runtime}
      onDiscover={onDiscover}
      onSettings={jest.fn()}
    />,
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Connection unavailable",
  );
  const retry = await screen.findByRole("button", {
    name: "Model unavailable - retry",
  });
  retry.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(
    await screen.findByRole("combobox", { name: "Claude Code Model" }),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test.each([false, true])(
  "live controls supersede discovery errors, including late rejections (%s)",
  async (late) => {
    const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
    let reject!: (error: Error) => void;
    const onDiscover = jest.fn(
      () => new Promise<never>((_resolve, fail) => (reject = fail)),
    );
    const props = { compact: true, runtime, onDiscover, onSettings: jest.fn() };
    const { rerender } = render(<HarnessRuntimeControl {...props} />);
    await waitFor(() => expect(onDiscover).toHaveBeenCalledTimes(1));
    const fail = async () => {
      await act(async () => {
        reject(Error("ACP discovery is busy; try again after it finishes"));
      });
    };
    if (!late) {
      await fail();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "ACP discovery is busy",
      );
      rerender(
        <HarnessRuntimeControl
          {...props}
          reported={{
            profile: { ...runtime.profile, revision: "old" },
            controls: claudeControls,
          }}
        />,
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "ACP discovery is busy",
      );
    }
    rerender(
      <HarnessRuntimeControl
        {...props}
        reported={{ profile: runtime.profile, controls: claudeControls }}
      />,
    );
    if (late) await fail();
    expect(
      await screen.findByRole("combobox", { name: "Claude Code Model" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onDiscover).toHaveBeenCalledTimes(1);
    const model = screen.getByRole("combobox", { name: "Claude Code Model" });
    model.focus();
    expect(document.activeElement).toBe(model);
  },
);

test("failed refresh of current controls remains visible", async () => {
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  render(
    <HarnessRuntimeControl
      runtime={runtime}
      reported={{ profile: runtime.profile, controls: claudeControls }}
      onDiscover={jest.fn().mockRejectedValue(Error("Discovery unavailable"))}
      onSettings={jest.fn()}
    />,
  );
  screen.getByRole("button", { name: "Refresh" }).focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Discovery unavailable",
  );
});

test("Claude composer automatically discovers model and effort without selecting a default", async () => {
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  const onDiscover = jest.fn(async () => ({
    profile: runtime.profile,
    controls: claudeControls,
  }));
  const onSettings = jest.fn();
  const { rerender } = render(
    <HarnessRuntimeControl
      compact
      runtime={runtime}
      onDiscover={onDiscover}
      onSettings={onSettings}
    />,
  );
  expect(
    await screen.findByRole("combobox", { name: "Claude Code Model" }),
  ).toBeTruthy();
  expect(screen.getByText("Opus 5.5")).toBeTruthy();
  expect(
    screen.getByRole("combobox", { name: "Claude Code Effort" }),
  ).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: /Mode$/ })).toBeNull();
  expect(screen.queryByText("Fast on")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onDiscover).toHaveBeenCalledTimes(1);
  expect(onSettings).not.toHaveBeenCalled();
  rerender(
    <HarnessRuntimeControl
      compact
      runtime={runtime}
      onDiscover={onDiscover}
      onSettings={onSettings}
    />,
  );
  expect(onDiscover).toHaveBeenCalledTimes(1);
  const user = userEvent.setup();
  const model = screen.getByRole("combobox", { name: "Claude Code Model" });
  await user.click(model);
  await screen.findByRole("option", { name: "Sonnet" });
  fireEvent.keyDown(model, { key: "ArrowDown", keyCode: 40 });
  fireEvent.keyDown(model, { key: "Enter", keyCode: 13 });
  expect(onSettings).toHaveBeenLastCalledWith({
    configOptions: [{ id: "model", value: "sonnet" }],
  });
});

test("Claude shows selected fast mode, hides explanations, and restores keyboard focus", async () => {
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  render(
    <HarnessRuntimeControl
      compact
      runtime={{
        ...runtime,
        settings: { configOptions: [{ id: "fast", value: "on" }] },
      }}
      reported={{ profile: runtime.profile, controls: claudeControls }}
      onSettings={jest.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Fast on" })).toBeTruthy();
  const user = userEvent.setup();
  await user.tab();
  const trigger = screen.getByRole("button", { name: "Claude Code settings" });
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("dialog", { name: "Claude Code settings" }),
  ).toBeTruthy();
  const details = screen
    .getByText("How access, billing, and settings work")
    .closest("details")!;
  expect(details.open).toBe(false);
  const summary = details.querySelector("summary")!;
  summary.focus();
  expect(document.activeElement).toBe(summary);
  // jsdom does not implement the native Enter-to-toggle behavior of summary.
  await user.click(summary);
  expect(details.open).toBe(true);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("failed automatic discovery shows an honest unknown model and permits retry", async () => {
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  const onDiscover = jest
    .fn()
    .mockRejectedValueOnce(Error("Offline"))
    .mockResolvedValue({ profile: runtime.profile, controls: claudeControls });
  render(
    <HarnessRuntimeControl
      compact
      runtime={runtime}
      onDiscover={onDiscover}
      onSettings={jest.fn()}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Offline",
  );
  expect(onDiscover).toHaveBeenCalledTimes(1);
  await userEvent
    .setup()
    .click(
      await screen.findByRole("button", { name: "Model unavailable - retry" }),
    );
  expect(
    await screen.findByRole("combobox", { name: "Claude Code Model" }),
  ).toBeTruthy();
  expect(onDiscover).toHaveBeenCalledTimes(2);
});

test("changing payment refreshes options and discards the previous credential's late discovery", async () => {
  const getStore = jest
    .spyOn(redux, "getStore")
    .mockReturnValue(accountStore as any);
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  let resolve!: (value: any) => void;
  const pending = new Promise<any>((done) => {
    resolve = done;
  });
  const onDiscover = jest.fn().mockReturnValueOnce(pending).mockResolvedValue({
    profile: runtime.profile,
    controls: claudeControls,
  });
  try {
    render(
      <HarnessRuntimeControl
        compact
        runtime={runtime}
        projectId="project-a"
        threadKey="thread-a"
        onDiscover={onDiscover}
        onSettings={jest.fn()}
      />,
    );
    await waitFor(() => expect(onDiscover).toHaveBeenCalledTimes(1));
    act(() =>
      writeHarnessCredentialSelection({
        accountId: "account-a",
        projectId: "project-a",
        threadKey: "thread-a",
        credential: {
          version: 1,
          provider: "anthropic",
          mode: "account-api-key",
          credentialId: "00000000-0000-4000-8000-000000000001",
        },
      }),
    );
    await act(async () =>
      resolve({ profile: runtime.profile, controls: { configOptions: [] } }),
    );
    expect(
      await screen.findByRole("combobox", { name: "Claude Code Model" }),
    ).toBeTruthy();
    expect(onDiscover).toHaveBeenCalledTimes(2);
  } finally {
    getStore.mockRestore();
    localStorage.clear();
  }
});

test("discovery errors are announced instead of supplying invented controls", async () => {
  const runtime = harnessRuntimeFromDraft(draft, "/home/user");
  const onSettings = jest.fn();
  const onDiscover = jest
    .fn()
    .mockRejectedValueOnce(Error("host unavailable"))
    .mockResolvedValueOnce({
      profile: runtime.profile,
      controls: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            currentValue: "local",
            options: [{ value: "local", name: "Local" }],
          },
        ],
      },
    });
  render(
    <HarnessRuntimeSummary
      runtime={runtime}
      onSettings={onSettings}
      onDiscover={onDiscover}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Load model and mode options" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "host unavailable",
  );
  expect(screen.queryByRole("combobox")).toBeNull();
  const button = screen.getByRole("button", {
    name: "Load model and mode options",
  });
  button.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(await screen.findByRole("combobox", { name: "Model" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("");
  expect(onDiscover).toHaveBeenCalledTimes(2);
  expect(onSettings).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button);
});

test("arguments remain structured and unknown runtimes do not display Codex controls", () => {
  const runtime = harnessRuntimeFromDraft(draft, "/home/user");
  expect(runtime.profile.args).toEqual(["--flag", "value with spaces"]);
  expect(() =>
    harnessRuntimeFromDraft({ ...draft, executable: "pi" }, "/home/user"),
  ).toThrow("absolute");
  const { rerender } = render(<HarnessRuntimeSummary runtime={runtime} />);
  expect(screen.getByText("ACP: Pi · Full project access")).toBeTruthy();
  rerender(<HarnessRuntimeSummary runtime={{ version: 200 }} />);
  expect(screen.getByRole("alert").textContent).toMatch("Invalid ACP");
});

test.each(["revision", "cwd"])(
  "profile %s changes discard pending discovery status and late results",
  async (field) => {
    const first = harnessRuntimeFromDraft(draft, "/home/user");
    const second = harnessRuntimeFromDraft(
      { ...draft, revision: field === "revision" ? "new" : draft.revision },
      field === "cwd" ? "/home/user/work" : "/home/user",
    );
    let resolve!: (value: unknown) => void;
    const pending = new Promise<any>((done) => {
      resolve = done;
    });
    const onDiscover = jest.fn(() => pending);
    const { rerender } = render(
      <HarnessRuntimeSummary
        runtime={first}
        onDiscover={onDiscover}
        onSettings={jest.fn()}
      />,
    );
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Load model and mode options" }),
      );
    expect(screen.getByRole("status").textContent).toBe("Loading...");
    rerender(
      <HarnessRuntimeSummary
        runtime={second}
        onDiscover={onDiscover}
        onSettings={jest.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("");
    await act(async () => {
      resolve({ profile: first.profile, controls: { configOptions: [] } });
      await pending;
    });
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

test("compact runtime settings open by keyboard and restore focus on Escape", async () => {
  render(
    <HarnessRuntimeControl
      compact
      runtime={harnessRuntimeFromDraft(draft, "/home/user")}
      onDiscover={jest.fn()}
    />,
  );
  const user = userEvent.setup();
  const button = screen.getByRole("button", { name: "ACP: Pi settings" });
  expect(
    screen.queryByRole("button", { name: "Load model and mode options" }),
  ).toBeNull();
  await user.tab();
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("dialog", { name: "ACP harness settings" }),
  ).toBeTruthy();
  const discovery = screen.getByRole("button", {
    name: "Load model and mode options",
  });
  discovery.focus();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

test("the phone summary is one chip that opens the full settings", async () => {
  const getStore = jest
    .spyOn(redux, "getStore")
    .mockReturnValue(accountStore as any);
  writeHarnessCredentialSelection({
    accountId: "account-a",
    projectId: "project-a",
    threadKey: "thread-summary",
    credential: {
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId: "00000000-0000-4000-8000-000000000001",
      claudeAiConnectors: false,
    },
  });
  try {
    const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
    render(
      <HarnessRuntimeControl
        compact
        summary
        runtime={{
          ...runtime,
          settings: {
            configOptions: [
              { id: "effort", value: "high" },
              { id: "fast", value: "on" },
            ],
          },
        }}
        reported={{ profile: runtime.profile, controls: claudeControls }}
        projectId="project-a"
        threadKey="thread-summary"
        onSettings={jest.fn()}
      />,
    );
    const chip = screen.getByRole("button", {
      name: "Claude Code settings: Opus 5.5 · High · Fast · Claude subscription",
    });
    // Nothing else competes for the line.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Preview")).toBeNull();
    await userEvent.setup().click(chip);
    expect(
      await screen.findByRole("dialog", { name: "Claude Code settings" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
  } finally {
    getStore.mockRestore();
  }
});

test("a model catalog saved under a superseded Claude pin is rediscovered", async () => {
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  const onDiscover = jest.fn(async () => ({
    profile: runtime.profile,
    controls: claudeControls,
  }));
  const { unmount } = render(
    <HarnessRuntimeControl
      compact
      runtime={runtime}
      reported={{
        profile: { ...runtime.profile, revision: "0.81.1" },
        controls: claudeControls,
      }}
      onDiscover={onDiscover}
      onSettings={jest.fn()}
    />,
  );
  await waitFor(() => expect(onDiscover).toHaveBeenCalledTimes(1));
  unmount();
  // A current catalog is used as is.
  const current = jest.fn();
  render(
    <HarnessRuntimeControl
      compact
      runtime={runtime}
      reported={{ profile: runtime.profile, controls: claudeControls }}
      onDiscover={current}
      onSettings={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("combobox", { name: "Claude Code Model" }),
  ).toBeTruthy();
  expect(current).not.toHaveBeenCalled();
});
