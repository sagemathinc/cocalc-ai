/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

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
