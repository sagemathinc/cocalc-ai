/** @jest-environment jsdom */

import { act } from "@testing-library/react";
import type { Root } from "react-dom/client";

let mockRoot: Root;
jest.mock("react-dom/client", () => {
  const actual = jest.requireActual("react-dom/client");
  return {
    ...actual,
    createRoot: (...args: any[]) => {
      mockRoot = actual.createRoot(...args);
      return mockRoot;
    },
  };
});

// Keep the real router and bootstrap; emulate the public app's async content.
jest.mock("../../app", () => {
  const React = jest.requireActual("react");
  return function DelayedPublicApp({ initialRoute }: any) {
    const [ready, setReady] = React.useState(false);
    React.useEffect(() => {
      const timer = setTimeout(() => setReady(true), 20);
      return () => clearTimeout(timer);
    }, []);
    return (
      <>
        <header className="cocalc-public-header">Navigation</header>
        {ready && initialRoute.section === "docs" && (
          <h2 id="example result">Example result</h2>
        )}
      </>
    );
  };
});

import { init } from "../../bootstrap";
import { navigatePublic } from "../../navigation";

describe("public fragment navigation", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(window, "setTimeout");
    jest.spyOn(window, "clearTimeout");
    window.history.replaceState({}, "", "/");
    document.body.innerHTML = '<div id="cocalc-webapp-container"></div>';
    jest.spyOn(window, "scrollTo").mockImplementation(() => {});
    jest
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        return {
          top: this.tagName === "H2" ? 1000 : 0,
          height: this.tagName === "HEADER" ? 64 : 24,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      });
  });

  afterEach(async () => {
    await act(async () => mockRoot.unmount());
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function expectFragmentTimerCleared() {
    const timer = window.setTimeout as jest.Mock;
    const index = timer.mock.calls.findIndex((call) => call[1] === 30_000);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(window.clearTimeout).toHaveBeenCalledWith(
      timer.mock.results[index].value,
    );
  }

  async function mount(url = "/") {
    window.history.replaceState({}, "", url);
    await act(async () => {
      await init();
    });
  }

  async function loadArticle() {
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
  }

  it("opens an initial encoded fragment below the sticky header after loading", async () => {
    await mount("/docs/research/private-dashboard#example%20result");
    expect(document.getElementById("example result")).toBeNull();
    expect(window.scrollTo).not.toHaveBeenCalled();
    await loadArticle();
    expect(document.getElementById("example result")).not.toBeNull();
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 920 });
    expectFragmentTimerCleared();
  });

  it("scrolls cross-page fragments and retains ordinary route-to-top navigation", async () => {
    await mount();
    await loadArticle();
    expect(window.scrollTo).not.toHaveBeenCalled();
    await act(async () =>
      navigatePublic("/docs/research/private-dashboard#example%20result"),
    );
    expect(window.location.hash).toBe("#example%20result");
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 920 });
    await act(async () => navigatePublic("/pricing"));
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0 });
  });

  it("honors a fragment when browser history changes the route", async () => {
    await mount();
    await loadArticle();
    await act(async () => {
      window.history.replaceState(
        {},
        "",
        "/docs/research/private-dashboard#example%20result",
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 920 });
  });

  it("cancels pending fragment work when the reader navigates away", async () => {
    await mount("/docs/research/private-dashboard#example%20result");
    await act(async () => navigatePublic("/pricing"));
    await loadArticle();
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0 });
    expectFragmentTimerCleared();
  });

  it("bounds the wait for absent fragments", async () => {
    const disconnect = jest.spyOn(MutationObserver.prototype, "disconnect");
    await mount("/docs/research/private-dashboard#missing");
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(disconnect).toHaveBeenCalled();
    expectFragmentTimerCleared();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("ignores malformed encoded fragments without breaking the page", async () => {
    await mount("/docs/research/private-dashboard#%E0%A4%A");
    await loadArticle();
    expect(document.getElementById("example result")).not.toBeNull();
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(
      (window.setTimeout as jest.Mock).mock.calls.some(
        (call) => call[1] === 30_000,
      ),
    ).toBe(false);
  });

  it("disconnects a pending observer on unmount", async () => {
    const disconnect = jest.spyOn(MutationObserver.prototype, "disconnect");
    await mount("/docs/research/private-dashboard#missing");
    await act(async () => mockRoot.unmount());
    expect(disconnect).toHaveBeenCalled();
    expectFragmentTimerCleared();
  });
});
