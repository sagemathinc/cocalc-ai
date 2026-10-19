/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
}));

import { sessionLifetimeWarningDue } from "./session-lifetime-banner";

const DAY = 24 * 3600_000;

describe("session lifetime reminder", () => {
  const now = Date.parse("2026-10-18T00:00:00Z");
  const warn_before_ms = 3 * DAY;

  it("shows from three days before the lifetime ends", () => {
    const lifetime = (ms: number) => ({
      max_expire: new Date(now + ms).toISOString(),
      warn_before_ms,
      renewable: true,
    });
    expect(sessionLifetimeWarningDue(lifetime(4 * DAY), now)).toBe(false);
    expect(sessionLifetimeWarningDue(lifetime(2 * DAY), now)).toBe(true);
    expect(sessionLifetimeWarningDue(lifetime(-1), now)).toBe(true);
  });

  it("never shows for sessions that cannot be extended or have no end", () => {
    expect(
      sessionLifetimeWarningDue(
        {
          max_expire: new Date(now + DAY).toISOString(),
          warn_before_ms,
          renewable: false,
        },
        now,
      ),
    ).toBe(false);
    expect(
      sessionLifetimeWarningDue({ warn_before_ms, renewable: true }, now),
    ).toBe(false);
    expect(sessionLifetimeWarningDue(undefined, now)).toBe(false);
  });
});
