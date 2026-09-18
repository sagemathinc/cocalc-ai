/** @jest-environment jsdom */
import { render, screen, within } from "@testing-library/react";
import { PUBLIC_HOME_CONTENT as content } from "@cocalc/util/public-home-content";
import PublicHomeApp from "../app";
import {
  getInjectedCss,
  installMatchMediaStub,
} from "../../__tests__/test-helpers";

beforeAll(installMatchMediaStub);

describe("homepage readability and interaction", () => {
  it("keeps the first decision short and moves details behind links", () => {
    const { container } = render(
      <PublicHomeApp config={{ cocalc_product: "launchpad" }} />,
    );
    const home = container.querySelector(".cocalc-public-home")!;
    expect(home.querySelectorAll("h1")).toHaveLength(1);
    expect(home.querySelectorAll("h2")).toHaveLength(4);
    expect(content.hero.description.split(/\s+/).length).toBeLessThanOrEqual(
      40,
    );
    expect(
      home.querySelector(".cocalc-public-home-actions")?.querySelectorAll("a"),
    ).toHaveLength(2);
    for (const card of home.querySelectorAll(".cocalc-public-home-card")) {
      expect((card.textContent ?? "").split(/\s+/).length).toBeLessThanOrEqual(
        45,
      );
    }
  });

  it("keeps each workflow a keyboard-focusable link with no nested controls", () => {
    render(<PublicHomeApp config={{ cocalc_product: "launchpad" }} />);
    const region = screen.getByRole("region", { name: "Ways to use CoCalc" });
    for (const card of content.workflows.cards) {
      const link = within(region).getByRole("link", {
        name: new RegExp(card.title),
      });
      expect(link).toHaveAttribute("href", "/" + card.link.href);
      expect(link.querySelector("a,button,input")).toBeNull();
      link.focus();
      expect(link).toHaveFocus();
    }
  });

  it("provides a full-size original rather than making a crop the only evidence", () => {
    render(<PublicHomeApp />);
    const image = screen.getByRole("img", { name: content.hero.example.alt });
    expect(image).toHaveAttribute("src", "/" + content.hero.example.image);
    expect(image).toHaveAttribute("width", "1512");
    expect(image).toHaveAttribute("height", "1245");
    const original = screen.getByRole("link", {
      name: content.hero.example.fullSizeLabel,
    });
    expect(original).toHaveAttribute("href", image.getAttribute("src"));
    expect(original).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      screen.getByText(content.hero.example.description),
    ).toHaveTextContent("synthetic");
  });

  it("provides narrow-screen reflow and visible keyboard focus", () => {
    const { container } = render(<PublicHomeApp />);
    const css = getInjectedCss(container);
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("@media (max-width: 560px)");
    expect(css).toContain(".cocalc-public-home a:focus-visible");
    expect(css).toContain(".cocalc-public-home-final-actions .ant-btn");
  });
});
