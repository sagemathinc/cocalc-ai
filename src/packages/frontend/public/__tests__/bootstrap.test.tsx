/** @jest-environment jsdom */

import { act, fireEvent, screen, waitFor } from "@testing-library/react";

import { UNPUBLISHED_TEAM_PROFILE_SLUGS } from "@cocalc/util/public-about-content";

import { init } from "../bootstrap";

const originalFetch = global.fetch;
const originalScrollIntoView = Element.prototype.scrollIntoView;
const scrollIntoView = jest.fn();
let scrollTo: jest.SpyInstance;
const profile = `/about/team/${UNPUBLISHED_TEAM_PROFILE_SLUGS[0]}`;

beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
  scrollIntoView.mockClear();
  scrollTo = jest.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  global.fetch = jest.fn(
    () => new Promise<Response>(() => undefined),
  ) as typeof fetch;
  document.body.innerHTML = '<div id="cocalc-webapp-container"></div>';
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  scrollTo.mockRestore();
  global.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

// The hub redirects these URLs itself; the bootstrap covers a shell that was
// served anyway, for example from a cache, so the address and the page agree.
describe("public bootstrap", () => {
  it("opens an unpublished team profile at the team page", async () => {
    window.history.replaceState({}, "", `${profile}?x=1#top`);

    await act(async () => {
      await init();
    });

    expect(window.location.pathname).toBe("/about/team");
    expect(window.location.search).toBe("?x=1");
    expect(window.location.hash).toBe("#top");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Meet the People Behind CoCalc",
      }),
    ).not.toBeNull();
  });

  it("opens a static-shell target for an unpublished profile at the team page", async () => {
    window.history.replaceState(
      {},
      "",
      `/static/public.html?target=${encodeURIComponent(profile)}`,
    );

    await act(async () => {
      await init();
    });

    expect(window.location.pathname).toBe("/about/team");
    expect(window.location.search).toBe("");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Meet the People Behind CoCalc",
      }),
    ).not.toBeNull();
  });

  it("opens a static-shell target for a hidden product's page at the products page, with its query string", async () => {
    window.history.replaceState(
      {},
      "",
      `/static/public.html?target=${encodeURIComponent(
        "/products/cocalc-rocket?ref=old-link",
      )}`,
    );

    await act(async () => {
      await init();
    });

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Where to run CoCalc",
      }),
    ).not.toBeNull();
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        "/products?ref=old-link",
      ),
    );
  });

  it("keeps a published page's address", async () => {
    window.history.replaceState({}, "", "/about/team/william-stein");

    await act(async () => {
      await init();
    });

    expect(window.location.pathname).toBe("/about/team/william-stein");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "William Stein, Founder and CEO",
      }),
    ).not.toBeNull();
  });
});

// Exercise real lazy routes, without depending on the marketing redesign.
describe("public bootstrap section landing", () => {
  async function waitForSection() {
    const section = await waitFor(() => {
      const element = document.getElementById("how-we-build");
      expect(element).not.toBeNull();
      return element!;
    });
    await waitFor(() => expect(section).toHaveFocus());
    expect(scrollIntoView.mock.contexts).toContain(section);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(section).toHaveAttribute("tabindex", "-1");
  }

  it("scrolls and focuses the requested section after a cross-page link", async () => {
    window.history.replaceState({}, "", "/about/team");
    await act(async () => {
      await init();
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Meet the People Behind CoCalc",
    });
    const link = document.createElement("a");
    link.href = "/about?from=team#how-we-build";
    link.textContent = "How we build";
    document.body.appendChild(link);
    fireEvent.click(link, { button: 0 });
    await waitForSection();
    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe("/about?from=team#how-we-build");
  });

  it("lands after JavaScript replaces the initial HTML of a direct section URL", async () => {
    window.history.replaceState({}, "", "/about#how-we-build");
    await act(async () => {
      await init();
    });
    await waitForSection();
  });

  it("starts an ordinary cross-page link at the top without moving section focus", async () => {
    window.history.replaceState({}, "", "/about/team");
    await act(async () => {
      await init();
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Meet the People Behind CoCalc",
    });
    const link = document.createElement("a");
    link.href = "/about";
    document.body.appendChild(link);
    fireEvent.click(link, { button: 0 });
    await waitFor(() =>
      expect(document.getElementById("how-we-build")).not.toBeNull(),
    );
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.getElementById("how-we-build")).not.toHaveFocus();
  });
});
