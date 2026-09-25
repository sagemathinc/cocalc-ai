/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { CourseTabBar } from "./course-tab-bar";

const props = {
  frame_id: "frame",
  type: "course_configuration",
  actions: { set_frame_type: jest.fn() },
  counts: { students: 1, assignments: 2, handouts: 3 },
};

function renderTabs(computeBudgetEnabled: boolean) {
  return render(
    <IntlProvider locale="en">
      <CourseTabBar
        {...(props as any)}
        computeBudgetEnabled={computeBudgetEnabled}
      />
    </IntlProvider>,
  );
}

it("hides the compute budget until the course enables it", () => {
  renderTabs(false);
  expect(screen.queryByRole("tab", { name: "Compute budget" })).toBeNull();
});

it("shows the compute budget after the course enables it", () => {
  renderTabs(true);
  expect(screen.getByRole("tab", { name: "Compute budget" })).toBeVisible();
});
