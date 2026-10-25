/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import {
  COCALC_AI_SIGN_UP_LABEL,
  PUBLIC_SIGN_UP_LABEL,
} from "@cocalc/util/public-site-policy";
import { PUBLIC_HOME_SECTION_TITLES } from "@cocalc/util/public-home-content";
import { PublicNextStep } from "../common";
import { type PublicConfig, PublicConfigProvider } from "../config";
import PublicFeaturesApp from "../features/app";
import PublicHomeApp from "../home/app";

// Copy that names CoCalc.ai as the place to start shows only on cocalc.ai:
// CoCalc Launchpad on the canonical host. The crawler fallback test
// (hub/servers/app/public-prerender-sign-up.test.ts) uses the same sites and
// expects the same sign-up labels.
const SITES: { config: PublicConfig; name: string; onCocalcAi: boolean }[] = [
  {
    // cocalc.ai's /customize reports the Launchpad product.
    config: {
      cocalc_product: "launchpad",
      dns: "cocalc.ai",
      is_launchpad: true,
      site_name: "CoCalc",
    },
    name: "cocalc.ai",
    onCocalcAi: true,
  },
  {
    config: {
      cocalc_product: "launchpad",
      dns: "compute.example.edu",
      is_launchpad: true,
      site_name: "CoCalc Launchpad",
    },
    name: "another Launchpad host",
    onCocalcAi: false,
  },
  {
    config: {
      cocalc_product: "rocket",
      dns: "cocalc.example.com",
      site_name: "Example Compute",
    },
    name: "a Rocket site",
    onCocalcAi: false,
  },
  {
    config: { cocalc_product: "rocket", dns: "cocalc.ai", site_name: "CoCalc" },
    name: "Rocket on the canonical host",
    onCocalcAi: false,
  },
  {
    config: {
      cocalc_product: "plus",
      dns: "localhost:5000",
      site_name: "CoCalc Plus",
    },
    name: "CoCalc Plus",
    onCocalcAi: false,
  },
];

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

// Whether text in `scope`, apart from its links, names CoCalc.ai. The sign-up
// labels are checked exactly; the prose around them is not, so a routine copy
// edit needs no test change.
function namesCocalcAi(scope: HTMLElement): boolean {
  return within(scope)
    .queryAllByText(/CoCalc\.ai/)
    .some((element) => element.closest("a") == null);
}

function expectSignUpLinks(
  container: HTMLElement,
  label: string,
  href: string,
  count: number,
) {
  const links = within(container).getAllByRole("link", { name: label });
  expect(links).toHaveLength(count);
  for (const link of links) {
    expect(link).toHaveAttribute("href", href);
  }
}

describe.each(SITES)("sign-up copy on $name", ({ config, onCocalcAi }) => {
  const label = onCocalcAi ? COCALC_AI_SIGN_UP_LABEL : PUBLIC_SIGN_UP_LABEL;

  it("labels both Terminal sign-up links for the site", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={config}
        initialRoute={{ slug: "terminal", view: "detail" }}
      />,
    );
    expectSignUpLinks(container, label, "/auth/sign-up?intent=code", 2);
    if (!onCocalcAi) {
      expect(
        screen.queryByRole("link", { name: COCALC_AI_SIGN_UP_LABEL }),
      ).toBeNull();
    }
  });

  it("names CoCalc.ai in the Jupyter page's final action only on cocalc.ai", () => {
    const { container } = render(
      <PublicFeaturesApp
        config={config}
        initialRoute={{ slug: "jupyter-notebook", view: "detail" }}
      />,
    );
    const action = container.querySelector<HTMLElement>(
      ".cocalc-feature-final-panel",
    );
    expect(action).not.toBeNull();
    expect(namesCocalcAi(action!)).toBe(onCocalcAi);
  });

  it("routes the Home hero and final action for the site's product", () => {
    render(<PublicHomeApp config={config} />);
    const plus = config.cocalc_product === "plus";
    const actionLabel = plus ? "Open your project" : label;
    const actionHref = plus ? "/projects" : "/auth/sign-up";
    for (const section of [
      screen.getByRole("region", { name: /hero$/ }),
      screen.getByRole("region", { name: PUBLIC_HOME_SECTION_TITLES.final }),
    ]) {
      expectSignUpLinks(section, actionLabel, actionHref, 1);
      if (plus) {
        expect(
          within(section).queryByRole("link", { name: PUBLIC_SIGN_UP_LABEL }),
        ).toBeNull();
      }
    }
    if (!onCocalcAi) {
      expect(
        screen.queryByRole("link", { name: COCALC_AI_SIGN_UP_LABEL }),
      ).toBeNull();
    }
  });

  it("labels the shared next step for the site", () => {
    const { container } = render(
      <PublicConfigProvider config={config}>
        <PublicNextStep />
      </PublicConfigProvider>,
    );
    expectSignUpLinks(container, label, "/auth/sign-up", 1);
  });
});

// jsdom's host is localhost, which is not cocalc.ai. The first-render test
// covers the canonical host.
describe("sign-up copy before the configuration arrives", () => {
  it("uses the default label on a host that is not cocalc.ai", () => {
    const terminal = render(
      <PublicFeaturesApp initialRoute={{ slug: "terminal", view: "detail" }} />,
    );
    expectSignUpLinks(
      terminal.container,
      PUBLIC_SIGN_UP_LABEL,
      "/auth/sign-up?intent=code",
      2,
    );
    terminal.unmount();

    render(<PublicHomeApp />);
    const hero = screen.getByRole("region", { name: /hero$/ });
    expect(
      within(hero).getByRole("link", { name: "Explore the tools" }),
    ).toHaveAttribute("href", "/features");
    for (const section of [
      hero,
      screen.getByRole("region", { name: PUBLIC_HOME_SECTION_TITLES.final }),
    ]) {
      expect(
        within(section).queryByRole("link", { name: PUBLIC_SIGN_UP_LABEL }),
      ).toBeNull();
      expect(namesCocalcAi(section)).toBe(false);
    }
  });

  it("keeps showing projects to signed-in visitors on every site", () => {
    for (const { config } of SITES) {
      const view = render(
        <PublicConfigProvider config={{ ...config, is_authenticated: true }}>
          <PublicNextStep authenticated />
        </PublicConfigProvider>,
      );
      expect(
        screen.getByRole("link", { name: "Open projects" }),
      ).toHaveAttribute("href", "/projects");
      expect(
        screen.queryByRole("link", { name: COCALC_AI_SIGN_UP_LABEL }),
      ).toBeNull();
      view.unmount();
    }
  });
});
