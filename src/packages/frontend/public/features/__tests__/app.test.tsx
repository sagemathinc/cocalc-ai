/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import PublicFeaturesApp from "../app";
import { featurePath, getFeaturesRouteFromPath } from "../routes";

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

describe("getFeaturesRouteFromPath", () => {
  it("supports the features index and detail routes", () => {
    expect(getFeaturesRouteFromPath(featurePath())).toEqual({ view: "index" });
    expect(getFeaturesRouteFromPath(featurePath("jupyter-notebook"))).toEqual({
      slug: "jupyter-notebook",
      view: "detail",
    });
  });
});

describe("PublicFeaturesApp", () => {
  it("renders the features index", () => {
    render(
      <PublicFeaturesApp
        config={{ site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad Features" }),
    ).not.toBeNull();
    expect(
      screen.getByText("The new direction is increasingly agent-first"),
    ).not.toBeNull();
    expect(screen.getByText("Jupyter Notebooks")).not.toBeNull();
    expect(screen.getByText("Linux Terminal")).not.toBeNull();
  });

  it("shows Projects but not Settings in the shared nav when authenticated", () => {
    render(
      <PublicFeaturesApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
        initialRoute={{ view: "index" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("renders a detail page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "ai", view: "detail" }}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Coding Agents and AI Assistance – Launchpad",
        level: 1,
      }),
    ).not.toBeNull();
    expect(
      screen.getByText("Code, explain, and fix in context"),
    ).not.toBeNull();
    expect(screen.getByText("Create account")).not.toBeNull();
  });

  it("renders the richer jupyter feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "jupyter-notebook", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("Jupyter notebooks made for teaching"),
    ).not.toBeNull();
    expect(
      screen.getByText("Managed kernels and practical compatibility"),
    ).not.toBeNull();
    expect(screen.getByText("Publishing notebooks")).not.toBeNull();
  });

  it("renders the richer terminal feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "terminal", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("A real Linux shell inside every project"),
    ).not.toBeNull();
    expect(
      screen.getByText("Realtime collaboration in the shell"),
    ).not.toBeNull();
  });

  it("renders the richer linux environment page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "linux", view: "detail" }}
      />,
    );

    expect(
      screen.getByText(
        "A browser-based Linux workspace for real technical projects",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Learn and use Linux without risking your own machine"),
    ).not.toBeNull();
  });

  it("renders the richer python feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "python", view: "detail" }}
      />,
    );

    expect(
      screen.getByText(
        "Run Python notebooks, scripts, and experiments in one shared environment",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Zero-setup Python for technical work"),
    ).not.toBeNull();
  });

  it("renders the richer whiteboard feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "whiteboard", view: "detail" }}
      />,
    );

    expect(
      screen.getByText(
        "An infinite collaborative canvas with code, math, and sketching",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("Built for interactive explanation"),
    ).not.toBeNull();
  });

  it.each([
    {
      slug: "sage",
      title: "Use SageMath online in the environment built by the same team",
      section: "Why SageMath fits naturally in CoCalc",
    },
    {
      slug: "julia",
      title: "Use Julia in notebooks, terminals, and project workflows",
      section: "Multiple ways to work with Julia",
    },
    {
      slug: "r-statistical-software",
      title:
        "Use R in notebooks, terminals, and reproducible document workflows",
      section: "Zero-setup R for teaching and analysis",
    },
    {
      slug: "octave",
      title:
        "Run Octave online in notebooks, terminals, or a graphical desktop",
      section: "Flexible Octave workflows",
    },
    {
      slug: "x11",
      title: "Run graphical Linux applications remotely in the browser",
      section: "Why X11 matters",
    },
  ])(
    "renders the richer $slug feature page",
    ({
      section,
      slug,
      title,
    }: {
      section: string;
      slug: string;
      title: string;
    }) => {
      render(
        <PublicFeaturesApp
          config={{ help_email: "help@example.com", site_name: "Launchpad" }}
          initialRoute={{ slug, view: "detail" }}
        />,
      );

      expect(screen.getByText(title)).not.toBeNull();
      expect(screen.getByText(section)).not.toBeNull();
    },
  );

  it("renders the compare feature page", () => {
    render(
      <PublicFeaturesApp
        config={{ help_email: "help@example.com", site_name: "Launchpad" }}
        initialRoute={{ slug: "compare", view: "detail" }}
      />,
    );

    expect(
      screen.getByText("Compare CoCalc by workflow, not by one checkbox"),
    ).not.toBeNull();
    expect(screen.getByText("How CoCalc compares by category")).not.toBeNull();
    expect(
      screen.getByText("Google Colab and quick notebook hosts"),
    ).not.toBeNull();
    expect(
      screen.getByText("AI agents now change the comparison"),
    ).not.toBeNull();
  });
});
