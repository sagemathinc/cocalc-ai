/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Checkbox, Input, Modal, QRCode, Space, Typography } from "antd";
import { useEffect, useState } from "react";

import { Button } from "@cocalc/frontend/antd-bootstrap";
import { SettingBox } from "@cocalc/frontend/components";
import { postAuthApi } from "@cocalc/frontend/auth/api";

type TwoFactorStatus = {
  enabled: boolean;
  factor_type?: string | null;
  label?: string | null;
  last_used_at?: string | Date | null;
  pending_setup_count?: number;
  fresh_auth_until?: string | Date | null;
};

type SetupState = {
  factor_id: string;
  secret: string;
  issuer: string;
  account_label: string;
  otpauth_url: string;
};

function RecoveryCodesBlock({ codes }: { codes: string[] }) {
  if (!codes.length) return null;
  return (
    <Alert
      type="warning"
      showIcon
      message="Save these recovery codes now. Each code can be used once."
      description={
        <pre style={{ margin: "12px 0 0 0", whiteSpace: "pre-wrap" }}>
          {codes.join("\n")}
        </pre>
      }
    />
  );
}

function FreshAuthModal({
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

export default function TwoFactorAuthSetting() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [freshAction, setFreshAction] = useState<"disable" | "rotate" | null>(
    null,
  );

  async function loadStatus() {
    setLoading(true);
    setError("");
    try {
      setStatus(
        await postAuthApi<TwoFactorStatus>({
          endpoint: "auth/2fa/status",
          body: {},
        }),
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function startSetup() {
    setBusy(true);
    setError("");
    try {
      setSetup(
        await postAuthApi<SetupState>({
          endpoint: "auth/2fa/setup/start",
          body: {},
        }),
      );
      setSetupCode("");
      setRecoveryCodes([]);
      await loadStatus();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup() {
    if (!setup) return;
    setBusy(true);
    setError("");
    try {
      const result = await postAuthApi<{ recovery_codes: string[] }>({
        endpoint: "auth/2fa/setup/confirm",
        body: {
          factor_id: setup.factor_id,
          code: setupCode,
        },
      });
      setRecoveryCodes(result.recovery_codes ?? []);
      setSetup(null);
      setSetupCode("");
      await loadStatus();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function rotateRecoveryCodes() {
    const result = await postAuthApi<{ recovery_codes: string[] }>({
      endpoint: "auth/2fa/recovery-codes/rotate",
      body: {},
    });
    setRecoveryCodes(result.recovery_codes ?? []);
    await loadStatus();
  }

  async function disableTwoFactor() {
    await postAuthApi({
      endpoint: "auth/2fa/disable",
      body: {},
    });
    setRecoveryCodes([]);
    setSetup(null);
    await loadStatus();
  }

  return (
    <SettingBox title="Two-Factor Authentication" icon="lock">
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {error ? <Alert type="error" showIcon message={error} /> : undefined}
        {loading ? (
          <Alert type="info" showIcon message="Loading security status..." />
        ) : undefined}
        {status && !status.enabled && !setup ? (
          <Alert
            type="info"
            showIcon
            message="Two-factor authentication is not enabled."
            description="Use an authenticator app plus recovery codes to protect this account."
          />
        ) : undefined}
        {status?.enabled ? (
          <Alert
            type="success"
            showIcon
            message="Two-factor authentication is enabled."
            description={
              <Space direction="vertical" size="small">
                <Typography.Text>
                  Last used:{" "}
                  {status.last_used_at
                    ? new Date(status.last_used_at).toLocaleString()
                    : "never"}
                </Typography.Text>
                <Typography.Text>
                  Fresh auth until:{" "}
                  {status.fresh_auth_until
                    ? new Date(status.fresh_auth_until).toLocaleString()
                    : "not currently elevated"}
                </Typography.Text>
              </Space>
            }
          />
        ) : undefined}
        {setup ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              message="Scan this QR code with your authenticator app."
            />
            <div style={{ display: "flex", justifyContent: "center" }}>
              <QRCode value={setup.otpauth_url} />
            </div>
            <Typography.Text copyable>{setup.secret}</Typography.Text>
            <Input
              value={setupCode}
              autoComplete="one-time-code"
              placeholder="Enter the 6-digit code from your authenticator app"
              onChange={(e) => setSetupCode(e.target.value)}
              onPressEnter={confirmSetup}
            />
            <Space wrap>
              <Button
                bsStyle="primary"
                disabled={busy || setupCode.trim().length === 0}
                onClick={confirmSetup}
              >
                {busy ? "Confirming..." : "Confirm setup"}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setSetup(null);
                  setSetupCode("");
                }}
              >
                Cancel
              </Button>
            </Space>
          </Space>
        ) : status?.enabled ? (
          <Space wrap>
            <Button onClick={() => setFreshAction("rotate")}>
              Rotate recovery codes
            </Button>
            <Button bsStyle="danger" onClick={() => setFreshAction("disable")}>
              Disable 2FA
            </Button>
          </Space>
        ) : (
          <Button bsStyle="primary" disabled={busy} onClick={startSetup}>
            {busy ? "Starting..." : "Set up authenticator app"}
          </Button>
        )}
        <RecoveryCodesBlock codes={recoveryCodes} />
      </Space>
      <FreshAuthModal
        open={freshAction != null}
        onCancel={() => setFreshAction(null)}
        onSuccess={async () => {
          if (freshAction === "rotate") {
            await rotateRecoveryCodes();
          } else if (freshAction === "disable") {
            await disableTwoFactor();
          }
        }}
      />
    </SettingBox>
  );
}
