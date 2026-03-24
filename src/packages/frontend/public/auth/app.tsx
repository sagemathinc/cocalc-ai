/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { SITE_NAME } from "@cocalc/util/theme";
import type { AuthView } from "@cocalc/frontend/auth/types";
import {
  PublicPasswordResetForm,
  PublicSignInForm,
  PublicSignUpForm,
} from "./forms";
import PublicAuthPageShell from "./page-shell";

interface PublicAuthAppProps {
  initialView: AuthView;
  initialRequiresToken?: boolean;
  siteName?: string;
}

function titleForView(view: AuthView, siteName: string): string {
  switch (view) {
    case "sign-up":
      return `Create your ${siteName} account`;
    case "password-reset":
      return `Reset your ${siteName} password`;
    case "sign-in":
    default:
      return `Sign in to ${siteName}`;
  }
}

function pathForView(view: AuthView): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  switch (view) {
    case "sign-up":
      return `${base}/auth/sign-up`;
    case "password-reset":
      return `${base}/auth/password-reset`;
    case "sign-in":
    default:
      return `${base}/auth/sign-in`;
  }
}

export function getAuthViewFromPath(pathname: string): AuthView {
  if (pathname.includes("/auth/sign-up")) {
    return "sign-up";
  }
  if (pathname.includes("/auth/password-reset")) {
    return "password-reset";
  }
  return "sign-in";
}

export default function PublicAuthApp({
  initialView,
  initialRequiresToken,
  siteName = SITE_NAME,
}: PublicAuthAppProps) {
  const [view, setView] = useState<AuthView>(initialView);
  const title = useMemo(() => titleForView(view, siteName), [siteName, view]);

  useEffect(() => {
    document.title = title;
  }, [title]);

  function onNavigate(next: AuthView) {
    setView(next);
    window.history.pushState({}, "", pathForView(next));
  }

  return (
    <PublicAuthPageShell title={title} subtitle={siteName}>
      {view === "sign-in" && <PublicSignInForm onNavigate={onNavigate} />}
      {view === "sign-up" && (
        <PublicSignUpForm
          initialRequiresToken={initialRequiresToken}
          onNavigate={onNavigate}
        />
      )}
      {view === "password-reset" && (
        <PublicPasswordResetForm onNavigate={onNavigate} />
      )}
    </PublicAuthPageShell>
  );
}
