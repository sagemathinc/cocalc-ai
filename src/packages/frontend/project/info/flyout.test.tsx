/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { Flyout } from "./flyout";

jest.mock("@cocalc/frontend/app-framework", () => {
  const react = jest.requireActual("react");
  return {
    useState: react.useState,
  };
});

jest.mock("react-intl", () => ({
  defineMessage: (message) => message,
  useIntl: () => ({
    formatMessage: () => "Project",
  }),
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    project: "project",
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading...</div>,
  Paragraph: ({ children }) => <p>{children}</p>,
}));

jest.mock("./components", () => ({
  AboutContent: () => null,
  CGroup: () => <div>cgroup</div>,
  ProcState: () => null,
  ProjectProblems: () => null,
  SignalButtons: () => null,
}));

const baseProps = {
  cg_info: { cpu_total: 0, mem_total: 0 },
  render_disconnected: () => undefined,
  disconnected: false,
  disk_usage: "unknown" as const,
  error: null,
  status: "running",
  loading: false,
  modal: undefined,
  project_actions: undefined,
  project_state: "running",
  project_status: undefined,
  pt_stats: {},
  select_proc: jest.fn(),
  selected: [],
  set_modal: jest.fn(),
  set_selected: jest.fn(),
  show_explanation: false,
  show_long_loading: false,
  start_ts: undefined,
  render_cocalc: () => undefined,
  onCellProps: (_field: string, render?: (value: any) => React.ReactNode) => {
    const fn = (value: any) => (render == null ? value : render(value));
    return fn as any;
  },
};

describe("project info flyout", () => {
  const getComputedStyle = window.getComputedStyle;

  beforeEach(() => {
    (globalThis as any).DEBUG = false;
    window.getComputedStyle = (() => ({
      getPropertyValue: () => "",
    })) as any;
  });

  afterEach(() => {
    window.getComputedStyle = getComputedStyle;
  });

  it("uses the flyout wrapper as the vertical scroll container", () => {
    const wrap = jest.fn((content: React.ReactNode) => (
      <div data-testid="outer-scroll" style={{ overflowY: "auto" }}>
        {content}
      </div>
    ));

    render(
      <Flyout
        {...baseProps}
        wrap={wrap}
        info={
          {
            timestamp: Date.now(),
            processes: {
              1: {
                pid: 1,
                ppid: 0,
                exe: "/usr/bin/python",
                name: "python",
                cmdline: ["python"],
                cpu: { pct: 10, secs: 1 },
                stat: { ppid: 0, state: "R", mem: { rss: 20 } },
                uptime: 1,
              },
            },
            disk_usage: {},
            uptime: 1,
            boottime: new Date(),
          } as any
        }
        ptree={[
          {
            key: "1",
            pid: 1,
            ppid: 0,
            name: "python",
            args: "",
            state: "R",
            mem: 20,
            cpu_pct: 10,
            cpu_tot: 10,
            cocalc: undefined,
          },
        ]}
      />,
    );

    expect(wrap).toHaveBeenCalled();
    expect(screen.getByTestId("outer-scroll")).toBeTruthy();
    expect(
      document.querySelector(".ant-table")?.getAttribute("style") ?? "",
    ).not.toContain("overflow-y");
  });
});
