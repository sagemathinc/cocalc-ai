import { act, render, screen, waitFor } from "@testing-library/react";
import { redux } from "@cocalc/frontend/app-framework";
import useDiskUsage from "./use-disk-usage";
import dust from "./dust";
import getQuota from "./quota";
import getSnapshotUsage from "./snapshot-usage";

jest.mock("./dust", () => ({
  __esModule: true,
  default: jest.fn(),
  key: ({ project_id, path }: { project_id: string; path: string }) =>
    `${project_id}-0-${path}`,
}));

jest.mock("./quota", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("./snapshot-usage", () => ({
  __esModule: true,
  default: jest.fn(),
  key: ({ project_id }: { project_id: string }) => `${project_id}-0`,
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
      <span data-testid="usage">{visible[0]?.usage.bytes ?? ""}</span>
      <span data-testid="summary-usage">{visible[0]?.summaryBytes ?? ""}</span>
      <span data-testid="summary-label">{visible[0]?.summaryLabel ?? ""}</span>
      <span data-testid="quota">{quotas[0]?.used ?? ""}</span>
      <span data-testid="counted">{counted[0]?.bytes ?? ""}</span>
      <span data-testid="error">{error ? `${error}` : ""}</span>
    </div>
  );
}

describe("useDiskUsage", () => {
  const dustMock = dust as jest.Mock;
  const quotaMock = getQuota as jest.Mock;
  const snapshotUsageMock = getSnapshotUsage as jest.Mock;
  let getStoreSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    getStoreSpy = jest
      .spyOn(redux, "getStore")
      .mockReturnValue(undefined as any);
  });

  afterEach(() => {
    getStoreSpy.mockRestore();
  });

  it("ignores stale disk-usage responses after the target changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    dustMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(null);
    snapshotUsageMock.mockResolvedValue([]);
    quotaMock.mockResolvedValue({ used: 17, size: 100 });

    const { rerender } = render(<TestComponent project_id="project-1" />);

    rerender(<TestComponent project_id="project-2" />);

    await act(async () => {
      second.resolve({ bytes: 200, children: [] });
    });
    await waitFor(() => {
      expect(screen.getByTestId("usage").textContent).toBe("200");
    });

    await act(async () => {
      first.resolve({ bytes: 100, children: [] });
    });

    await waitFor(() => {
      expect(screen.getByTestId("usage").textContent).toBe("200");
      expect(screen.getByTestId("quota").textContent).toBe("17");
    });
  });

  it("ignores missing scratch when computing visible usage", async () => {
    dustMock
      .mockResolvedValueOnce({ bytes: 111, children: [] })
      .mockRejectedValueOnce(new Error("scratch is not mounted"));
    snapshotUsageMock.mockResolvedValue([]);
    quotaMock.mockResolvedValue({ used: 17, size: 100 });

    render(<TestComponent project_id="project-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("usage").textContent).toBe("111");
      expect(screen.getByTestId("quota").textContent).toBe("17");
    });
  });

  it("includes environment changes for rootfs-backed projects", async () => {
    getStoreSpy.mockImplementation((name: string) => {
      if (name !== "projects") return undefined as any;
      return {
        get: (key: string) => {
          if (key !== "project_map") return undefined;
          return {
            getIn: (path: string[]) =>
              path[0] === "project-1" && path[1] === "rootfs_image"
                ? "sage"
                : undefined,
          };
        },
      } as any;
    });
    dustMock
      .mockResolvedValueOnce({ bytes: 111, children: [] })
      .mockResolvedValueOnce({ bytes: 22, children: [] })
      .mockResolvedValueOnce({ bytes: 33, children: [] });
    snapshotUsageMock.mockResolvedValue([]);
    quotaMock.mockResolvedValue({ used: 17, size: 100 });

    render(<TestComponent project_id="project-1" />);

    await waitFor(() => {
      expect(dustMock).toHaveBeenCalledTimes(3);
      expect(dustMock.mock.calls[2][0]).toMatchObject({
        path: "/root/.local/share/cocalc/rootfs",
        project_id: "project-1",
      });
      expect(screen.getByTestId("usage").textContent).toBe("111");
      expect(screen.getByTestId("summary-usage").textContent).toBe("78");
      expect(screen.getByTestId("summary-label").textContent).toBe("Home");
      expect(screen.getByTestId("quota").textContent).toBe("17");
    });
  });

  it("includes snapshot-exclusive bytes as counted storage when nontrivial", async () => {
    dustMock
      .mockResolvedValueOnce({ bytes: 111, children: [] })
      .mockResolvedValueOnce({ bytes: 22, children: [] });
    snapshotUsageMock.mockResolvedValue([
      {
        name: "2026-03-31T12:00:00Z",
        used: 4_000_000,
        exclusive: 2_500_000,
        quota: 20_000_000,
      },
      {
        name: "2026-03-31T13:00:00Z",
        used: 5_000_000,
        exclusive: 1_500_000,
        quota: 20_000_000,
      },
    ]);
    quotaMock.mockResolvedValue({ used: 17, size: 100 });

    render(<TestComponent project_id="project-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("counted").textContent).toBe("4000000");
    });
  });

  it("ignores stale errors after the target changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    dustMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(null);
    snapshotUsageMock.mockResolvedValue([]);
    quotaMock.mockResolvedValue({ used: 17, size: 100 });

    const { rerender } = render(<TestComponent project_id="project-1" />);

    rerender(<TestComponent project_id="project-2" />);

    await act(async () => {
      second.resolve({ bytes: 200, children: [] });
    });

    await waitFor(() => {
      expect(screen.getByTestId("usage").textContent).toBe("200");
    });

    await act(async () => {
      first.reject(new Error("disk usage scan returned invalid JSON"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("usage").textContent).toBe("200");
      expect(screen.getByTestId("error").textContent).toBe("");
    });
  });
});
