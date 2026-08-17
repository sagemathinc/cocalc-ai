import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { getAuthBootstrap } from "./api";
import { UltraliteApp } from "./app";
import { ESSENTIAL_THEME_STORAGE_KEY } from "./theme";

jest.mock("./api", () => ({ getAuthBootstrap: jest.fn() }));

const getAuthBootstrapMock = jest.mocked(getAuthBootstrap);

beforeEach(() => {
  window.localStorage.clear();
});

test("exposes the lightweight shell navigation before authentication", async () => {
  getAuthBootstrapMock.mockResolvedValue({ signed_in: false });
  render(<UltraliteApp />);

  expect(screen.getByRole("link", { name: "CoCalc home" })).toHaveAttribute(
    "href",
    "/",
  );
  expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
    "href",
    "/essential/projects",
  );
  expect(screen.getByRole("link", { name: "Full CoCalc" })).toBeVisible();
  expect(
    await screen.findByRole("heading", { name: "Sign in to continue" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open CoCalc to sign in" }),
  ).toBeVisible();
});

test("reports bootstrap failures and offers a retry", async () => {
  getAuthBootstrapMock.mockRejectedValue(new Error("offline"));
  render(<UltraliteApp />);

  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("follows the system theme and exposes a persistent upper-right control", () => {
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: jest.fn().mockReturnValue({
      addEventListener: jest.fn(),
      matches: true,
      media: "(prefers-color-scheme: dark)",
      removeEventListener: jest.fn(),
    }),
  });
  getAuthBootstrapMock.mockResolvedValue({ signed_in: false });
  render(<UltraliteApp />);

  const control = screen.getByRole("combobox", { name: "Color theme" });
  const app = control.closest(".ul-app");
  expect(control).toHaveValue("system");
  expect(app).toHaveAttribute("data-ul-theme", "dark");
  control.focus();
  expect(control).toHaveFocus();

  fireEvent.change(control, { target: { value: "light" } });
  expect(app).toHaveAttribute("data-ul-theme", "light");
  expect(window.localStorage.getItem(ESSENTIAL_THEME_STORAGE_KEY)).toBe(
    "light",
  );

  fireEvent.change(control, { target: { value: "system" } });
  expect(app).toHaveAttribute("data-ul-theme", "dark");
  expect(window.localStorage.getItem(ESSENTIAL_THEME_STORAGE_KEY)).toBeNull();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: originalMatchMedia,
  });
});
