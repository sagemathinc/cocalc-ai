import { act, renderHook, waitFor } from "@testing-library/react";
import { useDirectory } from "./use-directory";
import type { CollaborationPage } from "@cocalc/util/collaborators";
import { DirectoryRevisionContext } from "./use-directory-revision";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const page = (name: string, next?: string): CollaborationPage<string> => ({
  items: [name],
  coverage: "complete",
  next,
});

test("concurrent end-of-list notifications make one request and deduplicate overlapping pages", async () => {
  const later =
    deferred<CollaborationPage<{ account_id: string; name: string }>>();
  const load = jest
    .fn()
    .mockResolvedValueOnce({
      items: [{ account_id: "a", name: "old" }],
      next: "next",
      coverage: "complete",
    })
    .mockReturnValueOnce(later.promise);
  const { result } = renderHook(() => useDirectory("people", load));
  await waitFor(() => expect(result.current.page).toBeDefined());
  act(() => {
    result.current.next();
    result.current.next();
    result.current.next();
  });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(result.current.loadingMore).toBe(true);
  await act(async () =>
    later.resolve({
      items: [
        { account_id: "a", name: "updated" },
        { account_id: "b", name: "new" },
      ],
      coverage: "complete",
    }),
  );
  expect(result.current.page?.items).toEqual([
    { account_id: "a", name: "updated" },
    { account_id: "b", name: "new" },
  ]);
  act(() => result.current.next());
  expect(load).toHaveBeenCalledTimes(2);
});

test("refresh revalidates the loaded prefix atomically, including removal of old rows", async () => {
  const freshSecond = deferred<CollaborationPage<string>>();
  const load = jest
    .fn()
    .mockResolvedValueOnce(page("old-first", "c1"))
    .mockResolvedValueOnce(page("old-second"))
    .mockResolvedValueOnce(page("fresh-first", "c2"))
    .mockReturnValueOnce(freshSecond.promise);
  const { result } = renderHook(() => useDirectory("all", load));
  await waitFor(() => expect(result.current.page).toBeDefined());
  act(() => result.current.next());
  await waitFor(() =>
    expect(result.current.page?.items).toEqual(["old-first", "old-second"]),
  );
  act(() => result.current.refresh());
  await waitFor(() => expect(load).toHaveBeenCalledTimes(4));
  expect(load).toHaveBeenLastCalledWith("c2", expect.any(AbortSignal));
  expect(result.current.page?.items).toEqual(["old-first", "old-second"]);
  await act(async () => freshSecond.resolve(page("fresh-second")));
  expect(result.current.page?.items).toEqual(["fresh-first", "fresh-second"]);
});

test("late next-page results cannot leak across a filter change", async () => {
  const later = deferred<CollaborationPage<string>>();
  const load = jest
    .fn()
    .mockResolvedValueOnce(page("a", "next"))
    .mockReturnValueOnce(later.promise)
    .mockResolvedValueOnce(page("b"));
  const { result, rerender } = renderHook(
    ({ key }) => useDirectory(key, load),
    { initialProps: { key: "a" } },
  );
  await waitFor(() => expect(result.current.page).toBeDefined());
  act(() => result.current.next());
  rerender({ key: "b" });
  await waitFor(() => expect(result.current.page?.items).toEqual(["b"]));
  await act(async () => later.resolve(page("secret-a")));
  expect(result.current.page?.items).toEqual(["b"]);
});

test("a failed access-bound next page clears earlier results", async () => {
  const load = jest
    .fn()
    .mockResolvedValueOnce(page("authorized", "next"))
    .mockRejectedValueOnce(Error("access changed"));
  const { result } = renderHook(() => useDirectory("all", load));
  await waitFor(() => expect(result.current.page).toBeDefined());
  act(() => result.current.next());
  await waitFor(() => expect(result.current.error).toContain("access changed"));
  expect(result.current.page).toBeUndefined();
});

test("a nonadvancing cursor stops instead of repeatedly fetching", async () => {
  const load = jest
    .fn()
    .mockResolvedValueOnce(page("a", "next"))
    .mockResolvedValueOnce(page("b", "next"));
  const { result } = renderHook(() => useDirectory("all", load));
  await waitFor(() => expect(result.current.page).toBeDefined());
  act(() => result.current.next());
  await waitFor(() =>
    expect(result.current.error).toContain("cursor did not advance"),
  );
  act(() => result.current.next());
  expect(load).toHaveBeenCalledTimes(2);
});

