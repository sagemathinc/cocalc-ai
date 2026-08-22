/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";

import {
  networkAccessDisabledFromRunQuota,
  NetworkDisabledBadge,
} from "./network-disabled-badge";

describe("NetworkDisabledBadge", () => {
  it("explains the free-project restriction through an accessible control", () => {
    render(<NetworkDisabledBadge />);

    const button = screen.getByRole("button", { name: "Network unavailable" });
    button.focus();
    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("No network access")).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: "No network access details" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Free projects do not have network access/),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Upgrade your membership" }),
    ).toHaveAttribute("href", "/settings/membership");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
  });

  it("only treats an explicit false entitlement as disabled", () => {
    expect(networkAccessDisabledFromRunQuota({ network: false })).toBe(true);
    expect(networkAccessDisabledFromRunQuota({ network: 0 })).toBe(true);
    expect(networkAccessDisabledFromRunQuota({ network: true })).toBe(false);
    expect(networkAccessDisabledFromRunQuota(undefined)).toBe(false);
    expect(
      networkAccessDisabledFromRunQuota({
        get: (key: string) => (key === "network" ? false : undefined),
      }),
    ).toBe(true);
  });
});
