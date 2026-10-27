/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AIUsageWarning } from "./ai-usage-warning";

let mockStatus: any;

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  useActions: () => ({ set_active_tab: jest.fn() }),
  useTypedRedux: (_store: string, key: string) =>
    key === "account_id" ? "00000000-0000-4000-8000-000000000001" : true,
}));
jest.mock("@cocalc/frontend/account/membership-usage-cache", () => ({
  getWarningAIUsage: jest.fn(async () => mockStatus),
  shouldPollUsageWarnings: () => true,
  warningPollInterval: (ms: number) => ms,
}));

const pageStyle = {
  topPaddingIcons: "0px",
  sidePaddingIcons: "0px",
  height: 36,
  isNarrow: false,
} as any;

function status(used5h: number) {
  return {
    units_per_dollar: 1000,
    windows: [
      { window: "5h", used: used5h, limit: 100 },
      { window: "7d", used: 10, limit: 1000 },
    ],
  };
}

describe("AIUsageWarning pill", () => {
  it("is a named button that opens its dialog from the keyboard and restores focus", async () => {
    mockStatus = status(84);
    const user = userEvent.setup();
    render(<AIUsageWarning pageStyle={pageStyle} />);
    const trigger = await screen.findByRole("button", {
      name: /AI usage nearing limit\. 5h: 84 of 100 units \(84%\)/,
    });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");

    await user.tab();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("AI usage nearing limit");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("shows nothing below 80%", async () => {
    mockStatus = status(79);
    render(<AIUsageWarning pageStyle={pageStyle} />);
    await waitFor(() =>
      expect(
        require("@cocalc/frontend/account/membership-usage-cache")
          .getWarningAIUsage,
      ).toHaveBeenCalled(),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses the theme's danger tokens at 95% and warning tokens below", async () => {
    mockStatus = status(96);
    const { unmount } = render(<AIUsageWarning pageStyle={pageStyle} />);
    const severe = await screen.findByRole("button", {
      name: /AI usage warning/,
    });
    const severeStyle = severe.firstElementChild?.getAttribute("style") ?? "";
    expect(severeStyle).toContain("background: var(--cocalc-ui-dangerBg)");
    expect(severeStyle).toContain("color: var(--cocalc-ui-danger)");
    unmount();

    mockStatus = status(84);
    render(<AIUsageWarning pageStyle={pageStyle} />);
    const warning = await screen.findByRole("button", {
      name: /AI usage nearing limit/,
    });
    const warningStyle = warning.firstElementChild?.getAttribute("style") ?? "";
    expect(warningStyle).toContain("background: var(--cocalc-ui-warningBg)");
    expect(warningStyle).toContain("color: var(--cocalc-ui-warning)");
  });
});
