/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Checkbox, Input, Modal, Radio, Space } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  postAuthApi,
  startGoogleFreshAuth,
  type SecondFactorMethod,
} from "@cocalc/frontend/auth/api";
import { freshAuthWithPasskey } from "@cocalc/frontend/auth/passkeys";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import {
  getSecondFactorPlaceholder,
  inferSecondFactorInputMethod,
} from "@cocalc/frontend/auth/second-factor-input";
import GoogleLogo from "@cocalc/frontend/components/google-logo";
import { COLORS } from "@cocalc/util/theme";

type FreshAuthStatus = {
  mode: "account" | "impersonation_actor";
  enabled: boolean;
  methods?: SecondFactorMethod[];
  has_password?: boolean;
  sso_methods?: { provider: "google"; display: string }[];
  email_address?: string | null;
  actor_name?: string | null;
  actor_email_address?: string | null;
};

type EmailFreshAuthChallenge = {
  challenge_id: string;
  purpose: "email_fresh_auth";
  state: string;
  masked_email: string;
  resend_available_at: string;
};

export type FreshAuthActionRunner = (
  action: () => Promise<void>,
) => Promise<boolean>;

type PendingFreshAuthAction = {
  action: () => Promise<void>;
  resolve: (completed: boolean) => void;
  reject: (err: unknown) => void;
};

const FRESH_AUTH_MODAL_Z_INDEX = 3000;

const GOOGLE_FRESH_AUTH_BUTTON_STYLE = {
  background: "white",
  borderColor: "#ccc",
  boxShadow: "none",
  color: COLORS.GRAY_D,
  fontWeight: 600,
} as const;

