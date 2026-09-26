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
import type { HarnessSessionSettings } from "@cocalc/util/ai/harness-controls";
import { qualifiedHarnessRuntime } from "@cocalc/frontend/chat/harness-profile";
import {
  NewAgentClaudeControls,
  NewAgentAcpControls,
} from "./new-agent-harness-controls";
import { discoverNewAgentHarness } from "./discover-new-agent-harness";

jest.mock("./discover-new-agent-harness", () => ({
  discoverNewAgentHarness: jest.fn(),
}));
jest.mock("@cocalc/frontend/chat/claude-subscription-connect", () => ({
  ClaudeSubscriptionConnect: () => <button>Connect Claude subscription</button>,
}));

const controls = {
  version: 1,
  configOptions: [
    {
      id: "model",
      name: "Model",
      currentValue: "opus",
      options: [
        { value: "opus", name: "Opus" },
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
  onConnected: jest.fn(),
  assertCurrent: jest.fn(),
};
const result = {
  profile: qualifiedHarnessRuntime("claude-code", "/home/user").profile,
  controls,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(discoverNewAgentHarness).mockResolvedValue(result as any);
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
  expect(
    screen.queryByRole("button", { name: "Connect Claude subscription" }),
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

test("Claude setup opens from the keyboard, contains connection details, and restores focus", async () => {
  render(<NewAgentClaudeControls {...props} />);
  await screen.findByRole("combobox", { name: "Claude Code Model" });
  const user = userEvent.setup();
  await user.tab();
  const trigger = screen.getByRole("button", { name: "Configure Claude Code" });
  expect(document.activeElement).toBe(trigger);
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Configure Claude Code" });
  expect(
    screen.getByRole("combobox", { name: "Claude credential" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Connect Claude subscription" }),
  ).toBeTruthy();
  expect(
    screen.getByText("Connection and credential details").closest("details")
      ?.open,
  ).toBe(false);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("unconfigured Claude is prominent and does not discover before a project is selected", async () => {
  render(<NewAgentClaudeControls {...props} projectId={undefined} />);
  expect(discoverNewAgentHarness).not.toHaveBeenCalled();
  const trigger = screen.getByRole("button", { name: "Configure Claude Code" });
  expect(trigger.className).toContain("ant-btn-primary");
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
