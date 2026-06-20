/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import api from "@cocalc/frontend/client/api";
import { setStoredControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import {
  requireEssentialConsent,
  useEssentialConsent,
} from "@cocalc/frontend/cookie-consent";
import type { AuthView } from "@cocalc/frontend/auth/types";
import {
  isMfaRequiredAuthResponse,
  isWrongBayAuthResponse,
  postAuthApi,
  retryAuthOnHomeBay,
  type SecondFactorMethod,
} from "@cocalc/frontend/auth/api";
import { signInWithPasskey } from "@cocalc/frontend/auth/passkeys";
import {
  getSecondFactorPlaceholder,
  inferSecondFactorInputMethod,
} from "@cocalc/frontend/auth/second-factor-input";
import { appUrl } from "@cocalc/frontend/auth/util";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  arePublicPoliciesVisible,
  getExternalPoliciesUrl,
  type PublicConfig,
  usePublicConfig,
} from "@cocalc/frontend/public/config";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@cocalc/util/auth";
import {
  emailAllowedByPublicSignupPolicy,
  type SignupEmailDomainPublicPolicy,
} from "@cocalc/util/accounts/signup-email-domain-policy";
import {
  is_valid_email_address as isValidEmailAddress,
  len,
} from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";
import { legacyNamePartsFromDisplayName } from "@cocalc/util/accounts/display-name";

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

const CHECKBOX_ROW_STYLE: CSSProperties = {
  alignItems: "flex-start",
  color: COLORS.GRAY_D,
  cursor: "pointer",
  display: "flex",
  fontSize: "14px",
  gap: "8px",
  lineHeight: "20px",
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

function Alert({
  children,
  kind,
}: {
  children: ReactNode;
  kind: "error" | "info" | "success";
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
        : {
            ...ALERT_STYLE,
            background: "#e6f4ff",
            border: "1px solid #91caff",
            color: "#0958d9",
          };
  return <div style={style}>{children}</div>;
}

function TextInput(props: {
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
        ...BUTTON_STYLE,
        background: "white",
        border: `1px solid ${COLORS.GRAY_LL}`,
        color: COLORS.GRAY_D,
        display: "block",
        opacity: disabled ? 0.65 : 1,
        textAlign: "center",
        textDecoration: "none",
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
        }
      }}
    >
      {children}
    </a>
  );
}

