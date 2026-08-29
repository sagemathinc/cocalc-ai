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
  getControlPlaneAuthBootstrap,
  isMfaRequiredAuthResponse,
  postAuthApi,
  signOutAuthSession,
} from "@cocalc/frontend/auth/api";
import { enableForceConsent } from "@cocalc/frontend/cookie-consent";
import type { PublicConfig } from "@cocalc/frontend/public/common";
import PublicAuthApp, { getPublicAuthRouteFromPath } from "../app";
import { getPublicAuthRedirectTargetFromSearch } from "../routes";
import { resolveAuthRedirectPath } from "../forms";

jest.mock("@cocalc/frontend/client/api", () => jest.fn());
jest.mock("@cocalc/frontend/auth/api", () => ({
  getControlPlaneAuthBootstrap: jest.fn(),
  postAuthApi: jest.fn(),
  signOutAuthSession: jest.fn(),
  isMfaRequiredAuthResponse: jest.fn(() => false),
  isWrongBayAuthResponse: jest.fn(() => false),
  retryAuthOnHomeBay: jest.fn(),
}));
jest.mock("@cocalc/frontend/cookie-consent", () => ({
  enableForceConsent: jest.fn(() => jest.fn()),
  requireEssentialConsent: jest.fn(() => true),
  useEssentialConsent: jest.fn(() => true),
}));

