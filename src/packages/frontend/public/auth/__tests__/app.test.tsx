/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import PublicAuthApp, { getPublicAuthRouteFromPath } from "../app";
import { getPublicAuthRedirectTargetFromSearch } from "../bootstrap";

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

describe("getPublicAuthRouteFromPath", () => {
  it("supports auth and sso routes under a base path", () => {
    expect(getPublicAuthRouteFromPath("/auth/sign-in")).toEqual({
      kind: "auth-form",
      view: "sign-in",
    });
    expect(getPublicAuthRouteFromPath("/base/auth/sign-up")).toEqual({
      kind: "auth-form",
      view: "sign-up",
    });
    expect(getPublicAuthRouteFromPath("/base/auth/password-reset")).toEqual({
      kind: "auth-form",
      view: "password-reset",
    });
    expect(
      getPublicAuthRouteFromPath("/base/auth/password-reset/token-123"),
    ).toEqual({
      kind: "auth-password-reset-redeem",
      passwordResetId: "token-123",
    });
    expect(
      getPublicAuthRouteFromPath("/base/auth/verify/abc", "?email=x@y.z"),
    ).toEqual({
      email: "x@y.z",
      kind: "auth-verify-email",
      token: "abc",
    });
    expect(getPublicAuthRouteFromPath("/base/sso")).toEqual({
      kind: "sso-index",
    });
    expect(getPublicAuthRouteFromPath("/base/sso/example")).toEqual({
      id: "example",
      kind: "sso-detail",
    });
    expect(getPublicAuthRouteFromPath("/base/redeem")).toEqual({
      kind: "redeem",
    });
    expect(getPublicAuthRouteFromPath("/base/redeem/CODE12345")).toEqual({
      code: "CODE12345",
      kind: "redeem",
    });
  });
});

describe("getPublicAuthRedirectTargetFromSearch", () => {
  it("accepts safe app-relative targets", () => {
    expect(
      getPublicAuthRedirectTargetFromSearch(
        "?target=%2Fprojects%2Fproject-id%2Ffiles%2F%3Ffoo%3Dbar%23x",
      ),
    ).toBe("/projects/project-id/files/?foo=bar#x");
  });

  it("rejects external and auth-loop targets", () => {
    expect(
      getPublicAuthRedirectTargetFromSearch(
        "?target=https%3A%2F%2Fexample.com%2Fprojects",
      ),
    ).toBeUndefined();
    expect(
      getPublicAuthRedirectTargetFromSearch("?target=%2Fauth%2Fsign-in"),
    ).toBeUndefined();
    expect(
      getPublicAuthRedirectTargetFromSearch("?target=%2F%2Fevil.test"),
    ).toBeUndefined();
  });

  it("unwraps nested auth shell redirect targets", () => {
    expect(
      getPublicAuthRedirectTargetFromSearch(
        "?target=%2Fauth%2Fsign-in%3Ftarget%3D%252Fprojects%252Fproject-id",
      ),
    ).toBe("/projects/project-id");
  });
});

describe("PublicAuthApp", () => {
  it("renders the sign-up view without the app redux shell", () => {
    render(
      <PublicAuthApp
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
        initialRequiresToken={true}
        siteName="Launchpad"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Create your Launchpad account" }),
    ).not.toBeNull();
    expect(screen.getByText("Registration token")).not.toBeNull();
  });

  it("shows Projects but not Settings in the shared nav for authenticated users", () => {
    render(
      <PublicAuthApp
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
        isAuthenticated={true}
        siteName="Launchpad"
      />,
    );

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("renders the password reset done screen", () => {
    render(
      <PublicAuthApp
        initialRoute={{ kind: "auth-password-reset-done" }}
        siteName="Launchpad"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad password updated" }),
    ).not.toBeNull();
    expect(screen.getByText("Password updated")).not.toBeNull();
  });

  it("renders the sso index with provided strategies", () => {
    render(
      <PublicAuthApp
        initialRoute={{ kind: "sso-index" }}
        initialSSOStrategies={[
          {
            descr: "Use your Example account.",
            display: "Example SSO",
            domains: ["example.edu"],
            id: "example",
          },
        ]}
        siteName="Launchpad"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launchpad single sign-on" }),
    ).not.toBeNull();
    expect(screen.getByText("Example SSO")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Continue" })).not.toBeNull();
  });

  it("renders the public redeem view", () => {
    render(
      <PublicAuthApp
        initialRoute={{ code: "CODE12345", kind: "redeem" }}
        siteName="Launchpad"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Redeem voucher for Launchpad" }),
    ).not.toBeNull();
    expect(screen.getByDisplayValue("CODE12345")).not.toBeNull();
    expect(
      screen.getByText("Sign in or create an account to redeem this voucher"),
    ).not.toBeNull();
  });
});
