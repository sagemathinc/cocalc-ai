/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import PublicFeaturesApp from "../app";
import { featurePath, getFeaturesRouteFromPath } from "../routes";

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
      screen.getByRole("heading", { name: "Launchpad features" }),
    ).not.toBeNull();
    expect(screen.getByText("Jupyter Notebooks")).not.toBeNull();
    expect(screen.getByText("Linux Terminal")).not.toBeNull();
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
        name: "Coding Agents and AI Assistance",
        level: 1,
      }),
    ).not.toBeNull();
    expect(screen.getByText("Agent-native workflows")).not.toBeNull();
    expect(screen.getByText("Create account")).not.toBeNull();
  });
});
