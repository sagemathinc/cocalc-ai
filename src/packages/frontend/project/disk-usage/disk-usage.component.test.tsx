import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Map as ImmutableMap } from "immutable";
import DiskUsage from "./disk-usage";
import useDiskUsage from "./use-disk-usage";

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
    useTypedRedux: jest.fn(),
  };
});

const useDiskUsageMock = useDiskUsage as jest.Mock;
const { useTypedRedux } = jest.requireMock(
  "@cocalc/frontend/app-framework",
) as {
  useTypedRedux: jest.Mock;
};

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
      retained: {
        key: "retained",
        label: "Retained snapshot/history data",
        bytes: 10,
      },
      loading: false,
      error: null,
      setError: jest.fn(),
      refresh: jest.fn(),
      quotas: [{ key: "project", label: "Project quota", used: 17, size: 100 }],
    });
  });

  it("shows backup status on the button and the modal", async () => {
    useTypedRedux.mockReturnValue(
      ImmutableMap({
        "project-1": ImmutableMap({
          last_backup: new Date("2026-05-05T18:00:00.000Z"),
        }),
      }),
    );

    render(<DiskUsage compact project_id="project-1" />);

    expect(screen.getByText("Backed up")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByText("Last backup:")).toBeInTheDocument();
    });
    expect(
      screen.getByText("ago:2026-05-05T18:00:00.000Z"),
    ).toBeInTheDocument();
  });
});
