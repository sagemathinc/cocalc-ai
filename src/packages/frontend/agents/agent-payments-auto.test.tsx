/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetPaymentModal, agentPaymentSummary } from "./agent-payments";

const setPaymentSelections = jest.fn(async () => ({ updated: 1 }));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        agent: {
          setPaymentSelections: (...args: any[]) =>
            (setPaymentSelections as any)(...args),
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/agents/site-funded-claude", () => ({
  useSiteFundedClaudeAvailable: () => false,
}));
jest.mock("@cocalc/frontend/chat/claude-subscription-connect", () => ({
  ClaudeSubscriptionConnect: () => <button>Connect a subscription</button>,
}));
jest.mock("@cocalc/frontend/chat/payment-selection-store", () => ({
  PAYMENT_SELECTION_EVENT: "payment-selection",
  refreshPaymentSelections: jest.fn(),
}));

const payments = {
  records: new Map(),
  defaults: {},
  credentials: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      provider: "claude-code" as const,
      mode: "account-subscription" as const,
      label: "max-a",
    },
  ],
  loading: false,
  error: "",
  reload: jest.fn(),
};
const agent = {
  project_id: "10000000-0000-4000-8000-000000000000",
  thread_id: "thread-a",
  runtime: { kind: "claude-code" } as any,
};

test("several agents can be put on Auto at once", async () => {
  render(
    <SetPaymentModal
      open
      agents={[agent]}
      payments={payments}
      onClose={jest.fn()}
    />,
  );
  const select = screen.getByLabelText("Claude credential for selected agents");
  fireEvent.mouseDown(select);
  fireEvent.click(
    (
      await screen.findAllByText(
        "Auto: choose a Claude subscription for each turn",
      )
    ).at(-1)!,
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(setPaymentSelections).toHaveBeenCalledWith({
      targets: [{ project_id: agent.project_id, thread_id: "thread-a" }],
      selection: {
        version: 1,
        provider: "claude-code",
        mode: "subscription-pool",
      },
    }),
  );
});

test("an agent card says it is on Auto", () => {
  expect(
    agentPaymentSummary(
      {
        ...payments,
        defaults: {
          "claude-code": {
            version: 1,
            provider: "claude-code",
            mode: "subscription-pool",
          },
        },
      },
      agent,
    ),
  ).toBe("Paid with your default (Auto: Claude subscriptions)");
});
