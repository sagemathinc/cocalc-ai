/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import api from "@cocalc/frontend/client/api";
import { postAuthApi } from "./api";
import SignUpFormBase from "./sign-up-base";

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
});
