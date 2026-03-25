/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

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
});

describe("PublicHomeApp", () => {
  it("renders the top nav and major landing sections", () => {
    render(
      <PublicHomeApp
        config={{ site_name: "Launchpad", site_description: "Hello world" }}
        initialNews={[
          {
            channel: "blog",
            date: 1700000000,
            id: 1,
            tags: ["launch"],
            text: "This is a **news** item.",
            title: "Launch update",
          } as any,
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Home" })).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Popular Features" }),
    ).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Recent News" })).not.toBeNull();
  });

  it("shows direct app actions when authenticated", () => {
    render(
      <PublicHomeApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Open projects" })).not.toBeNull();
    expect(screen.getAllByRole("link", { name: "Settings" })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });
});
