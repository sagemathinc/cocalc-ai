/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FinancialApprovalLink } from "./financial-approval-link";

jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));

it("explains the isolated hostname before opening financial approval", async () => {
  const user = userEvent.setup();
  const open = jest.spyOn(window, "open").mockReturnValue(null);
  render(
    <FinancialApprovalLink approvalUrl="https://approve.example.test/funding/intent">
      Review and authorize
    </FinancialApprovalLink>,
  );

  await user.click(screen.getByRole("link", { name: "Review and authorize" }));
  expect(
    screen.getByRole("dialog", {
      name: "Continue to secure CoCalc confirmation?",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText("https://approve.example.test")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(open).toHaveBeenCalledWith(
    "https://approve.example.test/funding/intent",
    "_blank",
    "noopener,noreferrer",
  );
  open.mockRestore();
});
