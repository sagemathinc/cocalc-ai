/** @jest-environment jsdom */

// Every version of Home in the experiment (util/public-home-experiment.ts),
// rendered through the Home app with a ?home= preview: the rules each version
// must keep.

import { fireEvent, render, screen } from "@testing-library/react";
import { PUBLIC_FEATURE_PAGES } from "@cocalc/util/public-feature-pages";
import { PUBLIC_HOME_VARIANTS } from "@cocalc/util/public-home-experiment";
import PublicHomeApp from "../app";

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
  (window as any).fetch = jest.fn(async () => ({ ok: true }));
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

const config = {
  cocalc_product: "launchpad",
  dns: "cocalc.ai",
  is_launchpad: true,
  site_name: "CoCalc Launchpad",
};

function renderVersion(id: string) {
  window.history.replaceState(null, "", `/?home=${id}`);
  return render(<PublicHomeApp config={config as any} />);
}

const FEATURE_SLUGS = new Set(PUBLIC_FEATURE_PAGES.map((page) => page.slug));

describe.each(PUBLIC_HOME_VARIANTS.filter((id) => id !== "default"))(
  "Home version %s",
  (id) => {
    it("names Codex, Claude Code, Jupyter, LaTeX and SageMath", () => {
      const { container } = renderVersion(id);
      // the version itself, not the default page
      expect(container.querySelector("h1")?.id).not.toBe("");
      const text = container.textContent ?? "";
      for (const name of [
        "Codex",
        "Claude Code",
        "Jupyter",
        "LaTeX",
        "SageMath",
      ]) {
        expect(text).toContain(name);
      }
    });

    it("has one h1, and images with alt text and dimensions", () => {
      const { container } = renderVersion(id);
      expect(container.querySelectorAll("h1")).toHaveLength(1);
      // The page's own images (the header and footer logos are decorative).
      const images = Array.from(container.querySelectorAll("img")).filter(
        (img) => !img.closest("header, footer"),
      );
      for (const img of images) {
        expect(
          `${img.getAttribute("src")}: ${img.getAttribute("alt")}`,
        ).toMatch(/: .{20,}/);
        expect(img.getAttribute("width")).toMatch(/^\d+$/);
        expect(img.getAttribute("height")).toMatch(/^\d+$/);
      }
    });

    it("links only to feature pages that exist", () => {
      const { container } = renderVersion(id);
      const slugs = Array.from(container.querySelectorAll("a"))
        .map((a) => a.getAttribute("href") ?? "")
        .map((href) => href.match(/\/features\/([^/?#]+)/)?.[1])
        .filter((slug): slug is string => !!slug);
      for (const slug of slugs) expect(FEATURE_SLUGS).toContain(slug);
    });

    it("claims no SOC 2 certification", () => {
      const { container } = renderVersion(id);
      expect(container.textContent).not.toMatch(
        /SOC ?2[^.]*(certified|compliant)/i,
      );
    });
  },
);

describe.each(["math", "demo"])("the %s version's formulas", (id) => {
  it("are MathML elements, built without HTML strings", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { container } = renderVersion(id);
      const formulas = Array.from(container.querySelectorAll("math"));
      expect(formulas.length).toBeGreaterThan(0);
      for (const formula of formulas) {
        expect(formula.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
        expect(formula.querySelector("mfrac, msup, mi")?.namespaceURI).toBe(
          "http://www.w3.org/1998/Math/MathML",
        );
      }
      // no React warnings (keys, unknown props)
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe("the demo version's examples", () => {
  it("switches examples by click and by arrow keys, one panel at a time", () => {
    renderVersion("demo");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    // Every tab controls a panel that exists; only the selected one shows.
    for (const tab of tabs) {
      const panel = document.getElementById(
        tab.getAttribute("aria-controls") ?? "",
      );
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    }
    const shown = () => screen.getAllByRole("tabpanel"); // hidden ones excluded
    expect(shown()).toHaveLength(1);
    expect(shown()[0].textContent).toContain("SageMath");

    fireEvent.click(tabs[1]);
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(shown()).toHaveLength(1);
    expect(shown()[0].textContent).toContain("thesis.tex");

    fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: "End" });
    expect(tabs[3].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[3], { key: "ArrowRight" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("tabindex")).toBe("0");
    expect(tabs[1].getAttribute("tabindex")).toBe("-1");
  });
});
