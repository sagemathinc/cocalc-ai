/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";

import {
  postAuthApi,
  signOutAuthSession,
  type SecondFactorMethod,
} from "@cocalc/frontend/auth/api";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import { approveCliElevationWithPasskey } from "@cocalc/frontend/auth/passkeys";
import {
  getSecondFactorPlaceholder,
  inferSecondFactorInputMethod,
} from "@cocalc/frontend/auth/second-factor-input";
import { COLORS } from "@cocalc/util/theme";
import { ExternalAgentApproval } from "./external-agent-approval";
import {
  formatFreshAuthDuration,
  isLongFreshAuthDuration,
  parseFreshAuthDuration,
  type FreshAuthDuration,
} from "@cocalc/util/auth/fresh-auth-duration";

// The duration a CLI asked for, or "default" if it is not one we know.
function safeDuration(value: unknown): FreshAuthDuration {
  try {
    return parseFreshAuthDuration(value);
  } catch {
    return "default";
  }
}

// " for 72 hours" for a requested duration other than the default, so the
// approve button itself says what is being approved.
function forDurationSuffix(value: unknown): string {
  const duration = safeDuration(value);
  return duration === "default"
    ? ""
    : ` for ${formatFreshAuthDuration(duration)}`;
}

// A verification longer than 8 hours that an agent or a CLI asked for is
// never preselected or approved by default: the owner confirms it explicitly.
function LongDurationConfirm({
  value,
  checked,
  onChange,
}: {
  value: unknown;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const duration = safeDuration(value);
  if (!isLongFreshAuthDuration(duration)) return null;
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        Yes, this request asks for {formatFreshAuthDuration(duration)}, and I
        want the terminal to stay elevated that long.
      </span>
    </label>
  );
}

function elevatedForText(value: unknown, subject: string): string {
  const duration = safeDuration(value);
  if (duration === "default") return "";
  let text = ` ${subject} will stay elevated for ${formatFreshAuthDuration(duration)}.`;
  if (isLongFreshAuthDuration(duration)) {
    text +=
      " We will email you about it, and you can end it any time in Account Settings, Profile, Security.";
  }
  return text;
}

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

const ALERT_STYLE: CSSProperties = {
  borderRadius: "8px",
  padding: "10px 12px",
  fontSize: "14px",
} as const;

const ACTION_LINK_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  padding: 0,
  textDecoration: "underline",
} as const;

type ChallengeInfo = {
  challenge_id: string;
  kind: "login" | "elevate" | "external-agent";
  external?: { label: string; origin_bay_id: string };
  account_id: string | null;
  email_address?: string | null;
  display_name?: string | null;
  email_hint?: string | null;
  current_account_id?: string | null;
  current_email_address?: string | null;
  current_display_name?: string | null;
  current_matches_account?: boolean | null;
  requested_duration?: FreshAuthDuration | null;
  elevated_login?: boolean;
  auth_client?: "cli" | "mobile";
  state: "pending" | "approved" | "redeemed" | "canceled";
  expires_at: string;
  /** Server time left on the request when this was read. */
  expires_in_ms?: number;
};

/** The server measured the time left before its reply travelled here; count
 * the whole request against it, so the page never stays open past expiry. */
export function withRequestTimeSpent<T extends { expires_in_ms?: number }>(
  info: T,
  spentMs: number,
): T {
  if (info.expires_in_ms == null) return info;
  return {
    ...info,
    expires_in_ms: Math.max(0, info.expires_in_ms - Math.max(0, spentMs)),
  };
}

