/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AccountUsageOverview } from "@cocalc/conat/hub/api/purchases";
import { getAccountAiWarning, UsageWarningPill } from "./account-cpu-warning";

jest.mock("@cocalc/frontend/account/membership-purchase-modal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: jest.fn(),
}));

const pageStyle = {
  topPaddingIcons: "0px",
  sidePaddingIcons: "0px",
  height: 36,
  isNarrow: false,
} as any;

function aiWarning(percent: number) {
  const overview: AccountUsageOverview = {
    collected_at: new Date().toISOString(),
    summary: {},
    meters: [
      {
        id: "ai-5h",
        category: "ai",
        window: "5h",
        label: "5-hour limit",
        help: "AI usage.",
        unit: "units",
        used: percent,
        limit: 100,
        ratio: percent / 100,
        percent,
        severity: "near",
        upgrade_relevant: true,
      },
    ],
    recent_events: {},
    measurement_warnings: [],
  } as any;
  const warning = getAccountAiWarning(overview);
  if (!warning) throw Error("expected a warning");
  return warning;
}

describe("UsageWarningPill", () => {
  it("is a named button that opens its dialog from the keyboard and restores focus", async () => {
    const user = userEvent.setup();
    render(<UsageWarningPill warning={aiWarning(84)} pageStyle={pageStyle} />);
    const trigger = screen.getByRole("button", {
      name: /Included AI allowance nearing limit\. 5-hour limit: 84 AI units of 100 AI units used \(84%\)/,
    });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");

    await user.tab();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Included AI allowance nearing limit");
    expect(dialog.textContent).toContain("use your own API key");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("uses the danger tokens at 95% and the warning tokens below", () => {
    const { unmount } = render(
      <UsageWarningPill warning={aiWarning(96)} pageStyle={pageStyle} />,
    );
    const severe = screen.getByRole("button", {
      name: /Included AI allowance almost used up/,
    });
    const severeStyle = severe.firstElementChild?.getAttribute("style") ?? "";
    expect(severeStyle).toContain("background: var(--cocalc-ui-dangerBg)");
    expect(severeStyle).toContain("color: var(--cocalc-ui-danger)");
    unmount();
    render(<UsageWarningPill warning={aiWarning(84)} pageStyle={pageStyle} />);
    const warning = screen.getByRole("button", {
      name: /Included AI allowance nearing limit/,
    });
    const warningStyle = warning.firstElementChild?.getAttribute("style") ?? "";
    expect(warningStyle).toContain("background: var(--cocalc-ui-warningBg)");
    expect(warningStyle).toContain("color: var(--cocalc-ui-warning)");
  });
});
