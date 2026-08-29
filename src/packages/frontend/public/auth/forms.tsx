/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import api from "@cocalc/frontend/client/api";
import {
  getControlPlaneOrigin,
  setStoredControlPlaneOrigin,
} from "@cocalc/frontend/control-plane-origin";
import {
  requireEssentialConsent,
  useEssentialConsent,
} from "@cocalc/frontend/cookie-consent";
import type { AuthView } from "@cocalc/frontend/auth/types";
import {
  getControlPlaneAuthBootstrap,
  isMfaRequiredAuthResponse,
  isWrongBayAuthResponse,
  postAuthApi,
  retryAuthOnHomeBay,
  signOutAuthSession,
  type SecondFactorMethod,
} from "@cocalc/frontend/auth/api";
import AuthInstructions from "@cocalc/frontend/auth/instructions";
import { signInWithPasskey } from "@cocalc/frontend/auth/passkeys";
import {
  getSecondFactorPlaceholder,
  inferSecondFactorInputMethod,
} from "@cocalc/frontend/auth/second-factor-input";
import { appUrl } from "@cocalc/frontend/auth/util";
import GoogleLogo from "@cocalc/frontend/components/google-logo";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  arePublicPoliciesVisible,
  getExternalPoliciesUrl,
  isCocalcAiPublicSite,
  type PublicConfig,
  usePublicConfig,
} from "@cocalc/frontend/public/config";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@cocalc/util/auth";
import { normalizeEmailAuthenticationMode } from "@cocalc/util/auth/email-auth";
import {
  emailAllowedByPublicSignupPolicy,
  type SignupEmailDomainPublicPolicy,
} from "@cocalc/util/accounts/signup-email-domain-policy";
import {
  normalizeProjectOnboardingIntent,
  projectOnboardingIntentFromPublicPath,
} from "@cocalc/util/accounts/onboarding-intent";
import {
  is_valid_email_address as isValidEmailAddress,
  len,
} from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";
import { prefetchSignedInShell } from "./prefetch-signed-in";

const STACK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
} as const;

const FIELD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
} as const;

function onboardingIntentFromBrowser() {
  const explicit = normalizeProjectOnboardingIntent(
    new URL(window.location.href).searchParams.get("intent"),
  );
  if (explicit) return explicit;
  try {
    return projectOnboardingIntentFromPublicPath(
      new URL(document.referrer).pathname,
    );
  } catch {
    return undefined;
  }
}

const LABEL_STYLE: CSSProperties = {
  color: COLORS.GRAY_D,
  fontSize: "14px",
  fontWeight: 600,
} as const;

const TERMS_NOTICE_STYLE: CSSProperties = {
  color: COLORS.GRAY_M,
  fontSize: "13px",
  lineHeight: "18px",
} as const;

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  borderRadius: "8px",
  border: `1px solid ${COLORS.GRAY_LL}`,
  padding: "10px 12px",
  fontSize: "16px",
} as const;

const BUTTON_STYLE: CSSProperties = {
  width: "100%",
  border: "none",
  borderRadius: "8px",
  background: COLORS.BLUE_D,
  color: "white",
  fontSize: "16px",
  fontWeight: 600,
  padding: "11px 16px",
  cursor: "pointer",
} as const;

const SSO_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_STYLE,
  background: "white",
  border: "1px solid #ccc",
  color: COLORS.GRAY_D,
  display: "block",
  opacity: 1,
  textAlign: "center",
  textDecoration: "none",
} as const;

const SSO_BUTTON_CONTENT_STYLE: CSSProperties = {
  alignItems: "center",
  display: "grid",
  gap: "10px",
  gridTemplateColumns: "24px 1fr 24px",
} as const;

const DIVIDER_STYLE: CSSProperties = {
  alignItems: "center",
  color: COLORS.GRAY_M,
  display: "flex",
  fontSize: "13px",
  gap: "12px",
  lineHeight: "18px",
} as const;

const DIVIDER_LINE_STYLE: CSSProperties = {
  background: COLORS.GRAY_LL,
  flex: "1 1 auto",
  height: "1px",
} as const;

const LINK_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  flexWrap: "wrap",
} as const;

const LINK_STYLE: CSSProperties = {
  color: COLORS.BLUE_D,
  cursor: "pointer",
} as const;

const ALERT_STYLE: CSSProperties = {
  borderRadius: "8px",
  padding: "10px 12px",
  fontSize: "14px",
} as const;

const METHOD_CHOOSER_STYLE: CSSProperties = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
} as const;

const METHOD_BUTTON_STYLE: CSSProperties = {
  borderRadius: "999px",
  border: `1px solid ${COLORS.GRAY_LL}`,
  background: "white",
  color: COLORS.GRAY_D,
  fontSize: "14px",
  fontWeight: 600,
  padding: "7px 12px",
  cursor: "pointer",
} as const;

const SELECTED_METHOD_BUTTON_STYLE: CSSProperties = {
  ...METHOD_BUTTON_STYLE,
  borderColor: COLORS.BLUE_D,
  background: COLORS.BLUE_LLL,
  color: COLORS.BLUE_DD,
} as const;

const POLICY_STATUS_STYLE: CSSProperties = {
  minHeight: "20px",
  color: COLORS.GRAY_M,
  fontSize: "13px",
  lineHeight: "20px",
} as const;

type SignInMethod = {
  email: string;
  password_allowed: boolean;
  sso_required: boolean;
  sso_strategy?: {
    name: string;
    display: string;
  };
  reason?: "domain_sso_required";
};

type PublicSsoStrategy = {
  name?: string;
  display: string;
  public?: boolean;
  do_not_hide?: boolean;
};

export type AuthNavigateOptions = {
  initialEmail?: string;
  legacySignUpPrompt?: boolean;
};

export type AuthNavigate = (
  view: AuthView,
  options?: AuthNavigateOptions,
) => void;

function Alert({
  children,
  kind,
}: {
  children: ReactNode;
  kind: "error" | "info" | "success" | "warning";
}) {
  const style: CSSProperties =
    kind === "error"
      ? {
          ...ALERT_STYLE,
          background: "#fff2f0",
          border: "1px solid #ffccc7",
          color: "#a8071a",
        }
      : kind === "success"
        ? {
            ...ALERT_STYLE,
            background: "#f6ffed",
            border: "1px solid #b7eb8f",
            color: "#237804",
          }
        : kind === "warning"
          ? {
              ...ALERT_STYLE,
              background: COLORS.YELL_LLL,
              border: `1px solid ${COLORS.YELL_LL}`,
              color: COLORS.BRWN,
            }
          : {
              ...ALERT_STYLE,
              background: "#e6f4ff",
              border: "1px solid #91caff",
              color: "#0958d9",
            };
  return (
    <div role={kind === "error" ? "alert" : undefined} style={style}>
      {children}
    </div>
  );
}

function TextInput(props: {
  ariaLabel?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  maxLength?: number;
  name?: string;
  onChange: (value: string) => void;
  onPressEnter?: () => void;
  placeholder?: string;
  type?: string;
  value: string;
}) {
  return (
    <input
      aria-label={props.ariaLabel}
      autoComplete={props.autoComplete}
      autoFocus={props.autoFocus}
      ref={props.inputRef}
      maxLength={props.maxLength}
      name={props.name}
      placeholder={props.placeholder}
      style={INPUT_STYLE}
      type={props.type ?? "text"}
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          props.onPressEnter?.();
        }
      }}
    />
  );
}

