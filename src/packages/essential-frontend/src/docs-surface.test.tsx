/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { ESSENTIAL_ROUTE_CHANGE, parseRoute } from "./routes";
import DocsSurface, { essentialDocsHref } from "./docs-surface";

test("lists and searches the lightweight documentation", async () => {
  render(<DocsSurface route={{ kind: "docs" }} />);

  expect(screen.getByRole("heading", { name: "Essential Docs" })).toBeVisible();
  expect(screen.getAllByRole("link").length).toBeGreaterThan(10);

  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "custom jupyter kernels" },
  });
  expect(
    await screen.findByRole("link", { name: /Custom Jupyter kernels/ }),
  ).toHaveAttribute("href", "/essential/docs/jupyter/custom-kernels");
});

test("renders a documentation body without actions or images", () => {
  render(<DocsSurface route={{ kind: "docs", slug: "files/project-files" }} />);

  expect(
    screen.getByRole("heading", { name: "Work with project files" }),
  ).toBeVisible();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.queryByText("Open project files")).not.toBeInTheDocument();
});

test("rewrites full documentation links to Essential routes", () => {
  expect(essentialDocsHref("/docs/jupyter/create-notebook")).toBe(
    "/essential/docs/jupyter/create-notebook",
  );
  expect(essentialDocsHref("https://example.com/docs")).toBe(
    "https://example.com/docs",
  );
});

// Follow the same route-event bridge as App, including a newly parsed route
// for navigation to the current URL. Keep DocsSurface mounted across changes.
function RoutedDocs() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const update = () => setRoute(parseRoute());
    window.addEventListener(ESSENTIAL_ROUTE_CHANGE, update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener(ESSENTIAL_ROUTE_CHANGE, update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return route.kind === "docs" ? <DocsSurface route={route} /> : null;
}

async function findKernelResult() {
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "custom jupyter kernels" },
  });
  return screen.findByRole("link", { name: /Custom Jupyter kernels with uv/ });
}

test("opening a search result shows the article and keeps native links focusable", async () => {
  window.history.replaceState({}, "", "/essential/docs");
  render(<RoutedDocs />);
  const result = await findKernelResult();
  result.focus();
  expect(result).toHaveFocus();
  expect(result.tagName).toBe("A");
  // Native keyboard activation dispatches a click with detail zero. The real
  // browser check separately exercises Enter and the resulting focus order.
  fireEvent.click(result, { detail: 0 });
  expect(window.location.pathname).toBe(
    "/essential/docs/jupyter/custom-kernels",
  );
  expect(
    await screen.findByRole("heading", {
      name: "Custom Jupyter kernels with uv",
    }),
  ).toBeVisible();
  expect(screen.getByRole("searchbox")).toHaveValue("");
  const allDocs = screen.getByRole("link", { name: "All docs" });
  allDocs.focus();
  expect(allDocs).toHaveFocus();
  fireEvent.click(allDocs, { detail: 0 });
  expect(
    await screen.findByRole("region", { name: "Documentation pages" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Custom Jupyter kernels with uv" }),
  ).not.toBeInTheDocument();
});

test("opening a result for the current article also clears search", async () => {
  window.history.replaceState({}, "", "/essential/docs/jupyter/custom-kernels");
  render(<RoutedDocs />);
  fireEvent.click(await findKernelResult());
  expect(window.location.pathname).toBe(
    "/essential/docs/jupyter/custom-kernels",
  );
  expect(
    await screen.findByRole("heading", {
      name: "Custom Jupyter kernels with uv",
    }),
  ).toBeVisible();
  expect(screen.getByRole("searchbox")).toHaveValue("");
});

test("modified result clicks preserve the current search and route", async () => {
  window.history.replaceState({}, "", "/essential/docs");
  render(<RoutedDocs />);
  const result = await findKernelResult();
  // Prevent jsdom's unimplemented new-tab navigation after React handles it;
  // this listener does not intercept the component's modifier-key checks.
  const preventNativeNavigation = (event: Event) => event.preventDefault();
  document.addEventListener("click", preventNativeNavigation);
  try {
    fireEvent.click(result, { ctrlKey: true });
    fireEvent.click(result, { metaKey: true });
  } finally {
    document.removeEventListener("click", preventNativeNavigation);
  }
  expect(window.location.pathname).toBe("/essential/docs");
  expect(screen.getByRole("searchbox")).toHaveValue("custom jupyter kernels");
  expect(
    screen.getByRole("link", { name: /Custom Jupyter kernels with uv/ }),
  ).toBeVisible();
});

test("internal links and a browser history route show their article", async () => {
  window.history.replaceState(
    {},
    "",
    "/prefix/essential/docs/hosts/choose-compute",
  );
  render(<RoutedDocs />);
  fireEvent.click(screen.getByRole("link", { name: "Project host" }));
  expect(window.location.pathname).toBe(
    "/prefix/essential/docs/hosts/project-hosts",
  );
  expect(
    await screen.findByRole("heading", { name: "Use project hosts" }),
  ).toBeVisible();
  await findKernelResult();
  window.history.replaceState(
    {},
    "",
    "/prefix/essential/docs/hosts/choose-compute",
  );
  fireEvent.popState(window);
  await waitFor(() => expect(screen.getByRole("searchbox")).toHaveValue(""));
  expect(
    screen.getByRole("heading", { name: "Choose compute for research" }),
  ).toBeVisible();
});
