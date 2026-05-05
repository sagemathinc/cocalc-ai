/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";

import PublicHomeApp from "../app";

const originalFetch = global.fetch;

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
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders the top nav and major landing sections", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => [
        {
          channel: "blog",
          date: 1700000000,
          id: 1,
          tags: ["launch"],
          text: "This is a **news** item.",
          title: "Launch update",
        },
      ],
    }) as typeof fetch;
    render(
      <PublicHomeApp
        config={{ site_name: "Launchpad", site_description: "Hello world" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Launchpad home" })).not.toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "CoCalc AI is becoming agent-first",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Core workflows" }),
    ).not.toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Recent News" }),
      ).not.toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: "Patchflow" }).getAttribute("href"),
    ).toBe("https://github.com/sagemathinc/patchflow");
    expect(
      screen.getByRole("link", { name: "CoCalc Plus" }).getAttribute("href"),
    ).toBe("/products/cocalc-plus");
    expect(
      screen
        .getAllByRole("link", { name: "Launchpad" })
        .some(
          (link) =>
            link.getAttribute("href") ===
            "https://software.cocalc.ai/software/cocalc-launchpad/index.html",
        ),
    ).toBe(true);
    expect(screen.queryByText("Open page")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: /Jupyter Notebooks/i })
        .getAttribute("href"),
    ).toBe("/features/jupyter-notebook");
    expect(screen.getByRole("link", { name: "All news..." })).not.toBeNull();
  });

  it("shows direct app actions when authenticated", () => {
    global.fetch = jest.fn(
      () => new Promise<Response>(() => undefined),
    ) as typeof fetch;
    render(
      <PublicHomeApp
        config={{ is_authenticated: true, site_name: "Launchpad" }}
      />,
    );

    expect(screen.getAllByRole("link", { name: "Open projects" })).toHaveLength(
      1,
    );
    expect(
      screen.getAllByRole("link", { name: "Settings" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });
});
