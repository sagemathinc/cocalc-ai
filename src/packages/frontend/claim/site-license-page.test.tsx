/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";

import SiteLicenseClaimPage, {
  claimAuthHref,
  claimErrorMessage,
  tokenFromLocationOrSession,
} from "./site-license-page";
import { webapp_client } from "@cocalc/frontend/webapp-client";

let isLoggedIn = false;

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string, key: string) => {
    if (store === "account" && key === "is_logged_in") {
      return isLoggedIn;
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        purchases: {
          consumeSiteLicenseExternalClaimToken: jest.fn(),
        },
      },
    },
  },
}));

const consumeToken = webapp_client.conat_client.hub.purchases
  .consumeSiteLicenseExternalClaimToken as jest.Mock;

function setUrl(path: string) {
  window.history.replaceState({}, "", path);
}

describe("SiteLicenseClaimPage", () => {
  beforeEach(() => {
    isLoggedIn = false;
    consumeToken.mockReset();
    sessionStorage.clear();
    setUrl("/claim/site-license");
  });

  it("stashes URL tokens in session storage and builds token-free auth targets", () => {
    setUrl("/claim/site-license?token=secret-token&x=1#frag");

    expect(tokenFromLocationOrSession()).toBe("secret-token");
    expect(sessionStorage.getItem("cocalc-site-license-claim-token")).toBe(
      "secret-token",
    );
    expect(claimAuthHref("sign-in")).toBe(
      "/auth/sign-in?target=%2Fclaim%2Fsite-license%3Fx%3D1%23frag",
    );
  });

  it("maps structured claim errors to user-facing messages", () => {
    expect(claimErrorMessage({ code: "claim_token_expired" })).toBe(
      "This claim link has expired. Ask the issuer for a new claim link.",
    );
    expect(claimErrorMessage({ code: "claim_pool_limit" })).toBe(
      "This claim pool has no seats available.",
    );
    expect(claimErrorMessage(new Error("raw server failure"))).toBe(
      "raw server failure",
    );
  });

  it("removes token from the URL and preserves token-free sign-in target", async () => {
    setUrl("/claim/site-license?token=secret-token");

    render(<SiteLicenseClaimPage />);

    await waitFor(() => {
      expect(window.location.href).toBe("http://localhost/claim/site-license");
    });
    expect(
      screen.getByRole("link", { name: "Sign in and claim" }),
    ).toHaveAttribute("href", "/auth/sign-in?target=%2Fclaim%2Fsite-license");
    expect(sessionStorage.getItem("cocalc-site-license-claim-token")).toBe(
      "secret-token",
    );
  });

  it("consumes a stashed token after sign-in and clears it on success", async () => {
    isLoggedIn = true;
    sessionStorage.setItem("cocalc-site-license-claim-token", "secret-token");
    consumeToken.mockResolvedValue({
      id: "consumption-1",
      pool_id: "pool-1",
      site_license_id: "site-license-1",
      package_id: "package-1",
      jti: "jti-1",
      token_hash: "hash-1",
      issuer: "issuer-1",
      account_id: "account-1",
      status: "granted",
      side_effect_key: "side-effect-1",
      membership_class: "member_host",
      retry_count: 0,
      consumed_at: new Date(),
      updated: new Date(),
    });

    render(<SiteLicenseClaimPage />);

    await waitFor(() =>
      expect(consumeToken).toHaveBeenCalledWith({ token: "secret-token" }),
    );
    await screen.findByText("Access claimed");
    expect(
      sessionStorage.getItem("cocalc-site-license-claim-token"),
    ).toBeNull();
  });
});
