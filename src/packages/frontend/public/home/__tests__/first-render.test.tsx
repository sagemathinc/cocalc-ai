/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://cocalc.ai/"}
 */

import { render, screen, within } from "@testing-library/react";
import { PUBLIC_SIGN_UP_LABEL } from "@cocalc/util/public-site-policy";
import PublicHomeApp from "../app";
import { installMatchMediaStub } from "../../__tests__/test-helpers";

beforeAll(installMatchMediaStub);

function hero(name = "CoCalc") {
  return screen.getByRole("region", { name: `${name} hero` });
}

function expectUnresolvedProduct() {
  expect(within(hero()).getByRole("heading", { level: 1 })).toHaveTextContent(
    "Build and use software.",
  );
  expect(within(hero()).queryByRole("img")).toBeNull();
  expect(
    within(hero()).queryByRole("link", {
      name: /Start on CoCalc.ai|Open your agents/,
    }),
  ).toBeNull();
  expect(
    within(hero()).getByRole("link", { name: "Explore the tools" }),
  ).toHaveAttribute("href", "/features");
  expect(
    within(hero()).getByRole("link", { name: PUBLIC_SIGN_UP_LABEL }),
  ).toHaveAttribute("href", "/auth/sign-up");
  expect(screen.queryByRole("link", { name: "Agent Networks" })).toBeNull();
  expect(screen.queryByText(/Use Codex or Claude with the access/)).toBeNull();
}

describe("PublicHomeApp first render on cocalc.ai", () => {
  it.each(["cocalc.ai", "workspace.example.com"])(
    "keeps signed-in projects reachable before the product is known on %s",
    (dns) => {
      render(<PublicHomeApp config={{ dns, is_authenticated: true }} />);
      expect(
        within(hero()).getByRole("link", { name: "Open projects" }),
      ).toHaveAttribute("href", "/projects");
      expect(
        within(hero()).queryByRole("link", { name: PUBLIC_SIGN_UP_LABEL }),
      ).toBeNull();
      expect(within(hero()).queryByRole("img")).toBeNull();
    },
  );
  it("keeps canonical sign-up usable without inferring AI capabilities from the hostname", () => {
    expect(window.location.host).toBe("cocalc.ai");
    const view = render(<PublicHomeApp />);
    expectUnresolvedProduct();
    view.rerender(
      <PublicHomeApp
        config={{ site_name: "CoCalc", is_authenticated: false }}
      />,
    );
    expectUnresolvedProduct();
    view.rerender(
      <PublicHomeApp
        config={{ site_name: "CoCalc", cocalc_product: "launchpad" }}
      />,
    );
    expect(within(hero()).getByRole("heading", { level: 1 })).toHaveTextContent(
      "Build and use software with AI.",
    );
    expect(
      within(hero()).getByRole("link", { name: "Start on CoCalc.ai" }),
    ).toHaveAttribute("href", "/auth/sign-up");
    expect(within(hero()).getByRole("img")).toHaveAttribute(
      "src",
      "/public/docs/agent-new-form-20261015.jpg",
    );
  });

  it.each<[{ site_name: string; logo_square?: string }, string]>([
    [{ site_name: "University CoCalc" }, "University CoCalc"],
    [{ site_name: "CoCalc", logo_square: "/custom-logo.svg" }, "CoCalc"],
  ])(
    "keeps custom branding and provider choices when configuration arrives: %j",
    (branding, name) => {
      const view = render(<PublicHomeApp />);
      expectUnresolvedProduct();
      view.rerender(
        <PublicHomeApp
          config={{
            ...branding,
            cocalc_product: "launchpad",
            policy_pages: "custom",
          }}
        />,
      );
      expect(
        within(hero(name)).getByRole("link", { name: PUBLIC_SIGN_UP_LABEL }),
      ).toHaveAttribute("href", "/auth/sign-up");
      expect(
        within(hero(name)).queryByRole("link", { name: "Start on CoCalc.ai" }),
      ).toBeNull();
      expect(
        screen.queryByText(/Use Codex or Claude with the access/),
      ).toBeNull();
      expect(
        screen.queryByRole("link", { name: "Compare memberships" }),
      ).toBeNull();
    },
  );

  it("does not briefly advertise the agent entry when the resolved account disables AI", () => {
    const view = render(<PublicHomeApp />);
    expectUnresolvedProduct();
    view.rerender(
      <PublicHomeApp
        config={{
          site_name: "CoCalc",
          cocalc_product: "launchpad",
          is_authenticated: true,
          openai_disabled: true,
        }}
      />,
    );
    expect(within(hero()).getByRole("heading", { level: 1 })).toHaveTextContent(
      "Build and use software.",
    );
    expect(
      within(hero()).getByRole("link", { name: "Open projects" }),
    ).toHaveAttribute("href", "/projects");
    expect(within(hero()).queryByRole("img")).toBeNull();
    expect(screen.queryByRole("link", { name: "Agent Networks" })).toBeNull();
  });
});
