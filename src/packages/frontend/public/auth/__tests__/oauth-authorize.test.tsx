/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { postAuthApi } from "@cocalc/frontend/auth/api";
import {
  authorizeRequestFromSearch,
  PublicOAuthAuthorizeView,
} from "../oauth-authorize-view";
import { getPublicAuthRouteFromPath, isPublicAuthRoutePath } from "../routes";

jest.mock("@cocalc/frontend/auth/api", () => ({
  postAuthApi: jest.fn(),
  signOutAuthSession: jest.fn(),
}));
jest.mock("@cocalc/frontend/control-plane-origin", () => ({
  getControlPlaneOrigin: () => "https://home.test",
}));

const api = jest.mocked(postAuthApi);
const SEARCH =
  "?response_type=code&client_id=sagebrush&redirect_uri=https%3A%2F%2Fsagebrush.space%2Fauth%2Fcallback&state=s1&code_challenge=" +
  "a".repeat(43) +
  "&code_challenge_method=S256&extra=ignored";
const REQUEST = {
  response_type: "code",
  client_id: "sagebrush",
  redirect_uri: "https://sagebrush.space/auth/callback",
  state: "s1",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
};
const INFO = {
  client_id: "sagebrush",
  client_name: "Sagebrush",
  client_homepage: "https://sagebrush.space",
  redirect_uri: "https://sagebrush.space/auth/callback",
  redirect_origin: "https://sagebrush.space",
  deny_url:
    "https://sagebrush.space/auth/callback?error=access_denied&state=s1",
};

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
});

function respond(responses: Record<string, any>) {
  api.mockReset().mockImplementation(async ({ endpoint }) => {
    const value = responses[endpoint];
    if (value instanceof Error) throw value;
    return value;
  });
}

function renderView(
  props: Partial<Parameters<typeof PublicOAuthAuthorizeView>[0]> = {},
) {
  const navigate = jest.fn();
  render(
    <PublicOAuthAuthorizeView
      search={SEARCH}
      isAuthenticated
      accountDisplayName="Ada Lovelace"
      accountEmailAddress="ada@example.com"
      accountEmailAddressVerified
      navigate={navigate}
      {...props}
    />,
  );
  return navigate;
}

describe("authorize route", () => {
  it("is a public auth route that keeps the query string", () => {
    expect(getPublicAuthRouteFromPath("/auth/oauth/authorize", SEARCH)).toEqual(
      { kind: "auth-oauth-authorize", search: SEARCH },
    );
    expect(isPublicAuthRoutePath("/auth/oauth/authorize", SEARCH)).toBe(true);
    expect(isPublicAuthRoutePath("/auth/oauth/other")).toBe(false);
  });

  it("forwards only the authorize parameters", () => {
    expect(authorizeRequestFromSearch(SEARCH)).toEqual(REQUEST);
  });
});

describe("PublicOAuthAuthorizeView", () => {
  it("gets a home-bay proof, approves and sends the browser back with the code", async () => {
    respond({
      "auth/oauth/authorize-info": INFO,
      "auth/oauth/approval-token": { token: "proof", home_bay_id: "bay-2" },
      "auth/oauth/approve": {
        redirect_url: "https://sagebrush.space/auth/callback?code=c&state=s1",
      },
    });
    const navigate = renderView();
    expect(
      await screen.findByText(/It will receive your account id/),
    ).toBeTruthy();
    expect(screen.getByText(/Ada Lovelace \(ada@example.com\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "https://sagebrush.space/auth/callback?code=c&state=s1",
      ),
    );
    expect(api).toHaveBeenCalledWith({
      endpoint: "auth/oauth/approval-token",
      origin: "https://home.test",
      body: { request: REQUEST },
    });
    expect(api).toHaveBeenCalledWith({
      endpoint: "auth/oauth/approve",
      body: {
        request: REQUEST,
        approval_token: "proof",
        approval_home_bay_id: "bay-2",
      },
    });
  });

  it("sends Deny back to the client", async () => {
    respond({ "auth/oauth/authorize-info": INFO });
    const navigate = renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Deny" }));
    expect(navigate).toHaveBeenCalledWith(INFO.deny_url);
  });

  it("shows an invalid request as an error and offers no way back", async () => {
    respond({
      "auth/oauth/authorize-info": new Error("redirect_uri is not registered"),
    });
    const navigate = renderView();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /not valid.*redirect_uri is not registered/,
    );
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("asks a signed-out user to sign in first", async () => {
    respond({ "auth/oauth/authorize-info": INFO });
    renderView({ isAuthenticated: false });
    expect(
      await screen.findByText("Sign in to continue to Sagebrush"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("requires a verified email address before Allow", async () => {
    respond({
      "auth/oauth/authorize-info": INFO,
      "accounts/send-verification-email": {},
    });
    renderView({ accountEmailAddressVerified: false });
    expect(
      await screen.findByText("Verify your email address first"),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Send verification email" }),
    );
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("switches to the verification prompt when the home bay says so", async () => {
    respond({
      "auth/oauth/authorize-info": INFO,
      "auth/oauth/approval-token": Object.assign(new Error("verify"), {
        code: "email_not_verified",
      }),
    });
    const navigate = renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(
      await screen.findByText("Verify your email address first"),
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});
