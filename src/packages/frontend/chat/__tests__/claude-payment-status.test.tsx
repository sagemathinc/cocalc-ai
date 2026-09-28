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
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: { listExternalCredentials: jest.fn(async () => []) },
        projects: { getClaudeSubscriptionUsage: jest.fn() },
      },
    },
  },
}));
const getUsage = jest.mocked(
  webapp_client.conat_client.hub.projects.getClaudeSubscriptionUsage,
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
beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

test("payment status loads subscription windows on focus and dismisses with Escape", async () => {
  choose("account-subscription");
  getUsage.mockResolvedValue({
    available: true,
    fetchedAt: "2026-09-26T14:00:00Z",
    windows: [
      {
        name: "Current session (5 hours)",
        usedPercent: 8,
        resetsAt: "2026-09-26T15:00:00Z",
      },
      { name: "This week", usedPercent: 1 },
    ],
  });
  const configure = jest.fn();
  render(
    <ClaudePaymentStatus
      projectId="project-a"
      threadKey="thread-a"
      onConfigure={configure}
    />,
  );
  expect(getUsage).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.tab();
  expect(
    await screen.findByText("Current session (5 hours): 8% used"),
  ).toBeTruthy();
  expect(screen.getByText("This week: 1% used")).toBeTruthy();
  expect(screen.getByText(/^Resets /)).toBeTruthy();
  expect(getUsage).toHaveBeenCalledWith({
    project_id: "project-a",
    credential_id: credentialId,
  });
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

test("changing credential clears subscription usage and API-key modes never query it", async () => {
  choose("account-subscription");
  let resolve!: (value: any) => void;
  getUsage.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(
    <ClaudePaymentStatus
      projectId="project-a"
      threadKey="thread-a"
      onConfigure={jest.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.tab();
  await waitFor(() => expect(getUsage).toHaveBeenCalledTimes(1));
  act(() => choose("account-api-key"));
  await act(async () =>
    resolve({
      available: true,
      fetchedAt: new Date().toISOString(),
      windows: [{ name: "private old window", usedPercent: 8 }],
    }),
  );
  const button = screen.getByRole("button", {
    name: "Account API key: payment settings",
  });
  act(() => button.focus());
  expect(
    await screen.findByText("Anthropic bills API usage to the key owner."),
  ).toBeTruthy();
  expect(screen.queryByText(/private old window/)).toBeNull();
  expect(getUsage).toHaveBeenCalledTimes(1);
});

test("unavailable subscription usage does not invent percentages or expose server errors", async () => {
  choose("account-subscription");
  getUsage.mockRejectedValue(Error("private provider diagnostic"));
  render(
    <ClaudePaymentStatus
      projectId="project-a"
      threadKey="thread-a"
      onConfigure={jest.fn()}
    />,
  );
  await userEvent.setup().tab();
  expect(
    await screen.findByText(
      "Usage unavailable. Try again after your next turn.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/private provider/)).toBeNull();
  expect(screen.queryByText(/0%/)).toBeNull();
  expect(
    screen
      .getByRole("link", { name: "View usage on Claude" })
      .getAttribute("href"),
  ).toBe("https://claude.ai/settings/usage");
});