function ActionButton(props: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={props.disabled}
      type="button"
      style={{
        ...BUTTON_STYLE,
        opacity: props.disabled ? 0.65 : 1,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function AuthDivider({ children = "or" }: { children?: ReactNode }) {
  return (
    <div style={DIVIDER_STYLE}>
      <span aria-hidden="true" style={DIVIDER_LINE_STYLE} />
      <span>{children}</span>
      <span aria-hidden="true" style={DIVIDER_LINE_STYLE} />
    </div>
  );
}

function NavLink(props: { children: ReactNode; onClick: () => void }) {
  return (
    <a
      style={LINK_STYLE}
      onClick={(e) => {
        e.preventDefault();
        props.onClick();
      }}
    >
      {props.children}
    </a>
  );
}

function ssoLoginHref(
  strategyName: string,
  query?: Record<string, string | boolean | undefined>,
): string {
  const href = joinUrlPath(appBasePath, "auth", strategyName);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === false || value === "") {
      continue;
    }
    params.set(key, value === true ? "1" : value);
  }
  const search = params.toString();
  return search ? `${href}?${search}` : href;
}

function termsOfServiceHref(): string {
  return joinUrlPath(appBasePath, "policies/terms");
}

function privacyPolicyHref(): string {
  return joinUrlPath(appBasePath, "policies/privacy");
}

function policyUrls(publicConfig?: PublicConfig) {
  const externalPoliciesUrl = getExternalPoliciesUrl(publicConfig);
  return {
    termsUrl: externalPoliciesUrl ?? termsOfServiceHref(),
    privacyUrl: externalPoliciesUrl ?? privacyPolicyHref(),
  };
}

function PolicyActionNotice({
  action,
  privacyUrl,
  termsUrl,
}: {
  action: string;
  privacyUrl: string;
  termsUrl: string;
}) {
  return (
    <div style={TERMS_NOTICE_STYLE}>
      By {action}, you agree to CoCalc&apos;s{" "}
      <a href={termsUrl} target="_blank" rel="noreferrer">
        Terms of Service
      </a>{" "}
      and acknowledge the{" "}
      <a href={privacyUrl} target="_blank" rel="noreferrer">
        Privacy Policy
      </a>
      .
    </div>
  );
}

export function defaultAuthRedirectPath(): string {
  return appUrl("projects");
}

function isDefaultAuthRedirectTarget(target?: string): boolean {
  const normalized = `${target ?? ""}`.trim();
  if (!normalized) {
    return true;
  }
  const appRoot = appBasePath === "/" ? "/" : appBasePath;
  return (
    normalized === "/" || normalized === appRoot || normalized === `${appRoot}/`
  );
}

export function resolveAuthRedirectPath(
  redirectToPath?: string | (() => string),
): string {
  const target =
    typeof redirectToPath === "function" ? redirectToPath() : redirectToPath;
  if (target == null || isDefaultAuthRedirectTarget(target)) {
    return defaultAuthRedirectPath();
  }
  return target;
}

function usePublicSsoStrategies(
  initialStrategies?: PublicSsoStrategy[],
): PublicSsoStrategy[] {
  const [strategies, setStrategies] = useState<PublicSsoStrategy[]>(
    initialStrategies ?? [],
  );

  useEffect(() => {
    if (initialStrategies != null) {
      setStrategies(initialStrategies);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await api("auth/sso-strategies");
        if (!cancelled) {
          setStrategies(Array.isArray(result) ? result : []);
        }
      } catch {
        if (!cancelled) {
          setStrategies([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialStrategies]);

  return strategies;
}

function googleStrategyFrom(strategies: PublicSsoStrategy[]) {
  return strategies.find((strategy) => strategy.name === "google");
}

function normalizedEmailAddress(email: string): string {
  return email.trim().toLowerCase();
}

function signInErrorIsLegacyMissingAccount(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "legacy_account_requires_new_account"
  );
}

function validInitialEmail(email?: string): string {
  const normalized = normalizedEmailAddress(email ?? "");
  return isValidEmailAddress(normalized) ? normalized : "";
}

function LegacyCocalcAccountNotice({
  attemptedEmail,
  mode,
  onCreateAccount,
}: {
  attemptedEmail?: string;
  mode: "sign-in" | "sign-up";
  onCreateAccount?: () => void;
}) {
  const email = validInitialEmail(attemptedEmail);
  return (
    <Alert kind="warning">
      <div style={{ fontWeight: 700, marginBottom: "6px" }}>
        CoCalc.com accounts do not sign in directly on CoCalc.ai.
      </div>
      <div style={{ marginBottom: mode === "sign-in" ? "10px" : 0 }}>
        CoCalc.ai is the new service. If you used cocalc.com, create a new
        CoCalc.ai account
        {email ? (
          <>
            {" "}
            with <strong>{email}</strong>
          </>
        ) : null}
        . After signing in, open Settings &rarr; Legacy Migration to migrate
        projects and subscription credit.
      </div>
      {mode === "sign-in" && onCreateAccount ? (
        <button
          type="button"
          style={{
            ...BUTTON_STYLE,
            marginTop: "10px",
          }}
          onClick={onCreateAccount}
        >
          Create a new CoCalc.ai account
        </button>
      ) : null}
    </Alert>
  );
}

function SsoButton({
  children,
  disabled,
  href,
  cookieBannerEnabled,
  cookieConsentReady,
}: {
  children: ReactNode;
  disabled?: boolean;
  href: string;
  cookieBannerEnabled: boolean;
  cookieConsentReady: boolean;
}) {
  return (
    <a
      href={href}
      style={{
        ...SSO_BUTTON_STYLE,
        opacity: disabled ? 0.65 : 1,
      }}
      aria-disabled={disabled}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        if (
          cookieBannerEnabled &&
          !cookieConsentReady &&
          !requireEssentialConsent()
        ) {
          event.preventDefault();
          return;
        }
        void prefetchSignedInShell();
      }}
    >
      <span style={SSO_BUTTON_CONTENT_STYLE}>
        <GoogleLogo />
        <span>{children}</span>
        <span aria-hidden="true" />
      </span>
    </a>
  );
}

type EmailAuthChallengeResponse = {
  challenge_id: string;
  purpose?: "sign_in_or_sign_up" | "email_fresh_auth";
  state: string;
  account_created?: boolean;
  masked_email: string;
  expires_at: string;
  resend_available_at: string;
  message_sent_now?: boolean;
};

type EmailAuthExchangeResponse = {
  challenge_id: string;
  account_created?: boolean;
  exchange_token: string;
  exchange_expires_at: string;
  home_bay_id: string;
  home_bay_url?: string;
  redirect_to?: string;
  state: "account_ready";
};

type NewAccountProfileCompletion = {
  origin?: string;
  redirectTo: string;
};

const NEW_ACCOUNT_PLACEHOLDER_NAME = "CoCalc User";

export async function completeEmailAuthExchange(
  exchange: EmailAuthExchangeResponse,
): Promise<any> {
  const origin = `${exchange.home_bay_url ?? ""}`.trim();
  if (!origin) {
    throw new Error("The account home bay is temporarily unavailable.");
  }
  setStoredControlPlaneOrigin(origin);
  return await postAuthApi({
    endpoint: "auth/email/exchange",
    origin,
    body: { retry_token: exchange.exchange_token },
  });
}

function NewAccountDisplayNameStep({
  completion,
}: {
  completion: NewAccountProfileCompletion;
}) {
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function continueToApp(): void {
    window.location.href = completion.redirectTo;
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const bootstrap = await getControlPlaneAuthBootstrap();
        if (
          !cancelled &&
          bootstrap.signed_in &&
          bootstrap.display_name &&
          bootstrap.display_name !== NEW_ACCOUNT_PLACEHOLDER_NAME
        ) {
          window.location.href = completion.redirectTo;
        }
      } catch {
        // Another tab may complete this step; checking is best effort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [completion.redirectTo]);

  async function saveDisplayName(): Promise<void> {
    const name = displayName.trim();
    if (!name || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await postAuthApi({
        endpoint: "accounts/set-name",
        origin: completion.origin || getControlPlaneOrigin(),
        body: { display_name: name },
      });
      continueToApp();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={STACK_STYLE}>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <div>
        <div
          style={{
            color: COLORS.GRAY_D,
            fontSize: "18px",
            fontWeight: 700,
            marginBottom: "6px",
          }}
        >
          What should we call you?
        </div>
        <div style={TERMS_NOTICE_STYLE}>
          This is how collaborators will recognize you. You can change it later
          in Account Settings.
        </div>
      </div>
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Your name</div>
        <TextInput
          ariaLabel="Your name"
          autoComplete="name"
          autoFocus
          maxLength={254}
          name="display-name"
          placeholder="Your name"
          value={displayName}
          onChange={(value) => {
            setDisplayName(value);
            setError("");
          }}
          onPressEnter={saveDisplayName}
        />
      </div>
      <ActionButton
        disabled={!displayName.trim() || submitting}
        onClick={saveDisplayName}
      >
        {submitting ? "Saving..." : "Continue"}
      </ActionButton>
      <div style={{ textAlign: "center" }}>
        <NavLink onClick={continueToApp}>Skip for now</NavLink>
      </div>
    </div>
  );
}

export function PublicEmailAuthLinkView({
  challengeId,
  cookieBannerEnabled = false,
  initialSSOStrategies,
  onNavigate,
  redirectToPath,
}: {
  challengeId: string;
  cookieBannerEnabled?: boolean;
  initialSSOStrategies?: PublicSsoStrategy[];
  onNavigate: AuthNavigate;
  redirectToPath?: string | (() => string);
}) {
  const [token] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get(
      "token",
    );
    if (window.location.hash) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
    }
    return `${value ?? ""}`.trim();
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [freshAuthApproved, setFreshAuthApproved] = useState(false);
  const [mfa, setMfa] = useState<{
    challenge_id: string;
    home_bay_url?: string;
  }>();
  const [profileCompletion, setProfileCompletion] =
    useState<NewAccountProfileCompletion>();

  if (profileCompletion) {
    return <NewAccountDisplayNameStep completion={profileCompletion} />;
  }

  if (mfa) {
    return (
      <PublicSignInForm
        cookieBannerEnabled={cookieBannerEnabled}
        initialChallengeId={mfa.challenge_id}
        initialInfo="Your email is verified. Enter your CoCalc second factor to finish signing in."
        initialMfaOrigin={mfa.home_bay_url}
        initialSSOStrategies={initialSSOStrategies}
        onNavigate={onNavigate}
        redirectToPath={redirectToPath}
      />
    );
  }

  async function continueWithLink(): Promise<void> {
    if (!challengeId || token.length < 32 || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await postAuthApi<
        EmailAuthExchangeResponse | EmailAuthChallengeResponse
      >({
        endpoint: "auth/email/redeem-link",
        body: {
          challenge_id: challengeId,
          token,
        },
      });
      if (
        "purpose" in response &&
        response.purpose === "email_fresh_auth" &&
        response.state === "email_proved"
      ) {
        setFreshAuthApproved(true);
        return;
      }
      const exchange = response as EmailAuthExchangeResponse;
      const result = await completeEmailAuthExchange(exchange);
      if (isMfaRequiredAuthResponse(result)) {
        setMfa({
          challenge_id: result.challenge_id,
          home_bay_url: result.home_bay_url,
        });
        return;
      }
      if (!result?.account_id) {
        throw new Error("Email sign-in did not create a session.");
      }
      const redirectTo =
        exchange.redirect_to ?? resolveAuthRedirectPath(redirectToPath);
      if (exchange.account_created) {
        setProfileCompletion({
          origin: exchange.home_bay_url,
          redirectTo,
        });
        return;
      }
      window.location.href = redirectTo;
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={STACK_STYLE}>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {freshAuthApproved ? (
        <Alert kind="info">
          Email approval succeeded. Return to the original CoCalc tab to finish
          the security action.
        </Alert>
      ) : !token || !challengeId ? (
        <Alert kind="error">
          This email sign-in link is incomplete or invalid. Return to sign in
          and request a new message.
        </Alert>
      ) : (
        <>
          <Alert kind="info">
            Continue only if you requested this email from CoCalc. Opening the
            message alone does not sign you in.
          </Alert>
          <ActionButton disabled={submitting} onClick={continueWithLink}>
            {submitting ? "Continuing..." : "Continue to CoCalc"}
          </ActionButton>
        </>
      )}
      <div style={{ textAlign: "center" }}>
        <NavLink onClick={() => onNavigate("sign-in")}>Back to sign in</NavLink>
      </div>
    </div>
  );
}

export function PublicEmailFirstForm({
  cookieBannerEnabled = false,
  initialEmail,
  initialSSOStrategies,
  onNavigate,
  redirectToPath,
  view,
}: {
  cookieBannerEnabled?: boolean;
  initialEmail?: string;
  initialSSOStrategies?: PublicSsoStrategy[];
  onNavigate: AuthNavigate;
  redirectToPath?: string | (() => string);
  view: "sign-in" | "sign-up";
}) {
  const [requiresToken, setRequiresToken] = useState<boolean>();
  const onboardingIntent = useMemo(onboardingIntentFromBrowser, []);
  const [registrationToken, setRegistrationToken] = useState(
    new URL(window.location.href).searchParams.get("registrationToken") ?? "",
  );
  const [email, setEmail] = useState(() => validInitialEmail(initialEmail));
  const [challenge, setChallenge] = useState<EmailAuthChallengeResponse>();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [requiredSso, setRequiredSso] = useState<{
    name: string;
    display: string;
  }>();
  const [mfa, setMfa] = useState<{
    challenge_id: string;
    home_bay_url?: string;
  }>();
  const [profileCompletion, setProfileCompletion] =
    useState<NewAccountProfileCompletion>();
  const [now, setNow] = useState(Date.now());
  const registrationTokenInputRef = useRef<HTMLInputElement | null>(null);
  const strategies = usePublicSsoStrategies(initialSSOStrategies);
  const googleStrategy = googleStrategyFrom(strategies);
  const publicConfig = usePublicConfig();
  const consentReady = useEssentialConsent();
  const cookieConsentReady = !cookieBannerEnabled || consentReady;
  const policiesVisible = arePublicPoliciesVisible(publicConfig);
  const { termsUrl, privacyUrl } = policyUrls(publicConfig);

  useEffect(() => {
    const value = validInitialEmail(initialEmail);
    if (!value) return;
    setEmail((current) => current || value);
  }, [initialEmail]);

  useEffect(() => {
    if (view !== "sign-up") {
      setRequiresToken(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await api("auth/requires-token");
        if (!cancelled) {
          setRequiresToken(!!result);
        }
      } catch {
        if (!cancelled) {
          setRequiresToken(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view]);

  useEffect(() => {
    if (!challenge || profileCompletion) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge, profileCompletion]);

  useEffect(() => {
    if (!challenge || profileCompletion) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const status = await postAuthApi<EmailAuthChallengeResponse>({
            endpoint: "auth/email/status",
            body: { challenge_id: challenge.challenge_id },
          });
          if (cancelled) return;
          setChallenge((current) =>
            current ? { ...current, ...status } : status,
          );
          if (
            ["expired", "superseded", "blocked", "failed"].includes(
              status.state,
            )
          ) {
            setError(
              status.state === "expired"
                ? "This code has expired. Start again to receive a new one."
                : "This email sign-in can no longer be used. Start again.",
            );
            return;
          }
          if (
            ["account_ready", "mfa_required", "completed"].includes(
              status.state,
            )
          ) {
            const bootstrap = await getControlPlaneAuthBootstrap();
            if (bootstrap.signed_in) {
              const redirectTo = resolveAuthRedirectPath(redirectToPath);
              if (
                status.account_created &&
                (!bootstrap.display_name ||
                  bootstrap.display_name === NEW_ACCOUNT_PLACEHOLDER_NAME)
              ) {
                setProfileCompletion({
                  origin: bootstrap.home_bay_url,
                  redirectTo,
                });
                return;
              }
              window.location.href = redirectTo;
            }
          }
        } catch {
          // Polling is best effort; direct code/link completion reports errors.
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [challenge?.challenge_id, profileCompletion, redirectToPath]);

  if (profileCompletion) {
    return <NewAccountDisplayNameStep completion={profileCompletion} />;
  }

  if (usePassword) {
    return view === "sign-up" ? (
      <PublicSignUpForm
        cookieBannerEnabled={cookieBannerEnabled}
        initialEmail={email}
        initialRegistrationToken={registrationToken}
        initialSSOStrategies={initialSSOStrategies}
        onNavigate={onNavigate}
        redirectToPath={redirectToPath}
      />
    ) : (
      <PublicSignInForm
        cookieBannerEnabled={cookieBannerEnabled}
        initialEmail={email}
        initialSSOStrategies={initialSSOStrategies}
        onNavigate={onNavigate}
        redirectToPath={redirectToPath}
      />
    );
  }

  if (mfa) {
    return (
      <PublicSignInForm
        cookieBannerEnabled={cookieBannerEnabled}
        initialChallengeId={mfa.challenge_id}
        initialInfo="Your email is verified. Enter your CoCalc second factor to finish signing in."
        initialMfaOrigin={mfa.home_bay_url}
        initialSSOStrategies={initialSSOStrategies}
        onNavigate={onNavigate}
        redirectToPath={redirectToPath}
      />
    );
  }

  async function startEmailAuth(): Promise<void> {
    if (!isValidEmailAddress(email) || submitting) return;
    if (view === "sign-up" && requiresToken === undefined) {
      return;
    }
    if (
      view === "sign-up" &&
      requiresToken === true &&
      !registrationToken.trim()
    ) {
      setError("Enter the registration token for this site.");
      return;
    }
    if (
      cookieBannerEnabled &&
      !cookieConsentReady &&
      !requireEssentialConsent()
    ) {
      return;
    }
    setSubmitting(true);
    setError("");
    setRequiredSso(undefined);
    void prefetchSignedInShell();
    try {
      const result = await postAuthApi<any>({
        endpoint: "auth/email/start",
        body: {
          email: normalizedEmailAddress(email),
          onboarding_intent: onboardingIntent,
          ...(view === "sign-up" && registrationToken.trim()
            ? { registration_token: registrationToken.trim() }
            : {}),
          target: resolveAuthRedirectPath(redirectToPath),
          terms: true,
        },
      });
      if (result?.sso_required && result.strategy) {
        setRequiredSso(result.strategy);
        return;
      }
      if (!result?.challenge_id) {
        throw new Error("Unable to start email sign-in.");
      }
      setChallenge(result);
      setCode("");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function redeemCode(): Promise<void> {
    const normalizedCode = code.replace(/\s/g, "");
    if (!challenge || !/^\d{6}$/.test(normalizedCode) || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const exchange = await postAuthApi<EmailAuthExchangeResponse>({
        endpoint: "auth/email/redeem-code",
        body: {
          challenge_id: challenge.challenge_id,
          code: normalizedCode,
        },
      });
      const result = await completeEmailAuthExchange(exchange);
      if (isMfaRequiredAuthResponse(result)) {
        setMfa({
          challenge_id: result.challenge_id,
          home_bay_url: result.home_bay_url,
        });
        return;
      }
      if (!result?.account_id) {
        throw new Error("Email sign-in did not create a session.");
      }
      const redirectTo =
        exchange.redirect_to ?? resolveAuthRedirectPath(redirectToPath);
      if (exchange.account_created) {
        setProfileCompletion({
          origin: exchange.home_bay_url,
          redirectTo,
        });
        return;
      }
      window.location.href = redirectTo;
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function resend(): Promise<void> {
    if (!challenge || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      setChallenge(
        await postAuthApi<EmailAuthChallengeResponse>({
          endpoint: "auth/email/resend",
          body: { challenge_id: challenge.challenge_id },
        }),
      );
      setCode("");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  const resendSeconds = challenge
    ? Math.max(
        0,
        Math.ceil(
          (new Date(challenge.resend_available_at).valueOf() - now) / 1000,
        ),
      )
    : 0;

  return (
    <div style={STACK_STYLE}>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {!challenge ? (
        <>
          {view === "sign-up" && requiresToken ? (
            <div style={FIELD_STYLE}>
              <div style={LABEL_STYLE}>Registration token</div>
              <TextInput
                ariaLabel="Registration token"
                autoFocus
                inputRef={registrationTokenInputRef}
                name="registration-token"
                placeholder="Enter your registration token"
                value={registrationToken}
                onChange={(value) => {
                  setRegistrationToken(value);
                  setError("");
                }}
                onPressEnter={startEmailAuth}
              />
            </div>
          ) : null}
          {googleStrategy != null ? (
            <>
              {policiesVisible ? (
                <PolicyActionNotice
                  action={`continuing with ${googleStrategy.display}`}
                  privacyUrl={privacyUrl}
                  termsUrl={termsUrl}
                />
              ) : null}
              <SsoButton
                disabled={
                  view === "sign-up" &&
                  (requiresToken === undefined ||
                    (requiresToken && !registrationToken.trim()))
                }
                cookieBannerEnabled={cookieBannerEnabled}
                cookieConsentReady={cookieConsentReady}
                href={ssoLoginHref("google", {
                  target: resolveAuthRedirectPath(redirectToPath),
                  terms: policiesVisible ? true : undefined,
                  registration_token:
                    view === "sign-up"
                      ? registrationToken.trim() || undefined
                      : undefined,
                  onboarding_intent: onboardingIntent,
                })}
              >
                Continue with {googleStrategy.display}
              </SsoButton>
              <AuthDivider />
            </>
          ) : null}
          <div style={FIELD_STYLE}>
            <div style={LABEL_STYLE}>Email address</div>
            <TextInput
              ariaLabel="Email address"
              autoComplete="email"
              autoFocus={view !== "sign-up" || requiresToken === false}
              name="email"
              placeholder="you@example.com"
              value={email}
              onChange={(value) => {
                setEmail(value);
                setError("");
                setRequiredSso(undefined);
              }}
              onPressEnter={startEmailAuth}
            />
          </div>
          {requiredSso ? (
            <Alert kind="info">
              <div style={{ fontWeight: 600, marginBottom: "8px" }}>
                This email domain uses single sign-on.
              </div>
              <a
                href={ssoLoginHref(requiredSso.name, {
                  target: resolveAuthRedirectPath(redirectToPath),
                  terms: policiesVisible ? true : undefined,
                  onboarding_intent: onboardingIntent,
                })}
                style={LINK_STYLE}
              >
                Continue with {requiredSso.display}
              </a>
            </Alert>
          ) : null}
          {policiesVisible ? (
            <PolicyActionNotice
              action="continuing"
              privacyUrl={privacyUrl}
              termsUrl={termsUrl}
            />
          ) : null}
          <ActionButton
            disabled={
              !isValidEmailAddress(email) ||
              submitting ||
              (view === "sign-up" &&
                (requiresToken === undefined ||
                  (requiresToken && !registrationToken.trim()))) ||
              !cookieConsentReady ||
              !!requiredSso
            }
            onClick={startEmailAuth}
          >
            {submitting
              ? "Sending..."
              : !cookieConsentReady
                ? "Acknowledge cookie banner to continue"
                : "Continue with email"}
          </ActionButton>
          <div style={{ textAlign: "center" }}>
            <NavLink onClick={() => setUsePassword(true)}>
              Use a password instead
            </NavLink>
          </div>
        </>
      ) : (
        <>
          <Alert kind="info">
            <div style={{ fontWeight: 600, marginBottom: "6px" }}>
              Check your email
            </div>
            {challenge.message_sent_now === false ? (
              <>
                A sign-in email is already pending for{" "}
                <strong>{challenge.masked_email}</strong>. We did not send
                another message. Use <strong>Resend email</strong> below if it
                has not arrived.
              </>
            ) : (
              <>
                We sent a six-digit code and sign-in link to{" "}
                <strong>{challenge.masked_email}</strong>.
              </>
            )}
          </Alert>
          <div style={FIELD_STYLE}>
            <div style={LABEL_STYLE}>Six-digit code</div>
            <TextInput
              ariaLabel="Six-digit email code"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              name="email-code"
              placeholder="123456"
              value={code}
              onChange={(value) =>
                setCode(value.replace(/\D/g, "").slice(0, 6))
              }
              onPressEnter={redeemCode}
            />
          </div>
          <ActionButton
            disabled={!/^\d{6}$/.test(code) || submitting}
            onClick={redeemCode}
          >
            {submitting ? "Continuing..." : "Continue"}
          </ActionButton>
          <div style={{ ...LINK_ROW_STYLE, justifyContent: "center" }}>
            <NavLink
              onClick={() => {
                if (resendSeconds === 0) void resend();
              }}
            >
              {resendSeconds > 0
                ? `Resend available in ${resendSeconds}s`
                : "Resend email"}
            </NavLink>
            <NavLink
              onClick={() => {
                setChallenge(undefined);
                setCode("");
                setError("");
              }}
            >
              Use a different email
            </NavLink>
            <NavLink onClick={() => setUsePassword(true)}>
              Use a password instead
            </NavLink>
          </div>
        </>
      )}
    </div>
  );
}

export function PublicSignInForm({
  initialEmail,
  initialChallengeId,
  initialInfo,
  initialMfaOrigin,
  initialSSOStrategies,
  cookieBannerEnabled = false,
  onNavigate,
  redirectToPath,
}: {
  initialEmail?: string;
  initialChallengeId?: string;
  initialInfo?: string;
  initialMfaOrigin?: string;
  initialSSOStrategies?: PublicSsoStrategy[];
  cookieBannerEnabled?: boolean;
  onNavigate: AuthNavigate;
  redirectToPath?: string | (() => string);
}) {
  const [email, setEmail] = useState(() => validInitialEmail(initialEmail));
  const [password, setPassword] = useState("");
  const [challengeId, setChallengeId] = useState(initialChallengeId ?? "");
  const [factorMethods, setFactorMethods] = useState<SecondFactorMethod[]>([]);
  const [factorMethod, setFactorMethod] = useState<SecondFactorMethod>("totp");
  const [factorCode, setFactorCode] = useState("");
  const [mfaOrigin, setMfaOrigin] = useState<string | undefined>(
    initialMfaOrigin,
  );
  const [signingIn, setSigningIn] = useState(false);
  const [checkingSignInMethod, setCheckingSignInMethod] = useState(false);
  const [signInMethod, setSignInMethod] = useState<SignInMethod>();
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLDivElement | null>(null);
  const strategies = usePublicSsoStrategies(initialSSOStrategies);
  const googleStrategy = googleStrategyFrom(strategies);
  const publicConfig = usePublicConfig();
  const showLegacyMigrationNotice =
    !challengeId && isCocalcAiPublicSite(publicConfig);
  const hasTotp = factorMethods.includes("totp");
  const hasRecoveryCode = factorMethods.includes("recovery_code");
  const recoveryCodeOnly = hasRecoveryCode && !hasTotp;
  const codeFactorMethod =
    factorMethod === "recovery_code"
      ? "recovery_code"
      : inferSecondFactorInputMethod(factorCode);
  const consentReady = useEssentialConsent();
  const cookieConsentReady = !cookieBannerEnabled || consentReady;
  const policiesVisible = arePublicPoliciesVisible(publicConfig);
  const { termsUrl, privacyUrl } = policyUrls(publicConfig);
  const ssoStrategy =
    !challengeId && signInMethod?.sso_required
      ? signInMethod.sso_strategy
      : undefined;

  useEffect(() => {
    setChallengeId(initialChallengeId ?? "");
    setMfaOrigin(initialMfaOrigin);
  }, [initialChallengeId, initialMfaOrigin]);

  useEffect(() => {
    const value = validInitialEmail(initialEmail);
    if (!value) return;
    setEmail((current) => current || value);
  }, [initialEmail]);

  useEffect(() => {
    if (!error) return;
    const frame = requestAnimationFrame(() => {
      errorRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "center",
      });
      errorRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [error]);

  const canSubmit = challengeId
    ? factorMethod === "passkey"
      ? !signingIn
      : factorCode.trim().length > 0 && !signingIn
    : isValidEmailAddress(email) &&
      password.length > 0 &&
      !ssoStrategy &&
      !signingIn;

  function createAccountFromSignIn(legacySignUpPrompt = false) {
    const initialEmail = validInitialEmail(email);
    onNavigate("sign-up", {
      initialEmail: initialEmail || undefined,
      legacySignUpPrompt,
    });
  }

  useEffect(() => {
    if (challengeId) return;

    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmailAddress(normalizedEmail)) {
      setSignInMethod(undefined);
      setCheckingSignInMethod(false);
      return;
    }

    let cancelled = false;
    setCheckingSignInMethod(true);
    const timer = setTimeout(() => {
      (async () => {
        try {
          const result = (await api("auth/sign-in-method", {
            email: normalizedEmail,
          })) as SignInMethod;
          if (!cancelled) {
            setSignInMethod(
              result?.email === normalizedEmail ? result : undefined,
            );
          }
        } catch {
          if (!cancelled) {
            // Do not make a transient policy-query failure block password sign-in.
            setSignInMethod(undefined);
          }
        } finally {
          if (!cancelled) {
            setCheckingSignInMethod(false);
          }
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [challengeId, email]);

  async function signIn() {
    if (!canSubmit) {
      return;
    }
    setError("");
    setSigningIn(true);
    void prefetchSignedInShell();
    try {
      let method: SignInMethod | undefined;
      try {
        method = (await api("auth/sign-in-method", {
          email: email.trim().toLowerCase(),
        })) as SignInMethod;
      } catch {
        // Keep password sign-in available if the advisory policy query fails.
      }
      if (method?.sso_required && method.sso_strategy?.name) {
        setSignInMethod(method);
        return;
      }

      let result = await postAuthApi<any>({
        endpoint: "auth/sign-in",
        body: { email, password },
      });
      if (isWrongBayAuthResponse(result)) {
        result = await retryAuthOnHomeBay({
          endpoint: "auth/sign-in",
          wrongBay: result,
          body: { email, password },
        });
      }
      if (isMfaRequiredAuthResponse(result)) {
        setStoredControlPlaneOrigin(result?.home_bay_url);
        setChallengeId(result.challenge_id);
        setFactorMethods(result.methods ?? []);
        setFactorMethod(
          result.methods?.includes("passkey")
            ? "passkey"
            : (result.methods?.[0] ?? "totp"),
        );
        setMfaOrigin(result.home_bay_url);
        setFactorCode("");
        return;
      }
      if (!result?.account_id) {
        throw new Error("Sign in failed. Please try again.");
      }
      setStoredControlPlaneOrigin(result?.home_bay_url);
      window.location.href = resolveAuthRedirectPath(redirectToPath);
    } catch (err) {
      if (
        showLegacyMigrationNotice &&
        signInErrorIsLegacyMissingAccount(err) &&
        validInitialEmail(email)
      ) {
        createAccountFromSignIn(true);
        return;
      }
      setError(`${err}`);
    } finally {
      setSigningIn(false);
    }
  }

  async function verifySecondFactor() {
    if (!canSubmit) {
      return;
    }
    setError("");
    setSigningIn(true);
    void prefetchSignedInShell();
    try {
      const result =
        factorMethod === "passkey"
          ? await signInWithPasskey({
              challenge_id: challengeId,
              origin: mfaOrigin,
            })
          : await postAuthApi<any>({
              endpoint: "auth/verify-second-factor",
              origin: mfaOrigin,
              body: {
                challenge_id: challengeId,
                method: codeFactorMethod,
                code: factorCode.trim(),
              },
            });
      if (!result?.account_id) {
        throw new Error("Second factor verification failed. Please try again.");
      }
      setStoredControlPlaneOrigin(result?.home_bay_url);
      window.location.href = resolveAuthRedirectPath(redirectToPath);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div style={STACK_STYLE}>
      {!challengeId && (
        <AuthInstructions>
          {publicConfig?.sign_in_email_instructions}
        </AuthInstructions>
      )}
      {showLegacyMigrationNotice && (
        <LegacyCocalcAccountNotice
          attemptedEmail={email}
          mode="sign-in"
          onCreateAccount={() => createAccountFromSignIn(true)}
        />
      )}
      {error ? (
        <div ref={errorRef} style={{ scrollMarginTop: "180px" }} tabIndex={-1}>
          <Alert kind="error">{error}</Alert>
        </div>
      ) : null}
      {initialInfo && challengeId && <Alert kind="info">{initialInfo}</Alert>}
      {!challengeId ? (
        <>
          {googleStrategy != null ? (
            <>
              {policiesVisible ? (
                <PolicyActionNotice
                  action={`continuing with ${googleStrategy.display}`}
                  privacyUrl={privacyUrl}
                  termsUrl={termsUrl}
                />
              ) : null}
              <SsoButton
                cookieBannerEnabled={cookieBannerEnabled}
                cookieConsentReady={cookieConsentReady}
                href={ssoLoginHref("google", {
                  target: resolveAuthRedirectPath(redirectToPath),
                  terms: policiesVisible ? true : undefined,
                })}
              >
                {policiesVisible ? "Agree and continue" : "Continue"} with{" "}
                {googleStrategy.display}
              </SsoButton>
              <AuthDivider />
            </>
          ) : null}
          <div style={FIELD_STYLE}>
            <div style={LABEL_STYLE}>Email address</div>
            <TextInput
              autoComplete="username"
              autoFocus
              name="email"
              placeholder="you@example.com"
              value={email}
              onChange={(value) => {
                setEmail(value);
                setError("");
              }}
              onPressEnter={signIn}
            />
            <div aria-live="polite" style={POLICY_STATUS_STYLE}>
              {checkingSignInMethod ? "Checking sign-in policy..." : "\u00a0"}
            </div>
          </div>
          {ssoStrategy && (
            <Alert kind="info">
              <div style={{ fontWeight: 600, marginBottom: "6px" }}>
                This email domain uses single sign-on.
              </div>
              <div style={{ marginBottom: "10px" }}>
                Continue with {ssoStrategy.display} instead of using a password.
              </div>
              {policiesVisible ? (
                <div style={{ marginBottom: "12px" }}>
                  <PolicyActionNotice
                    action={`continuing with ${ssoStrategy.display}`}
                    privacyUrl={privacyUrl}
                    termsUrl={termsUrl}
                  />
                </div>
              ) : null}
              <a
                href={ssoLoginHref(ssoStrategy.name, {
                  target: resolveAuthRedirectPath(redirectToPath),
                  terms: policiesVisible ? true : undefined,
                })}
                style={{
                  ...BUTTON_STYLE,
                  display: "block",
                  textAlign: "center",
                  textDecoration: "none",
                }}
                aria-disabled="false"
                onClick={(event) => {
                  if (
                    cookieBannerEnabled &&
                    !cookieConsentReady &&
                    !requireEssentialConsent()
                  ) {
                    event.preventDefault();
                  }
                }}
              >
                {policiesVisible ? "Agree and continue" : "Continue"} with{" "}
                {ssoStrategy.display}
              </a>
            </Alert>
          )}
          <div style={FIELD_STYLE}>
            <div style={LABEL_STYLE}>Password</div>
            <TextInput
              autoComplete="current-password"
              maxLength={MAX_PASSWORD_LENGTH}
              name="password"
              placeholder="Password"
              type="password"
              value={password}
              onChange={setPassword}
              onPressEnter={signIn}
            />
          </div>
        </>
      ) : (
        <div style={FIELD_STYLE}>
          <div style={LABEL_STYLE}>Second factor</div>
          <div
            aria-label="Choose second factor method"
            role="group"
            style={METHOD_CHOOSER_STYLE}
          >
            {factorMethods.includes("passkey") ? (
              <button
                type="button"
                style={{
                  ...(factorMethod === "passkey"
                    ? SELECTED_METHOD_BUTTON_STYLE
                    : METHOD_BUTTON_STYLE),
                }}
                onClick={() => setFactorMethod("passkey")}
              >
                Passkey
              </button>
            ) : undefined}
            {factorMethods.some((method) => method !== "passkey") ? (
              <button
                type="button"
                style={{
                  ...(factorMethod !== "passkey"
                    ? SELECTED_METHOD_BUTTON_STYLE
                    : METHOD_BUTTON_STYLE),
                }}
                onClick={() =>
                  setFactorMethod(
                    factorMethods.includes("totp") ? "totp" : "recovery_code",
                  )
                }
              >
                {recoveryCodeOnly ? "Recovery code" : "Code"}
              </button>
            ) : undefined}
          </div>
          {factorMethod === "passkey" ? (
            <div style={{ color: "#666", marginBottom: "8px" }}>
              Use your browser or device passkey prompt to finish signing in.
            </div>
          ) : (
            <>
              <div style={{ color: "#666", marginBottom: "8px" }}>
                {factorMethod === "recovery_code"
                  ? "Enter one of the recovery codes saved when your passkey was set up."
                  : hasRecoveryCode
                    ? "Enter either the 6-digit authenticator code or one of your recovery codes."
                    : "Enter the 6-digit code from your authenticator app."}
              </div>
              <TextInput
                autoComplete="one-time-code"
                autoFocus
                name="one-time-code"
                placeholder={getSecondFactorPlaceholder(
                  factorCode,
                  codeFactorMethod,
                )}
                value={factorCode}
                onChange={setFactorCode}
                onPressEnter={verifySecondFactor}
              />
            </>
          )}
          <NavLink
            onClick={() => {
              setChallengeId("");
              setFactorMethods([]);
              setFactorMethod("totp");
              setFactorCode("");
              setMfaOrigin(undefined);
              setError("");
            }}
          >
            Use a different account
          </NavLink>
        </div>
      )}
      <ActionButton
        disabled={!canSubmit}
        onClick={challengeId ? verifySecondFactor : signIn}
      >
        {signingIn
          ? challengeId
            ? "Verifying..."
            : "Signing In..."
          : challengeId
            ? factorMethod === "passkey"
              ? "Use passkey"
              : "Verify"
            : "Sign In"}
      </ActionButton>
      {!challengeId && (
        <div style={LINK_ROW_STYLE}>
          <NavLink onClick={() => onNavigate("password-reset")}>
            Forgot password?
          </NavLink>
          <NavLink onClick={() => createAccountFromSignIn(true)}>
            Create an account
          </NavLink>
        </div>
      )}
    </div>
  );
}

export function PublicPasswordResetForm({
  onNavigate,
}: {
  onNavigate: AuthNavigate;
}) {
  const [email, setEmail] = useState("");
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const canSubmit = isValidEmailAddress(email) && !resetting;

  async function resetPassword() {
    if (!canSubmit) {
      return;
    }
    setError("");
    setSuccess("");
    setResetting(true);
    try {
      const result = await api("auth/password-reset", { email });
      if (result?.error) {
        setError(result.error);
        return;
      }
      setEmail("");
      setSuccess(
        result?.success ??
          "Password reset email sent. Check your inbox for the reset link.",
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div style={STACK_STYLE}>
      {error && <Alert kind="error">{error}</Alert>}
      {success && <Alert kind="success">{success}</Alert>}
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Email address</div>
        <TextInput
          autoComplete="username"
          autoFocus
          name="email"
          placeholder="you@example.com"
          value={email}
          onChange={setEmail}
          onPressEnter={resetPassword}
        />
      </div>
      <ActionButton disabled={!canSubmit} onClick={resetPassword}>
        {resetting ? "Sending reset email..." : "Send password reset email"}
      </ActionButton>
      <div style={LINK_ROW_STYLE}>
        <NavLink onClick={() => onNavigate("sign-in")}>Back to sign in</NavLink>
        <NavLink onClick={() => onNavigate("sign-up")}>
          Create an account
        </NavLink>
      </div>
    </div>
  );
}

const VERIFICATION_POLL_INTERVAL_MS = 2_000;
const VERIFICATION_RESEND_DELAY_MS = 30_000;

function PostSignupVerificationStep({
  initialEmail,
  redirectToPath,
}: {
  initialEmail: string;
  redirectToPath?: string | (() => string);
}) {
  const [email, setEmail] = useState(initialEmail);
  const [now, setNow] = useState(() => Date.now());
  const [resendAvailableAt, setResendAvailableAt] = useState(
    () => Date.now() + VERIFICATION_RESEND_DELAY_MS,
  );
  const [resending, setResending] = useState(false);
  const [sent, setSent] = useState(true);
  const [error, setError] = useState("");
  const [editingEmail, setEditingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState(initialEmail);
  const [currentPassword, setCurrentPassword] = useState("");
  const [updatingEmail, setUpdatingEmail] = useState(false);
  const redirecting = useRef(false);
  const correctedEmail = useRef("");

  useEffect(() => {
    let cancelled = false;

    async function checkVerification() {
      try {
        const bootstrap = await getControlPlaneAuthBootstrap();
        if (cancelled || redirecting.current) {
          return;
        }
        if (!bootstrap.signed_in) {
          setError(
            "Your signup session ended. Sign in with the password you just created to continue verification.",
          );
          return;
        }
        if (bootstrap.email_address) {
          const bootstrapEmail = bootstrap.email_address.trim().toLowerCase();
          if (
            !correctedEmail.current ||
            correctedEmail.current === bootstrapEmail
          ) {
            correctedEmail.current = "";
            setEmail(bootstrapEmail);
            if (!editingEmail) {
              setNewEmail(bootstrapEmail);
            }
          }
        }
        if (bootstrap.email_address_verified === true) {
          redirecting.current = true;
          window.location.href = resolveAuthRedirectPath(redirectToPath);
        }
      } catch {
        // A transient bootstrap failure should not replace the useful
        // verification instructions. The next poll retries automatically.
      }
    }

    void checkVerification();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void checkVerification();
    }, VERIFICATION_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [editingEmail, redirectToPath]);

  async function resendVerification() {
    setError("");
    setResending(true);
    try {
      await postAuthApi({
        endpoint: "accounts/send-verification-email",
        origin: getControlPlaneOrigin(),
        body: { email_address: email },
      });
      setSent(true);
      setResendAvailableAt(Date.now() + VERIFICATION_RESEND_DELAY_MS);
      setNow(Date.now());
    } catch (err) {
      setError(`${err}`);
    } finally {
      setResending(false);
    }
  }

  async function updateEmail() {
    const normalized = newEmail.trim().toLowerCase();
    if (!isValidEmailAddress(normalized)) {
      setError("Enter a valid email address.");
      return;
    }
    if (!currentPassword) {
      setError("Enter the password you just created.");
      return;
    }
    setError("");
    setUpdatingEmail(true);
    try {
      await postAuthApi({
        endpoint: "auth/fresh-auth",
        origin: getControlPlaneOrigin(),
        body: {
          current_password: currentPassword,
          duration: "default",
        },
      });
      const result = await postAuthApi<{
        verification_email_error?: string;
      }>({
        endpoint: "accounts/set-email-address",
        origin: getControlPlaneOrigin(),
        body: {
          email_address: normalized,
          password: currentPassword,
        },
      });
      correctedEmail.current = normalized;
      setEmail(normalized);
      setNewEmail(normalized);
      setCurrentPassword("");
      setEditingEmail(false);
      if (result?.verification_email_error) {
        setSent(false);
        setError(
          `The email address was changed, but the verification message could not be sent: ${result.verification_email_error}`,
        );
        setResendAvailableAt(Date.now());
      } else {
        setSent(true);
        setResendAvailableAt(Date.now() + VERIFICATION_RESEND_DELAY_MS);
      }
      setNow(Date.now());
    } catch (err) {
      setError(`${err}`);
    } finally {
      setUpdatingEmail(false);
    }
  }

  async function signOut() {
    setError("");
    try {
      await signOutAuthSession();
      window.location.reload();
    } catch (err) {
      setError(`${err}`);
    }
  }

  const resendSeconds = Math.max(
    0,
    Math.ceil((resendAvailableAt - now) / 1_000),
  );

  return (
    <div style={STACK_STYLE}>
      <Alert kind="success">
        <div style={{ fontSize: "17px", fontWeight: 700, marginBottom: "6px" }}>
          Check your email
        </div>
        We sent a verification link to <strong>{email}</strong>.
      </Alert>
      <div style={{ color: COLORS.GRAY_D, lineHeight: "22px" }}>
        Open the message and click <strong>Verify email address</strong>. This
        page will continue automatically. Check your spam folder if the message
        does not arrive.
      </div>
      {sent ? (
        <div style={POLICY_STATUS_STYLE}>
          Verification email sent. Waiting for confirmation...
        </div>
      ) : null}
      {error ? <Alert kind="error">{error}</Alert> : null}
      <ActionButton
        disabled={resending || resendSeconds > 0}
        onClick={resendVerification}
      >
        {resending
          ? "Sending..."
          : resendSeconds > 0
            ? `Resend available in ${resendSeconds}s`
            : "Resend verification email"}
      </ActionButton>
      {editingEmail ? (
        <div style={{ ...STACK_STYLE, paddingTop: "4px" }}>
          <Alert kind="info">
            Correct the address using the password you just created. We will
            send a new verification message.
          </Alert>
          <div style={FIELD_STYLE}>
            <div style={LABEL_STYLE}>New email address</div>
            <TextInput
              ariaLabel="New email address"
              autoComplete="email"
              autoFocus
              name="new-email"
              placeholder="you@example.com"
              value={newEmail}
              onChange={setNewEmail}
              onPressEnter={updateEmail}
            />
          </div>
          <div style={FIELD_STYLE}>
            <div style={LABEL_STYLE}>Current password</div>
            <TextInput
              ariaLabel="Current password"
              autoComplete="current-password"
              name="current-password"
              type="password"
              value={currentPassword}
              onChange={setCurrentPassword}
              onPressEnter={updateEmail}
            />
          </div>
          <ActionButton
            disabled={
              updatingEmail ||
              !isValidEmailAddress(newEmail.trim().toLowerCase()) ||
              !currentPassword
            }
            onClick={updateEmail}
          >
            {updatingEmail ? "Updating..." : "Update email and resend"}
          </ActionButton>
          <div style={{ textAlign: "center" }}>
            <NavLink onClick={() => setEditingEmail(false)}>Cancel</NavLink>
          </div>
        </div>
      ) : (
        <div style={{ ...LINK_ROW_STYLE, justifyContent: "center" }}>
          <NavLink onClick={() => setEditingEmail(true)}>
            Use a different email
          </NavLink>
          <NavLink onClick={signOut}>Sign out</NavLink>
        </div>
      )}
    </div>
  );
}

export function PublicSignUpForm({
  cookieBannerEnabled = false,
  initialEmail,
  initialRegistrationToken,
  initialSSOStrategies,
  legacySignUpPrompt = false,
  onNavigate,
  onVerificationPendingChange,
  redirectToPath,
  signupEmailDomainPolicy,
}: {
  cookieBannerEnabled?: boolean;
  initialEmail?: string;
  initialRegistrationToken?: string;
  initialSSOStrategies?: PublicSsoStrategy[];
  legacySignUpPrompt?: boolean;
  onNavigate: AuthNavigate;
  onVerificationPendingChange?: (pending: boolean) => void;
  redirectToPath?: string | (() => string);
  signupEmailDomainPolicy?: SignupEmailDomainPublicPolicy;
}) {
  const [requiresToken, setRequiresToken] = useState<boolean>();
  const onboardingIntent = useMemo(onboardingIntentFromBrowser, []);
  const [registrationToken, setRegistrationToken] = useState(
    initialRegistrationToken ??
      new URL(window.location.href).searchParams.get("registrationToken") ??
      "",
  );
  const [email, setEmail] = useState(() => validInitialEmail(initialEmail));
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [signingUp, setSigningUp] = useState(false);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const strategies = usePublicSsoStrategies(initialSSOStrategies);
  const googleStrategy = googleStrategyFrom(strategies);
  const registrationTokenInputRef = useRef<HTMLInputElement | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const confirmPasswordInputRef = useRef<HTMLInputElement | null>(null);
  const displayNameInputRef = useRef<HTMLInputElement | null>(null);
  const publicConfig = usePublicConfig();
  const requiresContinuousVerification =
    normalizeEmailAuthenticationMode(
      publicConfig?.email_authentication_mode,
    ) !== "password_required";
  const consentReady = useEssentialConsent();
  const cookieConsentReady = !cookieBannerEnabled || consentReady;
  const policiesVisible = arePublicPoliciesVisible(publicConfig);
  const { termsUrl, privacyUrl } = policyUrls(publicConfig);
  const emailAllowedByDomainPolicy = emailAllowedByPublicSignupPolicy({
    email_address: email,
    policy: signupEmailDomainPolicy,
  });
  const emailDomainPolicyViolation =
    isValidEmailAddress(email) && !emailAllowedByDomainPolicy;
  const passwordTooShort =
    password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  const bootstrap = useMemo(
    () => new URL(window.location.href).searchParams.get("bootstrap") === "1",
    [],
  );

  useEffect(() => {
    if (requiresToken !== undefined) {
      return;
    }
    (async () => {
      try {
        const result = await api("auth/requires-token");
        setRequiresToken(!!result);
      } catch {
        setRequiresToken(false);
      }
    })();
  }, [requiresToken]);

  useEffect(() => {
    const value = validInitialEmail(initialEmail);
    if (!value) {
      return;
    }
    setEmail((current) => current || value);
  }, [initialEmail]);

  const syncBrowserFilledInputs = useCallback(() => {
    const sync = (
      ref: RefObject<HTMLInputElement | null>,
      setter: (value: string) => void,
    ) => {
      const value = ref.current?.value;
      if (value) {
        setter(value);
      }
    };
    sync(registrationTokenInputRef, setRegistrationToken);
    sync(emailInputRef, setEmail);
    sync(passwordInputRef, setPassword);
    sync(confirmPasswordInputRef, setConfirmPassword);
    sync(displayNameInputRef, setDisplayName);
  }, []);

  useEffect(() => {
    const timers = [100, 500, 1000, 2000].map((delay) =>
      setTimeout(syncBrowserFilledInputs, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [syncBrowserFilledInputs]);

  const canSubmit = useMemo(() => {
    if (!isValidEmailAddress(email)) {
      return false;
    }
    if (!emailAllowedByDomainPolicy) {
      return false;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return false;
    }
    if (password !== confirmPassword) {
      return false;
    }
    if (!displayName.trim()) {
      return false;
    }
    if (requiresToken && !registrationToken.trim()) {
      return false;
    }
    return cookieConsentReady && !signingUp;
  }, [
    confirmPassword,
    cookieConsentReady,
    displayName,
    email,
    emailAllowedByDomainPolicy,
    password,
    registrationToken,
    requiresToken,
    signingUp,
  ]);

  async function signUp() {
    if (!canSubmit) {
      if (!cookieConsentReady) {
        requireEssentialConsent();
      }
      return;
    }
    if (cookieBannerEnabled && !requireEssentialConsent()) {
      return;
    }
    setIssues({});
    setError("");
    setSigningUp(true);
    void prefetchSignedInShell();
    try {
      let result = await postAuthApi<any>({
        endpoint: "auth/sign-up",
        body: {
          terms: true,
          marketing_consent: false,
          onboardingIntent,
          email,
          password,
          displayName,
          registrationToken: registrationToken.trim(),
        },
      });
      if (isWrongBayAuthResponse(result)) {
        result = await retryAuthOnHomeBay({
          endpoint: "auth/sign-in",
          wrongBay: result,
          body: { email, password },
        });
      }
      if (result?.issues && len(result.issues) > 0) {
        setIssues(result.issues);
        return;
      }
      if (result?.error) {
        throw new Error(`${result.error}`);
      }
      if (!result?.account_id) {
        if (requiresToken) {
          setIssues({
            registrationToken:
              "Registration token was not accepted. Check that it is active and typed correctly.",
          });
          return;
        }
        throw new Error("Sign up failed. Please try again.");
      }
      setStoredControlPlaneOrigin(result?.home_bay_url);
      if (requiresContinuousVerification) {
        setPendingVerificationEmail(email.trim().toLowerCase());
        onVerificationPendingChange?.(true);
        return;
      }
      window.location.href = resolveAuthRedirectPath(redirectToPath);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSigningUp(false);
    }
  }

  const issueList = Object.values(issues).filter(Boolean);
  const canGoogleSignUp =
    googleStrategy != null &&
    (requiresToken === false ||
      (requiresToken === true && !!registrationToken.trim())) &&
    cookieConsentReady;

  if (pendingVerificationEmail) {
    return (
      <PostSignupVerificationStep
        initialEmail={pendingVerificationEmail}
        redirectToPath={redirectToPath}
      />
    );
  }

  return (
    <div
      style={STACK_STYLE}
      onFocusCapture={syncBrowserFilledInputs}
      onInputCapture={syncBrowserFilledInputs}
    >
      <AuthInstructions>
        {publicConfig?.account_creation_email_instructions}
      </AuthInstructions>
      {bootstrap && (
        <Alert kind="info">
          You are creating the initial admin account for this server.
        </Alert>
      )}
      {legacySignUpPrompt && isCocalcAiPublicSite(publicConfig) ? (
        <LegacyCocalcAccountNotice attemptedEmail={email} mode="sign-up" />
      ) : null}
      {error && <Alert kind="error">{error}</Alert>}
      {issueList.length > 0 && (
        <Alert kind="error">
          <div style={{ fontWeight: 600, marginBottom: "8px" }}>
            Sign up failed
          </div>
          <ul style={{ margin: 0, paddingLeft: "18px" }}>
            {issueList.map((issue, idx) => (
              <li key={idx}>{issue}</li>
            ))}
          </ul>
        </Alert>
      )}
      {requiresToken && (
        <div style={FIELD_STYLE}>
          <div style={LABEL_STYLE}>Registration token</div>
          <TextInput
            autoFocus={!!requiresToken}
            inputRef={registrationTokenInputRef}
            name="registration-token"
            placeholder="Enter your registration token"
            value={registrationToken}
            onChange={setRegistrationToken}
          />
        </div>
      )}
      {googleStrategy != null ? (
        <>
          {policiesVisible ? (
            <PolicyActionNotice
              action={`continuing with ${googleStrategy.display}`}
              privacyUrl={privacyUrl}
              termsUrl={termsUrl}
            />
          ) : null}
          <SsoButton
            disabled={!canGoogleSignUp}
            cookieBannerEnabled={cookieBannerEnabled}
            cookieConsentReady={cookieConsentReady}
            href={ssoLoginHref("google", {
              target: resolveAuthRedirectPath(redirectToPath),
              terms: policiesVisible ? true : undefined,
              marketing_consent: false,
              onboarding_intent: onboardingIntent,
              registration_token: registrationToken.trim(),
            })}
          >
            {policiesVisible ? "Agree and sign up" : "Sign up"} with{" "}
            {googleStrategy.display}
          </SsoButton>
          <AuthDivider>or create an account with email</AuthDivider>
        </>
      ) : null}
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Email address</div>
        <TextInput
          autoComplete="username"
          autoFocus={!requiresToken}
          inputRef={emailInputRef}
          name="email"
          placeholder="you@example.com"
          value={email}
          onChange={setEmail}
          onPressEnter={signUp}
        />
        {signupEmailDomainPolicy?.message ? (
          <div
            style={{
              color: emailDomainPolicyViolation ? COLORS.FG_RED : COLORS.GRAY_M,
              fontSize: "13px",
              lineHeight: "18px",
            }}
          >
            {signupEmailDomainPolicy.message}
          </div>
        ) : null}
      </div>
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Password</div>
        <TextInput
          autoComplete="new-password"
          inputRef={passwordInputRef}
          maxLength={MAX_PASSWORD_LENGTH}
          name="new-password"
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          type="password"
          value={password}
          onChange={setPassword}
          onPressEnter={signUp}
        />
        {passwordTooShort ? (
          <div style={{ ...TERMS_NOTICE_STYLE, color: COLORS.FG_RED }}>
            Password must be at least {MIN_PASSWORD_LENGTH} characters.
          </div>
        ) : null}
      </div>
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Confirm password</div>
        <TextInput
          autoComplete="new-password"
          inputRef={confirmPasswordInputRef}
          maxLength={MAX_PASSWORD_LENGTH}
          name="confirm-password"
          placeholder="Enter the same password again"
          type="password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          onPressEnter={signUp}
        />
        {confirmPassword && password !== confirmPassword ? (
          <div style={{ ...TERMS_NOTICE_STYLE, color: COLORS.FG_RED }}>
            Passwords do not match.
          </div>
        ) : null}
      </div>
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Name</div>
        <TextInput
          autoComplete="name"
          inputRef={displayNameInputRef}
          name="name"
          placeholder="Your name"
          value={displayName}
          onChange={setDisplayName}
          onPressEnter={signUp}
        />
      </div>
      {policiesVisible ? (
        <>
          <PolicyActionNotice
            action="creating an account"
            privacyUrl={privacyUrl}
            termsUrl={termsUrl}
          />
          {issues.terms && <div style={TERMS_NOTICE_STYLE}>{issues.terms}</div>}
        </>
      ) : null}
      <ActionButton disabled={!canSubmit} onClick={signUp}>
        {signingUp
          ? "Creating account..."
          : !cookieConsentReady
            ? "Acknowledge cookie banner to continue"
            : policiesVisible
              ? "Agree and create account"
              : "Create account"}
      </ActionButton>
      <div style={{ textAlign: "center" }}>
        Already have an account?{" "}
        <NavLink onClick={() => onNavigate("sign-in")}>Sign in</NavLink>
      </div>
    </div>
  );
}
