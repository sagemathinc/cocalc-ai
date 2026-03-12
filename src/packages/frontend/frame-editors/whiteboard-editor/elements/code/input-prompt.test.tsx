import { act, render, screen, waitFor } from "@testing-library/react";
import CodeInputPrompt from "./input-prompt";

const getJupyterActions = jest.fn();
const useFrameContext = jest.fn();
const isMountedRef = { current: true };

jest.mock("../../hooks", () => ({
  useFrameContext: (...args: any[]) => useFrameContext(...args),
}));

jest.mock("./actions", () => ({
  getJupyterActions: (...args: any[]) => getJupyterActions(...args),
}));

jest.mock("@cocalc/frontend/app-framework/is-mounted-hook", () => ({
  __esModule: true,
  default: () => isMountedRef,
}));

jest.mock("@cocalc/frontend/jupyter/prompt/input", () => ({
  InputPrompt: ({ actions }: any) => (
    <div data-testid="actions-id">{actions?.id ?? ""}</div>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("CodeInputPrompt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("ignores stale Jupyter actions when the frame target changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    getJupyterActions
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    let frame = { project_id: "project-1", path: "/alpha.ipynb" };
    useFrameContext.mockImplementation(() => frame);

    const { rerender } = render(
      <CodeInputPrompt element={{ id: "e1", data: {} }} />,
    );

    frame = { project_id: "project-1", path: "/beta.ipynb" };
    rerender(<CodeInputPrompt element={{ id: "e1", data: {} }} />);

    await act(async () => {
      second.resolve({ id: "second-actions" });
      await second.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("actions-id").textContent).toBe(
        "second-actions",
      );
    });

    await act(async () => {
      first.resolve({ id: "first-actions" });
      await first.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("actions-id").textContent).toBe(
        "second-actions",
      );
    });
    expect(getJupyterActions).toHaveBeenCalledTimes(2);
  });
});
