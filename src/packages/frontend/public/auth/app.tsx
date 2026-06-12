/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";

import type { AuthView } from "@cocalc/frontend/auth/types";
import { enableForceConsent } from "@cocalc/frontend/cookie-consent";
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
  PublicRedeemProjectInviteView,
  PublicVerifyEmailView,
} from "./completion-views";
import {
  PublicPasswordResetForm,
  PublicSignInForm,
  PublicSignUpForm,
} from "./forms";
import PublicAuthPageShell from "./page-shell";
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
    case "project-invite":
      return `Accept project invite for ${siteName}`;
    case "sso-detail":
    case "sso-index":
      return `${siteName} single sign-on`;
    default:
      return siteName;
  }
}

function subtitleForRoute(
  route: PublicAuthRoute,
  siteName: string,
  isAuthenticated?: boolean,
): string | undefined {
  switch (route.kind) {
    case "auth-form":
      return undefined;
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
    case "project-invite":
      if (isAuthenticated) {
        return `Review this ${siteName} project invite before accepting it.`;
      }
      return `Sign in or create an account to accept this ${siteName} project invite.`;
    default:
      return undefined;
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
    case "project-invite":
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

  useEffect(() => {
    if (!config?.cookie_banner_enabled) return;
    if (route.kind !== "sso-detail" && route.kind !== "sso-index") return;
    return enableForceConsent();
  }, [config?.cookie_banner_enabled, route.kind]);

  function onNavigate(next: AuthView) {
    const nextRoute: PublicAuthRoute = { kind: "auth-form", view: next };
    setRoute(nextRoute);
    navigatePublic(pathForAuthView(next));
  }

  return (
    <PublicPage active="auth" config={config} title={title}>
      <PublicAuthPageShell
        cardWidth={cardWidthForRoute(route)}
        subtitle={subtitleForRoute(route, siteName, config?.is_authenticated)}
      >
        {route.kind === "auth-form" && route.view === "sign-in" && (
          <PublicSignInForm
            cookieBannerEnabled={!!config?.cookie_banner_enabled}
            onNavigate={onNavigate}
            redirectToPath={redirectToPath}
          />
        )}
        {route.kind === "auth-second-factor" && (
          <PublicSignInForm
            cookieBannerEnabled={!!config?.cookie_banner_enabled}
            initialChallengeId={route.challengeId}
            initialInfo="Single sign-on succeeded. Enter your CoCalc second factor to finish signing in."
            onNavigate={onNavigate}
            redirectToPath={redirectToPath}
          />
        )}
        {route.kind === "auth-form" && route.view === "sign-up" && (
          <PublicSignUpForm
            cookieBannerEnabled={!!config?.cookie_banner_enabled}
            onNavigate={onNavigate}
            redirectToPath={redirectToPath}
            signupEmailDomainPolicy={config?.signup_email_domain_public_policy}
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
                cookieBannerEnabled={!!config?.cookie_banner_enabled}
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
                cookieBannerEnabled={!!config?.cookie_banner_enabled}
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
        {route.kind === "project-invite" && (
          <>
            <PublicRedeemProjectInviteView
              inviteId={route.inviteId}
              currentAccountDisplayName={config?.account_display_name}
              currentAccountEmailAddress={config?.account_email_address}
              currentAccountId={config?.account_id}
              isAuthenticated={!!config?.is_authenticated}
              projectId={route.projectId}
              token={route.token}
            />
            {!config?.is_authenticated ? (
              <PublicSignInForm
                cookieBannerEnabled={!!config?.cookie_banner_enabled}
                onNavigate={onNavigate}
                redirectToPath={() =>
                  window.location.pathname + window.location.search
                }
              />
            ) : null}
          </>
        )}
        {route.kind === "sso-index" && (
          <PublicSSOIndexView
            cookieBannerEnabled={!!config?.cookie_banner_enabled}
            initialStrategies={initialSSOStrategies}
          />
        )}
        {route.kind === "sso-detail" && (
          <PublicSSODetailView
            cookieBannerEnabled={!!config?.cookie_banner_enabled}
            id={route.id}
            initialStrategies={initialSSOStrategies}
          />
        )}
      </PublicAuthPageShell>
    </PublicPage>
  );
}
