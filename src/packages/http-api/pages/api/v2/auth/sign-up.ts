/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Sign up for a new account:

1. Reject if password is absurdly weak.
2. Query the database to make sure the email address is not already taken.
3. Generate a random account_id. Do not check it is not already taken, since that's
   highly unlikely, and the insert in 4 would fail anyways.
4. Write account to the database.
5. Sign user in (if not being used via the API).

This can also be used by an already signed-in admin browser session, which skips
the captcha flow. API-key authenticated account creation is intentionally not
allowed; use the fresh-auth-protected admin account-creation RPC instead.


API Usage:

curl -d displayName='John Doe' \
  -d email=jd@example.com \
  -d password=xyzabc09090 \
  -d terms=true https://cocalc.ai/api/v2/auth/sign-up

TIP: If you want to pass in an email like jd+1@example.com, use '%2B' in place of '+'.
*/

import { v4 } from "uuid";

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getStrategies from "@cocalc/database/settings/get-sso-strategies";
import {
  getEnabledSsoDomainPolicyForEmail,
  passwordSignupBlockedBySsoPolicy,
} from "@cocalc/database/settings/sso-policies";
import getPool from "@cocalc/database/pool";
import isAccountAvailable from "@cocalc/server/auth/is-account-available";
import passwordStrength from "@cocalc/server/auth/password-strength";
import reCaptcha from "@cocalc/server/auth/recaptcha";
import {
  recordSignUpTokenFail,
  signUpTokenCheck,
} from "@cocalc/server/auth/throttle";
import { evaluateAccountCreationPolicy } from "@cocalc/server/auth/account-creation-policy";
import {
  checkRequiredSSO,
  getEmailDomain,
} from "@cocalc/server/auth/sso/check-required-sso";
import redeemRegistrationToken, {
  deleteRegistrationToken,
  restoreRedeemedRegistrationToken,
  validateRegistrationToken,
} from "@cocalc/server/auth/tokens/redeem";
import getRequiresRegistrationToken from "@cocalc/server/auth/tokens/get-requires-token";
import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOriginForRequest } from "@cocalc/server/bay-public-origin";
import { issueHomeBayRetryToken } from "@cocalc/server/auth/home-bay-retry-token";
import { selectSignupHomeBay } from "@cocalc/server/accounts/select-home-bay";
import { SignupEmailDomainPolicyError } from "@cocalc/server/accounts/signup-email-domain-policy";
import {
  createClusterAccount,
  sendClusterEmailVerification,
} from "@cocalc/server/inter-bay/accounts";
import { getTierTemplate } from "@cocalc/util/membership-tier-templates";
import {
  isLaunchpadMode,
  isSoftwareLicenseActivated,
} from "@cocalc/server/software-licenses/activation";
import {
  is_valid_email_address as isValidEmailAddress,
  len,
} from "@cocalc/util/misc";
import { buildMarketingConsentOtherSettings } from "@cocalc/util/notification-preferences";

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { apiRoute, apiRouteOperation } from "@cocalc/http-api/lib/api";
import assertTrusted from "@cocalc/http-api/lib/api/assert-trusted";
import getParams from "@cocalc/http-api/lib/api/get-params";
import {
  SignUpInputSchema,
  SignUpOutputSchema,
} from "@cocalc/http-api/lib/api/schema/accounts/sign-up";
import { SignUpIssues } from "@cocalc/http-api/lib/types/sign-up";
import { signUserIn } from "./sign-in";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_PASSWORD_STRENGTH,
} from "@cocalc/util/auth";
import {
  displayNameFromParts,
  normalizeDisplayName,
} from "@cocalc/util/accounts/display-name";

const logger = getLogger("auth:sign-up");

const ACCOUNT_CREATION_EMAIL_POLICY_MESSAGE =
  "We can’t create an account with this email address. Contact support if you think this is a mistake.";

