/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://cocalc.ai/"}
 */

import { render, screen, within } from "@testing-library/react";

import {
  COCALC_AI_SIGN_UP_LABEL,
  PUBLIC_SIGN_UP_LABEL,
} from "@cocalc/util/public-site-policy";
import PublicFeaturesApp from "../features/app";
import PublicHomeApp from "../home/app";

const COCALC_AI = {
  cocalc_product: "launchpad",
  dns: "cocalc.ai",
  is_launchpad: true,
  site_name: "CoCalc",
};

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
  });
});

// Terminal retains its host-based signup label. Home keeps signup available
// on the canonical host without advertising AI capabilities before the
// product configuration arrives.
describe("sign-up labels on cocalc.ai before /customize returns", () => {
  it("keeps the Terminal label from the first render", () => {
    expect(window.location.host).toBe("cocalc.ai");
    const route = { slug: "terminal", view: "detail" } as const;
    const view = render(<PublicFeaturesApp initialRoute={route} />);
    expect(
      screen.getAllByRole("link", { name: COCALC_AI_SIGN_UP_LABEL }),
    ).toHaveLength(2);
    // The sign-in state can arrive first, without the product.
    view.rerender(
      <PublicFeaturesApp
        config={{ is_authenticated: false }}
        initialRoute={route}
      />,
    );
    expect(
      screen.getAllByRole("link", { name: COCALC_AI_SIGN_UP_LABEL }),
    ).toHaveLength(2);
    view.rerender(
      <PublicFeaturesApp config={COCALC_AI} initialRoute={route} />,
    );
    expect(
      screen.getAllByRole("link", { name: COCALC_AI_SIGN_UP_LABEL }),
    ).toHaveLength(2);
  });

  it("keeps Home signup available while waiting for the product configuration", () => {
    const view = render(<PublicHomeApp />);
    const hero = () => screen.getByRole("region", { name: /hero$/ });
    const expectUnresolvedHome = () => {
      expect(
        within(hero()).getByRole("link", { name: PUBLIC_SIGN_UP_LABEL }),
      ).toHaveAttribute("href", "/auth/sign-up");
      expect(
        within(hero()).getByRole("heading", { level: 1 }),
      ).toHaveTextContent("Build and use software.");
      expect(within(hero()).queryByRole("img")).toBeNull();
      expect(screen.queryByRole("link", { name: "Agent Networks" })).toBeNull();
    };
    expectUnresolvedHome();
    view.rerender(<PublicHomeApp config={{ is_authenticated: false }} />);
    expectUnresolvedHome();
    view.rerender(<PublicHomeApp config={COCALC_AI} />);
    expect(
      within(hero()).getByRole("link", { name: COCALC_AI_SIGN_UP_LABEL }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(within(hero()).getByRole("img")).toHaveAttribute(
      "src",
      "/public/docs/agent-new-form-20261015.jpg",
    );
  });

  it("follows the product once it is known", () => {
    render(
      <PublicHomeApp
        config={{
          cocalc_product: "rocket",
          dns: "cocalc.ai",
          site_name: "CoCalc",
        }}
      />,
    );
    expect(
      within(screen.getByRole("region", { name: /hero$/ })).getByRole("link", {
        name: PUBLIC_SIGN_UP_LABEL,
      }),
    ).toHaveAttribute("href", "/auth/sign-up");
  });
});
