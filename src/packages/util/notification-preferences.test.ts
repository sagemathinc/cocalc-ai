/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getDefaultNotificationPreferences,
  normalizeNotificationPreferences,
} from "./notification-preferences";

describe("notification preferences", () => {
  it("provides safe first-release defaults", () => {
    expect(getDefaultNotificationPreferences()).toEqual({
      version: 1,
      email: {
        billing: "immediate",
        security: "immediate",
        support: "immediate",
        collaboration: "immediate",
        ai: "off",
        product: "digest",
        maintenance: "digest",
        course: "immediate",
      },
      digest: {
        time: "08:00",
        timezone: "auto",
      },
    });
  });

  it("normalizes partial user preferences", () => {
    expect(
      normalizeNotificationPreferences({
        email: {
          collaboration: "digest",
          ai: "immediate",
          product: "off",
          maintenance: "bad",
        },
      }),
    ).toEqual({
      version: 1,
      email: {
        billing: "immediate",
        security: "immediate",
        support: "immediate",
        collaboration: "digest",
        ai: "immediate",
        product: "off",
        maintenance: "digest",
        course: "immediate",
      },
      digest: {
        time: "08:00",
        timezone: "auto",
      },
    });
  });

  it("forces required categories to immediate", () => {
    expect(
      normalizeNotificationPreferences({
        email: {
          billing: "off",
          security: "digest",
        },
      }).email,
    ).toMatchObject({
      billing: "immediate",
      security: "immediate",
    });
  });
});
