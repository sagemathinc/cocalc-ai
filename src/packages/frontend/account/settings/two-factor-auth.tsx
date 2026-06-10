/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Flex,
  Input,
  QRCode,
  Space,
  Typography,
} from "antd";
import { useEffect, useState } from "react";

import {
  FreshAuthModal,
  isFreshAuthRequiredError,
} from "@cocalc/frontend/auth/fresh-auth";
import { registerPasskey } from "@cocalc/frontend/auth/passkeys";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { SettingBox } from "@cocalc/frontend/components";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { postAuthApi } from "@cocalc/frontend/auth/api";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";

type PasskeyStatus = {
  id: string;
  label: string;
  credential_id: string;
  created?: string | Date | null;
  activated_at?: string | Date | null;
  last_used_at?: string | Date | null;
  transports?: string[];
  backed_up?: boolean;
  device_type?: string;
};

type TwoFactorStatus = {
  enabled: boolean;
  factor_type?: string | null;
  label?: string | null;
  last_used_at?: string | Date | null;
  passkeys?: PasskeyStatus[];
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
  const text = codes.join("\n");
  return (
    <Alert
      type="warning"
      showIcon
      title="Save these recovery codes now. Each code can be used once."
      description={
        <Flex vertical gap="small">
          <div>
            <CopyButton value={text} />
          </div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{text}</pre>
        </Flex>
      }
    />
  );
}

interface Props {
  showHeader?: boolean;
}

