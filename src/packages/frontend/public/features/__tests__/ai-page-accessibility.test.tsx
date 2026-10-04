/** @jest-environment jsdom */

/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";

import { getPublicColors } from "@cocalc/frontend/public/theme";
import AIFeaturePage from "../ai-page";

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

function renderAiPage() {
  return render(<AIFeaturePage />);
}

function luminance(color: string): number {
  const hex = color === "white" ? "#ffffff" : color;
  const [red, green, blue] = hex
    .slice(1)
    .match(/../g)!
    .map((value) => {
      const channel = parseInt(value, 16) / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("AI feature page accessibility", () => {
  it("skips no heading level", () => {
    const { container } = renderAiPage();
    const levels = Array.from(
      container.querySelectorAll("h1, h2, h3, h4, h5, h6"),
      (heading) => Number(heading.tagName.slice(1)),
    );

    // The page shell renders the h1, so the page starts at h2.
    expect(levels[0]).toBe(2);
    levels.slice(1).forEach((level, index) => {
      expect(level).toBeLessThanOrEqual(levels[index] + 1);
    });
  });

  it("makes the card titles h3 headings at the h4 size", () => {
    renderAiPage();

    for (const name of [
      "Start with the project",
      "Project hosts",
      "Remote kernels",
      "Hosted CoCalc.ai",
    ]) {
      expect(screen.getByRole("heading", { level: 3, name })).toHaveStyle({
        fontSize: "20px",
      });
    }
  });

  it.each(["light", "dark"] as const)(
    "gives the section labels AA text contrast in %s mode",
    (mode) => {
      const { container } = renderAiPage();
      expect(
        screen
          .getByText("Direct, inspect, and continue agent work")
          .closest(".feature-ai-eyebrow"),
      ).not.toBeNull();

      const css = Array.from(
        container.querySelectorAll("style"),
        (style) => style.textContent ?? "",
      ).join("\n");
      const rule = css.match(/\.feature-ai-eyebrow \{([^}]*)\}/)?.[1] ?? "";
      const token = rule.match(/\bcolor: var\(--cocalc-public-(\w+)\);/)?.[1];
      expect(token).toBeDefined();

      const colors = getPublicColors(mode);
      const foreground = colors[token as keyof typeof colors];
      // The labels sit on the page, on white panels, and on the blue tint
      // that ends the hero and compute gradients.
      for (const background of [
        colors.pageBackground,
        colors.surface,
        colors.brandTint,
      ]) {
        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
