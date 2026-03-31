import { act, render, screen, waitFor } from "@testing-library/react";
import useDiskUsage from "./use-disk-usage";
import dust from "./dust";
import getQuota from "./quota";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function TestComponent({ project_id }: { project_id: string }) {
  const { visible, quotas } = useDiskUsage({ project_id });
  return (
    <div>
      <span data-testid="usage">{visible[0]?.usage.bytes ?? ""}</span>
      <span data-testid="quota">{quotas[0]?.used ?? ""}</span>
    </div>
  );
}

describe("useDiskUsage", () => {
  const dustMock = dust as jest.Mock;
  const quotaMock = getQuota as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("ignores stale disk-usage responses after the target changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    dustMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(null);
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
    quotaMock.mockResolvedValue({ used: 17, size: 100 });

    render(<TestComponent project_id="project-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("usage").textContent).toBe("111");
      expect(screen.getByTestId("quota").textContent).toBe("17");
    });
  });
});
