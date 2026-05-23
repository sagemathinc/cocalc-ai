/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Checkbox, Input, Modal, Radio, Space } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  postAuthApi,
  type SecondFactorMethod,
} from "@cocalc/frontend/auth/api";
import { freshAuthWithPasskey } from "@cocalc/frontend/auth/passkeys";
import {
  getSecondFactorPlaceholder,
  inferSecondFactorInputMethod,
} from "@cocalc/frontend/auth/second-factor-input";
import { COLORS } from "@cocalc/util/theme";

type FreshAuthStatus = {
  mode: "account" | "impersonation_actor";
  enabled: boolean;
  methods?: SecondFactorMethod[];
  email_address?: string | null;
  actor_name?: string | null;
  actor_email_address?: string | null;
};

function normalizeFreshAuthEmail(email: string): string {
  return `${email ?? ""}`.trim().toLowerCase();
}

function getFreshAuthEmail(status: FreshAuthStatus | null): string {
  if (status?.mode === "impersonation_actor") {
    return `${status.actor_email_address ?? ""}`.trim();
  }
  return `${status?.email_address ?? ""}`.trim();
}

export function isFreshAuthRequiredError(err: unknown): boolean {
  const code = `${(err as any)?.code ?? ""}`.trim().toLowerCase();
  const message = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return code === "fresh_auth_required" || message.includes("fresh auth");
}

