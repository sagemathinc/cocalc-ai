import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PasswordReset } from "./password-reset";

const mockAdminResetPasswordLink = jest.fn();
const mockAdminVerifyEmailAddress = jest.fn();
const mockAdminDisableTwoFactor = jest.fn();
const mockRunFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

jest.mock("antd", () => ({
  Alert: ({ message }: any) => <div>{message}</div>,
  Space: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/antd-bootstrap", () => ({
  Button: ({ children, onClick, disabled }: any) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

jest.mock("@cocalc/frontend/components", () => ({
  CopyToClipBoard: ({ value }: any) => <span>{value}</span>,
  ErrorDisplay: ({ error }: any) => <div>{error}</div>,
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => <div data-testid="fresh-auth-modal" />,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: mockRunFreshAuthAction,
  }),
}));

jest.mock("../../webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        system: {
          adminResetPasswordLink: (...args: any[]) =>
            mockAdminResetPasswordLink(...args),
          adminVerifyEmailAddress: (...args: any[]) =>
            mockAdminVerifyEmailAddress(...args),
          adminDisableTwoFactor: (...args: any[]) =>
            mockAdminDisableTwoFactor(...args),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "",
}));

beforeEach(() => {
  mockAdminResetPasswordLink.mockReset();
  mockAdminVerifyEmailAddress.mockReset();
  mockAdminDisableTwoFactor.mockReset();
  mockRunFreshAuthAction.mockClear();
  jest.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("PasswordReset profile actions", () => {
  it("fresh-auth wraps admin password reset link generation", async () => {
    mockAdminResetPasswordLink.mockResolvedValue(
      "/auth/password-reset/reset-1",
    );

    render(
      <PasswordReset account_id="acct-1" email_address="ada@example.com" />,
    );

    fireEvent.click(screen.getByText("Request Password Reset Link..."));

    await waitFor(() => {
      expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(1);
      expect(mockAdminResetPasswordLink).toHaveBeenCalledWith({
        browser_id: "browser-1",
        user_account_id: "acct-1",
      });
    });
    expect(
      screen.getByText("http://localhost/auth/password-reset/reset-1"),
    ).toBeTruthy();
  });

  it("fresh-auth wraps admin email verification", async () => {
    mockAdminVerifyEmailAddress.mockResolvedValue({
      account_id: "acct-1",
      already_verified: false,
      email_address: "ada@example.com",
      verified_at: "2026-05-20T00:00:00.000Z",
    });

    render(
      <PasswordReset account_id="acct-1" email_address="ada@example.com" />,
    );

    fireEvent.click(screen.getByText("Admin-verify email address"));

    await waitFor(() => {
      expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(1);
      expect(mockAdminVerifyEmailAddress).toHaveBeenCalledWith({
        browser_id: "browser-1",
        user_account_id: "acct-1",
      });
    });
    expect(screen.getByText("ada@example.com is now verified.")).toBeTruthy();
  });

  it("fresh-auth wraps admin two-factor removal", async () => {
    mockAdminDisableTwoFactor.mockResolvedValue({
      account_id: "acct-1",
      disabled_factors: 2,
      deleted_recovery_codes: 10,
    });

    render(
      <PasswordReset account_id="acct-1" email_address="ada@example.com" />,
    );

    fireEvent.click(screen.getByText("Remove 2FA from account..."));

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
      expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(1);
      expect(mockAdminDisableTwoFactor).toHaveBeenCalledWith({
        browser_id: "browser-1",
        user_account_id: "acct-1",
      });
    });
    expect(
      screen.getByText("Removed 2 2FA methods from this account."),
    ).toBeTruthy();
  });
});
