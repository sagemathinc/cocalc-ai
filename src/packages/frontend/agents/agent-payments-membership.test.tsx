/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { SetPaymentModal } from "./agent-payments";

jest.mock("@cocalc/frontend/agents/site-funded-claude", () => ({
  useSiteFundedClaudeAvailable: () => true,
}));
jest.mock("@cocalc/frontend/chat/claude-subscription-connect", () => ({
  ClaudeSubscriptionConnect: () => <button>Connect a subscription</button>,
}));

test("without a Claude credential, included Claude can still be chosen", () => {
  render(
    <SetPaymentModal
      open
      agents={[
        {
          project_id: "project-a",
          thread_id: "thread-a",
          runtime: { kind: "claude-code" } as any,
        },
      ]}
      payments={{
        records: new Map(),
        defaults: {},
        credentials: [],
        loading: false,
        error: "",
        reload: jest.fn(),
      }}
      onClose={jest.fn()}
    />,
  );
  // Connecting a subscription stays possible...
  expect(screen.getByText("Connect a subscription")).toBeTruthy();
  // ...and the choice of membership is offered.
  const select = screen.getByLabelText("Claude credential for selected agents");
  fireEvent.mouseDown(select);
  expect(
    screen.getAllByText("CoCalc Membership (Claude Haiku 5.5)").length,
  ).toBeGreaterThan(0);
});
