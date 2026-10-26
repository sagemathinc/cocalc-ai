/** @jest-environment jsdom */

import { lazy, Suspense } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import PublicApp from "../app";
import { PublicRouteErrorBoundary } from "../route-error-boundary";
import type { PublicRoute } from "../routes";

const mockDocsView = jest.fn();
jest.mock("../docs/app", () => ({
  __esModule: true,
  default: (props) => mockDocsView(props),
}));
jest.mock("../home/app", () => ({
  __esModule: true,
  default: () => <h1>Home content</h1>,
}));
jest.mock("@cocalc/frontend/auth/api", () => ({
  getControlPlaneAuthBootstrap: jest.fn(() => new Promise(() => {})),
}));

const docsRoute = (slug = "files/timetravel"): PublicRoute => ({
  section: "docs",
  route: { view: "docs-detail", slug },
});
const renderOptions = { onCaughtError: () => {} };

beforeEach(() => {
  mockDocsView.mockReset();
  mockDocsView.mockImplementation(() => <h1>Document content</h1>);
  document.head
    .querySelectorAll("[data-cocalc-public-route-meta]")
    .forEach((element) => element.remove());
});

afterEach(() => {
  jest.restoreAllMocks();
});

it("keeps the public route metadata when a document fails without exposing exception details", async () => {
  document.title = "Server documentation title";
  mockDocsView.mockImplementation(() => {
    throw new Error(
      "private failure at https://example.invalid/internal.js?token=hidden",
    );
  });
  render(
    <PublicApp config={{ site_name: "CoCalc" }} initialRoute={docsRoute()} />,
    renderOptions,
  );

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("This page could not be displayed.");
  expect(screen.getByRole("button", { name: "Reload page" })).toBeEnabled();
  expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute(
    "href",
    "/",
  );
  expect(document.body).not.toHaveTextContent(
    /private failure|internal\.js|token=hidden/,
  );
  expect(
    document.head.querySelector(
      'link[data-cocalc-public-route-meta="canonical"]',
    ),
  ).toHaveAttribute("href", `${window.location.origin}/docs/files/timetravel`);
  expect(document.title).toBe("Server documentation title");
  expect(
    document.head.querySelector('meta[property="og:title"]'),
  ).toHaveAttribute("content", expect.stringContaining("TimeTravel"));
});

it("does not retry for config updates but recovers when navigating within a section", async () => {
  mockDocsView.mockImplementation(() => {
    throw new Error("failed document");
  });
  const { rerender } = render(
    <PublicApp config={{ site_name: "CoCalc" }} initialRoute={docsRoute()} />,
    renderOptions,
  );
  await screen.findByRole("alert");
  const attempts = mockDocsView.mock.calls.length;
  mockDocsView.mockImplementation(() => <h1>Next document</h1>);

  rerender(
    <PublicApp
      config={{ site_name: "CoCalc", is_authenticated: true }}
      initialRoute={docsRoute()}
    />,
  );
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(mockDocsView).toHaveBeenCalledTimes(attempts);

  rerender(
    <PublicApp
      config={{ site_name: "CoCalc" }}
      initialRoute={docsRoute("terminal/use-terminal")}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "Next document" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("recovers when navigating to another public section", async () => {
  mockDocsView.mockImplementation(() => {
    throw new Error("failed document");
  });
  const { rerender } = render(
    <PublicApp config={{ site_name: "CoCalc" }} initialRoute={docsRoute()} />,
    renderOptions,
  );
  await screen.findByRole("alert");
  rerender(
    <PublicApp
      config={{ site_name: "CoCalc" }}
      initialRoute={{ section: "home" }}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "Home content" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("catches a rejected lazy import without automatically retrying it", async () => {
  const load = jest.fn(() => Promise.reject(new Error("chunk request failed")));
  const FailedChunk = lazy(load);
  const failedPage = (route: PublicRoute) => (
    <PublicRouteErrorBoundary route={route}>
      <Suspense fallback={<p role="status">Loading document</p>}>
        <FailedChunk />
      </Suspense>
    </PublicRouteErrorBoundary>
  );
  const { rerender } = render(failedPage(docsRoute()), renderOptions);
  await screen.findByRole("alert");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(load).toHaveBeenCalledTimes(1);

  rerender(
    <PublicRouteErrorBoundary route={{ section: "home" }}>
      <h1>Healthy route</h1>
    </PublicRouteErrorBoundary>,
  );
  expect(
    screen.getByRole("heading", { name: "Healthy route" }),
  ).toBeInTheDocument();
  rerender(failedPage(docsRoute()));
  await screen.findByRole("alert");
  // React retains the rejection even after navigation remounts this subtree.
  expect(load).toHaveBeenCalledTimes(1);
});

it("offers keyboard navigation and reloads only on explicit activation", async () => {
  const user = userEvent.setup();
  const consoleError = jest
    .spyOn(console, "error")
    .mockImplementation(() => {});
  mockDocsView.mockImplementation(() => {
    throw new Error("failed document");
  });
  render(
    <PublicApp config={{ site_name: "CoCalc" }} initialRoute={docsRoute()} />,
    renderOptions,
  );
  await screen.findByRole("alert");
  expect(consoleError).not.toHaveBeenCalled();
  await user.tab();
  expect(screen.getByRole("button", { name: "Reload page" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("link", { name: "Go to Home" })).toHaveFocus();
  await user.tab({ shift: true });
  await user.keyboard("{Enter}");
  // JSDOM cannot perform a full page reload. Its navigation diagnostic proves
  // the real Location.reload API was called rather than a React-only retry.
  await waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
  expect(consoleError.mock.calls[0][0]).toMatchObject({
    message: "Not implemented: navigation (except hash changes)",
  });
  expect(consoleError.mock.calls[0][0].stack).toContain("LocationImpl.reload");
});

it("preserves healthy content and input state across equivalent route objects", async () => {
  const user = userEvent.setup();
  const page = () => (
    <PublicRouteErrorBoundary route={docsRoute()}>
      <label>
        Draft
        <input defaultValue="" />
      </label>
    </PublicRouteErrorBoundary>
  );
  const { rerender } = render(page());
  const input = screen.getByRole("textbox", { name: "Draft" });
  await user.type(input, "Keep this draft");
  rerender(page());
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
  expect(input).toHaveValue("Keep this draft");
  expect(input).toHaveFocus();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
