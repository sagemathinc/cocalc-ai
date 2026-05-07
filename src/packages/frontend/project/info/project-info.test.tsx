/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ProjectInfo } from "./project-info";

const useProjectInfo = jest.fn();
const useProjectInfoHistory = jest.fn();
const useProjectContext = jest.fn();
const useTypedRedux = jest.fn();
const useActions = jest.fn();

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

jest.mock("@cocalc/comm/project-status/utils", () => ({
  cgroup_stats: () => ({
    mem_rss: 0,
    mem_tot: 0,
    mem_pct: 0,
    cpu_pct: 0,
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  React,
  Rendered: undefined,
  useActions: (...args) => useActions(...args),
  useState: React.useState,
  useTypedRedux: (...args) => useTypedRedux(...args),
}));

jest.mock("@cocalc/frontend/components/error", () => () => null);

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: (...args) => useProjectContext(...args),
}));

function useProjectInfoMock(...args) {
  return useProjectInfo(...args);
}

jest.mock("./use-project-info", () => ({
  __esModule: true,
  default: useProjectInfoMock,
}));

function useProjectInfoHistoryMock(...args) {
  return useProjectInfoHistory(...args);
}

jest.mock("./use-project-info-history", () => ({
  __esModule: true,
  default: useProjectInfoHistoryMock,
}));

jest.mock("./components", () => ({
  CoCalcFile: () => null,
  render_cocalc_btn: () => null,
}));

jest.mock("./flyout", () => ({
  Flyout: () => <div data-testid="project-info-flyout" />,
}));

jest.mock("./full", () => ({
  Full: ({
    project_id,
    project_state,
    show_long_loading,
    modal,
    selected,
  }: {
    project_id: string;
    project_state?: string;
    show_long_loading?: boolean;
    modal?: string | { pid?: number };
    selected?: number[];
  }) => (
    <div data-testid="project-info-full">
      {project_id}:{project_state ?? "none"}:
      {show_long_loading ? "long" : "short"}:
      {typeof modal === "string"
        ? modal
        : modal != null && typeof modal === "object" && "pid" in modal
          ? `pid:${modal.pid}`
          : "no-modal"}
      :{selected?.join(",") ?? ""}
    </div>
  ),
}));

describe("ProjectInfo", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useProjectContext.mockReturnValue({ project_id: "context-project" });
    useProjectInfo.mockReturnValue({
      disconnected: false,
      info: null,
      error: "",
      setError: jest.fn(),
      refresh: jest.fn(async () => {}),
    });
    useProjectInfoHistory.mockReturnValue({
      history: null,
      error: "",
      refresh: jest.fn(async () => {}),
    });
    useTypedRedux.mockReturnValue(undefined);
    useActions.mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("honors the explicit project_id prop instead of the ambient context id", () => {
    render(<ProjectInfo project_id="prop-project" />);

    expect(useProjectInfo).toHaveBeenCalledWith({
      project_id: "prop-project",
    });
    expect(useProjectInfoHistory).toHaveBeenCalledWith({
      project_id: "prop-project",
    });
    expect(screen.getByTestId("project-info-full")).toHaveTextContent(
      "prop-project:none:short:no-modal:",
    );
  });

  it("updates project-derived state when switching explicit project ids", async () => {
    const projectMap = {
      get: (id: string) =>
        ({
          "project-1": {
            getIn: () => "starting",
          },
          "project-2": {
            getIn: () => "running",
          },
        })[id],
    };
    useTypedRedux.mockImplementation((arg0, arg1) => {
      if (arg0 === "projects" && arg1 === "project_map") {
        return projectMap;
      }
      if (arg1 === "status") {
        return {
          get: (key: string) => (key === "start_ts" ? 123 : undefined),
        };
      }
      return undefined;
    });

    const { rerender } = render(<ProjectInfo project_id="project-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("project-info-full")).toHaveTextContent(
        "project-1:starting:short:no-modal:",
      ),
    );

    rerender(<ProjectInfo project_id="project-2" />);
    await waitFor(() =>
      expect(screen.getByTestId("project-info-full")).toHaveTextContent(
        "project-2:running:short:no-modal:",
      ),
    );
  });

  it("resets the long-loading timer when switching projects", async () => {
    jest.useFakeTimers();

    const { rerender } = render(<ProjectInfo project_id="project-1" />);

    act(() => {
      jest.advanceTimersByTime(30000);
    });
    expect(screen.getByTestId("project-info-full")).toHaveTextContent(
      "project-1:none:long:no-modal:",
    );

    rerender(<ProjectInfo project_id="project-2" />);
    await waitFor(() =>
      expect(screen.getByTestId("project-info-full")).toHaveTextContent(
        "project-2:none:short:no-modal:",
      ),
    );
  });

  it("clears stale modal and selection state when switching projects", async () => {
    const project1Info = {
      processes: {
        11: {
          pid: 11,
          ppid: 1,
          exe: "/usr/bin/python3",
          cmdline: ["python3", "notebook.ipynb"],
          cpu: { secs: 1, pct: 2 },
          stat: {
            state: "R",
            num_threads: 4,
            mem: { rss: 128 },
          },
        },
      },
    };
    let focus: { pid: number } | undefined = { pid: 11 };
    useTypedRedux.mockImplementation((arg0, arg1) => {
      if (arg0 === "projects" && arg1 === "project_map") {
        return {
          get: () => undefined,
        };
      }
      if (arg1 === "project_info_focus") {
        if ((arg0 as { project_id?: string })?.project_id === "project-1") {
          return focus;
        }
        return undefined;
      }
      return undefined;
    });

    useProjectInfo.mockImplementation(
      ({ project_id }: { project_id: string }) => ({
        disconnected: false,
        info: project_id === "project-1" ? project1Info : null,
        error: "",
        setError: jest.fn(),
        refresh: jest.fn(async () => {}),
      }),
    );

    const setState = jest.fn(({ project_info_focus }) => {
      focus = project_info_focus;
    });
    useActions.mockReturnValue({ setState });

    const { rerender } = render(<ProjectInfo project_id="project-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("project-info-full")).toHaveTextContent(
        "project-1:none:short:pid:11:11",
      ),
    );

    rerender(<ProjectInfo project_id="project-2" />);
    await waitFor(() =>
      expect(screen.getByTestId("project-info-full")).toHaveTextContent(
        "project-2:none:short:no-modal:",
      ),
    );
  });
});
