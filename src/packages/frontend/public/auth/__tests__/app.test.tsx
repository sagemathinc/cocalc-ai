/** @jest-environment jsdom */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import api from "@cocalc/frontend/client/api";
import {
  isMfaRequiredAuthResponse,
  postAuthApi,
  signOutAuthSession,
} from "@cocalc/frontend/auth/api";
import type { PublicConfig } from "@cocalc/frontend/public/common";
import PublicAuthApp, { getPublicAuthRouteFromPath } from "../app";
import { getPublicAuthRedirectTargetFromSearch } from "../routes";
import { resolveAuthRedirectPath } from "../forms";

jest.mock("@cocalc/frontend/client/api", () => jest.fn());
jest.mock("@cocalc/frontend/auth/api", () => ({
  postAuthApi: jest.fn(),
  signOutAuthSession: jest.fn(),
  isMfaRequiredAuthResponse: jest.fn(() => false),
  isWrongBayAuthResponse: jest.fn(() => false),
  retryAuthOnHomeBay: jest.fn(),
}));

const mockedApi = jest.mocked(api);
const mockedPostAuthApi = jest.mocked(postAuthApi);
const mockedSignOutAuthSession = jest.mocked(signOutAuthSession);
const mockedIsMfaRequiredAuthResponse = jest.mocked(isMfaRequiredAuthResponse);
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
  mockedPostAuthApi.mockReset();
  mockedSignOutAuthSession.mockReset();
  mockedIsMfaRequiredAuthResponse.mockReset();
  mockedIsMfaRequiredAuthResponse.mockReturnValue(false);
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
    expect(
      getPublicAuthRouteFromPath(
        "/base/auth/verify",
        "?email=x%2540y.z&token=abc",
      ),
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
    expect(getPublicAuthRouteFromPath("/base/not-real")).toEqual({
      kind: "auth-form",
      view: "sign-in",
    });
    expect(getPublicAuthRouteFromPath("/base/invites/secret-token")).toEqual({
      kind: "project-invite",
      token: "secret-token",
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
    expect(
      getPublicAuthRouteFromPath("/base/auth/second-factor/challenge-3"),
    ).toEqual({
      challengeId: "challenge-3",
      kind: "auth-second-factor",
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
  it("uses projects as the default post-auth redirect target", () => {
    expect(resolveAuthRedirectPath()).toBe("/projects");
    expect(resolveAuthRedirectPath("/projects/project-id")).toBe(
      "/projects/project-id",
    );
    expect(resolveAuthRedirectPath(() => "/projects/project-id/files")).toBe(
      "/projects/project-id/files",
    );
  });

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

  it("shows and enforces a public signup allow-list domain policy", async () => {
    mockedApi.mockResolvedValueOnce(false);

    render(
      <PublicAuthApp
        config={config({
          signup_email_domain_public_policy: {
            mode: "allow_only",
            message: "Use an approved email address: @example.edu.",
            allowed_domains: ["@example.edu"],
          },
        })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    expect(
      await screen.findByText("Use an approved email address: @example.edu."),
    ).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "new-user@other.edu" },
    });
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "correct horse battery staple 12345!" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Enter the same password again"),
      {
        target: { value: "correct horse battery staple 12345!" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText("First name"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByPlaceholderText("Last name"), {
      target: { value: "User" },
    });
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "new-user@example.edu" },
    });
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).not.toBeDisabled();
  });

  it("requires matching sign-up password confirmation", async () => {
    mockedApi.mockResolvedValueOnce(false);

    render(
      <PublicAuthApp
        config={config()}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "new-user@example.edu" },
    });
    const password = screen.getByPlaceholderText("At least 8 characters");
    expect(password).toHaveAttribute("name", "new-password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    fireEvent.change(password, {
      target: { value: "correct horse battery staple 12345!" },
    });
    const confirmPassword = screen.getByPlaceholderText(
      "Enter the same password again",
    );
    expect(confirmPassword).toHaveAttribute("name", "confirm-password");
    expect(confirmPassword).toHaveAttribute("autocomplete", "new-password");
    fireEvent.change(confirmPassword, {
      target: { value: "different horse battery staple 12345!" },
    });
    fireEvent.change(screen.getByPlaceholderText("First name"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByPlaceholderText("Last name"), {
      target: { value: "User" },
    });

    expect(screen.getByText("Passwords do not match.")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeDisabled();

    fireEvent.change(confirmPassword, {
      target: { value: "correct horse battery staple 12345!" },
    });
    expect(screen.queryByText("Passwords do not match.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).not.toBeDisabled();
  });

  it("requires explicit Terms of Service and Privacy Policy acceptance on sign-up", async () => {
    mockedApi.mockResolvedValueOnce(false);

    render(
      <PublicAuthApp
        config={config({
          terms_of_service_url: "https://example.com/terms",
        })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    const link = await screen.findByRole("link", {
      name: "Terms of Service",
    });
    expect(link.getAttribute("href")).toBe("https://example.com/terms");
    expect(
      screen.getByRole("link", { name: "Privacy Policy" }),
    ).toHaveAttribute("href", "https://example.com/terms");
    expect(
      (
        screen.getByRole("checkbox", {
          name: /I accept the Terms of Service and Privacy Policy/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it("does not require Terms of Service acceptance when policies are not configured", async () => {
    mockedApi.mockResolvedValueOnce(false);

    render(
      <PublicAuthApp
        config={config({ policy_pages: "none" })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    expect(
      screen.queryByRole("checkbox", {
        name: /I accept the Terms of Service and Privacy Policy/,
      }),
    ).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "new-user@example.edu" },
    });
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "correct horse battery staple 12345!" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Enter the same password again"),
      {
        target: { value: "correct horse battery staple 12345!" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText("First name"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByPlaceholderText("Last name"), {
      target: { value: "User" },
    });
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => {
      expect(mockedPostAuthApi).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "auth/sign-up",
          body: expect.objectContaining({ terms: true }),
        }),
      );
    });
  });

  it("shows registration-token issues on sign-up", async () => {
    mockedApi.mockResolvedValueOnce(true);
    mockedPostAuthApi.mockResolvedValueOnce({
      issues: {
        registrationToken:
          "Issue with registration token -- Registration token is wrong.",
      },
    } as any);

    render(
      <PublicAuthApp
        config={config()}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    fireEvent.change(
      await screen.findByPlaceholderText("Enter your registration token"),
      {
        target: { value: "wrong-token" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "new-user@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "correct horse battery staple 12345!" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Enter the same password again"),
      {
        target: { value: "correct horse battery staple 12345!" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText("First name"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByPlaceholderText("Last name"), {
      target: { value: "User" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText(
        "Issue with registration token -- Registration token is wrong.",
      ),
    ).not.toBeNull();
  });

  it("does not silently redirect when token-required sign-up returns no account", async () => {
    mockedApi.mockResolvedValueOnce(true);
    mockedPostAuthApi.mockResolvedValueOnce({} as any);

    render(
      <PublicAuthApp
        config={config()}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    fireEvent.change(
      await screen.findByPlaceholderText("Enter your registration token"),
      {
        target: { value: "wrong-token" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "new-user@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "correct horse battery staple 12345!" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Enter the same password again"),
      {
        target: { value: "correct horse battery staple 12345!" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText("First name"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByPlaceholderText("Last name"), {
      target: { value: "User" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText(
        "Registration token was not accepted. Check that it is active and typed correctly.",
      ),
    ).not.toBeNull();
  });

  it("shows Projects and Settings in the shared nav for authenticated users", () => {
    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).not.toBeNull();
  });

  it("routes domain-managed sign-in to the required SSO provider", async () => {
    mockedApi.mockResolvedValueOnce({
      email: "ada@cornell.edu",
      password_allowed: false,
      sso_required: true,
      sso_strategy: {
        name: "cornell",
        display: "Cornell SSO",
      },
      reason: "domain_sso_required",
    });

    render(
      <PublicAuthApp
        config={config({ terms_of_service_url: "https://example.com/terms" })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    const emailInput = screen.getByPlaceholderText("you@example.com");
    expect(emailInput).toHaveAttribute("name", "email");
    expect(emailInput).toHaveAttribute("autocomplete", "username");
    fireEvent.change(emailInput, {
      target: { value: "ada@cornell.edu" },
    });
    const passwordInput = screen.getByPlaceholderText("Password");
    expect(passwordInput).toHaveAttribute("name", "password");
    expect(passwordInput).toHaveAttribute("autocomplete", "current-password");
    fireEvent.change(passwordInput, {
      target: { value: "correct horse battery staple" },
    });

    expect(
      await screen.findByText("This email domain uses single sign-on."),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Continue with Cornell SSO" }),
    ).toHaveProperty("href", "http://localhost/auth/cornell");
    expect(
      (
        screen.getByRole("checkbox", {
          name: /I accept the Terms of Service and Privacy Policy/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      screen.getByRole("link", { name: "Continue with Cornell SSO" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Sign In" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(mockedPostAuthApi).not.toHaveBeenCalled();
  });

  it("does not require SSO policy acceptance when policies are not configured", async () => {
    mockedApi.mockResolvedValueOnce({
      email: "ada@cornell.edu",
      password_allowed: false,
      sso_required: true,
      sso_strategy: {
        name: "cornell",
        display: "Cornell SSO",
      },
      reason: "domain_sso_required",
    });

    render(
      <PublicAuthApp
        config={config({ policy_pages: "none" })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "ada@cornell.edu" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "correct horse battery staple" },
    });

    expect(
      await screen.findByText("This email domain uses single sign-on."),
    ).not.toBeNull();
    expect(
      screen.queryByRole("checkbox", {
        name: /I accept the Terms of Service and Privacy Policy/,
      }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Continue with Cornell SSO" }),
    ).toHaveAttribute("aria-disabled", "false");
  });

  it("keeps passkey selection visually separate from passkey submission", async () => {
    mockedApi.mockResolvedValue({
      email: "ada@example.com",
      password_allowed: true,
      sso_required: false,
    });
    mockedIsMfaRequiredAuthResponse.mockImplementation(
      (value: unknown): value is any =>
        !!value && typeof value === "object" && (value as any).mfa_required,
    );
    mockedPostAuthApi.mockResolvedValueOnce({
      mfa_required: true,
      challenge_id: "challenge-1",
      methods: ["passkey", "totp"],
      home_bay_id: "bay-1",
    } as any);

    render(
      <PublicAuthApp
        config={config()}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    const chooser = await screen.findByRole("group", {
      name: "Choose second factor method",
    });
    expect(within(chooser).getByRole("button", { name: "Passkey" })).not.toBe(
      null,
    );
    expect(screen.getByRole("button", { name: "Use passkey" })).not.toBeNull();
    expect(
      within(chooser).queryByRole("button", { name: "Use passkey" }),
    ).toBeNull();
  });

  it("renders an SSO second-factor challenge route", async () => {
    mockedPostAuthApi.mockResolvedValueOnce({
      account_id: "account-1",
      home_bay_url: "https://bay.example.test",
    } as any);

    render(
      <PublicAuthApp
        config={config()}
        initialRoute={{
          challengeId: "challenge-3",
          kind: "auth-second-factor",
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Verify your second factor" }),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Single sign-on succeeded. Enter your CoCalc second factor to finish signing in.",
      ),
    ).not.toBeNull();
    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "123456" },
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {
      // jsdom does not implement full-page reloads.
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "auth/verify-second-factor",
        body: {
          challenge_id: "challenge-3",
          method: "totp",
          code: "123456",
        },
      }),
    );
    consoleError.mockRestore();
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

  it("confirms verified email and uses signed-in actions", async () => {
    mockedApi.mockResolvedValueOnce(undefined);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{
          email: "ada@example.edu",
          kind: "auth-verify-email",
          token: "verification-token",
        }}
      />,
    );

    expect(await screen.findByText("Email verified")).not.toBeNull();
    expect(screen.getByText("ada@example.edu")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open projects" })).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Account settings" }),
    ).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
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

  it("previews project invite links without accepting them immediately", async () => {
    mockedApi.mockResolvedValueOnce({
      invite: {
        invite_id: "77777777-7777-4777-8777-777777777777",
        inviter_name: "Ada Lovelace",
        message: "Please join",
        project_id: "22222222-2222-4222-8222-222222222222",
        project_title: "Research Project",
        status: "pending",
      },
    } as any);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{
          kind: "project-invite",
          token: "secret",
        }}
      />,
    );

    expect(await screen.findByText("Confirm project invite")).not.toBeNull();
    expect(screen.getByText("Research Project")).not.toBeNull();
    expect(screen.getByText("Ada Lovelace")).not.toBeNull();
    expect(screen.getByText("Please join")).not.toBeNull();
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(mockedApi).toHaveBeenCalledWith("projects/preview-email-invite", {
      token: "secret",
    });
  });

  it("shows expired project invite links before sign-in", async () => {
    mockedApi.mockRejectedValueOnce(
      new Error("invite is not pending (status=expired)"),
    );

    render(
      <PublicAuthApp
        config={config({ is_authenticated: false })}
        initialRoute={{
          kind: "project-invite",
          token: "secret",
        }}
      />,
    );

    expect(
      await screen.findByText("Project invite unavailable"),
    ).not.toBeNull();
    expect(
      screen.getByText("Sorry, this project invite link has expired."),
    ).not.toBeNull();
  });

  it("shows the signed-in account before accepting a project invite", async () => {
    mockedApi.mockResolvedValueOnce({
      invite: {
        invite_id: "77777777-7777-4777-8777-777777777777",
        inviter_name: "Ada Lovelace",
        project_id: "22222222-2222-4222-8222-222222222222",
        project_title: "Research Project",
        status: "pending",
      },
    } as any);
    mockedSignOutAuthSession.mockResolvedValueOnce(undefined);

    render(
      <PublicAuthApp
        config={config({
          account_display_name: "Alice Example",
          account_email_address: "alice@example.com",
          account_id: "acct-alice",
          is_authenticated: true,
        })}
        initialRoute={{
          kind: "project-invite",
          token: "secret",
        }}
      />,
    );

    expect(
      await screen.findByText(/This browser is signed in as/),
    ).not.toBeNull();
    expect(
      screen.getByText("alice@example.com (Alice Example)"),
    ).not.toBeNull();
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {
      // jsdom does not implement full-page reloads.
    });
    fireEvent.click(screen.getByRole("button", { name: "sign out first" }));
    await waitFor(() =>
      expect(mockedSignOutAuthSession).toHaveBeenCalledWith(),
    );
    consoleError.mockRestore();
  });

  it("accepts project invite links only after clicking Accept", async () => {
    mockedApi
      .mockResolvedValueOnce({
        invite: {
          invite_id: "77777777-7777-4777-8777-777777777777",
          project_id: "22222222-2222-4222-8222-222222222222",
          project_title: "Research Project",
          status: "pending",
        },
      } as any)
      .mockResolvedValueOnce({
        invite: {
          invite_id: "77777777-7777-4777-8777-777777777777",
          project_id: "22222222-2222-4222-8222-222222222222",
          project_title: "Research Project",
          status: "accepted",
        },
      } as any);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{
          kind: "project-invite",
          token: "secret",
        }}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Accept invite" }),
    );

    expect(await screen.findByText("Project invite accepted")).not.toBeNull();
    expect(mockedApi).toHaveBeenLastCalledWith(
      "projects/respond-email-invite",
      {
        action: "accept",
        token: "secret",
      },
    );
  });

  it("shows a clear expired error when accepting an expired project invite", async () => {
    mockedApi
      .mockResolvedValueOnce({
        invite: {
          invite_id: "77777777-7777-4777-8777-777777777777",
          project_id: "22222222-2222-4222-8222-222222222222",
          project_title: "Research Project",
          status: "pending",
        },
      } as any)
      .mockRejectedValueOnce(
        new Error("invite is not pending (status=expired)"),
      );

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{
          kind: "project-invite",
          token: "secret",
        }}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Accept invite" }),
    );

    expect(
      await screen.findByText("Sorry, this project invite link has expired."),
    ).not.toBeNull();
  });

  it("declines project invite links without accepting them", async () => {
    mockedApi
      .mockResolvedValueOnce({
        invite: {
          invite_id: "77777777-7777-4777-8777-777777777777",
          project_id: "22222222-2222-4222-8222-222222222222",
          project_title: "Research Project",
          status: "pending",
        },
      } as any)
      .mockResolvedValueOnce({
        invite: {
          invite_id: "77777777-7777-4777-8777-777777777777",
          project_id: "22222222-2222-4222-8222-222222222222",
          project_title: "Research Project",
          status: "declined",
        },
      } as any);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{
          kind: "project-invite",
          token: "secret",
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));

    expect(await screen.findByText("Project invite declined")).not.toBeNull();
    expect(mockedApi).toHaveBeenLastCalledWith(
      "projects/respond-email-invite",
      {
        action: "decline",
        token: "secret",
      },
    );
  });

  it("shows a clear wrong-account warning for CLI login approvals", async () => {
    mockedPostAuthApi.mockResolvedValueOnce({
      challenge_id: "challenge-1",
      kind: "login",
      account_id: "acct-target",
      email_address: "bella@example.com",
      display_name: "Bella Example",
      current_account_id: "acct-viewer",
      current_email_address: "alice@example.com",
      current_display_name: "Alice Example",
      current_matches_account: false,
      state: "pending",
      expires_at: "2026-05-08T18:00:00.000Z",
    } as any);
    mockedSignOutAuthSession.mockResolvedValueOnce(undefined);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{ challengeId: "challenge-1", kind: "auth-cli-login" }}
      />,
    );

    expect(
      await screen.findByText(
        /This browser is signed in as alice@example.com \(Alice Example\)\./,
      ),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).not.toBeNull();
    expect(
      screen.getByText(
        /and then sign in as bella@example.com \(Bella Example\) to approve the CLI login request\./,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /If that is inconvenient, open this link in a new temporary incognito or private browser window and sign in there as bella@example.com \(Bella Example\)\./,
      ),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Approve CLI Login" }),
    ).toBeNull();

    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {
      // jsdom does not implement full-page reloads.
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(mockedSignOutAuthSession).toHaveBeenCalledWith(),
    );
    consoleError.mockRestore();
  });

  it("lets the current browser account approve an unbound CLI login challenge", async () => {
    mockedPostAuthApi.mockResolvedValueOnce({
      challenge_id: "challenge-1",
      kind: "login",
      account_id: null,
      email_address: null,
      display_name: null,
      email_hint: "hint@example.com",
      current_account_id: "acct-viewer",
      current_email_address: "alice@example.com",
      current_display_name: "Alice Example",
      current_matches_account: true,
      state: "pending",
      expires_at: "2026-05-08T18:00:00.000Z",
    } as any);
    mockedPostAuthApi.mockResolvedValueOnce({ approved: true } as any);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{ challengeId: "challenge-1", kind: "auth-cli-login" }}
      />,
    );

    expect(
      await screen.findByText(
        /Approve a CLI sign-in for alice@example.com \(Alice Example\)\./,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /The CLI was started with email hint hint@example.com\./,
      ),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Approve CLI Login" }));
    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "auth/cli/login/approve",
        body: { challenge_id: "challenge-1" },
      }),
    );
  });

  it("prompts for fresh auth before approving a CLI login when required", async () => {
    mockedPostAuthApi.mockResolvedValueOnce({
      challenge_id: "challenge-1",
      kind: "login",
      account_id: null,
      email_address: null,
      display_name: null,
      email_hint: null,
      current_account_id: "acct-viewer",
      current_email_address: "alice@example.com",
      current_display_name: "Alice Example",
      current_matches_account: true,
      state: "pending",
      expires_at: "2026-05-08T18:00:00.000Z",
    } as any);
    mockedPostAuthApi.mockRejectedValueOnce(
      Object.assign(new Error("fresh auth is required"), {
        code: "fresh_auth_required",
      }),
    );
    mockedPostAuthApi.mockResolvedValueOnce({
      mode: "account",
      enabled: false,
      methods: [],
      email_address: "alice@example.com",
    } as any);
    mockedPostAuthApi.mockResolvedValueOnce({
      fresh_auth_until: "2026-05-08T18:10:00.000Z",
      factor_level: "none",
    } as any);
    mockedPostAuthApi.mockResolvedValueOnce({ approved: true } as any);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{ challengeId: "challenge-1", kind: "auth-cli-login" }}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Approve CLI Login",
      }),
    );

    expect(await screen.findByText("Confirm security action")).not.toBeNull();
    fireEvent.change(
      screen.getByPlaceholderText(
        "Leave blank if this account has no password",
      ),
      { target: { value: "current-password" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "auth/fresh-auth",
        origin: undefined,
        body: {
          current_password: "current-password",
          duration: "default",
        },
      }),
    );
    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenLastCalledWith({
        endpoint: "auth/cli/login/approve",
        body: { challenge_id: "challenge-1" },
      }),
    );
  });
});
