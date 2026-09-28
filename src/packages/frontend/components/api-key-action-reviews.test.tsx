import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiKeyActionReviews } from "./api-key-action-reviews";

const mockApi = { listActions: jest.fn(), decideAction: jest.fn() };
const mockFresh = jest.fn(async (fn) => {
  await fn();
  return true;
});
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        apiKeys: {
          listActions: (...args) => mockApi.listActions(...args),
          decideAction: (...args) => mockApi.decideAction(...args),
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: mockFresh,
    freshAuthModalProps: {},
  }),
}));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
}));
const review = {
  request_id: "request",
  action: { kind: "revoke_api_key", target_key_id: "target-key" },
  binding: {
    account_id: "account",
    requesting_key_id: "requester-key",
    requesting_scope_revision: 1,
    target_key_id: "target-key",
    target_scope_revision: 2,
  },
  target_name: "Automation",
  target_trunc: "abc",
  created_at: 1000,
  expires_at: Date.now() + 60000,
  status: "pending",
};
beforeEach(() => {
  jest.clearAllMocks();
  mockApi.listActions.mockResolvedValue([review]);
  mockApi.decideAction.mockResolvedValue({ ...review, status: "executed" });
});

test("keyboard review shows exact target and approval uses the displayed snapshot", async () => {
  const user = userEvent.setup();
  const onExecuted = jest.fn(async () => {});
  render(<ApiKeyActionReviews onExecuted={onExecuted} />);
  const trigger = screen.getByRole("button", { name: "Review API requests" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Review API requests",
  });
  const select = await within(dialog).findByRole("button", {
    name: "Review revocation of Automation",
  });
  select.focus();
  await user.keyboard("{Enter}");
  expect(within(dialog).getByText("target-key")).toBeVisible();
  expect(mockApi.decideAction).not.toHaveBeenCalled();
  const approve = within(dialog).getByRole("button", {
    name: "Approve revocation",
  });
  approve.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onExecuted).toHaveBeenCalledTimes(1));
  expect(mockApi.decideAction).toHaveBeenCalledWith({
    reviewed: review,
    decision: "execute",
  });
  expect(mockFresh).toHaveBeenCalledTimes(2);
  const refresh = within(dialog).getByRole("button", {
    name: "Refresh requests",
  });
  refresh.focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(dialog).not.toBeVisible());
  await waitFor(() => expect(trigger).toHaveFocus());
});

test("failed approval remains visible and is not retried automatically", async () => {
  mockApi.decideAction.mockRejectedValueOnce(
    new Error("target API key changed since review"),
  );
  const user = userEvent.setup();
  render(<ApiKeyActionReviews onExecuted={jest.fn()} />);
  await user.click(screen.getByRole("button", { name: "Review API requests" }));
  await user.click(
    await screen.findByRole("button", {
      name: "Review revocation of Automation",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Approve revocation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "changed since review",
  );
  expect(mockApi.decideAction).toHaveBeenCalledTimes(1);
});
