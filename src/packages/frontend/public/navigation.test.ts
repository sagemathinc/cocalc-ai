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

  it("intercepts the internal guides bridge page", () => {
    const seen: Array<[string, string]> = [];
    setPublicNavigationListener((pathname, search) => {
      seen.push([pathname, search]);
    });
    const detach = attachPublicNavigationInterceptor();
    document.body.innerHTML = '<a href="/guides">Guides</a>';

    const link = document.querySelector("a")!;
    link.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }),
    );

    expect(window.location.pathname).toBe("/guides");
    expect(window.location.search).toBe("");
    expect(seen).toEqual([["/guides", ""]]);
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

  it.each(["altKey", "ctrlKey", "metaKey", "shiftKey"] as const)(
    "does not intercept public links clicked with %s",
    (modifier) => {
      const seen: Array<[string, string]> = [];
      setPublicNavigationListener((pathname, search) => {
        seen.push([pathname, search]);
      });
      const detach = attachPublicNavigationInterceptor();
      document.body.innerHTML = '<a href="/about?x=1">About</a>';

      const link = document.querySelector("a")!;
      const event = new MouseEvent("click", {
        bubbles: true,
        button: 0,
        cancelable: true,
        [modifier]: true,
      });
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(window.location.pathname).toBe("/");
      expect(window.location.search).toBe("");
      expect(seen).toEqual([]);
      detach();
    },
  );

  it("does not intercept public links that open a new browsing context", () => {
    const seen: Array<[string, string]> = [];
    setPublicNavigationListener((pathname, search) => {
      seen.push([pathname, search]);
    });
    const detach = attachPublicNavigationInterceptor();
    document.body.innerHTML = '<a href="/about?x=1" target="_blank">About</a>';

    const link = document.querySelector("a")!;
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(seen).toEqual([]);
    detach();
  });

  it("does not intercept public links that request a download", () => {
    const seen: Array<[string, string]> = [];
    setPublicNavigationListener((pathname, search) => {
      seen.push([pathname, search]);
    });
    const detach = attachPublicNavigationInterceptor();
    document.body.innerHTML = '<a href="/about?x=1" download>About</a>';

    const link = document.querySelector("a")!;
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(seen).toEqual([]);
    detach();
  });
});
