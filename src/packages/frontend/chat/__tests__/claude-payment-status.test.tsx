/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClaudePaymentStatus } from "../claude-payment-status";
import { writeHarnessCredentialSelection } from "../harness-credential-selection";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "account-a",
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
  expect(listCredentials).not.toHaveBeenCalled();
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