export function PublicSignInForm({
  initialChallengeId,
  initialInfo,
  initialSSOStrategies,
  cookieBannerEnabled = false,
  onNavigate,
  redirectToPath,
}: {
  initialChallengeId?: string;
  initialInfo?: string;
  initialSSOStrategies?: PublicSsoStrategy[];
  cookieBannerEnabled?: boolean;
  onNavigate: (view: AuthView) => void;
  redirectToPath?: string | (() => string);
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challengeId, setChallengeId] = useState(initialChallengeId ?? "");
  const [factorMethods, setFactorMethods] = useState<SecondFactorMethod[]>([]);
  const [factorMethod, setFactorMethod] = useState<SecondFactorMethod>("totp");
  const [factorCode, setFactorCode] = useState("");
  const [mfaOrigin, setMfaOrigin] = useState<string | undefined>();
  const [acceptedSsoTerms, setAcceptedSsoTerms] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [checkingSignInMethod, setCheckingSignInMethod] = useState(false);
  const [signInMethod, setSignInMethod] = useState<SignInMethod>();
  const [error, setError] = useState("");
  const strategies = usePublicSsoStrategies(initialSSOStrategies);
  const googleStrategy = googleStrategyFrom(strategies);
  const publicConfig = usePublicConfig();
  const codeFactorMethod = inferSecondFactorInputMethod(factorCode);
  const consentReady = useEssentialConsent();
  const cookieConsentReady = !cookieBannerEnabled || consentReady;
  const policiesVisible = arePublicPoliciesVisible(publicConfig);
  const { termsUrl, privacyUrl } = policyUrls(publicConfig);
  const ssoStrategy =
    !challengeId && signInMethod?.sso_required
      ? signInMethod.sso_strategy
      : undefined;
  const acceptedRequiredSsoTerms = !policiesVisible || acceptedSsoTerms;

  useEffect(() => {
    setChallengeId(initialChallengeId ?? "");
  }, [initialChallengeId]);

  const canSubmit = challengeId
    ? factorMethod === "passkey"
      ? !signingIn
      : factorCode.trim().length > 0 && !signingIn
    : isValidEmailAddress(email) &&
      password.length > 0 &&
      !ssoStrategy &&
      !signingIn;

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
      {error && <Alert kind="error">{error}</Alert>}
      {initialInfo && challengeId && <Alert kind="info">{initialInfo}</Alert>}
      {!challengeId ? (
        <>
          {googleStrategy != null ? (
            <SsoButton
              cookieBannerEnabled={cookieBannerEnabled}
              cookieConsentReady={cookieConsentReady}
              href={ssoLoginHref("google", {
                target: resolveAuthRedirectPath(redirectToPath),
              })}
            >
              Continue with {googleStrategy.display}
            </SsoButton>
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
                <label style={{ ...CHECKBOX_ROW_STYLE, marginBottom: "12px" }}>
                  <input
                    checked={acceptedSsoTerms}
                    type="checkbox"
                    onChange={(e) =>
                      setAcceptedSsoTerms(e.currentTarget.checked)
                    }
                  />
                  <span>
                    I accept the{" "}
                    <a href={termsUrl} target="_blank" rel="noreferrer">
                      Terms of Service
                    </a>{" "}
                    and{" "}
                    <a href={privacyUrl} target="_blank" rel="noreferrer">
                      Privacy Policy
                    </a>
                    .
                  </span>
                </label>
              ) : null}
              <a
                href={ssoLoginHref(
                  ssoStrategy.name,
                  acceptedRequiredSsoTerms
                    ? {
                        target: resolveAuthRedirectPath(redirectToPath),
                        terms: policiesVisible ? acceptedSsoTerms : true,
                      }
                    : undefined,
                )}
                style={{
                  ...BUTTON_STYLE,
                  opacity: acceptedRequiredSsoTerms ? 1 : 0.65,
                  display: "block",
                  textAlign: "center",
                  textDecoration: "none",
                }}
                aria-disabled={!acceptedRequiredSsoTerms}
                onClick={(event) => {
                  if (!acceptedRequiredSsoTerms) {
                    event.preventDefault();
                    return;
                  }
                  if (
                    cookieBannerEnabled &&
                    !cookieConsentReady &&
                    !requireEssentialConsent()
                  ) {
                    event.preventDefault();
                  }
                }}
              >
                Continue with {ssoStrategy.display}
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
                Code
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
                Enter either the 6-digit authenticator code or one of your
                recovery codes.
              </div>
              <TextInput
                autoComplete="one-time-code"
                autoFocus
                name="one-time-code"
                placeholder={getSecondFactorPlaceholder(factorCode)}
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
          <NavLink onClick={() => onNavigate("sign-up")}>
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
  onNavigate: (view: AuthView) => void;
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

export function PublicSignUpForm({
  cookieBannerEnabled = false,
  initialSSOStrategies,
  onNavigate,
  redirectToPath,
  signupEmailDomainPolicy,
}: {
  cookieBannerEnabled?: boolean;
  initialSSOStrategies?: PublicSsoStrategy[];
  onNavigate: (view: AuthView) => void;
  redirectToPath?: string | (() => string);
  signupEmailDomainPolicy?: SignupEmailDomainPublicPolicy;
}) {
  const [requiresToken, setRequiresToken] = useState<boolean>();
  const [registrationToken, setRegistrationToken] = useState(
    new URL(window.location.href).searchParams.get("registrationToken") ?? "",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [signingUp, setSigningUp] = useState(false);
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
    if (policiesVisible && !acceptedTerms) {
      return false;
    }
    return cookieConsentReady && !signingUp;
  }, [
    acceptedTerms,
    confirmPassword,
    cookieConsentReady,
    displayName,
    email,
    emailAllowedByDomainPolicy,
    password,
    policiesVisible,
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
    try {
      const legacyNameParts = legacyNamePartsFromDisplayName(displayName);
      let result = await postAuthApi<any>({
        endpoint: "auth/sign-up",
        body: {
          terms: policiesVisible ? acceptedTerms : true,
          marketing_consent: marketingConsent,
          email,
          password,
          displayName,
          firstName: legacyNameParts.first_name,
          lastName: legacyNameParts.last_name,
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
    (!policiesVisible || acceptedTerms) &&
    cookieConsentReady;

  return (
    <div
      style={STACK_STYLE}
      onFocusCapture={syncBrowserFilledInputs}
      onInputCapture={syncBrowserFilledInputs}
    >
      {bootstrap && (
        <Alert kind="info">
          You are creating the initial admin account for this server.
        </Alert>
      )}
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
          <SsoButton
            disabled={!canGoogleSignUp}
            cookieBannerEnabled={cookieBannerEnabled}
            cookieConsentReady={cookieConsentReady}
            href={ssoLoginHref("google", {
              target: resolveAuthRedirectPath(redirectToPath),
              terms: policiesVisible ? acceptedTerms : true,
              marketing_consent: marketingConsent,
              registration_token: registrationToken.trim(),
            })}
          >
            Sign up with {googleStrategy.display}
          </SsoButton>
          <div style={TERMS_NOTICE_STYLE}>
            Or create an account with an email address and password.
          </div>
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
          <label style={CHECKBOX_ROW_STYLE}>
            <input
              checked={acceptedTerms}
              type="checkbox"
              onChange={(e) => setAcceptedTerms(e.currentTarget.checked)}
            />
            <span>
              I accept the{" "}
              <a href={termsUrl} target="_blank" rel="noreferrer">
                Terms of Service
              </a>{" "}
              and{" "}
              <a href={privacyUrl} target="_blank" rel="noreferrer">
                Privacy Policy
              </a>
              .
            </span>
          </label>
          {issues.terms && <div style={TERMS_NOTICE_STYLE}>{issues.terms}</div>}
        </>
      ) : null}
      <label style={CHECKBOX_ROW_STYLE}>
        <input
          checked={marketingConsent}
          type="checkbox"
          onChange={(e) => setMarketingConsent(e.currentTarget.checked)}
        />
        <span>
          Send me occasional platform tips, onboarding help, and product
          updates. You can change this later in Account Preferences.
        </span>
      </label>
      <ActionButton disabled={!canSubmit} onClick={signUp}>
        {signingUp
          ? "Creating account..."
          : !cookieConsentReady
            ? "Acknowledge cookie banner to continue"
            : "Create account"}
      </ActionButton>
      <div style={{ textAlign: "center" }}>
        Already have an account?{" "}
        <NavLink onClick={() => onNavigate("sign-in")}>Sign in</NavLink>
      </div>
    </div>
  );
}
