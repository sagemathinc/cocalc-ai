/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  getDefaultNotificationPreferencesV2,
  getDefaultNotificationPreferences,
  normalizeCodexCompletionNotificationOverride,
  normalizeNotificationPreferences,
  normalizeNotificationPreferencesV2,
  resolveCodexCompletionNotificationEnabled,
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
        onboarding: "immediate",
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
        onboarding: "immediate",
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

  it("keeps the one-time onboarding status available in-app", () => {
    expect(
      normalizeNotificationPreferences({
        email: { onboarding: "none" },
      }).email.onboarding,
    ).toBe("immediate");
    expect(
      normalizeNotificationPreferences({
        email: { onboarding: "off" },
      }).email.onboarding,
    ).toBe("off");
  });

  it("preserves preferences supplied through an Immutable-style value", () => {
    expect(
      normalizeNotificationPreferences({
        toJS: () => ({ email: { mentions: "none", onboarding: "off" } }),
      }).email,
    ).toMatchObject({ mentions: "none", onboarding: "off" });
  });

  it("defaults Codex completion and independent delivery channels on", () => {
    expect(getDefaultNotificationPreferencesV2()).toEqual({
      version: 2,
      ai: {
        completion_default: true,
        events: {
          attention: {
            inbox: true,
            toast: true,
            browser: true,
            email: "unresolved_after_delay",
            email_delay_minutes: 5,
          },
          completion: {
            inbox: true,
            toast: true,
            browser: true,
            email: "off",
          },
          terminal_failure: {
            inbox: true,
            toast: true,
            browser: true,
            email: "unresolved_after_delay",
            email_delay_minutes: 5,
          },
        },
      },
    });
  });

  it("migrates legacy AI delivery without enabling an explicit none", () => {
    const disabled = normalizeNotificationPreferencesV2(undefined, {
      email: { ai: "none" },
    });
    for (const policy of Object.values(disabled.ai.events)) {
      expect(policy).toMatchObject({
        inbox: false,
        toast: false,
        browser: false,
        email: "off",
      });
    }

    expect(
      normalizeNotificationPreferencesV2(undefined, {
        email: { ai: "immediate" },
      }).ai.events.completion,
    ).toMatchObject({ inbox: true, email: "immediate" });
  });

  it("preserves V2 fields independently from legacy writers", () => {
    const v2 = normalizeNotificationPreferencesV2(
      {
        version: 2,
        ai: {
          completion_default: false,
          events: {
            attention: {
              inbox: false,
              toast: true,
              browser: false,
              email: "digest",
            },
          },
        },
      },
      { email: { ai: "none" } },
    );
    expect(v2.ai.completion_default).toBe(false);
    expect(v2.ai.events.attention).toMatchObject({
      inbox: false,
      toast: true,
      browser: false,
      email: "digest",
    });
  });

  it("maps ambiguous legacy thread false to inherit", () => {
    expect(normalizeCodexCompletionNotificationOverride(false)).toBe("inherit");
    expect(
      normalizeCodexCompletionNotificationOverride(undefined, {
        notifyOnTurnFinish: false,
      }),
    ).toBe("inherit");
    expect(
      normalizeCodexCompletionNotificationOverride(undefined, {
        notifyOnTurnFinish: true,
      }),
    ).toBe("on");
    expect(
      resolveCodexCompletionNotificationEnabled({
        override: "off",
        accountDefault: true,
      }),
    ).toBe(false);
  });
});
