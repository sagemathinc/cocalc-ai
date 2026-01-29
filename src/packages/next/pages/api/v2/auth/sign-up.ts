/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Sign up for a new account:

0. If email/password matches an existing account, just sign them in.  Reduces confusion.
1. Reject if password is absurdly weak.
2. Query the database to make sure the email address is not already taken.
3. Generate a random account_id. Do not check it is not already taken, since that's
   highly unlikely, and the insert in 4 would fail anyways.
4. Write account to the database.
5. Sign user in (if not being used via the API).

This can also be used via the API, but the client must have a minimum balance
of at least - $100.


API Usage:

curl -u sk_abcdefQWERTY090900000000: \
  -d firstName=John00 \
  -d lastName=Doe00 \
  -d email=jd@example.com \
  -d password=xyzabc09090 \
  -d terms=true https://cocalc.com/api/v2/auth/sign-up

TIP: If you want to pass in an email like jd+1@example.com, use '%2B' in place of '+'.
*/

import { v4 } from "uuid";

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getPool from "@cocalc/database/pool";
import createAccount from "@cocalc/server/accounts/create-account";
import isAccountAvailable from "@cocalc/server/auth/is-account-available";
import isDomainExclusiveSSO from "@cocalc/server/auth/is-domain-exclusive-sso";
import passwordStrength from "@cocalc/server/auth/password-strength";
import reCaptcha from "@cocalc/server/auth/recaptcha";
import redeemRegistrationToken from "@cocalc/server/auth/tokens/redeem";
import sendWelcomeEmail from "@cocalc/server/email/welcome-email";
import getLogger from "@cocalc/backend/logger";
import { getTierTemplate } from "@cocalc/util/membership-tier-templates";
import {
  isLaunchpadMode,
  isSoftwareLicenseActivated,
} from "@cocalc/server/software-licenses/activation";
import {
  is_valid_email_address as isValidEmailAddress,
  len,
} from "@cocalc/util/misc";

import getAccountId from "lib/account/get-account";
import { apiRoute, apiRouteOperation } from "lib/api";
import assertTrusted from "lib/api/assert-trusted";
import getParams from "lib/api/get-params";
import {
  SignUpInputSchema,
  SignUpOutputSchema,
} from "lib/api/schema/accounts/sign-up";
import { SignUpIssues } from "lib/types/sign-up";
import { getAccount, signUserIn } from "./sign-in";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_PASSWORD_STRENGTH,
} from "@cocalc/util/auth";

const logger = getLogger("auth:sign-up");

export async function signUp(req, res) {
  let {
    terms,
    email,
    password,
    firstName,
    lastName,
    registrationToken,
    tags,
    signupReason,
  } = getParams(req);

  password = (password ?? "").trim();
  email = (email ?? "").toLowerCase().trim();
  firstName = (firstName ? firstName : "Anonymous").trim();
  lastName = (
    lastName ? lastName : `User-${Math.round(Date.now() / 1000)}`
  ).trim();
  registrationToken = (registrationToken ?? "").trim();

  if (isLaunchpadMode() && !(await isSoftwareLicenseActivated())) {
    res.json({
      issues: {
        api: "Launchpad is not activated yet.",
      },
    });
    return;
  }

  if (email && password) {
    // Maybe there is already an account with this email and password?
    try {
      const account_id = await getAccount(email, password);
      await signUserIn(req, res, account_id);
      return;
    } catch (_err) {
      // fine -- just means they don't already have an account.
    }
  }

  const issues = checkObviousConditions({ terms, email, password });
  if (len(issues) > 0) {
    res.json({ issues });
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
  const exclusive = await isDomainExclusiveSSO(email);
  if (exclusive) {
    res.json({
      issues: {
        email: `To sign up with "@${exclusive}", you have to use the corresponding single sign on mechanism.  Delete your email address above, then click the SSO icon.`,
      },
    });
    return;
  }

  if (!(await isAccountAvailable(email))) {
    res.json({
      issues: { email: `Email address "${email}" already in use.` },
    });
    return;
  }

  let tokenInfo;
  try {
    tokenInfo = await redeemRegistrationToken(registrationToken);
  } catch (err) {
    res.json({
      issues: {
        registrationToken: `Issue with registration token -- ${err.message}`,
      },
    });
    return;
  }

  try {
    const account_id = v4();
    await createAccount({
      email,
      password,
      firstName,
      lastName,
      account_id,
      tags,
      signupReason,
      owner_id,
      ephemeral: tokenInfo?.ephemeral,
      customize: tokenInfo?.customize,
    });

    const tokenCustomize = tokenInfo?.customize;
    const wantsAdmin =
      tokenCustomize != null &&
      typeof tokenCustomize === "object" &&
      (tokenCustomize as { make_admin?: boolean }).make_admin === true;
    const isBootstrap =
      tokenCustomize != null &&
      typeof tokenCustomize === "object" &&
      (tokenCustomize as { bootstrap?: boolean }).bootstrap === true;

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
        `SELECT label, store_visible, priority, project_defaults, llm_limits, features
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
            price_monthly, price_yearly, project_defaults, llm_limits, features,
            disabled, notes, history, created, updated
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7::JSONB,$8::JSONB,$9::JSONB,$10,$11,$12::JSONB,NOW(),NOW())
          ON CONFLICT (id)
          DO UPDATE SET
            label=EXCLUDED.label,
            store_visible=EXCLUDED.store_visible,
            priority=EXCLUDED.priority,
            price_monthly=EXCLUDED.price_monthly,
            price_yearly=EXCLUDED.price_yearly,
            project_defaults=EXCLUDED.project_defaults,
            llm_limits=EXCLUDED.llm_limits,
            features=EXCLUDED.features,
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
          proDefaults?.llm_limits ?? null,
          proDefaults?.features ?? null,
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
      const pool = getPool();
      await pool.query(
        "UPDATE registration_tokens SET disabled=true WHERE token=$1",
        [registrationToken],
      );
    }

    if (email) {
      try {
        await sendWelcomeEmail(email, account_id);
      } catch (err) {
        // Expected to fail, e.g., when sendgrid or smtp not configured yet.
        logger.debug("welcome email skipped (no email backend configured)", {
          email,
          err,
        });
      }
    }
    if (!owner_id) {
      await signUserIn(req, res, account_id); // sets a cookie + response
      return;
    }
    res.json({ account_id });
  } catch (err) {
    if (!res.headersSent) {
      res.json({ error: err.message });
    }
  }
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