const GOOGLE_FRESH_AUTH_BUTTON_CONTENT_STYLE = {
  alignItems: "center",
  display: "inline-flex",
  gap: "8px",
} as const;

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
  defaultExtended = false,
  open,
  onCancel,
  onSuccess,
  origin,
}: {
  defaultExtended?: boolean;
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
  const [emailChallenge, setEmailChallenge] =
    useState<EmailFreshAuthChallenge | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [emailProofComplete, setEmailProofComplete] = useState(false);
  const emailCompletingRef = useRef(false);
  const inferredMethod = inferSecondFactorInputMethod(code);
  const expectedEmailAddress = getFreshAuthEmail(status);
  const authOrigin = origin ?? getControlPlaneOrigin();
  const googleFreshAuth = status?.sso_methods?.find(
    (method) => method.provider === "google",
  );
  const canUseGoogleFreshAuth =
    status?.mode === "account" && googleFreshAuth != null;
  const hasPassword = status?.has_password !== false;
  const showPassword = factorEnabled === false && hasPassword;
  const emailAuthAvailable =
    status?.mode === "account" &&
    status.has_password === false &&
    expectedEmailAddress.length > 0;
  const emailAuthPending = emailAuthAvailable && !emailProofComplete;
  const canUseSecondFactor =
    factorEnabled === true && (usePasskey || inferredMethod === "totp");
  const canUseExtended = canUseGoogleFreshAuth || canUseSecondFactor;
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
        setEmailChallenge(null);
        setEmailCode("");
        setEmailProofComplete(false);
        return;
      }
      setError("");
      setFactorEnabled(null);
      try {
        const next = await postAuthApi<FreshAuthStatus>({
          endpoint: "auth/fresh-auth-status",
          origin: authOrigin,
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
  }, [authOrigin, open]);

  useEffect(() => {
    if (!emailChallenge || emailProofComplete || !open) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const next = await postAuthApi<EmailFreshAuthChallenge>({
            endpoint: "auth/email/status",
            origin: authOrigin,
            body: { challenge_id: emailChallenge.challenge_id },
          });
          if (cancelled) return;
          setEmailChallenge(next);
          if (next.state === "email_proved") {
            await finishEmailProof(next.challenge_id);
          }
        } catch {
          // Polling is best effort; entering the code reports actionable errors.
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    authOrigin,
    emailChallenge?.challenge_id,
    emailProofComplete,
    factorEnabled,
    open,
  ]);

  useEffect(() => {
    if (!canUseExtended) {
      setExtended(false);
    }
  }, [canUseExtended]);

  useEffect(() => {
    if (open && defaultExtended && canUseExtended) {
      setExtended(true);
    }
  }, [canUseExtended, defaultExtended, open]);

  function getExpectedPopupOrigin(): string {
    if (authOrigin) {
      return new URL(authOrigin).origin;
    }
    return window.location.origin;
  }

  async function verifyWithGoogle() {
    if (emailMismatch) {
      setError(
        "Use the signed-in account email address for this confirmation.",
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { url } = await startGoogleFreshAuth({
        duration: extended ? "extended" : "default",
        origin: authOrigin,
      });
      const expectedOrigin = getExpectedPopupOrigin();
      await new Promise<void>((resolve, reject) => {
        const popup = window.open(
          url,
          "cocalc-google-fresh-auth",
          "popup,width=520,height=700",
        );
        if (popup == null) {
          reject(new Error("Allow popups to verify with Google."));
          return;
        }
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("Google verification timed out."));
        }, 5 * 60_000);
        function cleanup() {
          window.clearTimeout(timeout);
          window.removeEventListener("message", handleMessage);
        }
        function handleMessage(event: MessageEvent) {
          if (event.origin !== expectedOrigin) {
            return;
          }
          const data = event.data;
          if (data?.type !== "cocalc:google-fresh-auth") {
            return;
          }
          cleanup();
          if (data.ok === true) {
            resolve();
          } else {
            reject(
              new Error(`${data?.error ?? "Google verification failed."}`),
            );
          }
        }
        window.addEventListener("message", handleMessage);
      });
      await onSuccess();
      setCurrentPassword("");
      setCode("");
      setUsePasskey(false);
      setExtended(false);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function finishEmailProof(challengeId: string): Promise<void> {
    if (emailCompletingRef.current) return;
    emailCompletingRef.current = true;
    try {
      setEmailProofComplete(true);
      if (factorEnabled === false) {
        await postAuthApi({
          endpoint: "auth/email/fresh-finalize",
          origin: authOrigin,
          body: { challenge_id: challengeId },
        });
        await onSuccess();
        resetEmailFreshAuth();
      }
    } catch (err) {
      setEmailProofComplete(false);
      setError(`${err}`);
    } finally {
      emailCompletingRef.current = false;
    }
  }

  function resetEmailFreshAuth(): void {
    setEmailChallenge(null);
    setEmailCode("");
    setEmailProofComplete(false);
  }

  async function submitEmailFreshAuth(): Promise<void> {
    if (emailMismatch || saving) return;
    setSaving(true);
    setError("");
    try {
      if (!emailChallenge) {
        const challenge = await postAuthApi<EmailFreshAuthChallenge>({
          endpoint: "auth/email/fresh-start",
          origin: authOrigin,
          body: {},
        });
        setEmailChallenge(challenge);
        setEmailCode("");
        return;
      }
      if (!/^\d{6}$/.test(emailCode)) {
        throw new Error("Enter the six-digit code from your email.");
      }
      const proved = await postAuthApi<EmailFreshAuthChallenge>({
        endpoint: "auth/email/fresh-redeem-code",
        origin: authOrigin,
        body: {
          challenge_id: emailChallenge.challenge_id,
          code: emailCode,
        },
      });
      setEmailChallenge(proved);
      await finishEmailProof(proved.challenge_id);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    if (emailAuthPending) {
      await submitEmailFreshAuth();
      return;
    }
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
          origin: authOrigin,
        });
      } else {
        await postAuthApi({
          endpoint: "auth/fresh-auth",
          origin: authOrigin,
          body: {
            current_password: currentPassword,
            ...(requireSecondFactor
              ? { method: inferredMethod, code: code.trim() }
              : {}),
            duration: requireSecondFactor && extended ? "extended" : "default",
          },
        });
      }
      if (emailChallenge && emailProofComplete) {
        await postAuthApi({
          endpoint: "auth/email/fresh-finalize",
          origin: authOrigin,
          body: { challenge_id: emailChallenge.challenge_id },
        });
      }
      await onSuccess();
      setCurrentPassword("");
      setCode("");
      setUsePasskey(false);
      setExtended(false);
      resetEmailFreshAuth();
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
      okText={
        saving
          ? "Verifying..."
          : emailAuthPending && !emailChallenge
            ? "Email me a code"
            : "Verify"
      }
      zIndex={FRESH_AUTH_MODAL_Z_INDEX}
      okButtonProps={{
        disabled:
          saving ||
          factorEnabled == null ||
          emailMismatch ||
          (emailAuthPending &&
            emailChallenge != null &&
            !/^\d{6}$/.test(emailCode)) ||
          (showPassword && currentPassword.length === 0) ||
          (factorEnabled === false &&
            !showPassword &&
            !emailAuthAvailable &&
            !canUseGoogleFreshAuth) ||
          (factorEnabled === true &&
            !emailAuthPending &&
            !usePasskey &&
            code.trim().length === 0),
      }}
    >
      <Space vertical size="middle" style={{ width: "100%" }}>
        {error ? <Alert type="error" showIcon title={error} /> : undefined}
        {status?.mode === "impersonation_actor" ? (
          <Alert
            type="warning"
            showIcon
            title={`You are verifying the admin account "${`${status.actor_name ?? ""}`.trim() || `${status.actor_email_address ?? ""}`.trim() || "unknown"}" while acting as this user.`}
          />
        ) : undefined}
        {factorEnabled === false ? (
          <Alert
            type="info"
            showIcon
            title={
              showPassword
                ? "This account does not have 2FA enabled. Verify with your current password or a linked sign-in provider."
                : "This account does not have a CoCalc password. Approve by email or use a linked sign-in provider."
            }
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
        {canUseGoogleFreshAuth ? (
          <Button
            block
            disabled={saving || factorEnabled == null || emailMismatch}
            style={GOOGLE_FRESH_AUTH_BUTTON_STYLE}
            onClick={verifyWithGoogle}
          >
            <span style={GOOGLE_FRESH_AUTH_BUTTON_CONTENT_STYLE}>
              <GoogleLogo size={18} />
              <span>Verify with {googleFreshAuth?.display ?? "Google"}</span>
            </span>
          </Button>
        ) : undefined}
        {emailAuthPending ? (
          <>
            <Alert
              type="info"
              showIcon
              title="Approve this action by email"
              description={
                emailChallenge
                  ? `We sent a six-digit code and approval link to ${emailChallenge.masked_email}.`
                  : `We will send a code and approval link to ${expectedEmailAddress}. Add a password after approval to make similar confirmations faster.`
              }
            />
            {emailChallenge ? (
              <Input
                aria-label="Six-digit email approval code"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                value={emailCode}
                onChange={(e) =>
                  setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                onPressEnter={submitEmailFreshAuth}
              />
            ) : undefined}
          </>
        ) : undefined}
        {showPassword ? (
          <div>
            <div>Current password</div>
            <Input.Password
              name="current-password"
              autoComplete="current-password"
              value={currentPassword}
              placeholder="Enter your current password"
              onChange={(e) => setCurrentPassword(e.target.value)}
              onPressEnter={submit}
            />
          </div>
        ) : undefined}
        {factorEnabled === true && !emailAuthPending ? (
          <>
            <div>
              <div style={{ marginBottom: "8px" }}>Second factor</div>
              <Space vertical size="small" style={{ width: "100%" }}>
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
                  title={
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
          disabled={!canUseExtended}
          onChange={(e) => setExtended(e.target.checked)}
        >
          Keep this verification active for 8 hours on this browser
        </Checkbox>
      </Space>
    </Modal>
  );
}

export function useFreshAuthAction({
  defaultExtended,
  origin,
}: { defaultExtended?: boolean; origin?: string } = {}) {
  // Frontend counterpart to backend requireFreshAuth checks. Any browser UI
  // action that can hit a fresh-auth-protected HTTP route or Conat RPC should
  // run the mutation through runFreshAuthAction and render FreshAuthModal with
  // freshAuthModalProps. Backend-only fresh-auth changes without this wiring
  // leave users with an opaque "fresh auth is required" error. Batch actions
  // that collect per-item failures must rethrow fresh-auth errors instead of
  // converting them into ordinary results, or this wrapper cannot open the
  // verification modal and retry the action.
  const [open, setOpen] = useState(false);
  const pendingActionsRef = useRef<PendingFreshAuthAction[]>([]);

  const cancelFreshAuth = useCallback(() => {
    const pending = pendingActionsRef.current.splice(0);
    for (const item of pending) {
      item.resolve(false);
    }
    setOpen(false);
  }, []);

  const runFreshAuthAction = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      // Resolve only after the protected action has completed. If fresh auth is
      // required, the promise stays pending while the user authenticates and
      // while the action is retried. The only false result is user cancellation.
      try {
        await action();
        return true;
      } catch (err) {
        if (!isFreshAuthRequiredError(err)) {
          throw err;
        }
        return await new Promise<boolean>((resolve, reject) => {
          pendingActionsRef.current.push({ action, resolve, reject });
          setOpen(true);
        });
      }
    },
    [],
  );

  const handleFreshAuthSuccess = useCallback(async () => {
    const pending = pendingActionsRef.current.splice(0);
    if (!pending.length) {
      setOpen(false);
      return;
    }
    setOpen(false);
    await Promise.all(
      pending.map(async (item) => {
        try {
          await item.action();
          item.resolve(true);
        } catch (err) {
          item.reject(err);
        }
      }),
    );
    if (pendingActionsRef.current.length) {
      setOpen(true);
    }
  }, []);

  return {
    runFreshAuthAction,
    freshAuthModalProps: {
      defaultExtended,
      open,
      origin,
      onCancel: cancelFreshAuth,
      onSuccess: handleFreshAuthSuccess,
    },
  };
}
