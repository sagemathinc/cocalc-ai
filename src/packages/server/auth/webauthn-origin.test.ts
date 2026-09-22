/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { validateWebAuthnRelyingParty } from "./webauthn-origin";

const sibling = {
  origin: "https://approve.example.test",
  rp_id: "app.example.test",
  rp_name: "CoCalc",
};

it("accepts a configured Related Origin for a sibling RP ID", () => {
  expect(
    validateWebAuthnRelyingParty({
      ...sibling,
      allow_related_origin: true,
    }),
  ).toMatchObject({
    ...sibling,
    allow_related_origin: true,
  });
});

it("continues to reject an unmarked sibling RP ID", () => {
  expect(() => validateWebAuthnRelyingParty(sibling)).toThrow(
    "passkey relying party is not a parent of its origin",
  );
});
