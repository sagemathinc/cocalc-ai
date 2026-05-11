/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { EmailAddressSetting } from "./email-address-setting";
import { EmailVerification } from "./email-verification";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_client: {
      change_email: jest.fn(),
      send_verification_email: jest.fn(),
    },
  },
}));

describe("EmailAddressSetting", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("hides the email address by default and reveals it on demand", () => {
    render(
      <IntlProvider locale="en">
        <EmailAddressSetting email_address="user@example.com" />
      </IntlProvider>,
    );

    expect(screen.getByText("Hidden")).toBeInTheDocument();
    expect(screen.queryByText("user@example.com")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show" }));

    expect(screen.getByText("user@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    expect(screen.getByText("Hidden")).toBeInTheDocument();
    expect(screen.queryByText("user@example.com")).toBeNull();
  });

  it("shows automatic verification-email status after changing email", async () => {
    const changeEmail = jest.mocked(webapp_client.account_client.change_email);
    const sendVerification = jest.mocked(
      webapp_client.account_client.send_verification_email,
    );
    changeEmail.mockResolvedValueOnce({
      already_verified: false,
      email_address: "new@example.com",
      verification_email_sent: true,
    });

    render(
      <IntlProvider locale="en">
        <EmailAddressSetting
          email_address="user@example.com"
          verify_emails={true}
        />
      </IntlProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /change email/i }));
    fireEvent.change(screen.getByPlaceholderText("user@example.com"), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Current password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Change email address" }),
    );

    await waitFor(() => {
      expect(changeEmail).toHaveBeenCalledWith(
        "new@example.com",
        "correct horse battery staple",
      );
      expect(
        screen.getByText(/We sent a verification email to that address/i),
      ).toBeInTheDocument();
    });
    expect(sendVerification).not.toHaveBeenCalled();
  });

  it("shows sending and sent states for manual verification email", async () => {
    let resolveSend: () => void = () => undefined;
    jest
      .mocked(webapp_client.account_client.send_verification_email)
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
      );

    render(
      <IntlProvider locale="en">
        <EmailVerification email_address="new@example.com" />
      </IntlProvider>,
    );

    const button = screen.getByRole("button", {
      name: "Send Verification Email",
    });
    fireEvent.click(button);

    expect(screen.getByRole("button", { name: /Sending/i })).toBeDisabled();

    resolveSend();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Verification Email Sent" }),
      ).toBeDisabled();
    });
  });
});
