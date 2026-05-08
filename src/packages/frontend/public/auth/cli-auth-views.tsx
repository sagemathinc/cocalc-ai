/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { postAuthApi } from "@cocalc/frontend/auth/api";
import {
  getSecondFactorPlaceholder,
  inferSecondFactorInputMethod,
} from "@cocalc/frontend/auth/second-factor-input";
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

const ALERT_STYLE: CSSProperties = {
  borderRadius: "8px",
  padding: "10px 12px",
  fontSize: "14px",
} as const;

type ChallengeInfo = {
  challenge_id: string;
  kind: "login" | "elevate";
  account_id: string;
  email_address?: string | null;
  display_name?: string | null;
  current_account_id?: string | null;
  current_email_address?: string | null;
  current_display_name?: string | null;
  current_matches_account?: boolean | null;
  requested_duration?: "default" | "extended" | null;
  state: "pending" | "approved" | "redeemed" | "canceled";
  expires_at: string;
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

function currentAccountLabel(info: ChallengeInfo | null): string {
  return formatAccountIdentity({
    email_address: info?.current_email_address,
    display_name: info?.current_display_name,
    fallback: "another account",
  });
}

function isWrongSignedInAccount(info: ChallengeInfo | null): boolean {
  return info?.current_matches_account === false;
}

export function PublicCliLoginApprovalView({
  challengeId,
  isAuthenticated,
}: {
  challengeId: string;
  isAuthenticated: boolean;
}) {
  const [info, setInfo] = useState<ChallengeInfo | null>(null);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");

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
    setApproving(true);
    setError("");
    try {
      await postAuthApi({
        endpoint: "auth/cli/login/approve",
        body: { challenge_id: challengeId },
      });
      setApproved(true);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setApproving(false);
    }
  }

  if (!isAuthenticated) {
    return (
      <div style={STACK_STYLE}>
        <Alert kind="info">
          Sign in as {requestedAccountLabel(info)} in this browser, then approve
          the CLI login request.
        </Alert>
      </div>
    );
  }

  if (isWrongSignedInAccount(info)) {
    return (
      <div style={STACK_STYLE}>
        {error ? <Alert kind="error">{error}</Alert> : undefined}
        <Alert kind="error">
          This browser is signed in as {currentAccountLabel(info)}. Sign out,
          then sign in as {requestedAccountLabel(info)} and reload this page to
          approve the CLI login request.
        </Alert>
      </div>
    );
  }

  return (
    <div style={STACK_STYLE}>
      {error ? <Alert kind="error">{error}</Alert> : undefined}
      {approved ? (
        <Alert kind="success">
          CLI login approved. Return to your terminal to finish signing in.
        </Alert>
      ) : (
        <Alert kind="info">
          Approve a CLI sign-in for {requestedAccountLabel(info)}. This creates
          a separate CLI session and does not reuse your browser session.
        </Alert>
      )}
      {!approved ? (
        <ActionButton disabled={approving} onClick={approve}>
          {approving ? "Approving..." : "Approve CLI Login"}
        </ActionButton>
      ) : undefined}
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
  const [saving, setSaving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
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

  const allowExtended = useMemo(
    () => info?.requested_duration === "extended" && inferredMethod === "totp",
    [info?.requested_duration, inferredMethod],
  );

  async function approve() {
    setSaving(true);
    setError("");
    try {
      await postAuthApi({
        endpoint: "auth/cli/elevate/approve",
        body: {
          challenge_id: challengeId,
          current_password: currentPassword,
          method: code.trim() ? inferredMethod : undefined,
          code: code.trim() || undefined,
        },
      });
      setApproved(true);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
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
          This browser is signed in as {currentAccountLabel(info)}. Sign out,
          then sign in as {requestedAccountLabel(info)} and reload this page to
          verify the CLI elevation request.
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
          {allowExtended
            ? " This terminal session will stay elevated for 8 hours."
            : ""}
        </Alert>
      )}
      {!approved ? (
        <>
          <div style={FIELD_STYLE}>
            <div style={LABEL_STYLE}>Current password</div>
            <TextInput
              autoComplete="current-password"
              autoFocus
              placeholder="Leave blank if this account has no password"
              type="password"
              value={currentPassword}
              onChange={setCurrentPassword}
              onPressEnter={approve}
            />
          </div>
          <div style={FIELD_STYLE}>
            <div style={LABEL_STYLE}>Second factor</div>
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
          </div>
          <ActionButton disabled={saving} onClick={approve}>
            {saving ? "Verifying..." : "Approve CLI Elevation"}
          </ActionButton>
        </>
      ) : undefined}
    </div>
  );
}