test("late responses cannot cross an account/filter key, including A-B-A navigation", async () => {
  const first = deferred<CollaborationPage<string>>();
  const second = deferred<CollaborationPage<string>>();
  const third = deferred<CollaborationPage<string>>();
  const load = jest
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  const { result, rerender } = renderHook(
    ({ key }) => useDirectory(key, load),
    { initialProps: { key: "account-a:query" } },
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  rerender({ key: "account-b:query" });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await act(async () => first.resolve(page("private-a")));
  expect(result.current.page).toBeUndefined();
  rerender({ key: "account-a:query" });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  await act(async () => second.resolve(page("private-b")));
  expect(result.current.page).toBeUndefined();
  await act(async () => third.resolve(page("fresh-a")));
  expect(result.current.page?.items).toEqual(["fresh-a"]);
});

test("lazy loading appends pages and binds cursors to the filters", async () => {
  const load = jest.fn(async (cursor?: string) =>
    cursor ? page("second") : page("first", "next-1"),
  );
  const { result, rerender } = renderHook(
    ({ key }) => useDirectory(key, load),
    { initialProps: { key: "all" } },
  );
  await waitFor(() => expect(result.current.page?.items).toEqual(["first"]));
  act(() => result.current.next());
  await waitFor(() =>
    expect(result.current.page?.items).toEqual(["first", "second"]),
  );
  expect(load).toHaveBeenLastCalledWith("next-1", expect.any(AbortSignal));
  expect(result.current.pageNumber).toBe(2);
  rerender({ key: "project-filter" });
  expect(result.current.page).toBeUndefined();
  await waitFor(() => expect(result.current.page?.items).toEqual(["first"]));
  expect(load).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal));
  expect(result.current.pageNumber).toBe(1);
});

test("inactive mounts hide cached metadata and revalidate before showing it again", async () => {
  const load = jest.fn().mockResolvedValueOnce(page("old"));
  const { result, rerender } = renderHook(
    ({ active }) => useDirectory("account", load, active),
    { initialProps: { active: true } },
  );
  await waitFor(() => expect(result.current.page?.items).toEqual(["old"]));
  rerender({ active: false });
  expect(result.current.page).toBeUndefined();
  load.mockRejectedValueOnce(Error("access removed"));
  rerender({ active: true });
  expect(result.current.page).toBeUndefined();
  await waitFor(() => expect(result.current.error).toContain("access removed"));
  expect(result.current.page).toBeUndefined();
});

test("selected content revalidation preserves the runtime until a definitive access failure", async () => {
  let generation = 1;
  const fresh = deferred<CollaborationPage<string>>();
  const load = jest
    .fn()
    .mockResolvedValueOnce(page("authorized"))
    .mockReturnValueOnce(fresh.promise);
  const { result, rerender } = renderHook(
    () => useDirectory("selected-resource", load, true, true),
    {
      wrapper: ({ children }) => (
        <DirectoryRevisionContext.Provider value={{ generation, ready: true }}>
          {children}
        </DirectoryRevisionContext.Provider>
      ),
    },
  );
  await waitFor(() =>
    expect(result.current.page?.items).toEqual(["authorized"]),
  );
  generation = 2;
  rerender();
  expect(result.current.loading).toBe(true);
  expect(result.current.page?.items).toEqual(["authorized"]);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await act(async () => fresh.reject(Error("access removed")));
  expect(result.current.page).toBeUndefined();
  expect(result.current.error).toContain("access removed");
});

test("directory refresh keeps the current page mounted, but fails closed on access-check failure", async () => {
  let generation = 1;
  let ready = true;
  const fresh = deferred<CollaborationPage<string>>();
  const load = jest
    .fn()
    .mockResolvedValueOnce(page("Bob"))
    .mockReturnValueOnce(fresh.promise);
  const { result, rerender } = renderHook(() => useDirectory("people", load), {
    wrapper: ({ children }) => (
      <DirectoryRevisionContext.Provider value={{ generation, ready }}>
        {children}
      </DirectoryRevisionContext.Provider>
    ),
  });
  await waitFor(() => expect(result.current.page?.items).toEqual(["Bob"]));
  const original = result.current.page;
  generation++;
  rerender();
  expect(result.current.loading).toBe(true);
  expect(result.current.page).toBe(original);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await act(async () => fresh.resolve(page("Carol")));
  expect(result.current.page?.items).toEqual(["Carol"]);
  ready = false;
  rerender();
  expect(result.current.page).toBeUndefined();
});

test("returning to a previously loaded filter does not resurrect cached metadata", async () => {
  const load = jest
    .fn()
    .mockResolvedValueOnce(page("old"))
    .mockReturnValue(new Promise(() => {}));
  const { result, rerender } = renderHook(
    ({ key }) => useDirectory(key, load),
    { initialProps: { key: "a" } },
  );
  await waitFor(() => expect(result.current.page?.items).toEqual(["old"]));
  rerender({ key: "b" });
  expect(result.current.page).toBeUndefined();
  rerender({ key: "a" });
  expect(result.current.page).toBeUndefined();
});
