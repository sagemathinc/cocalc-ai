/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { render, waitFor } from "@testing-library/react";
import { MembershipAIAllowance } from "../membership-ai-allowance";
import { getWarningAIUsage } from "@cocalc/frontend/account/membership-usage-cache";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "account-1",
}));
jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: () => <span>soon</span>,
}));
jest.mock("@cocalc/frontend/account/membership-usage-cache", () => ({
  getWarningAIUsage: jest.fn(async () => ({
    units_per_dollar: 100,
    windows: [{ window: "5h", used: 14, limit: 100 }],
  })),
}));

test("each new opening reloads the allowance (open, close, open)", async () => {
  const view = render(<MembershipAIAllowance variant="full" reload={1} />);
  await waitFor(() => expect(getWarningAIUsage).toHaveBeenCalledTimes(1));
  expect(await view.findByText("5-hour limit: 14% used")).toBeTruthy();
  // Closed: the popover keeps it mounted with the same count.
  view.rerender(<MembershipAIAllowance variant="full" reload={1} />);
  expect(getWarningAIUsage).toHaveBeenCalledTimes(1);
  // Opened again: a new count.
  view.rerender(<MembershipAIAllowance variant="full" reload={2} />);
  await waitFor(() => expect(getWarningAIUsage).toHaveBeenCalledTimes(2));
});
