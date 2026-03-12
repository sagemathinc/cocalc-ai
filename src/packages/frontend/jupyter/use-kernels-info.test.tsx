import { act, render, screen, waitFor } from "@testing-library/react";
import { useJupyterKernelsInfo } from "./use-kernels-info";
import { getKernelInfo } from "@cocalc/frontend/components/run-button/kernel-info";

let currentProjectId = "project-1";
let currentIsRunning = false;

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({
    project_id: currentProjectId,
    isRunning: currentIsRunning,
  }),
}));

jest.mock("@cocalc/frontend/components/run-button/kernel-info", () => ({
  getKernelInfo: jest.fn(),
}));

jest.mock("@cocalc/jupyter/util/misc", () => ({
  get_kernel_selection: jest.fn(
    (specs: any) => specs?.get?.(0)?.get?.("name") ?? null,
  ),
  get_kernels_by_name_or_language: jest.fn(() => [null, null]),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function TestComponent() {
  const { kernel_selection, error } = useJupyterKernelsInfo();
  return (
    <div>
      <span data-testid="selection">{kernel_selection ?? ""}</span>
      <span data-testid="error">{error}</span>
    </div>
  );
}

describe("useJupyterKernelsInfo", () => {
  const getKernelInfoMock = getKernelInfo as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    currentProjectId = "project-1";
    currentIsRunning = false;
  });

  it("ignores stale kernel info after the project changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    getKernelInfoMock.mockImplementation((project_id: string) => {
      return project_id === "project-1" ? first.promise : second.promise;
    });

    const { rerender } = render(<TestComponent />);

    currentProjectId = "project-2";
    rerender(<TestComponent />);

    await act(async () => {
      second.resolve([{ name: "python-2" }]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("selection").textContent).toBe("python-2");
    });

    await act(async () => {
      first.resolve([{ name: "python-1" }]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("selection").textContent).toBe("python-2");
      expect(screen.getByTestId("error").textContent).toBe("");
    });
  });
});
