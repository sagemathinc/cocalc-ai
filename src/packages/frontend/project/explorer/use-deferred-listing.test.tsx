import { act, render, screen } from "@testing-library/react";

import {
  fileListingFingerprint,
  useDeferredListing,
} from "./use-deferred-listing";

type ListingItem = { name: string; mtime?: number; size?: number };

function listing(names: string[]): ListingItem[] {
  return names.map((name, i) => ({ name, mtime: i, size: i + 1 }));
}

function TestComponent({
  liveListing,
  currentPath = "/",
  alwaysPassThrough = false,
}: {
  liveListing: ListingItem[] | undefined;
  currentPath?: string;
  alwaysPassThrough?: boolean;
}) {
  const { displayListing, hasPending, flush, allowNextUpdate } =
    useDeferredListing({
      liveListing,
      currentPath,
      alwaysPassThrough,
      fingerprint: fileListingFingerprint,
    });

  return (
    <>
      <span data-testid="display">
        {displayListing?.map((item) => item.name).join(",") ?? ""}
      </span>
      <span data-testid="pending">{hasPending ? "yes" : "no"}</span>
      <button onClick={flush}>flush</button>
      <button onClick={allowNextUpdate}>allow</button>
    </>
  );
}

describe("useDeferredListing", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it("holds watcher-driven changes until flushed after the grace window", () => {
    const { rerender } = render(<TestComponent liveListing={listing(["a"])} />);

    expect(screen.getByTestId("display").textContent).toBe("a");
    expect(screen.getByTestId("pending").textContent).toBe("no");

    act(() => {
      jest.advanceTimersByTime(5000);
    });

    rerender(<TestComponent liveListing={listing(["b"])} />);

    expect(screen.getByTestId("display").textContent).toBe("a");
    expect(screen.getByTestId("pending").textContent).toBe("yes");

    act(() => {
      screen.getByText("flush").click();
    });

    expect(screen.getByTestId("display").textContent).toBe("b");
    expect(screen.getByTestId("pending").textContent).toBe("no");
  });

  it("lets the next explicit update through immediately", () => {
    const { rerender } = render(<TestComponent liveListing={listing(["a"])} />);

    act(() => {
      jest.advanceTimersByTime(5000);
      screen.getByText("allow").click();
    });

    rerender(<TestComponent liveListing={listing(["b"])} />);

    act(() => {
      jest.advanceTimersByTime(10);
    });

    expect(screen.getByTestId("display").textContent).toBe("b");
    expect(screen.getByTestId("pending").textContent).toBe("no");
  });

  it("flushes pending changes when navigating to another path", () => {
    const { rerender } = render(
      <TestComponent liveListing={listing(["a"])} currentPath="/alpha" />,
    );

    act(() => {
      jest.advanceTimersByTime(5000);
    });

    rerender(
      <TestComponent liveListing={listing(["b"])} currentPath="/alpha" />,
    );

    expect(screen.getByTestId("display").textContent).toBe("a");
    expect(screen.getByTestId("pending").textContent).toBe("yes");

    rerender(
      <TestComponent liveListing={listing(["b"])} currentPath="/beta" />,
    );

    expect(screen.getByTestId("display").textContent).toBe("b");
    expect(screen.getByTestId("pending").textContent).toBe("no");
  });
});
