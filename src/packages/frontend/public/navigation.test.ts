/** @jest-environment jsdom */

import {
  attachPublicNavigationInterceptor,
  setPublicNavigationListener,
} from "./navigation";

describe("public navigation", () => {
  afterEach(() => {
    setPublicNavigationListener(undefined);
    window.history.replaceState({}, "", "/");
    document.body.innerHTML = "";
    jest.restoreAllMocks();
  });

  it("navigates internal public links without a full reload", () => {
    const seen: Array<[string, string]> = [];
    setPublicNavigationListener((pathname, search) => {
      seen.push([pathname, search]);
    });
    const detach = attachPublicNavigationInterceptor();
    document.body.innerHTML = '<a href="/about?x=1">About</a>';

    const link = document.querySelector("a")!;
    link.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }),
    );

    expect(window.location.pathname).toBe("/about");
    expect(window.location.search).toBe("?x=1");
    expect(seen).toEqual([["/about", "?x=1"]]);
    detach();
  });

  it("does not intercept non-public links", () => {
    const seen: Array<[string, string]> = [];
    setPublicNavigationListener((pathname, search) => {
      seen.push([pathname, search]);
    });
    const detach = attachPublicNavigationInterceptor();
    document.body.innerHTML = '<a href="/projects">Projects</a>';

    const link = document.querySelector("a")!;
    link.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }),
    );

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(seen).toEqual([]);
    detach();
  });
});
