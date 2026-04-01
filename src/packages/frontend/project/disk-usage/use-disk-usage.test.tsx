import { act, render, screen, waitFor } from "@testing-library/react";
import useDiskUsage from "./use-disk-usage";
import getStorageOverview from "./storage-overview";

jest.mock("./storage-overview", () => ({
  __esModule: true,
  default: jest.fn(),
  key: ({ project_id, home }: { project_id: string; home: string }) =>
    `${project_id}:${home}`,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function TestComponent({ project_id }: { project_id: string }) {
  const { visible, quotas, counted, error } = useDiskUsage({ project_id });
  return (
    <div>
      <span data-testid="summary-usage">{visible[0]?.summaryBytes ?? ""}</span>
      <span data-testid="summary-label">{visible[0]?.summaryLabel ?? ""}</span>
      <span data-testid="quota">{quotas[0]?.used ?? ""}</span>
      <span data-testid="quota-warning">{quotas[0]?.warning ?? ""}</span>
      <span data-testid="counted">{counted[0]?.bytes ?? ""}</span>
      <span data-testid="error">{error ? `${error}` : ""}</span>
    </div>
  );
}

const overviewMock = getStorageOverview as jest.Mock;

function overview({
  used = 17,
  warning,
  visible = [
    {
      key: "home",
      label: "/root",
      summaryLabel: "Home",
      path: "/root",
      summaryBytes: 111,
      usage: { path: "/root", bytes: 111, children: [], collected_at: "" },
    },
  ],
  counted = [],
}: {
  used?: number;
  warning?: string;
  visible?: any[];
  counted?: any[];
} = {}) {
  return {
    collected_at: "2026-03-31T12:00:00.000Z",
    quotas: [
      {
        key: "project",
        label: "Project quota",
        used,
        size: 100,
        warning,
      },
    ],
    visible,
    counted,
  };
}

describe("useDiskUsage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("ignores stale storage overview responses after the target changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    overviewMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(<TestComponent project_id="project-1" />);

    rerender(<TestComponent project_id="project-2" />);

    await act(async () => {
      second.resolve(overview({ used: 29, visible: [overview().visible[0]] }));
    });
    await waitFor(() => {
      expect(screen.getByTestId("quota").textContent).toBe("29");
    });

    await act(async () => {
      first.resolve(overview({ used: 17 }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("quota").textContent).toBe("29");
    });
  });

  it("passes through storage overview buckets", async () => {
    overviewMock.mockResolvedValue(
      overview({
        visible: [
          {
            key: "home",
            label: "/root",
            summaryLabel: "Home",
            path: "/root",
            summaryBytes: 78,
            usage: {
              path: "/root",
              bytes: 111,
              children: [],
              collected_at: "",
            },
          },
        ],
        counted: [
          {
            key: "snapshots",
            label: "Snapshots",
            bytes: 4_000_000,
          },
        ],
      }),
    );

    render(<TestComponent project_id="project-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("summary-usage").textContent).toBe("78");
      expect(screen.getByTestId("summary-label").textContent).toBe("Home");
      expect(screen.getByTestId("quota").textContent).toBe("17");
      expect(screen.getByTestId("counted").textContent).toBe("4000000");
    });
  });

  it("passes through quota warnings", async () => {
    overviewMock.mockResolvedValue(
      overview({
        warning: "Btrfs quota accounting is inconsistent on this host.",
      }),
    );

    render(<TestComponent project_id="project-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("quota-warning").textContent).toContain(
        "inconsistent",
      );
    });
  });

  it("ignores stale errors after the target changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    overviewMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(<TestComponent project_id="project-1" />);

    rerender(<TestComponent project_id="project-2" />);

    await act(async () => {
      second.resolve(overview({ used: 22 }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("quota").textContent).toBe("22");
    });

    await act(async () => {
      first.reject(new Error("storage overview failed"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("quota").textContent).toBe("22");
      expect(screen.getByTestId("error").textContent).toBe("");
    });
  });
});
