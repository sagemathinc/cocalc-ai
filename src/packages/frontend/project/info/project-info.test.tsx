/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { render, screen } from "@testing-library/react";
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
  Full: ({ project_id }: { project_id: string }) => (
    <div data-testid="project-info-full">{project_id}</div>
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

  it("honors the explicit project_id prop instead of the ambient context id", () => {
    render(<ProjectInfo project_id="prop-project" />);

    expect(useProjectInfo).toHaveBeenCalledWith({
      project_id: "prop-project",
    });
    expect(useProjectInfoHistory).toHaveBeenCalledWith({
      project_id: "prop-project",
    });
    expect(screen.getByTestId("project-info-full")).toHaveTextContent(
      "prop-project",
    );
  });
});
