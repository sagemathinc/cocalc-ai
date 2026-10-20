/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { newSessionExpiry, sessionLimitsFromSettings } from "./session-expiry";

const DAY = 24 * 3600_000;

describe("session limits", () => {
  it("defaults to a 14-day idle timeout and a 60-day lifetime", () => {
    expect(sessionLimitsFromSettings({})).toEqual({
      idle_ms: 14 * DAY,
      max_lifetime_ms: 60 * DAY,
    });
  });

  it("ignores invalid values and never idles longer than the lifetime", () => {
    expect(
      sessionLimitsFromSettings({
        session_idle_timeout_days: "nope",
        session_max_lifetime_days: -3,
      }),
    ).toEqual({ idle_ms: 14 * DAY, max_lifetime_ms: 60 * DAY });
    expect(
      sessionLimitsFromSettings({
        session_idle_timeout_days: 90,
        session_max_lifetime_days: 30,
      }),
    ).toEqual({ idle_ms: 30 * DAY, max_lifetime_ms: 30 * DAY });
  });

  it("caps a new session at a shorter requested lifetime", () => {
    const limits = { idle_ms: 14 * DAY, max_lifetime_ms: 60 * DAY };
    const now = Date.parse("2026-10-18T00:00:00Z");
    expect(newSessionExpiry({ limits, now })).toEqual({
      last_used: new Date(now),
      max_expire: new Date(now + 60 * DAY),
      expire: new Date(now + 14 * DAY),
    });
    expect(newSessionExpiry({ limits, now, lifetime_ms: 3600_000 })).toEqual({
      last_used: new Date(now),
      max_expire: new Date(now + 3600_000),
      expire: new Date(now + 3600_000),
    });
    // Asking for more than the site allows gets the site's lifetime.
    expect(
      newSessionExpiry({ limits, now, lifetime_ms: 180 * DAY }).max_expire,
    ).toEqual(new Date(now + 60 * DAY));
  });
});
