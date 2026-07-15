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
        membership_requests: "immediate",
        access_requests: "immediate",
        mentions: "immediate",
        chat_replies: "immediate",
        support: "immediate",
        ai: "off",
        course: "immediate",
        maintenance: "digest",
        product: "off",
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
          access_requests: "none",
          membership_requests: "off",
          ai: "immediate",
          course: "none",
          product: "off",
          maintenance: "bad",
        },
      }),
    ).toEqual({
      version: 1,
      email: {
        billing: "immediate",
        security: "immediate",
        membership_requests: "immediate",
        access_requests: "none",
        mentions: "digest",
        chat_replies: "digest",
        support: "immediate",
        ai: "immediate",
        course: "none",
        maintenance: "digest",
        product: "off",
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
          billing: "none",
          security: "digest",
        },
      }).email,
    ).toMatchObject({
      billing: "immediate",
      security: "immediate",
    });
  });

  it("restricts membership requests to email delivery modes", () => {
    expect(
      normalizeNotificationPreferences({
        email: {
          membership_requests: "digest",
          access_requests: "off",
        },
      }).email,
    ).toMatchObject({
      membership_requests: "digest",
      access_requests: "off",
    });
  });
});
