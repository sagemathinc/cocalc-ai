/** @jest-environment jsdom */

// Home in the Home page experiment (util/public-home-experiment.ts): its
// sign-up links carry the version only once the view has been counted.

import { act, render, waitFor } from "@testing-library/react";
import { hasCategoryConsent } from "@cocalc/frontend/cookie-consent";
import PublicHomeApp from "../app";

let consentListeners: Array<() => void> = [];
jest.mock("@cocalc/frontend/cookie-consent", () => ({
  ...jest.requireActual("@cocalc/frontend/cookie-consent"),
  hasCategoryConsent: jest.fn(() => false),
  onConsentChange: jest.fn((cb: () => void) => {
    consentListeners.push(cb);
    return () => {
      consentListeners = consentListeners.filter((x) => x !== cb);
    };
  }),
}));
// An anonymous visit assigned a version while the experiment runs.
jest.mock("../../home-experiment", () => ({
  ...jest.requireActual("../../home-experiment"),
  choosePublicHomeVariant: () => ({ variant: "default", counted: true }),
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      addListener: jest.fn(),
      dispatchEvent: jest.fn(),
      removeEventListener: jest.fn(),
      removeListener: jest.fn(),
    }),
  });
});

function signUpHrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a"))
    .map((a) => a.getAttribute("href") ?? "")
    .filter((href) => href.includes("auth/sign-up"));
}

describe("Home in the Home page experiment", () => {
  const config = {
    cocalc_product: "launchpad",
    dns: "cocalc.ai",
    is_launchpad: true,
    site_name: "CoCalc Launchpad",
    cookie_banner_enabled: true,
  };

  it("tags the sign-up links only after the view is counted, which waits for consent", async () => {
    const fetch = jest.fn(async () => ({ ok: true }));
    (window as any).fetch = fetch;
    jest.mocked(hasCategoryConsent).mockReturnValue(false);
    const { container } = render(<PublicHomeApp config={config as any} />);
    // Before consent: plain links (a click now attributes nothing), and
    // nothing counted.
    const before = signUpHrefs(container);
    expect(before.length).toBeGreaterThan(0);
    for (const href of before) expect(href).not.toContain("home=");
    expect(fetch).not.toHaveBeenCalled();
    // Consent while still on Home: the view is counted once, and every
    // sign-up link, the header's included, now carries the version.
    jest.mocked(hasCategoryConsent).mockReturnValue(true);
    act(() => consentListeners.forEach((cb) => cb()));
    await waitFor(() =>
      expect(signUpHrefs(container)[0]).toContain("home=default"),
    );
    const after = signUpHrefs(container);
    expect(after.length).toBe(before.length);
    for (const href of after) expect(href).toContain("home=default");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body)).toEqual({
      variant: "default",
      event: "view",
    });
    act(() => consentListeners.forEach((cb) => cb()));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("tags the links on sites without the cookie banner once the view is stored", async () => {
    (window as any).fetch = jest.fn(async () => ({ ok: true }));
    jest.mocked(hasCategoryConsent).mockReturnValue(false);
    const { container } = render(
      <PublicHomeApp
        config={{ ...config, cookie_banner_enabled: false } as any}
      />,
    );
    await waitFor(() =>
      expect(signUpHrefs(container)[0]).toContain("home=default"),
    );
    const hrefs = signUpHrefs(container);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toContain("home=default");
  });

  for (const [why, fetch] of [
    [
      "the server could not store the view",
      async () => ({ ok: false, status: 503 }),
    ],
    ["the address is throttled", async () => ({ ok: false, status: 429 })],
    [
      "the request fails",
      async () => {
        throw Error("network down");
      },
    ],
  ] as const) {
    it(`leaves the links untagged when ${why}`, async () => {
      const send = jest.fn(fetch);
      (window as any).fetch = send;
      const { container } = render(
        <PublicHomeApp
          config={{ ...config, cookie_banner_enabled: false } as any}
        />,
      );
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      const hrefs = signUpHrefs(container);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) expect(href).not.toContain("home=");
    });
  }
});
