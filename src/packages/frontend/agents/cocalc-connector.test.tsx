import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CocalcConnector } from "./cocalc-connector";

const mockApi = {
  getCocalcConnectorConfig: jest.fn(),
  saveCocalcConnectorConfig: jest.fn(),
};
const mockRunFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

jest.mock("./api", () => ({ personalAgentApi: () => mockApi }));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: mockRunFreshAuthAction,
    freshAuthModalProps: {},
  }),
}));
jest.mock("@cocalc/frontend/components/api-key-scope-editor", () => ({
  EMPTY_API_KEY_SCOPE: { version: 1, account: [], projects: [] },
  ApiKeyScopeEditor: () => <div>Shared scope editor</div>,
}));

const agent = {
  name: "builder",
  endpoint: {
    project_id: "00000000-0000-4000-8000-000000000001",
    agent_id: "00000000-0000-4000-8000-000000000002",
  },
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getCocalcConnectorConfig.mockResolvedValue(null);
  mockApi.saveCocalcConnectorConfig.mockImplementation(async (opts) => ({
    ...opts,
    revision: 1,
  }));
});

test("keyboard opens the dialog and saving uses fresh auth", async () => {
  const user = userEvent.setup();
  render(<CocalcConnector agent={agent} />);
  const trigger = screen.getByRole("button", { name: "CoCalc access" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "CoCalc access for @builder",
  });
  await waitFor(() =>
    expect(within(dialog).getByText("Shared scope editor")).toBeVisible(),
  );
  const enabled = within(dialog).getByRole("switch", {
    name: "Enable CoCalc access",
  });
  await user.click(enabled);
  expect(enabled).toHaveAttribute("aria-checked", "true");
  await user.click(within(dialog).getByRole("button", { name: "Save access" }));
  await waitFor(() =>
    expect(mockApi.saveCocalcConnectorConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, expected_revision: undefined }),
    ),
  );
  expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(dialog).not.toBeVisible());
});

test("a failed load exposes an alert and does not allow saving", async () => {
  mockApi.getCocalcConnectorConfig.mockRejectedValueOnce(
    new Error("account home unavailable"),
  );
  const user = userEvent.setup();
  render(<CocalcConnector agent={agent} />);
  await user.click(screen.getByRole("button", { name: "CoCalc access" }));
  const dialog = await screen.findByRole("dialog", {
    name: "CoCalc access for @builder",
  });
  expect(
    await within(dialog).findByText("Error: account home unavailable"),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: "Save access" }),
  ).toBeDisabled();
});