export default function TwoFactorAuthSetting({ showHeader = true }: Props) {
  const authApiOrigin = getControlPlaneOrigin();
  const rawImpersonation = useTypedRedux("account", "impersonation") as any;
  const impersonation =
    rawImpersonation?.toJS?.() ?? rawImpersonation ?? undefined;
  const isImpersonating = impersonation?.active === true;
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [renamePasskeyId, setRenamePasskeyId] = useState("");
  const [renameLabel, setRenameLabel] = useState("");
  const [freshAction, setFreshAction] = useState<
    | { type: "setup-totp" }
    | { type: "add-passkey" }
    | { type: "disable-passkey"; factor_id: string }
    | { type: "rename-passkey"; factor_id: string; label: string }
    | { type: "disable" }
    | { type: "rotate" }
    | null
  >(null);
  const hasAuthenticatorApp = status?.factor_type === "totp";

  async function loadStatus() {
    setLoading(true);
    setError("");
    try {
      setStatus(
        await postAuthApi<TwoFactorStatus>({
          endpoint: "auth/2fa/status",
          origin: authApiOrigin,
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
          origin: authApiOrigin,
          body: {},
        }),
      );
      setSetupCode("");
      setRecoveryCodes([]);
      await loadStatus();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function startSetupWithFreshAuthFallback() {
    try {
      await startSetup();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        setError("");
        setFreshAction({ type: "setup-totp" });
      }
    }
  }

  async function confirmSetup() {
    if (!setup) return;
    setBusy(true);
    setError("");
    try {
      const result = await postAuthApi<{ recovery_codes: string[] }>({
        endpoint: "auth/2fa/setup/confirm",
        origin: authApiOrigin,
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
      origin: authApiOrigin,
      body: {},
    });
    setRecoveryCodes(result.recovery_codes ?? []);
    await loadStatus();
  }

  async function addPasskey() {
    const result = await registerPasskey({ origin: authApiOrigin });
    setRecoveryCodes(result.recovery_codes ?? []);
    await loadStatus();
  }

  async function disablePasskey(factor_id: string) {
    await postAuthApi({
      endpoint: "auth/2fa/passkeys/disable",
      origin: authApiOrigin,
      body: { factor_id },
    });
    await loadStatus();
  }

  async function renamePasskey(factor_id: string, label: string) {
    setBusy(true);
    setError("");
    try {
      await postAuthApi({
        endpoint: "auth/2fa/passkeys/rename",
        origin: authApiOrigin,
        body: { factor_id, label },
      });
      setRenamePasskeyId("");
      setRenameLabel("");
      await loadStatus();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  async function disableTwoFactor() {
    await postAuthApi({
      endpoint: "auth/2fa/disable",
      origin: authApiOrigin,
      body: {},
    });
    setRecoveryCodes([]);
    setSetup(null);
    await loadStatus();
  }

  const content = (
    <>
      <Flex vertical gap="middle">
        {error ? <Alert type="error" showIcon title={error} /> : undefined}
        {loading ? (
          <Alert type="info" showIcon title="Loading security status..." />
        ) : undefined}
        {isImpersonating ? (
          <Alert
            type="warning"
            showIcon
            title="Two-factor settings are unavailable while impersonating this account."
            description="End impersonation and sign in directly as the user to manage their security settings."
          />
        ) : undefined}
        {status && !status.enabled && !setup ? (
          <Alert
            type="info"
            showIcon
            title="Two-factor authentication is not enabled."
            description="Use an authenticator app plus recovery codes to protect this account."
          />
        ) : undefined}
        {status?.enabled ? (
          <Alert
            type="success"
            showIcon
            title="Two-factor authentication is enabled."
            description={
              <Flex vertical gap="small">
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
              </Flex>
            }
          />
        ) : undefined}
        {status?.passkeys?.length ? (
          <Flex vertical gap="small">
            <Typography.Title level={5} style={{ margin: 0 }}>
              Passkeys
            </Typography.Title>
            {status.passkeys.map((passkey) => (
              <Card key={passkey.id} size="small">
                <Flex vertical gap="small">
                  {renamePasskeyId === passkey.id ? (
                    <Space.Compact style={{ width: "100%" }}>
                      <Input
                        value={renameLabel}
                        maxLength={128}
                        onChange={(e) => setRenameLabel(e.target.value)}
                        onPressEnter={() =>
                          setFreshAction({
                            type: "rename-passkey",
                            factor_id: passkey.id,
                            label: renameLabel,
                          })
                        }
                      />
                      <Button
                        type="primary"
                        disabled={busy || renameLabel.trim().length === 0}
                        onClick={() =>
                          setFreshAction({
                            type: "rename-passkey",
                            factor_id: passkey.id,
                            label: renameLabel,
                          })
                        }
                      >
                        Save
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setRenamePasskeyId("");
                          setRenameLabel("");
                        }}
                      >
                        Cancel
                      </Button>
                    </Space.Compact>
                  ) : (
                    <Typography.Text strong>{passkey.label}</Typography.Text>
                  )}
                  <Typography.Text type="secondary">
                    Created:{" "}
                    {passkey.created
                      ? new Date(passkey.created).toLocaleString()
                      : "unknown"}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    Last used:{" "}
                    {passkey.last_used_at
                      ? new Date(passkey.last_used_at).toLocaleString()
                      : "never"}
                  </Typography.Text>
                  <div>
                    <Space wrap>
                      <Button
                        disabled={isImpersonating || busy}
                        onClick={() => {
                          setRenamePasskeyId(passkey.id);
                          setRenameLabel(passkey.label);
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        danger
                        disabled={isImpersonating}
                        onClick={() =>
                          setFreshAction({
                            type: "disable-passkey",
                            factor_id: passkey.id,
                          })
                        }
                      >
                        Disable passkey
                      </Button>
                    </Space>
                  </div>
                </Flex>
              </Card>
            ))}
          </Flex>
        ) : undefined}
        {isImpersonating ? null : setup ? (
          <Flex vertical gap="middle">
            <Alert
              type="info"
              showIcon
              title="Scan this QR code with your authenticator app."
            />
            <Flex justify="center">
              <QRCode value={setup.otpauth_url} />
            </Flex>
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
                type="primary"
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
          </Flex>
        ) : status?.enabled ? (
          <Space wrap>
            {!hasAuthenticatorApp ? (
              <Button
                type="primary"
                disabled={busy}
                onClick={startSetupWithFreshAuthFallback}
              >
                {busy ? "Starting..." : "Set up authenticator app"}
              </Button>
            ) : undefined}
            <Button onClick={() => setFreshAction({ type: "add-passkey" })}>
              Add passkey
            </Button>
            <Button onClick={() => setFreshAction({ type: "rotate" })}>
              Rotate recovery codes
            </Button>
            {status.passkeys?.length ? undefined : (
              <Button
                danger
                onClick={() => setFreshAction({ type: "disable" })}
              >
                Disable 2FA
              </Button>
            )}
          </Space>
        ) : (
          <Space wrap>
            <Button
              type="primary"
              disabled={busy}
              onClick={() => setFreshAction({ type: "setup-totp" })}
            >
              {busy ? "Starting..." : "Set up authenticator app"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => setFreshAction({ type: "add-passkey" })}
            >
              Add passkey
            </Button>
          </Space>
        )}
        <RecoveryCodesBlock codes={recoveryCodes} />
      </Flex>
      <FreshAuthModal
        origin={authApiOrigin}
        open={freshAction != null && !isImpersonating}
        onCancel={() => setFreshAction(null)}
        onSuccess={async () => {
          if (freshAction?.type === "setup-totp") {
            await startSetup();
          } else if (freshAction?.type === "add-passkey") {
            await addPasskey();
          } else if (freshAction?.type === "disable-passkey") {
            await disablePasskey(freshAction.factor_id);
          } else if (freshAction?.type === "rename-passkey") {
            await renamePasskey(freshAction.factor_id, freshAction.label);
          } else if (freshAction?.type === "rotate") {
            await rotateRecoveryCodes();
          } else if (freshAction?.type === "disable") {
            await disableTwoFactor();
          }
        }}
      />
    </>
  );

  if (!showHeader) {
    return content;
  }

  return (
    <SettingBox title="Two-Factor Authentication" icon="lock">
      {content}
    </SettingBox>
  );
}
