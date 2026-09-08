import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { useCommitWorktree } from "./use-commit-worktree";
import { locateCommitWorktree } from "./commit-worktree";
jest.mock("./commit-worktree", () => ({ locateCommitWorktree: jest.fn() }));
jest.mock("./project-read-service", () => ({ projectGitReader: {} }));
const unique = {
  kind: "unique" as const,
  commit: "a".repeat(40),
  selection: { worktree: "/other", ref: "b".repeat(40), firstParent: true },
  tip: "b".repeat(40),
};
const props = () => ({
  requestKey: "first",
  enabled: true,
  blocked: false,
  origin: {} as any,
  commit: "aaaaaaa",
  onSelect: jest.fn(),
});
beforeEach(() => jest.resetAllMocks());

test("applies a unique result once, including StrictMode effect replay", async () => {
  jest.mocked(locateCommitWorktree).mockResolvedValue(unique);
  const initialProps = props();
  const { rerender } = renderHook(useCommitWorktree, {
    initialProps,
    wrapper: StrictMode,
  });
  await waitFor(() => expect(initialProps.onSelect).toHaveBeenCalledTimes(1));
  const calls = jest.mocked(locateCommitWorktree).mock.calls.length;
  rerender({ ...initialProps });
  expect(locateCommitWorktree).toHaveBeenCalledTimes(calls);
});

test("starting feedback cancels lookup and does not resume a silent switch afterward", async () => {
  let finish!: (result: typeof unique) => void;
  jest.mocked(locateCommitWorktree).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const initialProps = props();
  const { result, rerender } = renderHook(useCommitWorktree, { initialProps });
  expect(result.current?.historicalOnly).toBe(true);
  rerender({ ...initialProps, blocked: true });
  await act(async () => finish(unique));
  expect(initialProps.onSelect).not.toHaveBeenCalled();
  rerender(initialProps);
  expect(locateCommitWorktree).toHaveBeenCalledTimes(1);
  expect(result.current?.message).toContain("interrupted");
});

test("explicit context skips lookup; changed requests discard late results", async () => {
  let finish!: (result: typeof unique) => void;
  jest.mocked(locateCommitWorktree).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const initialProps = { ...props(), enabled: false };
  const { rerender } = renderHook(useCommitWorktree, { initialProps });
  expect(locateCommitWorktree).not.toHaveBeenCalled();
  rerender({ ...initialProps, enabled: true });
  rerender({ ...initialProps, requestKey: "second" });
  await act(async () => finish(unique));
  expect(initialProps.onSelect).not.toHaveBeenCalled();
});

test("ambiguous matches remain historical and never auto-select", async () => {
  jest
    .mocked(locateCommitWorktree)
    .mockResolvedValue({
      kind: "ambiguous",
      commit: unique.commit,
      paths: ["/one", "/two"],
    });
  const initialProps = props();
  const { result } = renderHook(useCommitWorktree, { initialProps });
  await waitFor(() => expect(result.current?.message).toContain("/one, /two"));
  expect(initialProps.onSelect).not.toHaveBeenCalled();
});
