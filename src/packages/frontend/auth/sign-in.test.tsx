/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import SignInForm from "./sign-in";

const mockUseTypedRedux = jest.fn((_store: string, key: string) => {
  if (key === "sign_in_email_instructions") {
    return "Sign in with the email address your instructor invited.";
  }
  return "";
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  useTypedRedux: (...args: any[]) => mockUseTypedRedux(...args),
}));

jest.mock("./api", () => ({
  postAuthApi: jest.fn(),
  isMfaRequiredAuthResponse: jest.fn(() => false),
  isWrongBayAuthResponse: jest.fn(() => false),
  retryAuthOnHomeBay: jest.fn(),
}));

jest.mock("./passkeys", () => ({
  signInWithPasskey: jest.fn(),
}));

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

describe("SignInForm", () => {
  beforeEach(() => {
    mockUseTypedRedux.mockImplementation((_store: string, key: string) => {
      if (key === "sign_in_email_instructions") {
        return "Sign in with the email address your instructor invited.";
      }
      return "";
    });
  });

  it("shows custom sign-in instructions", () => {
    render(<SignInForm onNavigate={jest.fn()} />);

    expect(
      screen.getByText(
        "Sign in with the email address your instructor invited.",
      ),
    ).not.toBeNull();
  });
});
