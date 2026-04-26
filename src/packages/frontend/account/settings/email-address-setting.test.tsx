/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { EmailAddressSetting } from "./email-address-setting";

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
});
