/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ClaudePaymentStatus,
  clearClaudeCredentialsForTests,
  useClaudePaymentLabel,
  claudePaymentLabel,
  claudePaymentName,
} from "../claude-payment-status";
import { writeHarnessCredentialSelection } from "../harness-credential-selection";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "account-a",
  useAccountOtherSetting: () => undefined,
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));
jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: ({ date }: { date: string }) => <span>at {date}</span>,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: { listExternalCredentials: jest.fn(async () => []) },
      },
    },
  },
}));
const listCredentials = jest.mocked(
  webapp_client.conat_client.hub.system.listExternalCredentials,
);
const credentialId = "00000000-0000-4000-8000-000000000001";
function choose(
  mode: "account-subscription" | "account-api-key" | "project-secret",
) {
  writeHarnessCredentialSelection({
    accountId: "account-a",
    projectId: "project-a",
    threadKey: "thread-a",
    credential:
      mode === "project-secret"
        ? { version: 1, provider: "anthropic", mode }
        : { version: 1, provider: "anthropic", mode, credentialId },
  });
}
function credential(metadata: Record<string, unknown>) {
  return [{ id: credentialId, revoked: null, metadata }] as any;
}
const hour = 3600;
beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  clearClaudeCredentialsForTests();
});

test("payment status shows saved subscription limits on focus and dismisses with Escape", async () => {
  choose("account-subscription");
  const now = Math.floor(Date.now() / 1000);
  listCredentials.mockResolvedValue(
    credential({
      claude_usage: {
        observed_at: new Date((now - 120) * 1000).toISOString(),
        windows: {
          five_hour: { utilization: 0.08, resets_at: now + hour },
          seven_day: { utilization: 0.31, resets_at: now + 50 * hour },
        },
      },
    }),
  );
  const configure = jest.fn();
  render(
    <ClaudePaymentStatus
      projectId="project-a"
      threadKey="thread-a"
      onConfigure={configure}
    />,
  );
  // One list call names the footer button; opening reloads the usage.
  await waitFor(() => expect(listCredentials).toHaveBeenCalledTimes(1));
  const user = userEvent.setup();
  await user.tab();
  expect(
    await screen.findByText("Current session (5 hours): 8% used"),
  ).toBeTruthy();
  expect(screen.getByText("This week: 31% used")).toBeTruthy();
  expect(screen.getAllByText(/^Resets/)).toHaveLength(2);
  expect(
    screen.getByText(/as of your latest Claude turn in CoCalc/),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "View usage on Claude" })
      .getAttribute("href"),
  ).toBe("https://claude.ai/settings/usage");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  expect(document.activeElement).toBe(
    screen.getByRole("button", {
      name: "Claude subscription: payment settings",
    }),
  );
  await user.keyboard("{Enter}");
  expect(configure).toHaveBeenCalledTimes(1);
});

test("a window that reset since the last turn says so", async () => {
  choose("account-subscription");
  const now = Math.floor(Date.now() / 1000);
  listCredentials.mockResolvedValue(
    credential({
      claude_usage: {
        observed_at: new Date((now - 6 * hour) * 1000).toISOString(),
        windows: { five_hour: { utilization: 0.9, resets_at: now - hour } },
      },
    }),
  );
  render(
    <ClaudePaymentStatus
      projectId="project-a"
      threadKey="thread-a"
      onConfigure={jest.fn()}
    />,
  );
  await userEvent.setup().tab();
  expect(await screen.findByText(/\(since this update\)/)).toBeTruthy();
});

test("without saved limits it explains when they appear, never invents percentages", async () => {
  choose("account-subscription");
  listCredentials.mockResolvedValue(
    credential({ claude_usage: { private: "provider diagnostic" } }),
  );
  render(
    <ClaudePaymentStatus
      projectId="project-a"
      threadKey="thread-a"
      onConfigure={jest.fn()}
    />,
  );
  await userEvent.setup().tab();
  expect(
    await screen.findByText("Usage appears here after your next Claude turn."),
  ).toBeTruthy();
  expect(screen.queryByText(/provider diagnostic/)).toBeNull();
  expect(screen.queryByText(/% used/)).toBeNull();
});

test("API-key modes show billing text, not subscription usage", async () => {
  choose("account-api-key");
  render(
    <ClaudePaymentStatus
      projectId="project-a"
      threadKey="thread-a"
      onConfigure={jest.fn()}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Account API key: payment settings",
  });
  act(() => button.focus());
  expect(
    await screen.findByText("Anthropic bills API usage to the key owner."),
  ).toBeTruthy();
  expect(screen.queryByText(/% used/)).toBeNull();
});

test("the footer names the selected subscription, as the user named it", async () => {
  // William, 2026-10-16: the footer said only "Claude subscription".
  choose("account-subscription");
  listCredentials.mockResolvedValue(credential({ label: "claude1@sagemath" }));
  render(
    <ClaudePaymentStatus
      projectId="project-a"
      threadKey="thread-a"
      onConfigure={jest.fn()}
    />,
  );
  expect(
    await screen.findByRole("button", {
      name: "claude1@sagemath: payment settings",
    }),
  ).toBeTruthy();
});

test("a window on pace to hit its limit shows a warning", async () => {
  choose("account-subscription");
  const now = Math.floor(Date.now() / 1000);
  listCredentials.mockResolvedValue(
    credential({
      claude_usage: {
        observed_at: new Date(now * 1000).toISOString(),
        // 60% used with 3 of 7 days left: about 105% by the reset.
        windows: {
          seven_day: { utilization: 0.6, resets_at: now + 72 * hour },
        },
      },
    }),
  );
  render(
    <ClaudePaymentStatus
      projectId="project-a"
      threadKey="thread-a"
      onConfigure={jest.fn()}
    />,
  );
  await userEvent.setup().tab();
  expect(
    await screen.findByRole("button", {
      name: /This week: on pace to reach the limit before it resets \(about 105%\)/,
    }),
  ).toBeTruthy();
});

test("switching the selection never shows the previous credential's name", async () => {
  // Review on #1114: the phone summary kept the old row while the new one
  // loaded, and forever if that load failed.
  choose("account-subscription");
  listCredentials.mockResolvedValue(credential({ label: "Alpha" }));
  const rendered: (string | undefined)[] = [];
  function Label() {
    const label = useClaudePaymentLabel("project-a", "thread-a");
    rendered.push(label);
    return <span>label: {label}</span>;
  }
  render(<Label />);
  expect(await screen.findByText("label: Alpha")).toBeTruthy();
  clearClaudeCredentialsForTests();
  listCredentials.mockRejectedValue(new Error("hub unavailable"));
  const switchedAt = rendered.length;
  act(() =>
    writeHarnessCredentialSelection({
      accountId: "account-a",
      projectId: "project-a",
      threadKey: "thread-a",
      credential: {
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId: "00000000-0000-4000-8000-000000000002",
      },
    }),
  );
  expect(await screen.findByText("label: Claude subscription")).toBeTruthy();
  await waitFor(() => expect(listCredentials).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("label: Alpha")).toBeNull();
  // Not even for one render after the switch.
  expect(rendered.slice(switchedAt)).not.toContain("Alpha");
});

test("the footer names included Claude as CoCalc Membership", () => {
  expect(claudePaymentLabel("site-funded")).toBe("CoCalc Membership");
  expect(claudePaymentName("site-funded", undefined)).toBe("CoCalc Membership");
  // Nothing else changes.
  expect(claudePaymentLabel(undefined)).toBe("Project API key");
});