export async function signUp(req, res) {
  let {
    terms,
    email,
    password,
    displayName,
    firstName,
    lastName,
    registrationToken,
    marketing_consent,
  } = getParams(req);

  password = (password ?? "").trim();
  email = (email ?? "").toLowerCase().trim();
  displayName =
    normalizeDisplayName(displayName) ||
    displayNameFromParts({
      first_name: firstName,
      last_name: lastName,
    }) ||
    "Anonymous User";
  firstName = undefined;
  lastName = undefined;
  registrationToken = (registrationToken ?? "").trim();

  if (isLaunchpadMode() && !(await isSoftwareLicenseActivated())) {
    res.json({
      issues: {
        api: "Launchpad is not activated yet.",
      },
    });
    return;
  }

  const issues = checkObviousConditions({ terms, email, password });
  if (len(issues) > 0) {
    res.json({ issues });
    return;
  }

  if (req.header("Authorization")) {
    res.json({
      issues: {
        api: "API keys cannot create accounts through sign-up.",
      },
    });
    return;
  }

  // The UI doesn't let users try to make an account via signUp if
  // email isn't enabled.  However, they might try to directly POST
  // to the API, so we check here as well.
  const { email_signup } = await getServerSettings();

  const owner_id = await getAccountId(req);
  if (owner_id) {
    // no captcha required -- api access
    // We ONLY allow creation without checking the captcha
    // for trusted users.
    try {
      await assertTrusted(owner_id);
    } catch (err) {
      res.json({
        issues: {
          api: `${err}`,
        },
      });
      return;
    }
  } else {
    try {
      await reCaptcha(req);
    } catch (err) {
      res.json({
        issues: {
          reCaptcha: err.message,
        },
      });
      return;
    }
  }

  // Check the email sign up conditions.
  if (!email_signup) {
    res.json({
      issues: {
        email: "Email account creation is disabled.",
      },
    });
    return;
  }
  const [ssoDomainPolicy, ssoRequiredStrategy] = await Promise.all([
    getEnabledSsoDomainPolicyForEmail(email),
    getStrategies().then((strategies) =>
      checkRequiredSSO({ email, strategies }),
    ),
  ]);
  const exclusive = passwordSignupBlockedBySsoPolicy(ssoDomainPolicy)
    ? ssoDomainPolicy?.domain
    : ssoRequiredStrategy != null
      ? getEmailDomain(email)
      : undefined;
  const domainPolicy = evaluateAccountCreationPolicy({
    auth_method: "password",
    email,
    sso_required_domain: exclusive,
    signup_disabled_domain:
      ssoDomainPolicy?.signup_mode === "disabled"
        ? ssoDomainPolicy.domain
        : undefined,
  });
  if (domainPolicy.type === "deny_signup_disabled") {
    res.json({
      issues: {
        email: `Account creation is disabled for "@${domainPolicy.domain}".`,
      },
    });
    return;
  }
  if (ssoDomainPolicy?.require_cocalc_2fa) {
    res.json({
      issues: {
        email: `Account creation is disabled for "@${ssoDomainPolicy.domain}" because that domain requires CoCalc two-factor authentication. Contact your site administrator to create or prepare your account.`,
      },
    });
    return;
  }
  if (domainPolicy.type === "deny_use_sso") {
    res.json({
      issues: {
        email: `To sign up with "@${domainPolicy.domain}", you have to use the corresponding single sign on mechanism.  Delete your email address above, then click the SSO icon.`,
      },
    });
    return;
  }

  const requiresRegistrationToken =
    ssoDomainPolicy?.signup_mode === "public_allowed"
      ? false
      : ssoDomainPolicy?.signup_mode === "registration_token_required"
        ? true
        : await getRequiresRegistrationToken();
  let tokenInfo;
  if (requiresRegistrationToken) {
    const tokenThrottle = signUpTokenCheck(email, req.ip);
    if (tokenThrottle) {
      res.json({
        issues: {
          registrationToken: tokenThrottle,
        },
      });
      return;
    }
    try {
      tokenInfo = await validateRegistrationToken(registrationToken);
    } catch (err) {
      recordSignUpTokenFail(email, req.ip);
      res.json({
        issues: {
          registrationToken: `Issue with registration token -- ${err.message}`,
        },
      });
      return;
    }
  }

  const accountAvailable = await isAccountAvailable(email);
  const creationPolicy = evaluateAccountCreationPolicy({
    auth_method: "password",
    email,
    requires_registration_token: requiresRegistrationToken,
    registration_token_validated: requiresRegistrationToken,
    existing_account: !accountAvailable,
  });
  if (creationPolicy.type === "deny_existing_account") {
    res.json({
      issues: { email: `Email address "${email}" already in use.` },
    });
    return;
  }

  if (requiresRegistrationToken) {
    try {
      tokenInfo = await redeemRegistrationToken(registrationToken);
    } catch (err) {
      recordSignUpTokenFail(email, req.ip);
      res.json({
        issues: {
          registrationToken: `Issue with registration token -- ${err.message}`,
        },
      });
      return;
    }
  }

  const tokenCustomize = tokenInfo?.customize;
  const wantsAdmin =
    tokenCustomize != null &&
    typeof tokenCustomize === "object" &&
    (tokenCustomize as { make_admin?: boolean }).make_admin === true;
  const isBootstrap =
    tokenCustomize != null &&
    typeof tokenCustomize === "object" &&
    (tokenCustomize as { bootstrap?: boolean }).bootstrap === true;
  const selected_home_bay_id =
    wantsAdmin || isBootstrap
      ? getConfiguredBayId()
      : await selectSignupHomeBay({ req });

  try {
    const created = await createClusterAccount({
      account_id: v4(),
      email_address: email,
      password,
      display_name: displayName,
      first_name: firstName,
      last_name: lastName,
      home_bay_id: selected_home_bay_id,
      owner_id,
      ephemeral: tokenInfo?.ephemeral,
      other_settings: buildMarketingConsentOtherSettings(
        marketing_consent === true,
      ),
      trusted_product_access: requiresRegistrationToken,
      trusted_product_access_reason: requiresRegistrationToken
        ? "registration_token"
        : undefined,
    });
    const account_id = created.account_id;
    const home_bay_id =
      `${created.home_bay_id ?? ""}`.trim() || selected_home_bay_id;

    if (wantsAdmin) {
      const pool = getPool();
      await pool.query(
        `UPDATE accounts
            SET groups = CASE
              WHEN groups IS NULL THEN ARRAY['admin']::TEXT[]
              WHEN NOT ('admin' = ANY(groups)) THEN array_append(groups, 'admin')
              ELSE groups
            END
          WHERE account_id=$1`,
        [account_id],
      );
    }

    if (wantsAdmin && isBootstrap) {
      const pool = getPool();
      const { rows: proRows } = await pool.query(
        `SELECT label, store_visible, priority, project_defaults, ai_limits, features, usage_limits
         FROM membership_tiers
         WHERE id='pro'
         LIMIT 1`,
      );
      const pro = proRows[0];
      const proTemplate = getTierTemplate("pro");
      const proDefaults = pro ?? proTemplate;
      const adminLabel = "Admin";
      const adminPriority =
        typeof proDefaults?.priority === "number"
          ? proDefaults.priority + 1
          : 1;
      await pool.query(
        `INSERT INTO membership_tiers (
            id, label, store_visible, priority,
            price_monthly, price_yearly, project_defaults, ai_limits, features, usage_limits,
            disabled, notes, history, created, updated
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8::JSONB,$9::JSONB,$10::JSONB,$11,$12,$13::JSONB,NOW(),NOW())
          ON CONFLICT (id)
          DO UPDATE SET
            label=EXCLUDED.label,
            store_visible=EXCLUDED.store_visible,
            priority=EXCLUDED.priority,
            price_monthly=EXCLUDED.price_monthly,
            price_yearly=EXCLUDED.price_yearly,
            project_defaults=EXCLUDED.project_defaults,
            ai_limits=EXCLUDED.ai_limits,
            features=EXCLUDED.features,
            usage_limits=EXCLUDED.usage_limits,
            disabled=EXCLUDED.disabled,
            notes=EXCLUDED.notes,
            updated=NOW()`,
        [
          "admin",
          adminLabel,
          false,
          adminPriority,
          0,
          0,
          proDefaults?.project_defaults ?? null,
          proDefaults?.ai_limits ?? null,
          proDefaults?.features ?? null,
          proDefaults?.usage_limits ?? null,
          false,
          "bootstrap admin tier",
          [],
        ],
      );
      await pool.query(
        `INSERT INTO admin_assigned_memberships (
            account_id, membership_class, assigned_by, assigned_at, expires_at, notes
          )
          VALUES ($1,$2,$3,NOW(),NULL,$4)
          ON CONFLICT (account_id)
          DO UPDATE SET
            membership_class=EXCLUDED.membership_class,
            assigned_by=EXCLUDED.assigned_by,
            assigned_at=EXCLUDED.assigned_at,
            expires_at=NULL,
            notes=EXCLUDED.notes`,
        [account_id, "admin", account_id, "bootstrap admin"],
      );
    }

    if (isBootstrap && registrationToken) {
      await deleteRegistrationToken(registrationToken);
    }

    if (email) {
      const onlyVerify = !requiresRegistrationToken;
      const emailError = await sendClusterEmailVerification({
        account_id,
        home_bay_id,
        only_verify: onlyVerify,
      });
      if (emailError) {
        logger.debug("signup email skipped (no email backend configured)", {
          email,
          err: emailError,
        });
      }
    }
    if (!owner_id) {
      if (home_bay_id !== getConfiguredBayId()) {
        res.json({
          wrong_bay: true,
          home_bay_id,
          home_bay_url: await getBayPublicOriginForRequest(req, home_bay_id),
          retry_token: issueHomeBayRetryToken({
            email,
            home_bay_id,
            purpose: "sign-in",
          }).token,
        });
        return;
      }
      await signUserIn(req, res, account_id); // sets a cookie + response
      return;
    }
    res.json({
      account_id,
      home_bay_id,
      home_bay_url: await getBayPublicOriginForRequest(req, home_bay_id),
    });
  } catch (err) {
    if (!res.headersSent) {
      if (requiresRegistrationToken && registrationToken && tokenInfo) {
        try {
          await restoreRedeemedRegistrationToken(registrationToken);
        } catch (restoreErr) {
          logger.warn(
            "failed to restore registration token after signup error",
            {
              email,
              err: serializeError(restoreErr),
            },
          );
        }
      }
      if (
        err instanceof SignupEmailDomainPolicyError ||
        (err as any)?.name === "SignupEmailDomainPolicyError" ||
        (err as any)?.name === "SignupEmailAccountPolicyError"
      ) {
        logger.warn("account creation blocked by email policy", {
          email,
          err: serializeError(err),
        });
        res.json({
          issues: {
            email: ACCOUNT_CREATION_EMAIL_POLICY_MESSAGE,
          },
        });
        return;
      }
      logger.error("error creating account", {
        email,
        err: serializeError(err),
      });
      res.json({
        issues: {
          api: "Problem creating account. Please try again.",
        },
      });
    }
  }
}

function serializeError(err: unknown) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return `${err}`;
}

export function checkObviousConditions({
  terms,
  email,
  password,
}): SignUpIssues {
  const issues: SignUpIssues = {};
  if (!terms) {
    issues.terms = "You must agree to the terms of usage.";
  }
  if (!email || !isValidEmailAddress(email)) {
    issues.email = `You must provide a valid email address -- '${email}' is not valid.`;
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    issues.password = "Your password must not be very easy to guess.";
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    issues.password = `Your password must be at most ${MAX_PASSWORD_LENGTH} characters long.`;
  } else {
    const { score, help } = passwordStrength(password);
    if (score <= MIN_PASSWORD_STRENGTH) {
      issues.password = help ? help : "Your password is too easy to guess.";
    }
  }
  return issues;
}

export default apiRoute({
  signUp: apiRouteOperation({
    method: "POST",
    openApiOperation: {
      tags: ["Accounts", "Admin"],
    },
  })
    .input({
      contentType: "application/json",
      body: SignUpInputSchema,
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: SignUpOutputSchema,
      },
    ])
    .handler(signUp),
});
