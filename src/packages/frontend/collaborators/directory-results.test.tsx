import { act, render, screen } from "@testing-library/react";
import { DirectoryResults } from "./directory-results";
import userEvent from "@testing-library/user-event";

test("keyboard loading the last page preserves a focus anchor without leaving a pagination bar", async () => {
  const user = userEvent.setup();
  const result = {
    page: { items: ["first"], next: "cursor", coverage: "complete" as const },
    loading: false,
    loadingMore: false,
    pageNumber: 1,
    next: jest.fn(),
    refresh: jest.fn(),
  };
  const { rerender } = render(
    <DirectoryResults label="People" result={result}>
      {(items) => items.join(", ")}
    </DirectoryResults>,
  );
  screen.getByRole("button", { name: "Load more" }).focus();
  await user.keyboard("{Enter}");
  expect(result.next).toHaveBeenCalledTimes(1);
  rerender(
    <DirectoryResults label="People" result={{ ...result, loadingMore: true }}>
      {(items) => items.join(", ")}
    </DirectoryResults>,
  );
  expect(screen.getByRole("button", { name: "Loading more..." })).toHaveFocus();
  rerender(
    <DirectoryResults
      label="People"
      result={{
        ...result,
        page: { ...result.page, items: ["first", "last"], next: undefined },
      }}
    >
      {(items) => items.join(", ")}
    </DirectoryResults>,
  );
  expect(screen.getByLabelText("End of results")).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

test("approaching the end automatically requests the next page, with no empty pagination chrome", () => {
  const next = jest.fn();
  let notify: IntersectionObserverCallback = () => {};
  const previous = global.IntersectionObserver;
  const disconnect = jest.fn();
  global.IntersectionObserver = jest.fn().mockImplementation((callback) => {
    notify = callback;
    return { observe: jest.fn(), disconnect };
  });
  try {
    const result = {
      page: { items: ["first"], next: "cursor", coverage: "complete" as const },
      loading: false,
      loadingMore: false,
      pageNumber: 1,
      next,
      refresh: jest.fn(),
    };
    const { rerender, unmount } = render(
      <DirectoryResults label="People" result={result}>
        {(items) => items.join(", ")}
      </DirectoryResults>,
    );
    act(() =>
      notify(
        [{ isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
    expect(next).toHaveBeenCalledTimes(1);
    rerender(
      <DirectoryResults
        label="People"
        result={{ ...result, page: { ...result.page, next: undefined } }}
      >
        {(items) => items.join(", ")}
      </DirectoryResults>,
    );
    expect(
      screen.queryByRole("button", { name: /Load more|Previous|Next|Refresh/ }),
    ).toBeNull();
    expect(screen.queryByText(/Page 1|About these results/)).toBeNull();
    expect(disconnect).toHaveBeenCalled();
    unmount();
  } finally {
    global.IntersectionObserver = previous;
  }
});
