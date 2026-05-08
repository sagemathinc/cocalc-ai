/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import api from "@cocalc/frontend/client/api";
import type { PublicConfig } from "@cocalc/frontend/public/common";
import PublicAuthApp, { getPublicAuthRouteFromPath } from "../app";
import { getPublicAuthRedirectTargetFromSearch } from "../routes";

jest.mock("@cocalc/frontend/client/api", () => jest.fn());

const mockedApi = jest.mocked(api);
const config = (overrides: Partial<PublicConfig> = {}): PublicConfig => ({
  site_name: "Launchpad",
  ...overrides,
});

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

beforeEach(() => {
  mockedApi.mockReset();
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
    expect(
      getPublicAuthRouteFromPath("/base/auth/cli-login/challenge-1"),
    ).toEqual({
      challengeId: "challenge-1",
      kind: "auth-cli-login",
    });
    expect(
      getPublicAuthRouteFromPath("/base/auth/cli-elevate/challenge-2"),
    ).toEqual({
      challengeId: "challenge-2",
      kind: "auth-cli-elevate",
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
  it("renders the sign-up view without the app redux shell", async () => {
    mockedApi.mockResolvedValueOnce(true);

    render(
      <PublicAuthApp
        config={config()}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Create your Launchpad account" }),
    ).not.toBeNull();
    expect(await screen.findByText("Registration token")).not.toBeNull();
  });

  it("shows Projects but not Settings in the shared nav for authenticated users", () => {
    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("renders the password reset done screen", () => {
    render(
      <PublicAuthApp
        config={config()}
        initialRoute={{ kind: "auth-password-reset-done" }}
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
        config={config()}
        initialRoute={{ kind: "sso-index" }}
        initialSSOStrategies={[
          {
            descr: "Use your Example account.",
            display: "Example SSO",
            domains: ["example.edu"],
            id: "example",
          },
        ]}
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
        config={config()}
        initialRoute={{ code: "CODE12345", kind: "redeem" }}
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
