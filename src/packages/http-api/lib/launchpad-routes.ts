/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ApiV2RouteEntry } from "./api-v2-routes";

import authBootstrap from "../pages/api/v2/auth/bootstrap";
import authFreshAuth from "../pages/api/v2/auth/fresh-auth";
import authRequiresToken from "../pages/api/v2/auth/requires-token";
import authSignIn from "../pages/api/v2/auth/sign-in";
import authSignInMethod from "../pages/api/v2/auth/sign-in-method";
import authSignUp from "../pages/api/v2/auth/sign-up";
import authCliChallengeInfo from "../pages/api/v2/auth/cli/challenge-info";
import authCliLoginApprovalToken from "../pages/api/v2/auth/cli/login/approval-token";
import authCliLoginApprove from "../pages/api/v2/auth/cli/login/approve";
import authCliLoginRedeem from "../pages/api/v2/auth/cli/login/redeem";
import authCliLoginStart from "../pages/api/v2/auth/cli/login/start";
import authCliLoginStatus from "../pages/api/v2/auth/cli/login/status";
import authCliSessionStatus from "../pages/api/v2/auth/cli/session-status";
import accountSendVerificationEmail from "../pages/api/v2/accounts/send-verification-email";
import accountSetEmailAddress from "../pages/api/v2/accounts/set-email-address";

export function getLaunchpadApiV2Routes(): ApiV2RouteEntry[] {
  return [
    { path: "/auth/bootstrap", handler: authBootstrap },
    { path: "/auth/fresh-auth", handler: authFreshAuth },
    { path: "/auth/requires-token", handler: authRequiresToken },
    { path: "/auth/sign-in", handler: authSignIn },
    { path: "/auth/sign-in-method", handler: authSignInMethod },
    { path: "/auth/sign-up", handler: authSignUp },
    { path: "/auth/cli/challenge-info", handler: authCliChallengeInfo },
    {
      path: "/auth/cli/login/approval-token",
      handler: authCliLoginApprovalToken,
    },
    { path: "/auth/cli/login/approve", handler: authCliLoginApprove },
    { path: "/auth/cli/login/redeem", handler: authCliLoginRedeem },
    { path: "/auth/cli/login/start", handler: authCliLoginStart },
    { path: "/auth/cli/login/status", handler: authCliLoginStatus },
    { path: "/auth/cli/session-status", handler: authCliSessionStatus },
    {
      path: "/accounts/send-verification-email",
      handler: accountSendVerificationEmail,
    },
    { path: "/accounts/set-email-address", handler: accountSetEmailAddress },
  ];
}
