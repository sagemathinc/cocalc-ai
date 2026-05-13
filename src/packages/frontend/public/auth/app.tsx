/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";

import type { AuthView } from "@cocalc/frontend/auth/types";
import { PublicPage } from "@cocalc/frontend/public/layout/shell";
import { getSiteName, type PublicConfig } from "../common";
import { navigatePublic } from "../navigation";

import {
  PublicCliElevateApprovalView,
  PublicCliLoginApprovalView,
} from "./cli-auth-views";
import {
  PublicPasswordResetDoneView,
  PublicRedeemPasswordResetView,
  PublicVerifyEmailView,
} from "./completion-views";
import {
  PublicPasswordResetForm,
  PublicSignInForm,
  PublicSignUpForm,
} from "./forms";
import PublicAuthPageShell from "./page-shell";
import PublicRedeemVoucherView from "./redeem-view";
import {
  getPublicAuthRouteFromPath,
  pathForAuthView,
  type PublicAuthRoute,
} from "./routes";
import {
  PublicSSODetailView,
  PublicSSOIndexView,
  type PublicSSOStrategy,
} from "./sso-views";

interface PublicAuthAppProps {
  config?: PublicConfig;
  initialRoute: PublicAuthRoute;
  initialSSOStrategies?: PublicSSOStrategy[];
  redirectToPath?: string;
}

function titleForRoute(route: PublicAuthRoute, siteName: string): string {
  switch (route.kind) {
    case "auth-form":
      switch (route.view) {
        case "sign-up":
          return `Create your ${siteName} account`;
        case "password-reset":
          return `Reset your ${siteName} password`;
        case "sign-in":
        default:
          return `Sign in to ${siteName}`;
      }
    case "auth-cli-login":
      return `Approve CLI sign-in for ${siteName}`;
    case "auth-cli-elevate":
      return `Approve CLI security action for ${siteName}`;
    case "auth-second-factor":
      return "Verify your second factor";
    case "auth-password-reset-done":
      return `${siteName} password updated`;
    case "auth-password-reset-redeem":
      return `Choose a new ${siteName} password`;
    case "auth-verify-email":
      return `Verify your ${siteName} email`;
    case "redeem":
      return `Redeem voucher for ${siteName}`;
    case "sso-detail":
    case "sso-index":
      return `${siteName} single sign-on`;
    default:
      return siteName;
  }
}

function subtitleForRoute(route: PublicAuthRoute, siteName: string): string {
  switch (route.kind) {
    case "sso-detail":
    case "sso-index":
      return `Single sign-on for ${siteName}`;
    case "auth-cli-login":
      return `Approve a terminal sign-in request for ${siteName}`;
    case "auth-cli-elevate":
      return `Verify a terminal security action for ${siteName}`;
    case "auth-second-factor":
      return `Finish signing in to ${siteName}`;
    case "auth-password-reset-done":
      return siteName;
    case "redeem":
      return `Sign in or create an account to apply voucher credit to your ${siteName} account.`;
    default:
      return siteName;
  }
}

function cardWidthForRoute(route: PublicAuthRoute): string | undefined {
  switch (route.kind) {
    case "sso-detail":
      return "min(760px, 96vw)";
    case "sso-index":
      return "min(900px, 96vw)";
    case "auth-cli-login":
    case "auth-cli-elevate":
    case "auth-password-reset-redeem":
    case "auth-password-reset-done":
    case "auth-verify-email":
      return "min(560px, 96vw)";
    case "redeem":
      return "min(720px, 96vw)";
    default:
      return undefined;
  }
}

export { getPublicAuthRouteFromPath };

export default function PublicAuthApp({
  config,
  initialRoute,
  initialSSOStrategies,
  redirectToPath,
}: PublicAuthAppProps) {
  const [route, setRoute] = useState<PublicAuthRoute>(initialRoute);
  const siteName = getSiteName(config);

  useEffect(() => {
    setRoute(initialRoute);
  }, [initialRoute]);

  const title = useMemo(
    () => titleForRoute(route, siteName),
    [route, siteName],
  );

  useEffect(() => {
    document.title = title;
  }, [title]);

  function onNavigate(next: AuthView) {
    const nextRoute: PublicAuthRoute = { kind: "auth-form", view: next };
    setRoute(nextRoute);
    navigatePublic(pathForAuthView(next));
  }

  return (
    <PublicPage active="auth" config={config} title={title}>
      <PublicAuthPageShell
        cardWidth={cardWidthForRoute(route)}
        subtitle={subtitleForRoute(route, siteName)}
      >
        {route.kind === "auth-form" && route.view === "sign-in" && (
          <PublicSignInForm
            onNavigate={onNavigate}
            redirectToPath={
              redirectToPath ??
              (() => window.location.pathname + window.location.search)
            }
          />
        )}
        {route.kind === "auth-second-factor" && (
          <PublicSignInForm
            initialChallengeId={route.challengeId}
            initialInfo="Single sign-on succeeded. Enter your CoCalc second factor to finish signing in."
            onNavigate={onNavigate}
            redirectToPath={redirectToPath}
          />
        )}
        {route.kind === "auth-form" && route.view === "sign-up" && (
          <PublicSignUpForm
            onNavigate={onNavigate}
            redirectToPath={redirectToPath}
          />
        )}
        {route.kind === "auth-form" && route.view === "password-reset" && (
          <PublicPasswordResetForm onNavigate={onNavigate} />
        )}
        {route.kind === "auth-password-reset-redeem" && (
          <PublicRedeemPasswordResetView
            passwordResetId={route.passwordResetId}
          />
        )}
        {route.kind === "auth-cli-login" && (
          <>
            <PublicCliLoginApprovalView
              challengeId={route.challengeId}
              isAuthenticated={!!config?.is_authenticated}
            />
            {!config?.is_authenticated ? (
              <PublicSignInForm
                onNavigate={onNavigate}
                redirectToPath={() =>
                  window.location.pathname + window.location.search
                }
              />
            ) : null}
          </>
        )}
        {route.kind === "auth-cli-elevate" && (
          <>
            <PublicCliElevateApprovalView
              challengeId={route.challengeId}
              isAuthenticated={!!config?.is_authenticated}
            />
            {!config?.is_authenticated ? (
              <PublicSignInForm
                onNavigate={onNavigate}
                redirectToPath={() =>
                  window.location.pathname + window.location.search
                }
              />
            ) : null}
          </>
        )}
        {route.kind === "auth-password-reset-done" && (
          <PublicPasswordResetDoneView />
        )}
        {route.kind === "auth-verify-email" && (
          <PublicVerifyEmailView
            email={route.email}
            isAuthenticated={!!config?.is_authenticated}
            token={route.token}
          />
        )}
        {route.kind === "redeem" && (
          <PublicRedeemVoucherView
            initialCode={route.code}
            isAuthenticated={!!config?.is_authenticated}
            onNavigate={onNavigate}
          />
        )}
        {route.kind === "sso-index" && (
          <PublicSSOIndexView initialStrategies={initialSSOStrategies} />
        )}
        {route.kind === "sso-detail" && (
          <PublicSSODetailView
            id={route.id}
            initialStrategies={initialSSOStrategies}
          />
        )}
      </PublicAuthPageShell>
    </PublicPage>
  );
}