const mockedApi = jest.mocked(api);
const mockedGetControlPlaneAuthBootstrap = jest.mocked(
  getControlPlaneAuthBootstrap,
);
const mockedPostAuthApi = jest.mocked(postAuthApi);
const mockedSignOutAuthSession = jest.mocked(signOutAuthSession);
const mockedIsMfaRequiredAuthResponse = jest.mocked(isMfaRequiredAuthResponse);
const mockedEnableForceConsent = jest.mocked(enableForceConsent);
const config = (overrides: Partial<PublicConfig> = {}): PublicConfig => ({
  site_name: "Launchpad",
  strategies: [],
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
  window.history.replaceState({}, "", "/auth/sign-up");
  mockedApi.mockReset();
  mockedGetControlPlaneAuthBootstrap.mockReset();
  mockedGetControlPlaneAuthBootstrap.mockRejectedValue(
    new Error("auth bootstrap unavailable in test"),
  );
  mockedPostAuthApi.mockReset();
  mockedSignOutAuthSession.mockReset();
  mockedIsMfaRequiredAuthResponse.mockReset();
  mockedIsMfaRequiredAuthResponse.mockReturnValue(false);
  mockedEnableForceConsent.mockReset();
  mockedEnableForceConsent.mockReturnValue(jest.fn());
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
    expect(
      getPublicAuthRouteFromPath(
        "/base/auth/email/continue/11111111-1111-4111-8111-111111111111",
      ),
    ).toEqual({
      challengeId: "11111111-1111-4111-8111-111111111111",
      kind: "auth-email-continue",
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
    expect(
      getPublicAuthRedirectTargetFromSearch("?target=%2F"),
    ).toBeUndefined();
    expect(
      getPublicAuthRedirectTargetFromSearch("?target=%2F%3Ffrom%3Dhome"),
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
    expect(resolveAuthRedirectPath("")).toBe("/projects");
    expect(resolveAuthRedirectPath("/")).toBe("/projects");
    expect(resolveAuthRedirectPath(() => "/")).toBe("/projects");
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
    expect(
      screen.queryByText("Create or access your CoCalc account."),
    ).toBeNull();
    expect(await screen.findByText("Registration token")).not.toBeNull();
  });

  it("shows custom account creation instructions on the public sign-up page", async () => {
    mockedApi.mockResolvedValueOnce(false);

    render(
      <PublicAuthApp
        config={config({
          account_creation_email_instructions:
            "Create your account with your university email.",
        })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    expect(
      await screen.findByText(
        "Create your account with your university email.",
      ),
    ).not.toBeNull();
  });

  it("shows custom sign-in instructions on the public sign-in page", () => {
    render(
      <PublicAuthApp
        config={config({
          sign_in_email_instructions:
            "Sign in with the email address your instructor invited.",
        })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    expect(
      screen.getByText(
        "Sign in with the email address your instructor invited.",
      ),
    ).not.toBeNull();
  });

  it("forces cookie consent only on the sign-up auth page", async () => {
    mockedApi.mockResolvedValue(false);

    const { unmount } = render(
      <PublicAuthApp
        config={config({ cookie_banner_enabled: true })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    await waitFor(() => expect(mockedEnableForceConsent).toHaveBeenCalled());
    unmount();

    mockedEnableForceConsent.mockClear();
    const signIn = render(
      <PublicAuthApp
        config={config({ cookie_banner_enabled: true })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Sign in to Launchpad" }),
    ).not.toBeNull();
    expect(mockedEnableForceConsent).not.toHaveBeenCalled();
    signIn.unmount();

    mockedEnableForceConsent.mockClear();
    render(
      <PublicAuthApp
        config={config({ cookie_banner_enabled: true })}
        initialRoute={{ kind: "sso-index" }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Single sign-on for Launchpad")).not.toBeNull(),
    );
    expect(mockedEnableForceConsent).not.toHaveBeenCalled();
  });

  it("forces cookie consent on email-first sign-in because it can create an account", async () => {
    render(
      <PublicAuthApp
        config={config({
          cookie_banner_enabled: true,
          email_authentication_mode: "email_first",
        })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    await waitFor(() => expect(mockedEnableForceConsent).toHaveBeenCalled());
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
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "New User" },
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

    expect(
      screen.queryByText("Create or access your CoCalc account."),
    ).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "new-user@example.edu" },
    });
    const password = screen.getByPlaceholderText("At least 8 characters");
    expect(password).toHaveAttribute("name", "new-password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    fireEvent.change(password, {
      target: { value: "short" },
    });
    expect(
      screen.getByText("Password must be at least 8 characters."),
    ).not.toBeNull();
    fireEvent.change(password, {
      target: { value: "correct horse battery staple 12345!" },
    });
    expect(
      screen.queryByText("Password must be at least 8 characters."),
    ).toBeNull();
    const confirmPassword = screen.getByPlaceholderText(
      "Enter the same password again",
    );
    expect(confirmPassword).toHaveAttribute("name", "confirm-password");
    expect(confirmPassword).toHaveAttribute("autocomplete", "new-password");
    fireEvent.change(confirmPassword, {
      target: { value: "different horse battery staple 12345!" },
    });
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "New User" },
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

  it("shows Terms of Service and Privacy Policy notice on sign-up", async () => {
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
      screen.queryByRole("checkbox", {
        name: /I accept the Terms of Service and Privacy Policy/,
      }),
    ).toBeNull();
    expect(
      screen.getByText(/By creating an account, you agree/),
    ).not.toBeNull();
    expect(screen.queryByText(/Send me occasional platform tips/)).toBeNull();
  });

  it("uses email first without requesting a password", () => {
    render(
      <PublicAuthApp
        config={config({ email_authentication_mode: "email_first" })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    expect(screen.getByLabelText("Email address")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue with email" }),
    ).not.toBeNull();
    expect(screen.queryByPlaceholderText("At least 8 characters")).toBeNull();

    fireEvent.click(screen.getByText("Use a password instead"));

    expect(screen.getByPlaceholderText("At least 8 characters")).not.toBeNull();
  });

  it("requests the registration token in email-first signup", async () => {
    mockedApi.mockResolvedValueOnce(true);
    mockedPostAuthApi.mockResolvedValueOnce({
      challenge_id: "11111111-1111-4111-8111-111111111111",
      state: "pending",
      masked_email: "pe…@example.edu",
      expires_at: "2026-07-29T01:15:00.000Z",
      resend_available_at: "2026-07-29T01:00:30.000Z",
      send_count: 1,
      message_sent: true,
      message_failed: false,
    });
    render(
      <PublicAuthApp
        config={config({ email_authentication_mode: "email_first" })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Registration token"), {
      target: { value: "course-token" },
    });
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "Person@Example.EDU" },
    });
    const continueButton = screen.getByRole("button", {
      name: "Continue with email",
    });
    await waitFor(() => expect(continueButton).not.toBeDisabled());
    fireEvent.click(continueButton);

    expect(await screen.findByText("Check your email")).not.toBeNull();
    expect(mockedPostAuthApi).toHaveBeenCalledWith({
      endpoint: "auth/email/start",
      body: {
        email: "person@example.edu",
        registration_token: "course-token",
        target: "/projects",
        terms: true,
      },
    });
  });

  it("carries acquisition intent into email-first account creation", async () => {
    window.history.replaceState({}, "", "/auth/sign-up?intent=jupyter-python");
    mockedApi.mockResolvedValueOnce(false);
    mockedPostAuthApi.mockResolvedValueOnce({
      challenge_id: "11111111-1111-4111-8111-111111111111",
      state: "pending",
      masked_email: "pe…@example.edu",
      expires_at: "2026-07-29T01:15:00.000Z",
      resend_available_at: "2026-07-29T01:00:30.000Z",
      send_count: 1,
      message_sent: true,
      message_failed: false,
    });
    render(
      <PublicAuthApp
        config={config({ email_authentication_mode: "email_first" })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "Person@Example.EDU" },
    });
    const continueButton = screen.getByRole("button", {
      name: "Continue with email",
    });
    await waitFor(() => expect(continueButton).not.toBeDisabled());
    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(mockedPostAuthApi).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "auth/email/start",
          body: expect.objectContaining({
            onboarding_intent: "jupyter-python",
          }),
        }),
      );
    });
  });

  it("starts a passwordless email challenge", async () => {
    mockedPostAuthApi.mockResolvedValueOnce({
      challenge_id: "11111111-1111-4111-8111-111111111111",
      state: "pending",
      masked_email: "pe…@example.edu",
      expires_at: "2026-07-29T01:15:00.000Z",
      resend_available_at: "2026-07-29T01:00:30.000Z",
      send_count: 1,
      message_sent: true,
      message_failed: false,
    });
    render(
      <PublicAuthApp
        config={config({ email_authentication_mode: "email_first" })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "Person@Example.EDU" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );

    expect(await screen.findByText("Check your email")).not.toBeNull();
    expect(mockedPostAuthApi).toHaveBeenCalledWith({
      endpoint: "auth/email/start",
      body: {
        email: "person@example.edu",
        target: "/projects",
        terms: true,
      },
    });
    expect(screen.getByLabelText("Six-digit email code")).not.toBeNull();
  });

  it("explains when an existing email challenge is reused", async () => {
    mockedPostAuthApi.mockResolvedValueOnce({
      challenge_id: "11111111-1111-4111-8111-111111111111",
      state: "pending",
      masked_email: "pe…@example.edu",
      expires_at: "2026-07-29T01:15:00.000Z",
      resend_available_at: "2026-07-29T01:00:30.000Z",
      message_sent_now: false,
    });
    render(
      <PublicAuthApp
        config={config({ email_authentication_mode: "email_first" })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "Person@Example.EDU" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );

    expect(
      await screen.findByText(/A sign-in email is already pending/),
    ).not.toBeNull();
    expect(screen.getByText(/We did not send another message/)).not.toBeNull();
  });

  it("asks a newly created email-first account for its display name", async () => {
    mockedApi.mockResolvedValueOnce(false);
    mockedPostAuthApi
      .mockResolvedValueOnce({
        challenge_id: "11111111-1111-4111-8111-111111111111",
        state: "pending",
        account_created: false,
        masked_email: "pe…@example.edu",
        expires_at: "2026-07-29T01:15:00.000Z",
        resend_available_at: "2026-07-29T01:00:30.000Z",
      })
      .mockResolvedValueOnce({
        challenge_id: "11111111-1111-4111-8111-111111111111",
        account_created: true,
        exchange_token: "x".repeat(64),
        exchange_expires_at: "2026-07-29T01:01:00.000Z",
        home_bay_id: "bay-1",
        home_bay_url: "https://bay-1.example.test",
        redirect_to: "/projects/welcome",
        state: "account_ready",
      })
      .mockResolvedValueOnce({
        account_id: "22222222-2222-4222-8222-222222222222",
        home_bay_id: "bay-1",
        home_bay_url: "https://bay-1.example.test",
      })
      .mockResolvedValueOnce({ status: "success" });

    render(
      <PublicAuthApp
        config={config({ email_authentication_mode: "email_first" })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Email address"), {
      target: { value: "person@example.edu" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    fireEvent.change(await screen.findByLabelText("Six-digit email code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("What should we call you?")).not.toBeNull();
    expect(screen.getByText("Skip for now")).not.toBeNull();
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Ada Lovelace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "accounts/set-name",
        origin: "https://bay-1.example.test",
        body: { display_name: "Ada Lovelace" },
      }),
    );
  });

  it("asks a newly created magic-link account for its display name", async () => {
    window.history.replaceState(
      {},
      "",
      "/auth/email/continue/11111111-1111-4111-8111-111111111111#token=abcdefghijklmnopqrstuvwxyz1234567890",
    );
    mockedPostAuthApi
      .mockResolvedValueOnce({
        challenge_id: "11111111-1111-4111-8111-111111111111",
        account_created: true,
        exchange_token: "x".repeat(64),
        exchange_expires_at: "2026-07-29T01:01:00.000Z",
        home_bay_id: "bay-1",
        home_bay_url: "https://bay-1.example.test",
        state: "account_ready",
      })
      .mockResolvedValueOnce({
        account_id: "22222222-2222-4222-8222-222222222222",
        home_bay_id: "bay-1",
        home_bay_url: "https://bay-1.example.test",
      });

    render(
      <PublicAuthApp
        config={config({ email_authentication_mode: "email_first" })}
        initialRoute={{
          challengeId: "11111111-1111-4111-8111-111111111111",
          kind: "auth-email-continue",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue to CoCalc" }));

    expect(await screen.findByText("What should we call you?")).not.toBeNull();
    expect(screen.getByLabelText("Your name")).not.toBeNull();
  });

  it("does not redeem an email link until the user continues", () => {
    window.history.replaceState(
      {},
      "",
      "/auth/email/continue/11111111-1111-4111-8111-111111111111#token=abcdefghijklmnopqrstuvwxyz1234567890",
    );

    render(
      <PublicAuthApp
        config={config({ email_authentication_mode: "email_first" })}
        initialRoute={{
          challengeId: "11111111-1111-4111-8111-111111111111",
          kind: "auth-email-continue",
        }}
      />,
    );

    expect(window.location.hash).toBe("");
    expect(mockedPostAuthApi).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Continue to CoCalc" }),
    ).not.toBeNull();
  });

  it("shows policy notice before Google sign-up without disabling SSO", async () => {
    mockedApi.mockResolvedValueOnce(false);

    render(
      <PublicAuthApp
        config={config({
          terms_of_service_url: "https://example.com/terms",
        })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
        initialSSOStrategies={[{ name: "google", display: "Google" }]}
      />,
    );

    const notice = await screen.findByText(/By continuing with Google/);
    const googleLink = screen.getByRole("link", {
      name: "Agree and sign up with Google",
    });
    expect(
      notice.compareDocumentPosition(googleLink) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(googleLink).toHaveAttribute("aria-disabled", "false");
  });

  it("includes policy acceptance on generic Google sign-in", async () => {
    render(
      <PublicAuthApp
        config={config({
          terms_of_service_url: "https://example.com/terms",
        })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
        initialSSOStrategies={[{ name: "google", display: "Google" }]}
      />,
    );

    expect(screen.getByText(/By continuing with Google/)).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Agree and continue with Google" }),
    ).toHaveProperty("href", expect.stringContaining("/auth/google"));
    expect(
      screen.getByRole("link", { name: "Agree and continue with Google" }),
    ).toHaveProperty("href", expect.stringContaining("terms=1"));
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
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "New User" },
    });
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => {
      expect(mockedPostAuthApi).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "auth/sign-up",
          body: expect.objectContaining({
            displayName: "New User",
            marketing_consent: false,
            terms: true,
          }),
        }),
      );
      expect(mockedPostAuthApi.mock.calls[0][0].body).not.toHaveProperty(
        "firstName",
      );
      expect(mockedPostAuthApi.mock.calls[0][0].body).not.toHaveProperty(
        "lastName",
      );
    });
  });

  it("keeps verify-after-signup users in a dedicated verification step", async () => {
    mockedApi.mockResolvedValueOnce(false);
    mockedPostAuthApi
      .mockResolvedValueOnce({
        account_id: "account-new",
        home_bay_id: "bay-0",
        home_bay_url: "https://bay-0.example.test",
      } as any)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        verification_email_error: "temporary delivery failure",
      })
      .mockResolvedValueOnce(undefined);
    mockedGetControlPlaneAuthBootstrap
      .mockRejectedValueOnce(new Error("initial bootstrap unavailable"))
      .mockResolvedValue({
        account_id: "account-new",
        email_address: "new-user@example.edu",
        email_address_verified: false,
        signed_in: true,
      });

    render(
      <PublicAuthApp
        config={config({
          email_authentication_mode: "verify_after_signup",
          policy_pages: "none",
        })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

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
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "New User" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Check your email")).not.toBeNull();
    expect(screen.getByText("new-user@example.edu")).not.toBeNull();
    expect(
      screen.getByText("Verification email sent. Waiting for confirmation..."),
    ).not.toBeNull();
    expect(screen.queryByPlaceholderText("Your name")).toBeNull();
    expect(
      screen.queryByText(
        "Create an account to start projects, then compare product paths whenever your needs change.",
      ),
    ).toBeNull();
    expect(mockedGetControlPlaneAuthBootstrap).toHaveBeenCalled();

    fireEvent.click(screen.getByText("Use a different email"));
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "corrected@example.edu" },
    });
    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "correct horse battery staple 12345!" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Update email and resend" }),
    );

    await waitFor(() => {
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "auth/fresh-auth",
        origin: expect.any(String),
        body: {
          current_password: "correct horse battery staple 12345!",
          duration: "default",
        },
      });
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "accounts/set-email-address",
        origin: expect.any(String),
        body: {
          email_address: "corrected@example.edu",
          password: "correct horse battery staple 12345!",
        },
      });
    });

    expect(
      await screen.findByText(
        /The email address was changed, but the verification message could not be sent/,
      ),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Resend verification email" }),
    );
    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "accounts/send-verification-email",
        origin: expect.any(String),
        body: { email_address: "corrected@example.edu" },
      }),
    );
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
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "New User" },
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
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "New User" },
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

  it("replaces sign-up with signed-in account actions after auth bootstrap", async () => {
    mockedGetControlPlaneAuthBootstrap.mockResolvedValueOnce({
      account_id: "acct-alice",
      display_name: "Alice Example",
      email_address: "alice@example.com",
      signed_in: true,
    });
    mockedSignOutAuthSession.mockResolvedValueOnce(undefined);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: false })}
        initialRoute={{ kind: "auth-form", view: "sign-up" }}
      />,
    );

    expect(await screen.findByText("You are already signed in")).not.toBeNull();
    expect(
      screen.getByText("Alice Example (alice@example.com)"),
    ).not.toBeNull();
    expect(screen.queryByPlaceholderText("you@example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open projects" })).toHaveAttribute(
      "href",
      "/projects",
    );

    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {
      // jsdom does not implement full-page reloads.
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Sign out to create another account",
      }),
    );
    await waitFor(() =>
      expect(mockedSignOutAuthSession).toHaveBeenCalledWith(),
    );
    consoleError.mockRestore();
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
    expect(screen.getByText(/By continuing with Cornell SSO/)).not.toBeNull();
    expect(
      screen.queryByRole("checkbox", {
        name: /I accept the Terms of Service and Privacy Policy/,
      }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Agree and continue with Cornell SSO" }),
    ).toHaveProperty("href", expect.stringContaining("/auth/cornell"));
    expect(
      screen.getByRole("link", { name: "Agree and continue with Cornell SSO" }),
    ).toHaveProperty("href", expect.stringContaining("terms=1"));
    expect(
      screen.getByRole("link", { name: "Agree and continue with Cornell SSO" }),
    ).toHaveAttribute("aria-disabled", "false");
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

  it("moves missing legacy CoCalc.com accounts into sign-up with the email preserved", async () => {
    mockedApi.mockImplementation(async (endpoint: string, body?: any) => {
      if (endpoint === "auth/sign-in-method") {
        return {
          email: body.email,
          password_allowed: true,
          sso_required: false,
        };
      }
      if (endpoint === "auth/requires-token") {
        return false;
      }
      return undefined;
    });
    const err = new Error(
      "Problem signing into account -- no account with email address 'legacy@example.com'.",
    ) as Error & { code?: string };
    err.code = "legacy_account_requires_new_account";
    mockedPostAuthApi.mockRejectedValueOnce(err);

    render(
      <PublicAuthApp
        config={config({ dns: "cocalc.ai", site_name: "CoCalc" })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "legacy@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "old cocalc.com password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    expect(
      await screen.findByRole("heading", {
        name: "Create your CoCalc account",
      }),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "CoCalc.com accounts do not sign in directly on CoCalc.ai.",
      ),
    ).not.toBeNull();
    expect(screen.getByDisplayValue("legacy@example.com")).not.toBeNull();
  });

  it("keeps missing non-legacy accounts on the sign-in form", async () => {
    mockedApi.mockImplementation(async (endpoint: string, body?: any) => {
      if (endpoint === "auth/sign-in-method") {
        return {
          email: body.email,
          password_allowed: true,
          sso_required: false,
        };
      }
      return undefined;
    });
    mockedPostAuthApi.mockRejectedValueOnce(
      new Error(
        "Problem signing into account -- no account with email address 'new@example.com'.",
      ),
    );

    render(
      <PublicAuthApp
        config={config({ dns: "cocalc.ai", site_name: "CoCalc" })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "mistyped password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    expect(
      await screen.findByText(
        /no account with email address 'new@example.com'/,
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Sign in to CoCalc" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Create your CoCalc account" }),
    ).toBeNull();
  });

  it("keeps wrong-password failures on the sign-in form", async () => {
    mockedApi.mockImplementation(async (endpoint: string, body?: any) => {
      if (endpoint === "auth/sign-in-method") {
        return {
          email: body.email,
          password_allowed: true,
          sso_required: false,
        };
      }
      return undefined;
    });
    mockedPostAuthApi.mockRejectedValueOnce(
      new Error(
        "Problem signing into account -- password for 'ada@example.com' is incorrect.",
      ),
    );

    render(
      <PublicAuthApp
        config={config({ dns: "cocalc.ai", site_name: "CoCalc" })}
        initialRoute={{ kind: "auth-form", view: "sign-in" }}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), {
      target: { value: "wrong password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    expect(
      await screen.findByText(/password for 'ada@example.com' is incorrect/),
    ).not.toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "password for 'ada@example.com' is incorrect",
    );
    expect(
      screen.getByRole("heading", { name: "Sign in to CoCalc" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Create your CoCalc account" }),
    ).toBeNull();
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

  it("labels and submits the recovery-only alternative to a passkey", async () => {
    mockedApi.mockResolvedValue({
      email: "ada@example.com",
      password_allowed: true,
      sso_required: false,
    });
    mockedIsMfaRequiredAuthResponse.mockImplementation(
      (value: unknown): value is any =>
        !!value && typeof value === "object" && (value as any).mfa_required,
    );
    mockedPostAuthApi
      .mockResolvedValueOnce({
        mfa_required: true,
        challenge_id: "challenge-1",
        methods: ["passkey", "recovery_code"],
        home_bay_id: "bay-1",
      } as any)
      .mockResolvedValueOnce({
        account_id: "account-1",
        home_bay_url: "https://bay.example.test",
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
    fireEvent.click(
      within(chooser).getByRole("button", { name: "Recovery code" }),
    );

    expect(
      screen.getByText(
        "Enter one of the recovery codes saved when your passkey was set up.",
      ),
    ).not.toBeNull();
    expect(within(chooser).queryByRole("button", { name: "Code" })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("ABCD-EFGH-IJKL"), {
      target: { value: "123456" },
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {
      // jsdom does not implement full-page reloads.
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenLastCalledWith({
        endpoint: "auth/verify-second-factor",
        body: {
          challenge_id: "challenge-1",
          method: "recovery_code",
          code: "123456",
        },
      }),
    );
    consoleError.mockRestore();
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
    mockedGetControlPlaneAuthBootstrap.mockResolvedValueOnce({
      account_id: "acct-alice",
      display_name: "Alice Example",
      email_address: "alice@example.com",
      signed_in: true,
    });

    render(
      <PublicAuthApp
        config={config({
          is_authenticated: true,
        })}
        initialRoute={{
          kind: "project-invite",
          token: "secret",
        }}
      />,
    );

    expect(await screen.findByText("Signed-in account")).not.toBeNull();
    expect(screen.getByText("Email:")).not.toBeNull();
    expect(screen.getByText("alice@example.com")).not.toBeNull();
    expect(screen.getByText("Name:")).not.toBeNull();
    expect(screen.getAllByText("Alice Example").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Accepting this invite will add this account to the project.",
      ),
    ).not.toBeNull();
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {
      // jsdom does not implement full-page reloads.
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Sign out to use a different account",
      }),
    );
    await waitFor(() =>
      expect(mockedSignOutAuthSession).toHaveBeenCalledWith(),
    );
    consoleError.mockRestore();
  });

  it("requires the inviter to switch accounts instead of accepting", async () => {
    mockedApi.mockResolvedValueOnce({
      invite: {
        invite_id: "77777777-7777-4777-8777-777777777777",
        inviter_account_id: "acct-owner",
        inviter_name: "Owner Example",
        project_id: "22222222-2222-4222-8222-222222222222",
        project_title: "Research Project",
        status: "pending",
      },
    } as any);
    mockedGetControlPlaneAuthBootstrap.mockResolvedValueOnce({
      account_id: "acct-owner",
      display_name: "Owner Example",
      email_address: "owner@example.com",
      signed_in: true,
    });

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{
          kind: "project-invite",
          token: "secret",
        }}
      />,
    );

    expect(
      await screen.findByText("Switch accounts to accept this invite"),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "You created this invitation, so this account cannot accept it. Sign out and open the same link using the CoCalc account you want to add.",
      ),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Accept invite" })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Sign out to use a different account",
      }),
    ).not.toBeNull();
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

  it("prefills an anonymous CLI login from its email hint", async () => {
    window.history.replaceState({}, "", "/auth/cli-login/challenge-1");
    mockedPostAuthApi
      .mockResolvedValueOnce({
        challenge_id: "challenge-1",
        kind: "login",
        account_id: null,
        email_address: null,
        display_name: null,
        email_hint: "hint@example.com",
        current_account_id: null,
        current_email_address: null,
        current_display_name: null,
        current_matches_account: null,
        state: "pending",
        expires_at: "2026-05-08T18:00:00.000Z",
      } as any)
      .mockResolvedValueOnce({
        challenge_id: "email-challenge-1",
        state: "pending",
        masked_email: "hi…@example.com",
        expires_at: "2026-05-08T18:00:00.000Z",
        resend_available_at: "2026-05-08T17:55:30.000Z",
      } as any);

    render(
      <PublicAuthApp
        config={config({
          email_authentication_mode: "email_first",
          is_authenticated: false,
        })}
        initialRoute={{ challengeId: "challenge-1", kind: "auth-cli-login" }}
      />,
    );

    expect(await screen.findByDisplayValue("hint@example.com")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue with email" }),
    ).not.toBeNull();
    expect(screen.queryByPlaceholderText("Password")).toBeNull();
    expect(
      screen.queryByText(/CoCalc.com accounts do not sign in directly/),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "auth/email/start",
        body: {
          email: "hint@example.com",
          target: "/auth/cli-login/challenge-1",
          terms: true,
        },
      }),
    );
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
    mockedPostAuthApi
      .mockResolvedValueOnce({
        token: "approval-token",
        home_bay_id: "bay-0",
      } as any)
      .mockResolvedValueOnce({ approved: true } as any);

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
        body: {
          challenge_id: "challenge-1",
          approval_token: "approval-token",
          approval_home_bay_id: "bay-0",
        },
      }),
    );
  });

  it("labels mobile app login approvals without terminal or CLI wording", async () => {
    mockedPostAuthApi.mockResolvedValueOnce({
      challenge_id: "challenge-1",
      kind: "login",
      auth_client: "mobile",
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
    mockedPostAuthApi
      .mockResolvedValueOnce({
        token: "approval-token",
        home_bay_id: "bay-0",
      } as any)
      .mockResolvedValueOnce({ approved: true } as any);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{ challengeId: "challenge-1", kind: "auth-cli-login" }}
      />,
    );

    expect(
      await screen.findByText(
        /Approve a CoCalc mobile app sign-in for alice@example.com \(Alice Example\)\./,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /The mobile app was started with email hint hint@example.com\./,
      ),
    ).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/terminal sign-in/i);
    expect(document.body.textContent).not.toMatch(/CLI sign-in/i);

    fireEvent.click(
      screen.getByRole("button", { name: "Approve Mobile App Login" }),
    );
    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "auth/cli/login/approve",
        body: {
          challenge_id: "challenge-1",
          approval_token: "approval-token",
          approval_home_bay_id: "bay-0",
        },
      }),
    );
  });

  it("clearly approves an elevated CLI login in one browser flow", async () => {
    mockedPostAuthApi
      .mockResolvedValueOnce({
        challenge_id: "challenge-1",
        kind: "login",
        account_id: null,
        current_account_id: "acct-viewer",
        current_email_address: "alice@example.com",
        current_display_name: "Alice Example",
        current_matches_account: true,
        elevated_login: true,
        requested_duration: "extended",
        state: "pending",
        expires_at: "2026-05-08T18:00:00.000Z",
      } as any)
      .mockResolvedValueOnce({
        token: "approval-token",
        home_bay_id: "bay-0",
      } as any)
      .mockResolvedValueOnce({ approved: true } as any);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{ challengeId: "challenge-1", kind: "auth-cli-login" }}
      />,
    );

    expect(
      await screen.findByText(/Approve an elevated CLI sign-in/),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Approve Elevated CLI Login" }),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Approve Elevated CLI Login" }),
    );

    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "auth/cli/login/approval-token",
        origin: expect.anything(),
        body: {
          challenge_id: "challenge-1",
          elevated_login: true,
          requested_duration: "extended",
        },
      }),
    );
    expect(
      await screen.findByText(/Elevated CLI login approved/),
    ).not.toBeNull();
  });

  it("does not ask for or submit a password when CLI elevation uses a second factor", async () => {
    mockedPostAuthApi
      .mockResolvedValueOnce({
        challenge_id: "challenge-2",
        kind: "elevate",
        account_id: "acct-viewer",
        email_address: "alice@example.com",
        display_name: "Alice Example",
        current_account_id: "acct-viewer",
        current_email_address: "alice@example.com",
        current_display_name: "Alice Example",
        current_matches_account: true,
        state: "pending",
        expires_at: "2026-05-08T18:00:00.000Z",
      } as any)
      .mockResolvedValueOnce({
        mode: "account",
        enabled: true,
        methods: ["totp", "recovery_code"],
        has_password: true,
        email_address: "alice@example.com",
      } as any)
      .mockResolvedValueOnce({ approved: true } as any);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{ challengeId: "challenge-2", kind: "auth-cli-elevate" }}
      />,
    );

    expect(await screen.findByText("Second factor")).not.toBeNull();
    expect(screen.queryByText("Current password")).toBeNull();
    expect(
      screen.queryByPlaceholderText("Enter your current password"),
    ).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("123456"), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Approve CLI Elevation" }),
    );
    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "auth/cli/elevate/approve",
        body: {
          challenge_id: "challenge-2",
          current_password: "",
          method: "totp",
          code: "123456",
        },
      }),
    );
  });

  it("requires a password when CLI elevation has no second factor", async () => {
    mockedPostAuthApi
      .mockResolvedValueOnce({
        challenge_id: "challenge-2",
        kind: "elevate",
        account_id: "acct-viewer",
        email_address: "alice@example.com",
        display_name: "Alice Example",
        current_account_id: "acct-viewer",
        current_email_address: "alice@example.com",
        current_display_name: "Alice Example",
        current_matches_account: true,
        state: "pending",
        expires_at: "2026-05-08T18:00:00.000Z",
      } as any)
      .mockResolvedValueOnce({
        mode: "account",
        enabled: false,
        methods: [],
        has_password: true,
        email_address: "alice@example.com",
      } as any);

    render(
      <PublicAuthApp
        config={config({ is_authenticated: true })}
        initialRoute={{ challengeId: "challenge-2", kind: "auth-cli-elevate" }}
      />,
    );

    expect(
      await screen.findByPlaceholderText("Enter your current password"),
    ).not.toBeNull();
    expect(screen.queryByText("Second factor")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Approve CLI Elevation" }),
    ).toBeDisabled();
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
      screen.getByPlaceholderText("Enter your current password"),
      {
        target: { value: "current-password" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(mockedPostAuthApi).toHaveBeenCalledWith({
        endpoint: "auth/fresh-auth",
        origin: "https://bay.example.test",
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
