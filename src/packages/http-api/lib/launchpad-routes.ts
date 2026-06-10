/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ApiV2RouteEntry } from "./api-v2-routes";

import authBootstrap from "../pages/api/v2/auth/bootstrap";
import authRequiresToken from "../pages/api/v2/auth/requires-token";
import authSignIn from "../pages/api/v2/auth/sign-in";
import authSignInMethod from "../pages/api/v2/auth/sign-in-method";
import authSignUp from "../pages/api/v2/auth/sign-up";

export function getLaunchpadApiV2Routes(): ApiV2RouteEntry[] {
  return [
    { path: "/auth/bootstrap", handler: authBootstrap },
    { path: "/auth/requires-token", handler: authRequiresToken },
    { path: "/auth/sign-in", handler: authSignIn },
    { path: "/auth/sign-in-method", handler: authSignInMethod },
    { path: "/auth/sign-up", handler: authSignUp },
  ];
}
