/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { SiteFundedFunnelSection } from "./site-funded-codex-status";

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));

describe("SiteFundedFunnelSection", () => {
  it("shows why admissions were refused and how admitted turns ended", () => {
    render(
      <SiteFundedFunnelSection
        funnel={{
          periodStart: "2026-10-17T00:00:00.000Z",
          periodEnd: "2026-10-24T00:00:00.000Z",
          attempts: 40,
          accounts: 25,
          admittedAccounts: 5,
          outcomes: [
            { outcome: "unverified_email", attempts: 30, accounts: 20 },
            { outcome: "allowed", attempts: 10, accounts: 5 },
          ],
          turns: [
            {
              status: "committed",
              turns: 8,
              accounts: 5,
              committedMicrousd: 240_000,
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByText("Refused: email address not verified"),
    ).toBeTruthy();
    expect(screen.getByText("Admitted")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    // $0.24 over 8 turns
    expect(screen.getByText("$0.03")).toBeTruthy();
  });
});
