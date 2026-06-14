import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Map as ImmutableMap } from "immutable";
import type React from "react";
import { PathNavigator } from "./path-navigator";
import getStorageOverview, {
  getCachedStorageOverview,
} from "../disk-usage/storage-overview";

jest.mock("@cocalc/frontend/components", () => ({
  DropdownMenu: ({ title }: { title: string }) => <button>{title}</button>,
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("../disk-usage/storage-overview", () => ({
  __esModule: true,
  default: jest.fn(async () => ({})),
  getCachedStorageOverview: jest.fn(),
}));

const mockOpenDirectory = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    React,
    useActions: jest.fn(() => ({ open_directory: mockOpenDirectory })),
    useTypedRedux: jest.fn(),
  };
});

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
  resolveProjectHomeDirectory: jest.fn(async () => "/Users/wstein"),
}));

const getStorageOverviewMock = getStorageOverview as jest.Mock;
const getCachedStorageOverviewMock = getCachedStorageOverview as jest.Mock;
const { useTypedRedux } = jest.requireMock(
  "@cocalc/frontend/app-framework",
) as {
  useTypedRedux: jest.Mock;
};

describe("PathNavigator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useTypedRedux.mockImplementation((_opts, key) => {
      if (key === "available_features") {
        return ImmutableMap({ homeDirectory: "/home/user" });
      }
      return undefined;
    });
  });

  it("uses /scratch as its own source when shared scratch is available", () => {
    getCachedStorageOverviewMock.mockReturnValue({
      shared_scratch: {
        key: "shared_scratch",
        label: "Host shared scratch",
        path: "/scratch",
        used: 0,
        size: 10,
        free: 10,
        available: 10,
        collected_at: "2026-05-28T00:00:00.000Z",
      },
    });
    getStorageOverviewMock.mockReturnValueOnce(new Promise(() => {}));

    render(
      <PathNavigator
        project_id="project-1"
        showSourceSelector
        currentPath="/scratch"
      />,
    );

    expect(
      screen.getByRole("button", { name: "/scratch" }),
    ).toBeInTheDocument();
  });

  it("renders absolute snapshot paths relative to Home", () => {
    render(
      <PathNavigator
        project_id="project-1"
        currentPath="/home/user/.snapshots"
      />,
    );

    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText(".snapshots")).toBeInTheDocument();
    expect(screen.queryByText("home")).not.toBeInTheDocument();
    expect(screen.queryByText("user")).not.toBeInTheDocument();
  });

  it("resolves exact home before navigating from the Home breadcrumb", async () => {
    useTypedRedux.mockImplementation((_opts, key) => {
      if (key === "current_path_abs") return "/home/user";
      return undefined;
    });

    render(<PathNavigator project_id="project-1" />);
    fireEvent.click(screen.getByText("Home"));

    await waitFor(() => {
      expect(mockOpenDirectory).toHaveBeenCalledWith(
        "/Users/wstein",
        true,
        false,
      );
    });
  });
});
