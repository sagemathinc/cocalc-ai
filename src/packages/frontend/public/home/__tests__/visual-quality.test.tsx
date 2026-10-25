/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import PublicHomeApp from "../app";
import {
  getInjectedCss,
  HERO_H1_MAX,
  installMatchMediaStub,
  INTERNAL_IMPLEMENTATION_TERMS,
  SECTION_H2_MAX,
  STALE_REPETITIVE_HOME_LINES,
  textLength,
} from "../../__tests__/test-helpers";

beforeAll(installMatchMediaStub);

function renderHome() {
  return render(
    <PublicHomeApp
      config={{
        cocalc_product: "launchpad",
        dns: "cocalc.ai",
        site_name: "CoCalc",
      }}
    />,
  );
}

// These are semantic/content regression guards. jsdom does not establish
// pixel quality, actual reflow, contrast or real 200% browser zoom.
describe("PublicHomeApp review-reference guards", () => {
  it("retains the welcome image and broad first impression rather than a specialized example", () => {
    const { container } = renderHome();
    const hero = screen.getByRole("region", { name: "CoCalc hero" });
    const image = within(hero).getByRole("img");
    expect(image).toHaveAttribute(
      "src",
      "/public/docs/agent-new-form-20261015.jpg",
    );
    expect(image).toHaveAttribute("width", "884");
    expect(image).toHaveAttribute("height", "280");
    expect(image).toHaveAccessibleName(/form for a new agent/i);
    expect(hero.querySelector("figcaption")).toBeNull();
    expect(within(hero).queryByRole("list")).toBeNull();
    expect(hero.textContent).not.toMatch(
      /dispatch|cooling|notebook|synthetic|since 2013/i,
    );
    expect(container.textContent).not.toMatch(
      /experimental preview|Concept diagram|not a product capture/i,
    );
    expect(container.textContent).not.toMatch(
      /Codex and Claude Code in one project|Collaborators see edits live|Restore earlier versions/,
    );
  });

  it("keeps the story's section order and accessible heading associations", () => {
    const { container } = renderHome();
    const sections = Array.from(
      container.querySelectorAll(".cocalc-home > section"),
    );
    expect(sections.map((section) => section.id)).toEqual([
      "home-hero",
      "home-process",
      "home-platform",
      "home-paths",
      "home-evaluate",
      "home-run",
      "home-final",
    ]);
    for (const section of sections) {
      expect(section).toHaveAccessibleName();
      if (section.id !== "home-hero") {
        const heading = section.querySelector("h2");
        expect(heading).not.toBeNull();
        expect(section.getAttribute("aria-labelledby")).toBe(heading!.id);
        expect(textLength(heading!)).toBeLessThanOrEqual(SECTION_H2_MAX);
      }
    }
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(textLength(headings[0])).toBeLessThanOrEqual(HERO_H1_MAX);
    expect(container.textContent).not.toMatch(INTERNAL_IMPLEMENTATION_TERMS);
    expect(container.textContent).not.toMatch(STALE_REPETITIVE_HOME_LINES);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("provides fluid image sizing and visible keyboard focus without locking the hero height", () => {
    const { container } = renderHome();
    const css = getInjectedCss(container);
    const imageRules = css.match(/\.cocalc-home-figure img\s*\{([^}]+)\}/)?.[1];
    expect(imageRules).toMatch(/width:\s*100%/);
    expect(imageRules).toMatch(/height:\s*auto/);
    expect(css).toContain(".cocalc-home a:focus-visible");
    expect(css).toContain(".cocalc-home summary:focus-visible");
    const hero = screen.getByRole("region", { name: "CoCalc hero" });
    expect(hero.style.height).toBe("");
    expect(within(hero).getByRole("img").style.height).toBe("");
  });
});
