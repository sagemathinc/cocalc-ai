import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { SiteName } from "@cocalc/frontend/customize";
import { set_url } from "@cocalc/frontend/history";
import { getPageUrlPath } from "@cocalc/frontend/page-routing";
import { SITE_NAME } from "@cocalc/util/theme";
import PublicAuthPageShell from "@cocalc/frontend/public/auth/page-shell";
import type { AuthView } from "./types";
import SignInForm from "./sign-in";
import SignUpForm from "./sign-up";
import PasswordResetForm from "./password-reset";

function viewTitle(view: AuthView, siteName: string): string {
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

export default function AuthPage() {
  const page_actions = useActions("page");
  const auth_view = useTypedRedux("page", "auth_view") ?? "sign-in";
  const site_name = useTypedRedux("customize", "site_name") ?? SITE_NAME;

  function onNavigate(next: AuthView) {
    page_actions.setState({ active_top_tab: "auth", auth_view: next });
    set_url(getPageUrlPath({ page: "auth", view: next }));
  }

  return (
    <PublicAuthPageShell subtitle={<SiteName />}>
      <h1 style={{ margin: 0 }}>{viewTitle(auth_view, site_name)}</h1>
      {auth_view === "sign-up" && <SignUpForm onNavigate={onNavigate} />}
      {auth_view === "password-reset" && (
        <PasswordResetForm onNavigate={onNavigate} />
      )}
      {auth_view === "sign-in" && <SignInForm onNavigate={onNavigate} />}
    </PublicAuthPageShell>
  );
}
