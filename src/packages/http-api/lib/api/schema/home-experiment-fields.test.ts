/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The Home page experiment version (util/public-home-experiment.ts) must
// survive request validation, which replaces the body with the parsed data.

import { SignUpInputSchema } from "./accounts/sign-up";
import { EmailAuthStartInputSchema } from "./auth/email";

describe("Home experiment fields in the sign-up schemas", () => {
  it("keeps homeVariant in password sign-up", () => {
    const parsed = SignUpInputSchema.parse({
      terms: true,
      email: "new@example.com",
      password: "correct horse battery staple 12345!",
      homeVariant: "math",
    });
    expect(parsed.homeVariant).toBe("math");
  });

  it("keeps home_variant in email-code start", () => {
    const parsed = EmailAuthStartInputSchema.parse({
      email: "new@example.com",
      home_variant: "math",
    });
    expect(parsed.home_variant).toBe("math");
  });

  it("bounds the field's length", () => {
    expect(() =>
      EmailAuthStartInputSchema.parse({
        email: "new@example.com",
        home_variant: "x".repeat(33),
      }),
    ).toThrow();
  });
});
