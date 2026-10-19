/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";

import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { formatManagedEgressBlockedMessage } from "@cocalc/util/managed-egress-message";
import { parseManagedEgressBlockedError } from "@cocalc/frontend/purchases/managed-egress-blocked";
import { ManagedEgressBlockedScreen } from "./managed-egress-blocked-screen";

jest.mock("@cocalc/frontend/account/membership-purchase-modal", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@cocalc/frontend/customize", () => ({
  HelpEmailLink: () => <a href="mailto:help@example.com">help@example.com</a>,
}));

function blockedInfo(category: string) {
  return parseManagedEgressBlockedError(
    `failed to sign in - Error: ${formatManagedEgressBlockedMessage({
      category,
      policy: {
        blocked_by: "7d",
        blocked_until: "2026-10-21T09:00:00.000Z",
        managed_egress_7d_bytes: 108_000_000_000,
        egress_7d_bytes: 100_000_000_000,
      },
      blocked: "New browser sessions for this account are blocked.",
    })}`,
  )!;
}

describe("ManagedEgressBlockedScreen", () => {
  it("is a labelled region using theme tokens (light and dark), not fixed colors", () => {
    const { container } = render(
      <ManagedEgressBlockedScreen
        blocked={blockedInfo("control-plane-conat")}
      />,
    );
    const region = screen.getByRole("region", {
      name: "Account control traffic limit reached for this account.",
    });
    expect(region.style.background).toBe(UI_COLORS.page);
    // every inline color is a theme variable, so dark appearance applies
    for (const element of Array.from(
      container.querySelectorAll<HTMLElement>("[style]"),
    )) {
      expect(element.getAttribute("style")).not.toMatch(
        /#[0-9a-f]{3,8}\b|rgba?\(/i,
      );
    }
  });

  it("offers support, not an upgrade, for the control-plane limit, and an upgrade otherwise", () => {
    const { unmount } = render(
      <ManagedEgressBlockedScreen
        blocked={blockedInfo("control-plane-conat")}
      />,
    );
    expect(screen.getByText("Need it sooner?")).toBeTruthy();
    expect(screen.queryByText("Upgrade is still available")).toBeNull();
    unmount();
    render(<ManagedEgressBlockedScreen blocked={blockedInfo("raw-network")} />);
    expect(screen.getByText("Upgrade is still available")).toBeTruthy();
  });
});
