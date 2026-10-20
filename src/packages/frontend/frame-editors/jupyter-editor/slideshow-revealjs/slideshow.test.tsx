/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";

const useProjectContentUrl = jest.fn();
jest.mock("@cocalc/frontend/project/use-project-content-url", () => ({
  useProjectContentUrl: (opts: any) => useProjectContentUrl(opts),
}));
jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>loading</div>,
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  Component: class {},
  rclass: (x: any) => x,
  rtypes: { immutable: { Map: null } },
}));

import { SlideshowFrame } from "./slideshow";

const PROJECT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => useProjectContentUrl.mockReset());

it("shows the slides on the content origin, sandboxed", () => {
  useProjectContentUrl.mockReturnValue({
    status: "ready",
    url: "https://p.h-x.content.test/_c/CAP/files/d/._nb.slides.html",
    expires_at: 0,
  });
  render(
    <SlideshowFrame project_id={PROJECT} path="/d/._nb.slides.html" url="/raw" />,
  );
  const frame = screen.getByTitle("Jupyter slideshow preview");
  expect(frame.getAttribute("src")).toBe(
    "https://p.h-x.content.test/_c/CAP/files/d/._nb.slides.html",
  );
  expect(frame.getAttribute("sandbox")).toBe(
    "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
  );
  expect(useProjectContentUrl).toHaveBeenCalledWith({
    project_id: PROJECT,
    path: "/d/._nb.slides.html",
    enabled: true,
  });
});

it("as before on sites without a content origin", () => {
  useProjectContentUrl.mockReturnValue({ status: "unavailable" });
  render(<SlideshowFrame project_id={PROJECT} path="/d/x.html" url="/raw" />);
  expect(
    screen.getByTitle("Jupyter slideshow preview").getAttribute("src"),
  ).toBe("/raw");
});

it("never frames the raw slides for a viewer", () => {
  useProjectContentUrl.mockReturnValue({ status: "no-access" });
  render(<SlideshowFrame project_id={PROJECT} path="/d/x.html" url="/raw" />);
  expect(screen.queryByTitle("Jupyter slideshow preview")).toBeNull();
});

it.each(["error", "loading"])("%s: never frames the raw slides", (status) => {
  useProjectContentUrl.mockReturnValue({ status });
  render(<SlideshowFrame project_id={PROJECT} path="/d/x.html" url="/raw" />);
  expect(screen.queryByTitle("Jupyter slideshow preview")).toBeNull();
});