type CliElevationFreshAuthStatus = {
  enabled: boolean;
  methods?: SecondFactorMethod[];
  has_password?: boolean;
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
      placeholder={props.placeholder}
      style={INPUT_STYLE}
      type={props.type ?? "text"}
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
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

function formatAccountIdentity(opts: {
  email_address?: string | null;
  display_name?: string | null;
  fallback?: string;
}): string {
  const email = `${opts.email_address ?? ""}`.trim();
  const display = `${opts.display_name ?? ""}`.trim();
  if (email && display) {
    return `${email} (${display})`;
  }
  return email || display || opts.fallback || "this account";
}

function requestedAccountLabel(info: ChallengeInfo | null): string {
  return formatAccountIdentity({
    email_address: info?.email_address,
    display_name: info?.display_name,
  });
}

function loginHintLabel(info: ChallengeInfo | null): string {
  const emailHint = `${info?.email_hint ?? ""}`.trim();
  if (!emailHint) return "";
  return info?.auth_client === "mobile"
    ? ` The mobile app was started with email hint ${emailHint}.`
    : ` The CLI was started with email hint ${emailHint}.`;
}

function isMobileLogin(info: ChallengeInfo | null): boolean {
  return info?.auth_client === "mobile";
}

function currentAccountLabel(info: ChallengeInfo | null): string {
  return formatAccountIdentity({
    email_address: info?.current_email_address,
    display_name: info?.current_display_name,
    fallback: "another account",
  });
}

function currentCliLoginAccountLabel(info: ChallengeInfo | null): string {
  return formatAccountIdentity({
    email_address: info?.current_email_address,
    display_name: info?.current_display_name,
    fallback: "this browser account",
  });
}

function isWrongSignedInAccount(info: ChallengeInfo | null): boolean {
  return info?.current_matches_account === false;
}

function InlineActionLink(props: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={props.disabled}
      style={{
        ...ACTION_LINK_STYLE,
        opacity: props.disabled ? 0.65 : 1,
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function PublicCliLoginApprovalView({
  challengeId,
  isAuthenticated,
  onEmailHintChange,
}: {
  challengeId: string;
  isAuthenticated: boolean;
  onEmailHintChange?: (email: string | undefined) => void;
}) {
  const [info, setInfo] = useState<ChallengeInfo | null>(null);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const authOrigin = getControlPlaneOrigin();
  const [longConfirmed, setLongConfirmed] = useState(false);
  const requestedDuration = safeDuration(info?.requested_duration);
  const needsLongConfirm =
    info?.elevated_login === true && isLongFreshAuthDuration(requestedDuration);
  // A confirmation never carries over to another request.
  useEffect(() => {
    setLongConfirmed(false);
  }, [challengeId, info?.requested_duration]);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    // A long request is never preselected; the owner confirms it above and
    // then picks it in the verification dialog.
    defaultDuration:
      info?.elevated_login === true && !needsLongConfirm
        ? requestedDuration
        : undefined,
    origin: authOrigin,
  });

  useEffect(() => {
    let cancelled = false;
    onEmailHintChange?.(undefined);
    async function load() {
      try {
        const requestedAt = performance.now();
        const next = await postAuthApi<ChallengeInfo>({
          endpoint: "auth/cli/challenge-info",
          body: { challenge_id: challengeId },
        });
        if (!cancelled) {
          setInfo(withRequestTimeSpent(next, performance.now() - requestedAt));
          const emailHint = `${next.email_hint ?? ""}`.trim();
          onEmailHintChange?.(emailHint || undefined);
        }
      } catch (err) {
        if (!cancelled) {
          setError(`${err}`);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [challengeId, onEmailHintChange]);

  async function approve() {
    // Not only the button: Enter or any other path must not approve a long
    // request without the confirmation (the server checks it too).
    if (needsLongConfirm && !longConfirmed) {
      setError(
        `Confirm that the terminal should stay elevated for ${formatFreshAuthDuration(requestedDuration)}.`,
      );
      return;
    }
    setApproving(true);
    setError("");
    try {
      await runFreshAuthAction(async () => {
        const proof = await postAuthApi<{
          token: string;
          home_bay_id: string;
        }>({
          endpoint: "auth/cli/login/approval-token",
          origin: authOrigin,
          body: {
            challenge_id: challengeId,
            elevated_login: info?.elevated_login === true,
            requested_duration: info?.requested_duration ?? "default",
          },
        });
        await postAuthApi({
          endpoint: "auth/cli/login/approve",
          body: {
            challenge_id: challengeId,
            approval_token: proof.token,
            approval_home_bay_id: proof.home_bay_id,
            ...(needsLongConfirm
              ? { confirmed_duration: requestedDuration }
              : {}),
          },
        });
        setApproved(true);
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setApproving(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    setError("");
    try {
      await signOutAuthSession();
      window.location.reload();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSigningOut(false);
    }
  }

  if (info == null) {
    return (
      <div style={STACK_STYLE}>
        <Alert kind={error ? "error" : "info"}>
          {error || "Loading sign-in request…"}
        </Alert>
      </div>
    );
  }

  if (info.kind === "external-agent" && info.external) {
    return (
      <ExternalAgentApproval
        challengeId={challengeId}
        label={info.external.label}
        originBayId={info.external.origin_bay_id}
        isAuthenticated={isAuthenticated}
        accountLabel={currentCliLoginAccountLabel(info)}
        expiresInMs={info.expires_in_ms}
        state={info.state}
      />
    );
  }

  if (!isAuthenticated) {
    const client = isMobileLogin(info) ? "mobile app" : "CLI";
    return (
      <div style={STACK_STYLE}>
        <Alert kind="info">
          Sign in with the CoCalc account you want this {client} to use, then
          approve the {client} login request.{loginHintLabel(info)}
        </Alert>
      </div>
    );
  }

  if (isWrongSignedInAccount(info)) {
    const client = isMobileLogin(info) ? "mobile app" : "CLI";
    return (
      <div style={STACK_STYLE}>
        {error ? <Alert kind="error">{error}</Alert> : undefined}
        <Alert kind="error">
          This browser is signed in as {currentAccountLabel(info)}.{" "}
          <InlineActionLink disabled={signingOut} onClick={signOut}>
            {signingOut ? "Signing out..." : "Sign out"}
          </InlineActionLink>
          {` and then sign in as ${requestedAccountLabel(info)} to approve the ${client} login request.`}
        </Alert>
        <Alert kind="info">
          If that is inconvenient, open this link in a new temporary incognito
          or private browser window and sign in there as{" "}
          {requestedAccountLabel(info)}.
        </Alert>
      </div>
    );
  }

  return (
    <div style={STACK_STYLE}>
      {error ? <Alert kind="error">{error}</Alert> : undefined}
      {approved ? (
        <Alert kind="success">
          {info?.elevated_login
            ? "Elevated CLI login approved. Return to your terminal to finish signing in."
            : isMobileLogin(info)
              ? "Mobile app login approved. Return to the CoCalc app to finish signing in."
              : "CLI login approved. Return to your terminal to finish signing in."}
        </Alert>
      ) : (
        <Alert kind="info">
          {isMobileLogin(info) ? (
            <>
              Approve a CoCalc mobile app sign-in for{" "}
              {currentCliLoginAccountLabel(info)}. This creates a separate
              mobile app session and does not reuse your browser session.
            </>
          ) : (
            <>
              Approve {info?.elevated_login ? "an elevated" : "a"} CLI sign-in
              for {currentCliLoginAccountLabel(info)}. This creates a separate
              CLI session and does not reuse your browser session.
            </>
          )}
          {info?.elevated_login
            ? elevatedForText(info.requested_duration, "The terminal session")
            : ""}
          {loginHintLabel(info)}
        </Alert>
      )}
      {!approved && needsLongConfirm ? (
        <>
          <LongDurationConfirm
            value={requestedDuration}
            checked={longConfirmed}
            onChange={setLongConfirmed}
          />
          <div>
            In the verification dialog, choose{" "}
            {formatFreshAuthDuration(requestedDuration)}.
          </div>
        </>
      ) : undefined}
      {!approved ? (
        <ActionButton
          disabled={approving || (needsLongConfirm && !longConfirmed)}
          onClick={approve}
        >
          {approving
            ? "Approving..."
            : info?.elevated_login
              ? "Approve Elevated CLI Login" +
                forDurationSuffix(requestedDuration)
              : isMobileLogin(info)
                ? "Approve Mobile App Login"
                : "Approve CLI Login"}
        </ActionButton>
      ) : undefined}
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}

export function PublicCliElevateApprovalView({
  challengeId,
  isAuthenticated,
}: {
  challengeId: string;
  isAuthenticated: boolean;
}) {
  const [info, setInfo] = useState<ChallengeInfo | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [freshAuthStatus, setFreshAuthStatus] =
    useState<CliElevationFreshAuthStatus | null>(null);
  const [usePasskey, setUsePasskey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [longConfirmed, setLongConfirmed] = useState(false);
  const requestedDuration = safeDuration(info?.requested_duration);
  const needsLongConfirm = isLongFreshAuthDuration(requestedDuration);
  // A confirmation never carries over to another request.
  useEffect(() => {
    setLongConfirmed(false);
  }, [challengeId, info?.requested_duration]);
  const methods = freshAuthStatus?.methods ?? [];
  const requiresPassword = freshAuthStatus?.enabled === false;
  const passwordUnavailable =
    requiresPassword && freshAuthStatus.has_password === false;
  const canApprove =
    freshAuthStatus != null &&
    !passwordUnavailable &&
    (requiresPassword
      ? currentPassword.length > 0
      : usePasskey || code.trim().length > 0);
  const inferredMethod = inferSecondFactorInputMethod(code);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await postAuthApi<ChallengeInfo>({
          endpoint: "auth/cli/challenge-info",
          body: { challenge_id: challengeId },
        });
        if (!cancelled) {
          setInfo(next);
        }
        const status = await postAuthApi<CliElevationFreshAuthStatus>({
          endpoint: "auth/fresh-auth-status",
          body: {},
        });
        if (!cancelled) {
          const nextMethods = status.methods ?? [];
          setFreshAuthStatus(status);
          setUsePasskey(nextMethods.includes("passkey"));
        }
      } catch (err) {
        if (!cancelled) {
          setError(`${err}`);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [challengeId]);

  async function approve() {
    // Not only the button: Enter in the password or code field must not
    // approve a long request without the confirmation (the server checks it
    // too).
    if (needsLongConfirm && !longConfirmed) {
      setError(
        `Confirm that the terminal should stay elevated for ${formatFreshAuthDuration(requestedDuration)}.`,
      );
      return;
    }
    const confirmed = needsLongConfirm
      ? { confirmed_duration: requestedDuration }
      : {};
    setSaving(true);
    setError("");
    try {
      if (usePasskey) {
        await approveCliElevationWithPasskey({
          challenge_id: challengeId,
          current_password: "",
          ...confirmed,
        });
      } else {
        await postAuthApi({
          endpoint: "auth/cli/elevate/approve",
          body: {
            challenge_id: challengeId,
            current_password: requiresPassword ? currentPassword : "",
            method: code.trim() ? inferredMethod : undefined,
            code: code.trim() || undefined,
            ...confirmed,
          },
        });
      }
      setApproved(true);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    setError("");
    try {
      await signOutAuthSession();
      window.location.reload();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSigningOut(false);
    }
  }

  if (!isAuthenticated) {
    return (
      <div style={STACK_STYLE}>
        <Alert kind="info">
          Sign in as {requestedAccountLabel(info)} in this browser, then verify
          the CLI elevation request.
        </Alert>
      </div>
    );
  }

  if (isWrongSignedInAccount(info)) {
    return (
      <div style={STACK_STYLE}>
        {error ? <Alert kind="error">{error}</Alert> : undefined}
        <Alert kind="error">
          This browser is signed in as {currentAccountLabel(info)}.{" "}
          <InlineActionLink disabled={signingOut} onClick={signOut}>
            {signingOut ? "Signing out..." : "Sign out"}
          </InlineActionLink>{" "}
          and then sign in as {requestedAccountLabel(info)} to verify the CLI
          elevation request.
        </Alert>
        <Alert kind="info">
          If that is inconvenient, open this link in a new temporary incognito
          or private browser window and sign in there as{" "}
          {requestedAccountLabel(info)}.
        </Alert>
      </div>
    );
  }

  return (
    <div style={STACK_STYLE}>
      {error ? <Alert kind="error">{error}</Alert> : undefined}
      {approved ? (
        <Alert kind="success">
          CLI elevation approved. Return to your terminal and retry the command.
        </Alert>
      ) : (
        <Alert kind="info">
          Verify a CLI security action for {requestedAccountLabel(info)}.
          {info
            ? elevatedForText(info.requested_duration, "This terminal session")
            : ""}
        </Alert>
      )}
      {!approved ? (
        <>
          {freshAuthStatus == null ? (
            <Alert kind="info">Loading verification methods...</Alert>
          ) : undefined}
          {requiresPassword && !passwordUnavailable ? (
            <div style={FIELD_STYLE}>
              <div style={LABEL_STYLE}>Current password</div>
              <TextInput
                autoComplete="current-password"
                autoFocus
                placeholder="Enter your current password"
                type="password"
                value={currentPassword}
                onChange={setCurrentPassword}
                onPressEnter={approve}
              />
            </div>
          ) : undefined}
          {passwordUnavailable ? (
            <Alert kind="error">
              This account has no password or second factor available for CLI
              elevation.
            </Alert>
          ) : undefined}
          {methods.length > 0 ? (
            <div style={FIELD_STYLE}>
              <div style={LABEL_STYLE}>Second factor</div>
              {methods.includes("passkey") &&
              methods.some((method) => method !== "passkey") ? (
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button
                    style={{
                      ...BUTTON_STYLE,
                      width: "auto",
                      background: usePasskey ? COLORS.BLUE_D : COLORS.GRAY_L,
                    }}
                    onClick={() => setUsePasskey(true)}
                  >
                    Use passkey
                  </button>
                  <button
                    style={{
                      ...BUTTON_STYLE,
                      width: "auto",
                      background: !usePasskey ? COLORS.BLUE_D : COLORS.GRAY_L,
                    }}
                    onClick={() => setUsePasskey(false)}
                  >
                    Use code
                  </button>
                </div>
              ) : undefined}
              {usePasskey ? (
                <div style={{ color: "#666" }}>
                  Use your browser or device passkey prompt to approve CLI
                  elevation.
                </div>
              ) : (
                <>
                  <div style={{ color: "#666" }}>
                    Enter either the 6-digit authenticator code or one of your
                    recovery codes.
                  </div>
                  <TextInput
                    autoComplete="one-time-code"
                    placeholder={getSecondFactorPlaceholder(code)}
                    value={code}
                    onChange={setCode}
                    onPressEnter={approve}
                  />
                </>
              )}
            </div>
          ) : undefined}
          <LongDurationConfirm
            value={info?.requested_duration}
            checked={longConfirmed}
            onChange={setLongConfirmed}
          />
          <ActionButton
            disabled={
              saving || !canApprove || (needsLongConfirm && !longConfirmed)
            }
            onClick={approve}
          >
            {saving
              ? "Verifying..."
              : "Approve CLI Elevation" +
                forDurationSuffix(info?.requested_duration)}
          </ActionButton>
        </>
      ) : undefined}
    </div>
  );
}
