/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { Flyout } from "./flyout";

jest.mock("antd", () => ({
  Alert: ({ title }: any) => <div role="alert">{title}</div>,
  Table: () => <div>table</div>,
}));

jest.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: () => "Project",
  }),
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    project: "project",
  },
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  ProjectActions: undefined,
  useState: React.useState,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading...</div>,
  Paragraph: ({ children }: any) => <p>{children}</p>,
}));

jest.mock("./components", () => ({
  AboutContent: () => null,
  CGroup: () => <div>cgroup</div>,
  ProcState: () => null,
  ProjectProblems: () => null,
  SignalButtons: () => null,
}));

jest.mock("./utils", () => ({
  process_inclusive_value: () => 0,
}));

function renderFlyout(props: Partial<React.ComponentProps<typeof Flyout>>) {
  (globalThis as any).DEBUG = false;
  return render(
    <Flyout
      cg_info={{} as any}
      disconnected={false}
      disk_usage={{} as any}
      error={null}
      info={null}
      loading={false}
      modal={undefined}
      onCellProps={() => ({})}
      project_actions={undefined}
      project_state="running"
      project_status={undefined}
      pt_stats={{} as any}
      ptree={undefined}
      render_cocalc={() => undefined}
      render_disconnected={() => undefined}
      selected={[]}
      set_modal={jest.fn()}
      set_selected={jest.fn()}
      show_explanation={false}
      show_long_loading={false}
      start_ts={undefined}
      status="Connecting..."
      {...props}
    />,
  );
}

describe("Project info flyout loading state", () => {
  it("keeps showing a spinner while running project info has no data or error", () => {
    renderFlyout({ loading: true, error: null });

    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("shows the load error instead of a spinner when project info fails", () => {
    renderFlyout({
      loading: true,
      error: <div role="alert">Project info unavailable</div>,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Project info unavailable",
    );
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });
});
