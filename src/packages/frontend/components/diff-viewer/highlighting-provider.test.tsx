/** @jest-environment jsdom */
import { act, render, screen } from "@testing-library/react";
import { DiffHighlightingProvider } from "./highlighting-provider";

const mockWorker = new EventTarget();
const mockUnsubscribe = jest.fn();
let mockNotify: (stats: { workersFailed: boolean }) => void;
const mockInitialize = jest.fn(() => Promise.resolve());
const mockPool = {
  getStats: () => ({ workersFailed: false }),
  initialize: mockInitialize,
  subscribeToStatChanges: (callback: typeof mockNotify) => {
    mockNotify = callback;
    return mockUnsubscribe;
  },
};
let mockOptions: any;
jest.mock("./highlighting-worker", () => ({
  createHighlightingWorker: () => mockWorker,
}));
jest.mock(
  "@pierre/diffs/react",
  () => ({
    WorkerPoolContextProvider: ({
      children,
      poolOptions,
      highlighterOptions,
    }: any) => {
      mockOptions = { poolOptions, highlighterOptions };
      return children;
    },
    useWorkerPool: () => mockPool,
  }),
  { virtual: true },
);

it("bounds worker resources and retains delivery of handled worker errors", () => {
  const { unmount } = render(
    <DiffHighlightingProvider>
      <div>Diff content</div>
    </DiffHighlightingProvider>,
  );
  expect(mockOptions.poolOptions).toEqual(
    expect.objectContaining({
      poolSize: 2,
      totalASTLRUCacheSize: 16,
      workerInitializationTimeout: 5000,
    }),
  );
  expect(mockOptions.highlighterOptions.theme).toEqual({
    light: "github-light",
    dark: "github-dark",
  });
  const worker = mockOptions.poolOptions.workerFactory();
  const poolListener = jest.fn();
  worker.addEventListener("error", poolListener);
  const error = new Event("error", { cancelable: true });
  worker.dispatchEvent(error);
  expect(error.defaultPrevented).toBe(true);
  expect(poolListener).toHaveBeenCalledTimes(1);
  expect(mockInitialize).toHaveBeenCalled();
  act(() => mockNotify({ workersFailed: true }));
  expect(screen.getByRole("status").textContent).toContain("fallback");
  expect(screen.getByText("Diff content")).toBeTruthy();
  unmount();
  expect(mockUnsubscribe).toHaveBeenCalled();
});

it("observes an initialization rejection without rejecting the React render", async () => {
  mockInitialize.mockImplementationOnce(() =>
    Promise.reject(new Error("Worker unavailable")),
  );
  await act(async () => {
    render(
      <DiffHighlightingProvider>
        <div>Still readable</div>
      </DiffHighlightingProvider>,
    );
  });
  expect(screen.getByText("Still readable")).toBeTruthy();
});
