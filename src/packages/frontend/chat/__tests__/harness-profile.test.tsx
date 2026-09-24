/** @jest-environment jsdom */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { harnessSessionControls } from "@cocalc/util/ai/harness-controls";
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

test("qualified Claude profiles contain only trusted catalog identity", () => {
  const runtime = qualifiedHarnessRuntime("claude-code", "/home/user");
  expect(runtime.profile).toEqual({
    version: 2,
    kind: "acp",
    id: "claude-code",
    revision: "0.81.1",
    cwd: "/home/user",
    executionPolicy: "full-access",
    credentialMode: "project-managed",
  });
  expect(runtime.profile).not.toHaveProperty("executable");
});

test("Claude settings distinguish account-key usage from readable project secrets", () => {
  render(
    <HarnessRuntimeSummary
      runtime={qualifiedHarnessRuntime("claude-code", "/home/user")}
      projectId="project-a"
      threadKey="thread-a"
    />,
  );
  expect(
    screen.getByText(/project secret can be read, copied, or used/),
  ).toBeTruthy();
  expect(claudeCredentialTrustWarning("account-api-key")).toMatch(
    /does not expose the account-stored key value.*reading or copying/,
  );
  expect(claudeCredentialTrustWarning("account-api-key")).toMatch(
    /project code can use the key through Claude's active relay/,
  );
  expect(
    screen.getByRole("combobox", { name: "Claude credential" }),
  ).toBeTruthy();
});

test("Claude account-key selection says its value is not copied into the project", () => {
  const getStore = jest.spyOn(redux, "getStore").mockReturnValue({
    get: () => "account-a",
  } as any);
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
    expect(
      screen.getByText(/does not expose the account-stored key value/),
    ).toBeTruthy();
    expect(screen.getByText(/project code can use the key/)).toBeTruthy();
  } finally {
    getStore.mockRestore();
    localStorage.clear();
  }
});

test("Claude subscription selection exposes an explicit disconnect action", () => {
  const getStore = jest.spyOn(redux, "getStore").mockReturnValue({
    get: () => "account-a",
  } as any);
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
      screen.getByRole("button", { name: "Disconnect Claude subscription" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Credential isolation and subscription billing still require live qualification/,
      ),
    ).toBeTruthy();
  } finally {
    getStore.mockRestore();
    localStorage.clear();
  }
});

test("Claude subscription shows the verified billing account and plan", async () => {
  const getStore = jest.spyOn(redux, "getStore").mockReturnValue({
    get: () => "account-a",
  } as any);
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
      await screen.findByText(
        /Billing: Claude max plan for subscriber@example.com/,
      ),
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
      /Text and image prompts\. Agent Networks support queued messages/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(/Automations and live guidance are not supported yet/),
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
    screen.getByText(/Agent Networks support queued messages/),
  ).toBeTruthy();
  expect(screen.getByText(/live guidance are not supported/)).toBeTruthy();
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
  await user.tab();
  const button = screen.getByRole("button", {
    name: "Load model and mode options",
  });
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("combobox", { name: "Model" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Harness options loaded");
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
  expect(screen.getByRole("status").textContent).toBe("Harness options loaded");
  expect(document.activeElement).toBe(button);
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
  expect(screen.getByRole("status").textContent).toBe("Harness options loaded");
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

test("profile changes discard pending discovery status and late results", async () => {
  const first = harnessRuntimeFromDraft(draft, "/home/user");
  const second = harnessRuntimeFromDraft(
    { ...draft, revision: "new" },
    "/home/user",
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
    .click(screen.getByRole("button", { name: "Load model and mode options" }));
  expect(screen.getByRole("status").textContent).toBe(
    "Loading harness options",
  );
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
});

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
