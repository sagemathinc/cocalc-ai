/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";

import type { GrowthDashboard } from "@cocalc/conat/hub/api/growth-analytics";

import { HeadlineCards, NEW_ACCOUNT_FUNNEL_TITLE } from "./retention-overview";

describe("growth and retention headline cards", () => {
  it("labels recorded work without claiming user activation or value", () => {
    const dashboard = {
      summary: {
        activity_signal: "project_work_v1",
        series: [
          {
            metric_name: "eligible_signups",
            points: [{ value: 10 }],
          },
          {
            metric_name: "verified_accounts",
            points: [{ value: 8 }],
          },
          {
            metric_name: "activated_24h",
            points: [{ value: 4 }],
          },
          {
            metric_name: "project_work_v1",
            points: [{ value: 3 }],
          },
        ],
      },
    } as GrowthDashboard;

    render(<HeadlineCards dashboard={dashboard} />);

    expect(screen.getByText("First recorded work within 24h")).toBeVisible();
    expect(screen.getByText("40")).toBeVisible();
    expect(
      screen.getByText(
        /Share of eligible signups in the selected range whose first observed project-work/,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/not proof of completion, usefulness, or retention/),
    ).toBeVisible();
    expect(screen.queryByText(/Activated in 24h/i)).not.toBeInTheDocument();
    expect(NEW_ACCOUNT_FUNNEL_TITLE).toBe("New-account journey funnel");
  });
});
