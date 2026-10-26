/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isPublicHomeVariantId } from "@cocalc/util/public-home-experiment";
import getStrategies from "@cocalc/database/settings/get-sso-strategies";
import { apiRoute, apiRouteOperation } from "@cocalc/http-api/lib/api";
import getParams from "@cocalc/http-api/lib/api/get-params";
import {
  EmailAuthStartInputSchema,
  EmailAuthStartOutputSchema,
} from "@cocalc/http-api/lib/api/schema/auth/email";
import { checkRequiredSSO } from "@cocalc/server/auth/sso/check-required-sso";
import { startEmailAuthChallenge } from "@cocalc/server/inter-bay/email-auth";
import { selectSignupHomeBay } from "@cocalc/server/accounts/select-home-bay";
import { normalizeProjectOnboardingIntent } from "@cocalc/util/accounts/onboarding-intent";

import {
  assertEmailAuthStartEnabled,
  emailAuthErrorPayload,
  getOrSetEmailAuthBrowserBinding,
} from "@cocalc/http-api/lib/auth/email-shared";

function safeContinuationTarget(value: unknown): string | undefined {
  const target = `${value ?? ""}`.trim();
  if (
    !target ||
    target.length > 4096 ||
    !target.startsWith("/") ||
    target.startsWith("//")
  ) {
    return undefined;
  }
  try {
    const url = new URL(target, "https://example.invalid");
    if (
      url.origin !== "https://example.invalid" ||
      /^\/(auth|sso)(\/|$)/.test(url.pathname)
    ) {
      return undefined;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export async function start(req, res) {
  try {
    await assertEmailAuthStartEnabled();
    const {
      email: rawEmail,
      registration_token,
      analytics_token,
      target,
      terms,
      terms_version,
      onboarding_intent,
      home_variant,
    } = getParams(req);
    const email = `${rawEmail ?? ""}`.trim().toLowerCase();
    const strategy = checkRequiredSSO({
      email,
      strategies: await getStrategies(),
    });
    if (strategy) {
      res.json({
        sso_required: true,
        strategy: {
          name: strategy.name,
          display: strategy.display,
        },
      });
      return;
    }
    res.json(
      await startEmailAuthChallenge({
        email_address: email,
        browser_binding: getOrSetEmailAuthBrowserBinding(req, res),
        request_ip: req.ip,
        registration_token: `${registration_token ?? ""}`.trim() || undefined,
        analytics_token: `${analytics_token ?? ""}`.trim() || undefined,
        prospective_home_bay_id: await selectSignupHomeBay({ req }),
        terms_accepted: terms === true,
        terms_version: `${terms_version ?? ""}`.trim() || undefined,
        continuation_target: safeContinuationTarget(target),
        onboarding_intent: normalizeProjectOnboardingIntent(onboarding_intent),
        home_variant: isPublicHomeVariantId(home_variant)
          ? home_variant
          : undefined,
      }),
    );
  } catch (err) {
    res.json(emailAuthErrorPayload(err));
  }
}

export default apiRoute({
  start: apiRouteOperation({
    method: "POST",
    openApiOperation: { tags: ["Auth"] },
  })
    .input({
      contentType: "application/json",
      body: EmailAuthStartInputSchema,
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: EmailAuthStartOutputSchema,
      },
    ])
    .handler(start),
});
