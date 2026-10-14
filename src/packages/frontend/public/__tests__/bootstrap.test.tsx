/** @jest-environment jsdom */

import { act, screen } from "@testing-library/react";

import { UNPUBLISHED_TEAM_PROFILE_SLUGS } from "@cocalc/util/public-about-content";

import { init } from "../bootstrap";

const originalFetch = global.fetch;
const profile = `/about/team/${UNPUBLISHED_TEAM_PROFILE_SLUGS[0]}`;

beforeEach(() => {
  global.fetch = jest.fn(
    () => new Promise<Response>(() => undefined),
  ) as typeof fetch;
  document.body.innerHTML = '<div id="cocalc-webapp-container"></div>';
});

afterEach(() => {
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
