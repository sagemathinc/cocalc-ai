/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getStrategies from "@cocalc/database/settings/get-sso-strategies";
import { apiRoute, apiRouteOperation, z } from "@cocalc/http-api/lib/api";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { checkRequiredSSO } from "@cocalc/server/auth/sso/check-required-sso";
import { is_valid_email_address as isValidEmailAddress } from "@cocalc/util/misc";

const PublicStrategySchema = z.object({
  name: z.string(),
  display: z.string(),
  icon: z.string().optional(),
  backgroundColor: z.string(),
  public: z.boolean(),
  exclusiveDomains: z.array(z.string()),
  doNotHide: z.boolean(),
});

const SignInMethodInputSchema = z.object({
  email: z.string().min(1),
});

const SignInMethodOutputSchema = z.union([
  z.object({
    email: z.string(),
    password_allowed: z.boolean(),
    sso_required: z.boolean(),
    sso_strategy: PublicStrategySchema.optional(),
    reason: z.enum(["domain_sso_required"]).optional(),
  }),
  z.object({
    error: z.string(),
  }),
]);

export async function signInMethod(req, res) {
  const { email: rawEmail } = getParams(req);
  const email = `${rawEmail ?? ""}`.trim().toLowerCase();

  if (!email || !isValidEmailAddress(email)) {
    res.json({ error: "Invalid email address." });
    return;
  }

  const strategies = await getStrategies();
  const ssoStrategy = checkRequiredSSO({ email, strategies });
  if (ssoStrategy != null) {
    res.json({
      email,
      password_allowed: false,
      sso_required: true,
      sso_strategy: ssoStrategy,
      reason: "domain_sso_required",
    });
    return;
  }

  res.json({
    email,
    password_allowed: true,
    sso_required: false,
  });
}

export default apiRoute({
  signInMethod: apiRouteOperation({
    method: "POST",
    openApiOperation: {
      tags: ["Auth"],
    },
  })
    .input({
      contentType: "application/json",
      body: SignInMethodInputSchema,
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: SignInMethodOutputSchema,
      },
    ])
    .handler(signInMethod),
});
