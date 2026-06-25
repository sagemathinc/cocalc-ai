/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import api from "@cocalc/frontend/client/api";
import { postAuthApi } from "./api";
import SignUpFormBase from "./sign-up-base";

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  useTypedRedux: jest.fn(() => ({ mode: "allow_all" })),
}));
jest.mock("@cocalc/frontend/customize", () => ({
  PolicyPrivacyPageUrl: "/policies/privacy",
  PolicyTOSPageUrl: "/policies/terms",
}));
jest.mock("@cocalc/frontend/client/api", () => jest.fn());
jest.mock("./api", () => ({
  postAuthApi: jest.fn(),
  isWrongBayAuthResponse: jest.fn(() => false),
  retryAuthOnHomeBay: jest.fn(),
}));

const mockedApi = jest.mocked(api);
const mockedPostAuthApi = jest.mocked(postAuthApi);

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
});

describe("SignUpFormBase", () => {
  it("shows Terms of Service and Privacy Policy notice near account creation", () => {
    render(
      <SignUpFormBase initialRequiresToken={false} onNavigate={jest.fn()} />,
    );

    expect(
      screen.queryByRole("checkbox", {
        name: /I accept the Terms of Service and Privacy Policy/,
      }),
    ).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Terms of Service" })
        .getAttribute("href"),
    ).toBe("/policies/terms");
    expect(
      screen.getByRole("link", { name: "Privacy Policy" }).getAttribute("href"),
    ).toBe("/policies/privacy");
    expect(
      screen
        .getByText(/By creating an account, you agree/)
        .compareDocumentPosition(
          screen.getByRole("button", { name: "Agree and create account" }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows registration-token issues returned by sign-up", async () => {
    mockedPostAuthApi.mockResolvedValueOnce({
      issues: {
        registrationToken:
          "Issue with registration token -- Registration token is wrong.",
      },
    } as any);

    render(<SignUpFormBase initialRequiresToken onNavigate={jest.fn()} />);

    fireEvent.change(
      screen.getByPlaceholderText("Enter your registration token"),
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
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "New User" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Agree and create account" }),
    );

    expect(
      await screen.findByText(
        "Issue with registration token -- Registration token is wrong.",
      ),
    ).not.toBeNull();
  });

  it("explains that sign-up passwords must be at least 8 characters", () => {
    render(
      <SignUpFormBase initialRequiresToken={false} onNavigate={jest.fn()} />,
    );

    const password = screen.getByPlaceholderText("At least 8 characters");
    fireEvent.change(password, { target: { value: "short" } });
    expect(
      screen.getByText("Password must be at least 8 characters."),
    ).not.toBeNull();

    fireEvent.change(password, { target: { value: "long enough" } });
    expect(
      screen.queryByText("Password must be at least 8 characters."),
    ).toBeNull();
  });

  it("sends marketing consent only when the optional checkbox is selected", async () => {
    mockedPostAuthApi.mockResolvedValueOnce({
      account_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    } as any);

    render(
      <SignUpFormBase initialRequiresToken={false} onNavigate={jest.fn()} />,
    );

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "new-user@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
      target: { value: "correct horse battery staple 12345!" },
    });
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "New User" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Send me occasional platform tips/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Agree and create account" }),
    );

    expect(mockedPostAuthApi).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          displayName: "New User",
          terms: true,
          marketing_consent: true,
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
