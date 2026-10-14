/** @jest-environment jsdom */

import { UNPUBLISHED_TEAM_PROFILE_SLUGS } from "@cocalc/util/public-about-content";

import {
  attachPublicNavigationInterceptor,
  navigatePublic,
  setPublicNavigationListener,
} from "./navigation";
import { isPublicTarget } from "./routes";

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

  it("follows a permanent redirect before adding the address to the history", () => {
    window.history.replaceState({}, "", "/about");
    const before = window.history.length;
    const seen: Array<[string, string]> = [];
    setPublicNavigationListener((pathname, search) => {
      seen.push([pathname, search]);
    });
    const detach = attachPublicNavigationInterceptor();
    document.body.innerHTML = `<a href="/about/team/${UNPUBLISHED_TEAM_PROFILE_SLUGS[0]}?x=1#top">Profile</a>`;

    const link = document.querySelector("a")!;
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe("/about/team");
    expect(window.location.search).toBe("?x=1");
    expect(window.location.hash).toBe("#top");
    expect(window.history.length).toBe(before + 1);
    expect(seen).toEqual([["/about/team", "?x=1"]]);
    detach();
  });

  it("follows a permanent redirect when replacing the current address", () => {
    window.history.replaceState({}, "", "/about");
    const before = window.history.length;
    const seen: Array<[string, string]> = [];
    setPublicNavigationListener((pathname, search) => {
      seen.push([pathname, search]);
    });

    navigatePublic(`/about/team/${UNPUBLISHED_TEAM_PROFILE_SLUGS[0]}`, true);

    expect(window.location.pathname).toBe("/about/team");
    expect(window.history.length).toBe(before);
    expect(seen).toEqual([["/about/team", ""]]);
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

  it("leaves same-page fragment links to native browser scrolling", () => {
    window.history.replaceState({}, "", "/products/cocalc-star");
    const seen: Array<[string, string]> = [];
    setPublicNavigationListener((pathname, search) => {
      seen.push([pathname, search]);
    });
    const detach = attachPublicNavigationInterceptor();
    document.body.innerHTML = '<a href="#install-cocalc-star">Install</a>';

    const link = document.querySelector("a")!;
    const event = new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    link.dispatchEvent(event);

    // Not intercepted: the browser's default fragment navigation performs
    // the scroll; intercepting would update the hash without scrolling.
    expect(event.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
    detach();
  });

  it("intercepts links to a different page even when they carry a hash", () => {
    window.history.replaceState({}, "", "/pricing");
    const seen: Array<[string, string]> = [];
    setPublicNavigationListener((pathname, search) => {
      seen.push([pathname, search]);
    });
    const detach = attachPublicNavigationInterceptor();
    document.body.innerHTML =
      '<a href="/products/cocalc-star#install-cocalc-star">Install</a>';

    const link = document.querySelector("a")!;
    link.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }),
    );

    expect(window.location.pathname).toBe("/products/cocalc-star");
    expect(window.location.hash).toBe("#install-cocalc-star");
    expect(seen).toEqual([["/products/cocalc-star", ""]]);
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

describe("isPublicTarget", () => {
  it("claims public sections by their first path segment only", () => {
    expect(isPublicTarget("/news")).toBe(true);
    expect(isPublicTarget("/news/some-post-42")).toBe(true);
    expect(isPublicTarget("/docs/admin/users")).toBe(true);
    expect(isPublicTarget("/de")).toBe(true);
    expect(isPublicTarget("/features/jupyter-notebook")).toBe(true);
  });

  it("does not claim app routes that merely contain a public section name", () => {
    // Admin news management links from the public news page must trigger a
    // full navigation into the webapp, not the public SPA router.
    expect(isPublicTarget("/admin/news")).toBe(false);
    expect(isPublicTarget("/admin/news/new")).toBe(false);
    expect(isPublicTarget("/settings/ai")).toBe(false);
    expect(isPublicTarget("/projects/docs")).toBe(false);
  });

  it("only treats the guides index as public", () => {
    expect(isPublicTarget("/guides")).toBe(true);
    expect(isPublicTarget("/guides/some-guide")).toBe(false);
  });

  it("treats two-letter segments as locales only in final position", () => {
    expect(isPublicTarget("/de")).toBe(true);
    expect(isPublicTarget("/base/de")).toBe(true);
    // A two-letter base-path prefix must not be mistaken for a locale page.
    expect(isPublicTarget("/hb/projects/123")).toBe(false);
    expect(isPublicTarget("/hb/admin")).toBe(false);
  });
});
