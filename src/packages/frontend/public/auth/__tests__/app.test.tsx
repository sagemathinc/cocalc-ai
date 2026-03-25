/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import PublicAuthApp, { getAuthViewFromPath } from "../app";

describe("getAuthViewFromPath", () => {
  it("supports auth routes under a base path", () => {
    expect(getAuthViewFromPath("/auth/sign-in")).toBe("sign-in");
    expect(getAuthViewFromPath("/base/auth/sign-up")).toBe("sign-up");
    expect(getAuthViewFromPath("/base/auth/password-reset")).toBe(
      "password-reset",
    );
  });
});

describe("PublicAuthApp", () => {
  it("renders the sign-up view without the app redux shell", () => {
    render(
      <PublicAuthApp
        initialRequiresToken={true}
        initialView="sign-up"
        siteName="Launchpad"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Create your Launchpad account" }),
    ).not.toBeNull();
    expect(screen.getByText("Registration token")).not.toBeNull();
  });

  it("shows app links in the shared nav for authenticated users", () => {
    render(
      <PublicAuthApp
        initialView="sign-in"
        isAuthenticated={true}
        siteName="Launchpad"
      />,
    );

    expect(screen.getByRole("link", { name: "Projects" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).not.toBeNull();
  });
});