export function FreshAuthModal({
  open,
  onCancel,
  onSuccess,
  origin,
}: {
  open: boolean;
  onCancel: () => void;
  onSuccess: () => Promise<void>;
  origin?: string;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [code, setCode] = useState("");
  const [usePasskey, setUsePasskey] = useState(false);
  const [extended, setExtended] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [factorEnabled, setFactorEnabled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<FreshAuthStatus | null>(null);
  const inferredMethod = inferSecondFactorInputMethod(code);
  const expectedEmailAddress = getFreshAuthEmail(status);
  const emailMismatch =
    expectedEmailAddress.length > 0 &&
    normalizeFreshAuthEmail(emailAddress) !==
      normalizeFreshAuthEmail(expectedEmailAddress);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      if (!open) {
        setStatus(null);
        setEmailAddress("");
        return;
      }
      setError("");
      setFactorEnabled(null);
      try {
        const next = await postAuthApi<FreshAuthStatus>({
          endpoint: "auth/fresh-auth-status",
          origin,
          body: {},
        });
        if (!cancelled) {
          setStatus(next);
          setEmailAddress(getFreshAuthEmail(next));
          setFactorEnabled(!!next?.enabled);
          setUsePasskey((next.methods ?? []).includes("passkey"));
        }
      } catch (err) {
        if (!cancelled) {
          setError(`${err}`);
          setStatus(null);
          setFactorEnabled(null);
        }
      }
    }
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [open, origin]);

  useEffect(() => {
    if (factorEnabled !== true || (!usePasskey && inferredMethod !== "totp")) {
      setExtended(false);
    }
  }, [factorEnabled, inferredMethod, usePasskey]);

  async function submit() {
    if (emailMismatch) {
      setError(
        "Use the signed-in account email address for this confirmation.",
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      const requireSecondFactor = factorEnabled === true;
      if (requireSecondFactor && usePasskey) {
        await freshAuthWithPasskey({
          duration: extended ? "extended" : "default",
          origin,
        });
      } else {
        await postAuthApi({
          endpoint: "auth/fresh-auth",
          origin,
          body: {
            current_password: currentPassword,
            ...(requireSecondFactor
              ? { method: inferredMethod, code: code.trim() }
              : {}),
            duration: requireSecondFactor && extended ? "extended" : "default",
          },
        });
      }
      await onSuccess();
      setCurrentPassword("");
      setCode("");
      setUsePasskey(false);
      setExtended(false);
      onCancel();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Confirm security action"
      onCancel={onCancel}
      onOk={submit}
      okText={saving ? "Verifying..." : "Verify"}
      okButtonProps={{
        disabled:
          saving ||
          factorEnabled == null ||
          emailMismatch ||
          (factorEnabled === true && !usePasskey && code.trim().length === 0),
      }}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {error ? <Alert type="error" showIcon message={error} /> : undefined}
        {status?.mode === "impersonation_actor" ? (
          <Alert
            type="warning"
            showIcon
            message={`You are verifying the admin account "${`${status.actor_name ?? ""}`.trim() || `${status.actor_email_address ?? ""}`.trim() || "unknown"}" while acting as this user.`}
          />
        ) : undefined}
        {factorEnabled === false ? (
          <Alert
            type="info"
            showIcon
            message="This account does not have 2FA enabled. Only your current password is required."
          />
        ) : undefined}
        <div>
          <div>Email address</div>
          <Input
            name="username"
            autoComplete="username"
            type="email"
            value={emailAddress}
            status={emailMismatch ? "error" : undefined}
            placeholder="Signed-in account email"
            onChange={(e) => setEmailAddress(e.target.value)}
            onPressEnter={submit}
          />
          {emailMismatch ? (
            <div style={{ color: COLORS.ANTD_RED, marginTop: "4px" }}>
              This must match the signed-in account email.
            </div>
          ) : undefined}
        </div>
        {factorEnabled === false ? (
          <div>
            <div>Current password</div>
            <Input.Password
              name="current-password"
              autoComplete="current-password"
              value={currentPassword}
              placeholder="Leave blank if this account has no password"
              onChange={(e) => setCurrentPassword(e.target.value)}
              onPressEnter={submit}
            />
          </div>
        ) : undefined}
        {factorEnabled === true ? (
          <>
            <div>
              <div style={{ marginBottom: "8px" }}>Second factor</div>
              <Space
                direction="vertical"
                size="small"
                style={{ width: "100%" }}
              >
                {(status?.methods ?? []).includes("passkey") &&
                (status?.methods ?? []).some(
                  (method) => method !== "passkey",
                ) ? (
                  <Radio.Group
                    value={usePasskey ? "passkey" : "code"}
                    optionType="button"
                    buttonStyle="solid"
                    onChange={(e) =>
                      setUsePasskey(e.target.value === "passkey")
                    }
                  >
                    <Radio.Button value="passkey">Use passkey</Radio.Button>
                    <Radio.Button value="code">Use code</Radio.Button>
                  </Radio.Group>
                ) : undefined}
                <Alert
                  type="info"
                  showIcon
                  message={
                    usePasskey
                      ? "Use your browser or device passkey prompt to verify this security action."
                      : "Enter either the 6-digit authenticator code or one of your recovery codes."
                  }
                />
              </Space>
            </div>
            {!usePasskey ? (
              <div>
                <Input
                  value={code}
                  autoComplete="one-time-code"
                  placeholder={getSecondFactorPlaceholder(code)}
                  onChange={(e) => setCode(e.target.value)}
                  onPressEnter={submit}
                />
              </div>
            ) : undefined}
          </>
        ) : undefined}
        <Checkbox
          checked={extended}
          disabled={
            factorEnabled !== true || (!usePasskey && inferredMethod !== "totp")
          }
          onChange={(e) => setExtended(e.target.checked)}
        >
          Keep this verification active for 8 hours on this browser
        </Checkbox>
      </Space>
    </Modal>
  );
}

export function useFreshAuthAction({
  onUnhandledError,
}: {
  onUnhandledError?: (err: unknown) => void;
} = {}) {
  // Frontend counterpart to backend requireFreshAuth checks. Any browser UI
  // action that can hit a fresh-auth-protected HTTP route or Conat RPC should
  // run the mutation through runFreshAuthAction and render FreshAuthModal with
  // freshAuthModalProps. Backend-only fresh-auth changes without this wiring
  // leave users with an opaque "fresh auth is required" error.
  const [open, setOpen] = useState(false);
  const pendingActionRef = useRef<null | (() => Promise<void>)>(null);

  const cancelFreshAuth = useCallback(() => {
    pendingActionRef.current = null;
    setOpen(false);
  }, []);

  const runFreshAuthAction = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (err) {
        if (!isFreshAuthRequiredError(err)) {
          throw err;
        }
        pendingActionRef.current = action;
        setOpen(true);
        return false;
      }
    },
    [],
  );

  const handleFreshAuthSuccess = useCallback(async () => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (!action) {
      return;
    }
    try {
      await action();
    } catch (err) {
      onUnhandledError?.(err);
      throw err;
    }
  }, [onUnhandledError]);

  return {
    runFreshAuthAction,
    freshAuthModalProps: {
      open,
      onCancel: cancelFreshAuth,
      onSuccess: handleFreshAuthSuccess,
    },
  };
}
