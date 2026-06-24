/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Router } from "express";

import { sendPublicAppShell } from "./public-shell";

export default function initPublicAuth(router: Router): void {
  const authPaths = [
    "/auth",
    "/auth/",
    "/auth/sign-in",
    "/auth/sign-in/*rest",
    "/auth/cli-login",
    "/auth/cli-login/*rest",
    "/auth/cli-elevate",
    "/auth/cli-elevate/*rest",
    "/auth/sign-up",
    "/auth/sign-up/*rest",
    "/auth/password-reset",
    "/auth/password-reset/*rest",
    "/auth/password-reset-done",
    "/auth/password-reset-done/*rest",
    "/auth/verify",
    "/auth/verify/*rest",
    "/invites",
    "/invites/*rest",
    "/redeem",
    "/redeem/*rest",
    "/sso",
    "/sso/*rest",
  ];

  router.get(authPaths, sendPublicAppShell);
}
