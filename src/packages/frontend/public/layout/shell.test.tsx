/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";

import { PublicCard, PublicGrid, PublicPage, PublicSection } from "./shell";

describe("PublicPage", () => {
  it("renders the shared page title when provided", () => {
    render(
      <PublicPage config={{ site_name: "Launchpad" }} title="About Launchpad">
        Body
      </PublicPage>,
    );

    expect(
      screen.getByRole("heading", { name: "About Launchpad" }),
    ).not.toBeNull();
  });

  it("omits the shared page title when not provided", () => {
    render(<PublicPage config={{ site_name: "Launchpad" }}>Body</PublicPage>);

    expect(screen.queryByRole("heading", { name: "Launchpad" })).toBeNull();
    expect(screen.getByText("Body")).not.toBeNull();
  });

  it("renders the shared footer navigation", () => {
    render(
      <PublicPage
        config={{
          help_email: "help@example.com",
          policy_pages: "sagemathinc",
          site_name: "CoCalc",
        }}
      >
        Body
      </PublicPage>,
    );

    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("Platform")).not.toBeNull();
    expect(within(footer).getByText("Resources")).not.toBeNull();
    expect(within(footer).getByText("Company")).not.toBeNull();
    expect(
      within(footer).getByRole("link", { name: "Features" }),
    ).toHaveAttribute("href", "/features");
    expect(
      within(footer).getByRole("link", { name: "Products" }),
    ).toHaveAttribute("href", "/products");
    expect(
      within(footer).getByRole("link", { name: "Pricing" }),
    ).toHaveAttribute("href", "/pricing");
    expect(
      within(footer).getByRole("link", { name: "Documentation" }),
    ).toHaveAttribute("target", "_blank");
    expect(
      within(footer).getByRole("link", { name: "Support" }),
    ).toHaveAttribute("href", "/support");
    expect(
      within(footer).getByRole("link", { name: "Status" }),
    ).toHaveAttribute("href", "/support/status");
    expect(within(footer).getByRole("link", { name: "About" })).toHaveAttribute(
      "href",
      "/about",
    );
    expect(
      within(footer).getByRole("link", { name: "Contact" }),
    ).toHaveAttribute("href", "mailto:help@example.com");
    expect(
      within(footer).getByRole("link", { name: "Policies" }),
    ).toHaveAttribute("href", "/policies");
  });

  it("uses the CoCalc wordmark in the footer for default branding", () => {
    render(
      <PublicPage config={{ logo_square: "", site_name: "CoCalc" }}>
        Body
      </PublicPage>,
    );

    const footer = screen.getByRole("contentinfo");
    expect(
      within(footer)
        .getByRole("link", { name: "CoCalc home" })
        .querySelectorAll("img").length,
    ).toBe(2);
  });

  it("uses the custom brand in the footer for custom branding", () => {
    render(
      <PublicPage
        config={{ logo_square: "/custom-logo.svg", site_name: "Custom Site" }}
      >
        Body
      </PublicPage>,
    );

    const footer = screen.getByRole("contentinfo");
    const homeLink = within(footer).getByRole("link", {
      name: "Custom Site home",
    });
    const images = homeLink.querySelectorAll("img");
    expect(images.length).toBe(1);
    expect(images[0].getAttribute("src")).toBe("/custom-logo.svg");
    expect(within(footer).getByText("Custom Site")).not.toBeNull();
  });

  it("falls back to support for contact when no email is configured", () => {
    render(<PublicPage config={{ site_name: "Launchpad" }}>Body</PublicPage>);

    const footer = screen.getByRole("contentinfo");
    expect(
      within(footer).getByRole("link", { name: "Contact" }),
    ).toHaveAttribute("href", "/support");
  });

  it("hides policies when there is no policy destination", () => {
    render(
      <PublicPage
        config={
          {
            policy_pages: "none",
            show_policies: true,
            site_name: "Launchpad",
          } as any
        }
      >
        Body
      </PublicPage>,
    );

    const footer = screen.getByRole("contentinfo");
    expect(within(footer).queryByRole("link", { name: "Policies" })).toBeNull();
  });

  it("links policies to the external policy URL when configured", () => {
    render(
      <PublicPage
        config={{
          policy_pages: "none",
          site_name: "Launchpad",
          terms_of_service_url: "https://example.com/policies",
        }}
      >
        Body
      </PublicPage>,
    );

    const footer = screen.getByRole("contentinfo");
    expect(
      within(footer).getByRole("link", { name: "Policies" }),
    ).toHaveAttribute("href", "https://example.com/policies");
  });
});

describe("PublicSection", () => {
  it("renders a standard title when provided", () => {
    render(<PublicSection title="Overview Card">Body</PublicSection>);

    expect(screen.getByText("Overview Card")).not.toBeNull();
    expect(screen.getByText("Body")).not.toBeNull();
  });
});

describe("PublicCard", () => {
  it("renders as a link when href is provided", () => {
    render(
      <PublicCard href="/products/cocalc-plus" title="CoCalc Plus">
        Body
      </PublicCard>,
    );

    expect(screen.getByRole("link", { name: /CoCalc Plus/i })).not.toBeNull();
  });
});

describe("PublicGrid", () => {
  it("renders children inside a shared grid wrapper", () => {
    const { container } = render(
      <PublicGrid columns={3}>
        <div>First</div>
        <div>Second</div>
      </PublicGrid>,
    );

    expect(screen.getByText("First")).not.toBeNull();
    expect(screen.getByText("Second")).not.toBeNull();
    expect(container.querySelectorAll(".ant-col").length).toBe(2);
  });
});
