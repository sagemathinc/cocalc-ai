/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Checkbox, Input, Modal, Space } from "antd";
import { React, useEffect, useState } from "@cocalc/frontend/app-framework";

import { postAuthApi } from "@cocalc/frontend/auth/api";
import {
  getSecondFactorPlaceholder,
  inferSecondFactorInputMethod,
} from "@cocalc/frontend/auth/second-factor-input";

type TwoFactorStatus = {
  enabled: boolean;
};

export function isFreshAuthRequiredError(err: unknown): boolean {
  const code = `${(err as any)?.code ?? ""}`.trim().toLowerCase();
  const message = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return code === "fresh_auth_required" || message.includes("fresh auth");
}

export function FreshAuthModal({
  open,
  onCancel,
  onSuccess,
}: {
  open: boolean;
  onCancel: () => void;
  onSuccess: () => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [extended, setExtended] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [factorEnabled, setFactorEnabled] = useState<boolean | null>(null);
  const inferredMethod = inferSecondFactorInputMethod(code);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      if (!open) {
        return;
      }
      setError("");
      setFactorEnabled(null);
      try {
        const status = await postAuthApi<TwoFactorStatus>({
          endpoint: "auth/2fa/status",
          body: {},
        });
        if (!cancelled) {
          setFactorEnabled(!!status?.enabled);
        }
      } catch (err) {
        if (!cancelled) {
          setError(`${err}`);
          setFactorEnabled(null);
        }
      }
    }
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (factorEnabled !== true || inferredMethod !== "totp") {
      setExtended(false);
    }
  }, [factorEnabled, inferredMethod]);

  async function submit() {
    setSaving(true);
    setError("");
    try {
      const requireSecondFactor = factorEnabled === true;
      await postAuthApi({
        endpoint: "auth/fresh-auth",
        body: {
          current_password: currentPassword,
          ...(requireSecondFactor
            ? { method: inferredMethod, code: code.trim() }
            : {}),
          duration: requireSecondFactor && extended ? "extended" : "default",
        },
      });
      await onSuccess();
      setCurrentPassword("");
      setCode("");
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
          (factorEnabled === true && code.trim().length === 0),
      }}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {error ? <Alert type="error" showIcon message={error} /> : undefined}
        {factorEnabled === false ? (
          <Alert
            type="info"
            showIcon
            message="This account does not have 2FA enabled. Only your current password is required."
          />
        ) : undefined}
        <div>
          <div>Current password</div>
          <Input.Password
            value={currentPassword}
            placeholder="Leave blank if this account has no password"
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
        {factorEnabled === true ? (
          <>
            <div>
              <div style={{ marginBottom: "8px" }}>Second factor</div>
              <Alert
                type="info"
                showIcon
                message="Enter either the 6-digit authenticator code or one of your recovery codes."
              />
            </div>
            <div>
              <Input
                value={code}
                autoComplete="one-time-code"
                placeholder={getSecondFactorPlaceholder(code)}
                onChange={(e) => setCode(e.target.value)}
                onPressEnter={submit}
              />
            </div>
          </>
        ) : undefined}
        <Checkbox
          checked={extended}
          disabled={factorEnabled !== true || inferredMethod !== "totp"}
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
  const [open, setOpen] = React.useState(false);
  const pendingActionRef = React.useRef<null | (() => Promise<void>)>(null);

  const cancelFreshAuth = React.useCallback(() => {
    pendingActionRef.current = null;
    setOpen(false);
  }, []);

  const runFreshAuthAction = React.useCallback(
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

  const handleFreshAuthSuccess = React.useCallback(async () => {
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
