import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Map as ImmutableMap } from "immutable";
import DiskUsage from "./disk-usage";
import useDiskUsage from "./use-disk-usage";
import getStorageOverview from "./storage-overview";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
  TimeAgo: ({ date }: { date: Date | string }) => (
    <span>{`ago:${date instanceof Date ? date.toISOString() : date}`}</span>
  ),
}));

jest.mock("@cocalc/frontend/components/error", () => () => null);

jest.mock("./use-disk-usage", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("./dust", () => ({
  __esModule: true,
  default: jest.fn(async () => ({
    path: "/home/user",
    bytes: 123,
    children: [],
    collected_at: "2026-05-05T18:00:00.000Z",
  })),
}));

jest.mock("./storage-history", () => ({
  __esModule: true,
  default: jest.fn(async () => ({
    points: [],
    point_count: 0,
    window_minutes: 24 * 60,
  })),
}));

jest.mock("./storage-overview", () => ({
  __esModule: true,
  default: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    redux: {
      getProjectActions: jest.fn(() => ({
        set_current_path: jest.fn(),
        open_directory: jest.fn(),
      })),
    },
    useProjectMapField: jest.fn(),
    useTypedRedux: jest.fn(),
  };
});

const useDiskUsageMock = useDiskUsage as jest.Mock;
const getStorageOverviewMock = getStorageOverview as jest.Mock;
const { useProjectMapField, useTypedRedux } = jest.requireMock(
  "@cocalc/frontend/app-framework",
) as {
  useProjectMapField: jest.Mock;
  useTypedRedux: jest.Mock;
};
const applyOverviewMock = jest.fn();

describe("DiskUsage backup UI", () => {
  const originalGetComputedStyle = window.getComputedStyle;

  beforeAll(() => {
    Object.defineProperty(window, "getComputedStyle", {
      configurable: true,
      value: ((elt: Element) =>
        originalGetComputedStyle(elt)) as typeof window.getComputedStyle,
    });
  });

  afterAll(() => {
    Object.defineProperty(window, "getComputedStyle", {
      configurable: true,
      value: originalGetComputedStyle,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    applyOverviewMock.mockClear();
    useProjectMapField.mockReturnValue(undefined);
    useDiskUsageMock.mockReturnValue({
      visible: [
        {
          key: "home",
          label: "/home/user",
          summaryLabel: "Home",
          path: "/home/user",
          summaryBytes: 111,
          usage: {
            path: "/home/user",
            bytes: 111,
            children: [],
            collected_at: "2026-05-05T18:00:00.000Z",
          },
        },
      ],
      live: {
        key: "live",
        label: "Live files",
        path: "/home/user",
        bytes: 111,
      },
      collectedAt: "2026-05-05T18:00:00.000Z",
      retained: {
        key: "retained",
        label: "Retained snapshot/history data",
        bytes: 10,
      },
      sharedScratch: null,
      loading: false,
      error: null,
      setError: jest.fn(),
      applyOverview: applyOverviewMock,
      quotas: [{ key: "project", label: "Project quota", used: 17, size: 100 }],
    });
  });

  it("shows backup status in the storage modal", async () => {
    useProjectMapField.mockImplementation((project_id: string, path: string) =>
      project_id === "project-1" && path === "last_backup"
        ? new Date("2026-05-05T18:00:00.000Z")
        : undefined,
    );
    useTypedRedux.mockReturnValue(
      ImmutableMap({
        "project-1": ImmutableMap({
          last_backup: new Date("2026-05-05T18:00:00.000Z"),
        }),
      }),
    );

    render(<DiskUsage compact project_id="project-1" />);

    expect(screen.queryByText("Backup")).not.toBeInTheDocument();
    expect(screen.queryByText(/Live/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Retained/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText("Backup")).toBeInTheDocument();
      expect(screen.getByText("Last backup:")).toBeInTheDocument();
    });
    expect(
      screen.getAllByText("ago:2026-05-05T18:00:00.000Z").length,
    ).toBeGreaterThan(0);
  });

  it("labels recompute status without doing a second hook refresh", async () => {
    useTypedRedux.mockReturnValue(ImmutableMap());
    const overview = {
      collected_at: "2026-05-05T19:00:00.000Z",
      refresh: {
        status: "sampled",
        requested_at: "2026-05-05T19:00:00.000Z",
      },
      quotas: [{ key: "project", label: "Project quota", used: 22, size: 100 }],
      live: {
        key: "live",
        label: "Live files",
        path: "/home/user",
        bytes: 222,
      },
      retained: {
        key: "retained",
        label: "Retained snapshot/history data",
        bytes: 0,
      },
      shared_scratch: undefined,
      visible: [
        {
          key: "home",
          label: "/home/user",
          summaryLabel: "Home",
          path: "/home/user",
          summaryBytes: 222,
          usage: {
            path: "/home/user",
            bytes: 222,
            children: [],
            collected_at: "2026-05-05T19:00:00.000Z",
          },
        },
      ],
    };
    getStorageOverviewMock.mockResolvedValueOnce(overview);

    render(<DiskUsage compact project_id="project-1" />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByText("Recompute"));

    await waitFor(() => {
      expect(applyOverviewMock).toHaveBeenCalledWith(overview);
      expect(
        screen.getByText("Recomputed storage usage just now."),
      ).toBeInTheDocument();
    });
  });

  it("shows shared scratch as host storage outside project quota", async () => {
    useTypedRedux.mockReturnValue(ImmutableMap());
    useDiskUsageMock.mockReturnValue({
      visible: [
        {
          key: "home",
          label: "/home/user",
          summaryLabel: "Home",
          path: "/home/user",
          summaryBytes: 111,
          usage: {
            path: "/home/user",
            bytes: 111,
            children: [],
            collected_at: "2026-05-05T18:00:00.000Z",
          },
        },
      ],
      live: {
        key: "live",
        label: "Live files",
        path: "/home/user",
        bytes: 111,
      },
      collectedAt: "2026-05-05T18:00:00.000Z",
      retained: {
        key: "retained",
        label: "Retained snapshot/history data",
        bytes: 10,
      },
      sharedScratch: {
        key: "shared_scratch",
        label: "Host shared scratch",
        path: "/scratch",
        used: 40,
        size: 100,
        free: 60,
        available: 50,
        collected_at: "2026-05-05T18:00:00.000Z",
      },
      loading: false,
      error: null,
      setError: jest.fn(),
      applyOverview: applyOverviewMock,
      quotas: [{ key: "project", label: "Project quota", used: 17, size: 100 }],
    });

    render(<DiskUsage compact project_id="project-1" />);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(
        screen.getByText("Host shared scratch (/scratch)"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/outside this project's storage quota/),
    ).toBeInTheDocument();
    expect(screen.getByText(/not backed up by CoCalc/)).toBeInTheDocument();
    expect(
      screen.getByText(/Other projects on this host can read/),
    ).toBeInTheDocument();
  });
});
