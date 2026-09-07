/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("restores the saved email when cancelling edits with the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider locale="en">
        <EmailAddressSetting email_address="user@example.com" />
      </IntlProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: /change/i }));
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("user@example.com");
    await user.clear(input);
    await user.type(input, "unsaved@example.com");
    await user.tab(); // Password field.
    await user.tab(); // Cancel button.
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.queryByText("unsaved@example.com")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    expect(webapp_client.account_client.change_email).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /change/i }));
    expect(screen.getByRole("textbox")).toHaveValue("user@example.com");
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it.each(["success", "failure"])(
    "locks the form during saving and recovers on %s",
    async (outcome) => {
      jest.useFakeTimers();
      try {
        const changeEmail = jest.mocked(
          webapp_client.account_client.change_email,
        );
        let finishSave!: (result: {
          email_address: string;
          already_verified: boolean;
        }) => void;
        let failSave!: (error: Error) => void;
        changeEmail.mockReturnValueOnce(
          new Promise((resolve, reject) => {
            finishSave = resolve;
            failSave = reject;
          }),
        );
        render(
          <IntlProvider locale="en">
            <EmailAddressSetting email_address="user@example.com" />
          </IntlProvider>,
        );
        fireEvent.click(screen.getByRole("button", { name: "Show" }));
        fireEvent.click(screen.getByRole("button", { name: /change/i }));
        fireEvent.change(screen.getByRole("textbox"), {
          target: { value: "new@example.com" },
        });
        const password = screen.getByPlaceholderText("Current password");
        fireEvent.change(password, {
          target: { value: "correct horse battery staple" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Change" }));
        const cancel = screen.getByRole("button", { name: "Cancel" });
        expect(cancel).toBeDisabled();
        expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
        expect(screen.getByRole("textbox")).toBeDisabled();
        expect(password).toBeDisabled();
        fireEvent.click(cancel);
        // A slow request is still pending, not cancelled or safe to retry.
        await act(async () => {
          jest.advanceTimersByTime(60_000);
        });
        expect(cancel).toBeDisabled();
        expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
        expect(screen.getByRole("textbox")).toBeDisabled();
        expect(password).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Change" }));
        expect(changeEmail).toHaveBeenCalledTimes(1);
        if (outcome === "success") {
          await act(async () => {
            finishSave({
              email_address: "new@example.com",
              already_verified: true,
            });
          });
          expect(
            screen.getByText("new@example.com", { exact: true }),
          ).toBeInTheDocument();
          expect(
            screen.queryByRole("button", { name: "Cancel" }),
          ).not.toBeInTheDocument();
        } else {
          await act(async () => {
            failSave(new Error("password is incorrect"));
          });
          expect(screen.getByText(/password is incorrect/)).toBeInTheDocument();
          expect(cancel).toBeEnabled();
          expect(screen.getByRole("textbox")).toBeEnabled();
          expect(password).toBeEnabled();
          expect(screen.getByRole("button", { name: "Change" })).toBeEnabled();
          fireEvent.click(cancel);
          expect(
            screen.getByText("user@example.com", { exact: true }),
          ).toBeInTheDocument();
          expect(
            screen.queryByText(/Email address changed to/),
          ).not.toBeInTheDocument();
        }
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it("shows automatic verification-email status after changing email", async () => {
    const changeEmail = jest.mocked(webapp_client.account_client.change_email);
    const sendVerification = jest.mocked(
      webapp_client.account_client.send_verification_email,
    );
    const runFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
      await action();
      return true;
    });
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
          runFreshAuthAction={runFreshAuthAction}
        />
      </IntlProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /change/i }));
    fireEvent.change(screen.getByPlaceholderText("user@example.com"), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Current password"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));

    await waitFor(() => {
      expect(runFreshAuthAction).toHaveBeenCalledTimes(1);
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
