/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Checkbox, Input, Modal, Space } from "antd";
import { React, useState } from "@cocalc/frontend/app-framework";

import { Button } from "@cocalc/frontend/antd-bootstrap";
import { postAuthApi } from "@cocalc/frontend/auth/api";

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
  const [method, setMethod] = useState<"totp" | "recovery_code">("totp");
  const [code, setCode] = useState("");
  const [extended, setExtended] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setSaving(true);
    setError("");
    try {
      await postAuthApi({
        endpoint: "auth/fresh-auth",
        body: {
          current_password: currentPassword,
          method,
          code,
          duration: extended ? "extended" : "default",
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
      okButtonProps={{ disabled: saving || code.trim().length === 0 }}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {error ? <Alert type="error" showIcon message={error} /> : undefined}
        <div>
          <div>Current password</div>
          <Input.Password
            value={currentPassword}
            placeholder="Leave blank if this account has no password"
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
        <div>
          <div style={{ marginBottom: "8px" }}>Second factor</div>
          <Space wrap>
            <Button
              bsStyle={method === "totp" ? "primary" : undefined}
              onClick={() => setMethod("totp")}
            >
              Authenticator code
            </Button>
            <Button
              bsStyle={method === "recovery_code" ? "primary" : undefined}
              onClick={() => setMethod("recovery_code")}
            >
              Recovery code
            </Button>
          </Space>
        </div>
        <div>
          <Input
            value={code}
            autoComplete="one-time-code"
            placeholder={method === "totp" ? "123456" : "ABCD-EFGH-IJKL"}
            onChange={(e) => setCode(e.target.value)}
            onPressEnter={submit}
          />
        </div>
        <Checkbox
          checked={extended}
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
