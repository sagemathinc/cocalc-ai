import { act, render, screen, waitFor } from "@testing-library/react";
import Code from "./index";

const getMode = jest.fn();
const useFrameContext = jest.fn();
const isMountedRef = { current: true };

jest.mock("../../hooks", () => ({
  useFrameContext: (...args: any[]) => useFrameContext(...args),
}));

jest.mock("./actions", () => ({
  getMode: (...args: any[]) => getMode(...args),
}));

jest.mock("@cocalc/frontend/app-framework/is-mounted-hook", () => ({
  __esModule: true,
  default: () => isMountedRef,
}));

jest.mock("@cocalc/frontend/file-extensions", () => ({
  codemirrorMode: () => "python",
}));

jest.mock("../edit-focus", () => ({
  __esModule: true,
  default: () => [false, jest.fn()],
}));

jest.mock("./control", () => () => null);
jest.mock("./input", () => () => null);
jest.mock("./input-prompt", () => () => null);
jest.mock("./output", () => () => null);
jest.mock("./style", () => ({
  __esModule: true,
  default: () => ({}),
}));

jest.mock("use-resize-observer", () => ({
  __esModule: true,
  default: () => ({}),
}));

jest.mock("./input-static", () => ({
  __esModule: true,
  default: ({ mode }: any) => <div data-testid="mode">{mode}</div>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("Code", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("ignores stale mode loads when the frame path changes", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    getMode
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    let frame = {
      actions: {
        in_undo_mode: jest.fn(() => false),
        setElement: jest.fn(),
      },
      project_id: "project-1",
      path: "/alpha.ipynb",
    };
    useFrameContext.mockImplementation(() => frame);

    const { rerender } = render(
      <Code
        element={{ id: "e1", data: {}, h: 100, str: "" } as any}
        canvasScale={1}
        readOnly={true}
        focused={false}
      />,
    );

    frame = {
      ...frame,
      path: "/beta.ipynb",
    };
    rerender(
      <Code
        element={{ id: "e1", data: {}, h: 100, str: "" } as any}
        canvasScale={1}
        readOnly={true}
        focused={false}
      />,
    );

    await act(async () => {
      second.resolve("second-mode");
      await second.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("mode").textContent).toBe("second-mode");
    });

    await act(async () => {
      first.resolve("first-mode");
      await first.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("mode").textContent).toBe("second-mode");
    });
  });
});
