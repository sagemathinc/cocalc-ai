/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import api from "@cocalc/frontend/client/api";
import type { AuthView } from "@cocalc/frontend/auth/types";
import { appUrl } from "@cocalc/frontend/auth/util";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@cocalc/util/auth";
import {
  is_valid_email_address as isValidEmailAddress,
  len,
} from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";

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
  maxLength?: number;
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
      maxLength={props.maxLength}
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

export function PublicSignInForm({
  onNavigate,
  redirectToPath,
}: {
  onNavigate: (view: AuthView) => void;
  redirectToPath?: string | (() => string);
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");

  const canSubmit =
    isValidEmailAddress(email) && password.length > 0 && !signingIn;

  async function signIn() {
    if (!canSubmit) {
      return;
    }
    setError("");
    setSigningIn(true);
    try {
      await api("auth/sign-in", { email, password });
      const redirectTarget =
        typeof redirectToPath === "function"
          ? redirectToPath()
          : redirectToPath;
      window.location.href = redirectTarget ?? appUrl("app?sign-in");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div style={STACK_STYLE}>
      {error && <Alert kind="error">{error}</Alert>}
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Email address</div>
        <TextInput
          autoComplete="username"
          autoFocus
          placeholder="you@example.com"
          value={email}
          onChange={setEmail}
          onPressEnter={signIn}
        />
      </div>
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Password</div>
        <TextInput
          autoComplete="current-password"
          maxLength={MAX_PASSWORD_LENGTH}
          placeholder="Password"
          type="password"
          value={password}
          onChange={setPassword}
          onPressEnter={signIn}
        />
      </div>
      <ActionButton disabled={!canSubmit} onClick={signIn}>
        {signingIn ? "Signing In..." : "Sign In"}
      </ActionButton>
      <div style={LINK_ROW_STYLE}>
        <NavLink onClick={() => onNavigate("password-reset")}>
          Forgot password?
        </NavLink>
        <NavLink onClick={() => onNavigate("sign-up")}>
          Create an account
        </NavLink>
      </div>
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
  initialRequiresToken,
  onNavigate,
  redirectToPath,
}: {
  initialRequiresToken?: boolean;
  onNavigate: (view: AuthView) => void;
  redirectToPath?: string | (() => string);
}) {
  const [requiresToken, setRequiresToken] = useState(initialRequiresToken);
  const [registrationToken, setRegistrationToken] = useState(
    new URL(window.location.href).searchParams.get("registrationToken") ?? "",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [signingUp, setSigningUp] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const bootstrap = useMemo(
    () => new URL(window.location.href).searchParams.get("bootstrap") === "1",
    [],
  );

  useEffect(() => {
    setRequiresToken(initialRequiresToken);
  }, [initialRequiresToken]);

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

  const canSubmit = useMemo(() => {
    if (!isValidEmailAddress(email)) {
      return false;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return false;
    }
    if (!firstName.trim() || !lastName.trim()) {
      return false;
    }
    if (requiresToken && !registrationToken.trim()) {
      return false;
    }
    return !signingUp;
  }, [
    email,
    firstName,
    lastName,
    password,
    registrationToken,
    requiresToken,
    signingUp,
  ]);

  async function signUp() {
    if (!canSubmit) {
      return;
    }
    setIssues({});
    setError("");
    setSigningUp(true);
    try {
      const result = await api("auth/sign-up", {
        terms: true,
        email,
        password,
        firstName,
        lastName,
        registrationToken: registrationToken.trim(),
      });
      if (result?.issues && len(result.issues) > 0) {
        setIssues(result.issues);
        return;
      }
      const redirectTarget =
        typeof redirectToPath === "function"
          ? redirectToPath()
          : redirectToPath;
      window.location.href = redirectTarget ?? appUrl("app?sign-in");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSigningUp(false);
    }
  }

  const issueList = Object.values(issues).filter(Boolean);

  return (
    <div style={STACK_STYLE}>
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
            placeholder="Enter your registration token"
            value={registrationToken}
            onChange={setRegistrationToken}
          />
        </div>
      )}
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Email address</div>
        <TextInput
          autoComplete="username"
          autoFocus
          placeholder="you@example.com"
          value={email}
          onChange={setEmail}
          onPressEnter={signUp}
        />
      </div>
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Password</div>
        <TextInput
          autoComplete="new-password"
          maxLength={MAX_PASSWORD_LENGTH}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          type="password"
          value={password}
          onChange={setPassword}
          onPressEnter={signUp}
        />
      </div>
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>First name</div>
        <TextInput
          placeholder="First name"
          value={firstName}
          onChange={setFirstName}
          onPressEnter={signUp}
        />
      </div>
      <div style={FIELD_STYLE}>
        <div style={LABEL_STYLE}>Last name</div>
        <TextInput
          placeholder="Last name"
          value={lastName}
          onChange={setLastName}
          onPressEnter={signUp}
        />
      </div>
      <ActionButton disabled={!canSubmit} onClick={signUp}>
        {signingUp ? "Creating account..." : "Create account"}
      </ActionButton>
      <div style={{ textAlign: "center" }}>
        Already have an account?{" "}
        <NavLink onClick={() => onNavigate("sign-in")}>Sign in</NavLink>
      </div>
    </div>
  );
}
