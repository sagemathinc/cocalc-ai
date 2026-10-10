/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Input,
  Modal,
  Space,
  Spin,
  Typography,
  theme,
} from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

type LoginStatus = {
  id: string;
  state: string;
  verificationUrl?: string;
  credentialId?: string;
  error?: string;
};

// Sign-in runs on the project's host. A project on a host that is gone (or
// not yet assigned) cannot be routed; retrying the same project will not help.
export function isProjectHostUnavailable(error: string): boolean {
  return /host routing info unavailable|unable to route .* to project-host/i.test(
    error,
  );
}

export function claudeSignInErrorMessage(error: string): string {
  return isProjectHostUnavailable(error)
    ? "This project's server is not available. Select a different project, or create a new one, and try again."
    : `Claude sign-in error: ${error}`;
}

// Claude's authentication code is "<code>#<state>"; the CLI rejects anything
// else, so say so before submitting.
export function looksLikeClaudeCode(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,}#[A-Za-z0-9_-]{8,}$/.test(value.trim());
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <div style={{ display: "flex", gap: 12, minWidth: 0 }}>
      <div
        aria-hidden
        style={{
          flex: "none",
          width: 24,
          height: 24,
          borderRadius: 12,
          background: token.colorPrimary,
          color: token.colorWhite,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {number}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Typography.Text strong>{title}</Typography.Text>
        <div style={{ marginTop: 8 }}>{children}</div>
      </div>
    </div>
  );
}

export function ClaudeSubscriptionConnect({
  projectId,
  disabled,
  onConnected,
  hasConnection = false,
  compact = false,
  modal = false,
  reconnectCredentialId,
  reconnectOnly = false,
  links = false,
  leadingActions,
  trailingActions,
  openRequested = false,
  onOpenRequestHandled,
}: {
  projectId: string;
  // Starts sign-in as if "Connect Claude Pro/Max" was clicked (e.g. from a
  // send button that needs a connection first), once enabled; the caller
  // clears the request in onOpenRequestHandled.
  openRequested?: boolean;
  onOpenRequestHandled?: () => void;
  // Offer only "Reconnect Claude" (e.g. when a turn failed on expired sign-in).
  reconnectOnly?: boolean;
  disabled?: boolean;
  hasConnection?: boolean;
  compact?: boolean;
  modal?: boolean;
  reconnectCredentialId?: string;
  // Account actions as one row of small links (settings panels), with the
  // caller's own actions before and after Reconnect.
  links?: boolean;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  onConnected: (credentialId: string) => Promise<void> | void;
}) {
  const [login, setLogin] = useState<LoginStatus>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const [error, setError] = useState("");
  // A code that could not be submitted stays editable for another try.
  const [codeError, setCodeError] = useState("");
  const [open, setOpen] = useState(false);
  // Briefly confirm success after the sign-in panel closes.
  const [justConnected, setJustConnected] = useState(false);
  useEffect(() => {
    if (!justConnected) return;
    const timer = setTimeout(() => setJustConnected(false), 8000);
    return () => clearTimeout(timer);
  }, [justConnected]);
  const attempt = useRef(0);
  const pendingLogin = useRef<{ project_id: string; id: string } | undefined>(
    undefined,
  );
  const connected = useEffectEvent(onConnected);
  useEffect(
    () => () => {
      attempt.current++;
      const pending = pendingLogin.current;
      pendingLogin.current = undefined;
      if (pending) {
        // Navigation must not leave a host-side sign-in blocking the next try.
        void webapp_client.conat_client.hub.projects
          .claudeSubscriptionLoginCancel(pending)
          .catch(() => {});
      }
    },
    [],
  );
  const start = async (credentialId?: string) => {
    const started = ++attempt.current;
    setBusy(true);
    setLogin(undefined);
    setSubmitting(false);
    setError("");
    setCodeError("");
    setCode("");
    setCodeSubmitted(false);
    try {
      const next =
        await webapp_client.conat_client.hub.projects.claudeSubscriptionLoginStart(
          {
            project_id: projectId,
            ...(credentialId ? { credential_id: credentialId } : {}),
          },
        );
      if (started !== attempt.current) {
        if (next.state === "pending" || next.state === "verifying") {
          await webapp_client.conat_client.hub.projects.claudeSubscriptionLoginCancel(
            { project_id: projectId, id: next.id },
          );
        }
        return;
      }
      pendingLogin.current =
        next.state === "pending" || next.state === "verifying"
          ? { project_id: projectId, id: next.id }
          : undefined;
      setLogin(next);
    } catch (err) {
      if (started === attempt.current) setError(`${err}`);
    } finally {
      if (started === attempt.current) setBusy(false);
    }
  };
  const cancel = async () => {
    const cancelled = ++attempt.current;
    const pending = pendingLogin.current;
    pendingLogin.current = undefined;
    setBusy(false);
    setSubmitting(false);
    setOpen(false);
    setLogin(undefined);
    setCode("");
    setCodeSubmitted(false);
    if (!pending) return;
    try {
      await webapp_client.conat_client.hub.projects.claudeSubscriptionLoginCancel(
        pending,
      );
    } catch (err) {
      if (cancelled === attempt.current) {
        pendingLogin.current = pending;
        setError(`Unable to cancel sign-in: ${err}`);
        setLogin(login);
        if (modal) setOpen(true);
      }
    }
  };
  const signingIn =
    busy || login?.state === "pending" || login?.state === "verifying";
  useEffect(() => {
    if (!openRequested || disabled) return;
    onOpenRequestHandled?.();
    if (reconnectOnly || signingIn) return;
    if (modal) setOpen(true);
    void start();
  }, [openRequested, disabled]);
  const { token } = theme.useToken();
  const submitCode = async (value: string) => {
    if (!login || submitting || codeSubmitted) return;
    const started = attempt.current;
    setSubmitting(true);
    setCodeError("");
    try {
      await webapp_client.conat_client.hub.projects.claudeSubscriptionLoginSubmitCode(
        { project_id: projectId, id: login.id, code: value.trim() },
      );
      if (started !== attempt.current) return;
      setCode("");
      setCodeSubmitted(true);
    } catch (err) {
      if (started === attempt.current)
        setCodeError(`${err}`.replace(/^(?:Error:\s*)+/, ""));
    } finally {
      if (started === attempt.current) setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!login || (login.state !== "pending" && login.state !== "verifying"))
      return;
    let active = true;
    let completed = false;
    const started = attempt.current;
    const timer = setInterval(() => {
      void webapp_client.conat_client.hub.projects
        .claudeSubscriptionLoginStatus({ project_id: projectId, id: login.id })
        .then(async (next) => {
          if (!active || started !== attempt.current) return;
          if (next.state !== "pending" && next.state !== "verifying") {
            pendingLogin.current = undefined;
          }
          if (next.state === "completed" && next.credentialId && !completed) {
            completed = true;
            await connected(next.credentialId);
            if (active && started === attempt.current) {
              // Done: close the sign-in rather than leave it on screen.
              setOpen(false);
              setLogin(undefined);
              setJustConnected(true);
            }
            return;
          }
          if (active && started === attempt.current) setLogin(next);
        })
        .catch((err) => {
          if (active && started === attempt.current) setError(`${err}`);
        });
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [login?.id, login?.state, projectId]);

  const active = busy || !!login || !!error;
  const connecting =
    submitting || codeSubmitted || login?.state === "verifying";
  // Terminal: the sign-in itself failed or never started.
  const failed = login?.state === "failed" || (!!error && !login);
  const codeReady = looksLikeClaudeCode(code);
  const signIn = active && (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        ...(modal
          ? {}
          : {
              boxSizing: "border-box",
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusLG,
              padding: 16,
              background: token.colorBgContainer,
            }),
      }}
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        {!modal && (
          <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
            Connect your Claude subscription
          </Typography.Text>
        )}
        <Typography.Text type="secondary">
          CoCalc keeps a long-lived Claude token (valid for a year), so your
          agents can run at the same time without signing you out.
        </Typography.Text>
        {login?.state === "completed" ? (
          <Typography.Text role="status">
            <Icon name="check-circle" style={{ color: token.colorSuccess }} />{" "}
            Claude subscription connected.
          </Typography.Text>
        ) : failed ? (
          <Alert
            type="error"
            showIcon
            title={
              error
                ? claudeSignInErrorMessage(error)
                : login?.error || "Claude sign-in failed"
            }
            action={
              !isProjectHostUnavailable(error) && (
                <Button size="small" onClick={() => void start()}>
                  Try again
                </Button>
              )
            }
          />
        ) : (
          <>
            <Step number={1} title="Sign in to Claude">
              <Button
                type={codeSubmitted ? "default" : "primary"}
                href={login?.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
                loading={!login?.verificationUrl}
                disabled={connecting}
                icon={<Icon name="external-link" />}
                aria-label={
                  login?.verificationUrl
                    ? "Open Claude sign-in"
                    : "Preparing sign-in..."
                }
              >
                {login?.verificationUrl
                  ? "Open Claude sign-in"
                  : "Preparing sign-in..."}
              </Button>
            </Step>
            <Step number={2} title="Paste the authentication code">
              {!login?.verificationUrl ? (
                <Typography.Text type="secondary">
                  Claude shows the code after you sign in.
                </Typography.Text>
              ) : connecting ? (
                <Space role="status" aria-live="polite">
                  <Spin size="small" />
                  Connecting to Claude... usually a few seconds.
                </Space>
              ) : (
                <Space
                  orientation="vertical"
                  size={8}
                  style={{ width: "100%" }}
                >
                  <Input.TextArea
                    aria-label="Claude sign-in code"
                    placeholder="Paste the code Claude shows after you sign in"
                    autoComplete="off"
                    spellCheck={false}
                    autoSize={{ minRows: 2, maxRows: 4 }}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    onPaste={(event) => {
                      const pasted = event.clipboardData.getData("text");
                      // A complete code needs no extra click.
                      if (looksLikeClaudeCode(pasted) && !code.trim()) {
                        event.preventDefault();
                        setCode(pasted.trim());
                        void submitCode(pasted);
                      }
                    }}
                    onPressEnter={(event) => {
                      event.preventDefault();
                      if (codeReady) void submitCode(code);
                    }}
                    style={{
                      fontFamily: "monospace",
                      background: token.colorFillTertiary,
                    }}
                  />
                  {codeError && (
                    <Alert type="error" showIcon title={codeError} />
                  )}
                  {code.trim() && !codeReady && (
                    <Typography.Text type="warning">
                      That does not look like the whole code. Use Copy code on
                      Claude's page and paste it here.
                    </Typography.Text>
                  )}
                  <Button
                    type="primary"
                    disabled={!codeReady}
                    onClick={() => void submitCode(code)}
                  >
                    Connect
                  </Button>
                </Space>
              )}
            </Step>
          </>
        )}
        {error && !failed && (
          <Alert
            type="warning"
            showIcon
            title={claudeSignInErrorMessage(error)}
          />
        )}
        {signingIn && (
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            onClick={() => void cancel()}
            disabled={login?.state === "verifying"}
          >
            Cancel
          </Button>
        )}
      </Space>
    </div>
  );
  if (links && !reconnectOnly) {
    const link = { type: "link" as const, size: "small" as const };
    return (
      <Space
        orientation="vertical"
        size={8}
        style={{ width: "100%", minWidth: 0 }}
      >
        {!signingIn && (
          <Space wrap size={[16, 4]}>
            {leadingActions}
            {reconnectCredentialId && (
              <Button
                {...link}
                style={{ padding: 0 }}
                icon={<Icon name="refresh" />}
                disabled={disabled}
                onClick={() => void start(reconnectCredentialId)}
              >
                Reconnect
              </Button>
            )}
            {trailingActions}
            {justConnected && (
              <Typography.Text type="success" role="status">
                <Icon name="check-circle" /> Connected
              </Typography.Text>
            )}
          </Space>
        )}
        {!signingIn &&
          (hasConnection ? (
            <Button
              {...link}
              style={{ padding: 0 }}
              icon={<Icon name="plus" />}
              disabled={disabled}
              onClick={() => void start()}
            >
              Connect another subscription
            </Button>
          ) : (
            <Button disabled={disabled} onClick={() => void start()}>
              Connect Claude Pro/Max
            </Button>
          ))}
        {signIn}
      </Space>
    );
  }
  // Compact with the sign-in in a modal sits in a row of settings: stay
  // inline and one line high there.
  const inline = compact && modal;
  return (
    <Space
      orientation={inline ? "horizontal" : "vertical"}
      size={inline ? 4 : 12}
      style={inline ? { minWidth: 0 } : { width: "100%", minWidth: 0 }}
    >
      {hasConnection && !compact && (
        <Typography.Text type="secondary">
          Already connected. Choose an existing subscription in the Claude
          credential selector; you do not need to sign in for each agent.
        </Typography.Text>
      )}
      {reconnectCredentialId && !(signingIn && !modal) && (
        <Button
          type={reconnectOnly ? "primary" : undefined}
          disabled={disabled || signingIn}
          loading={reconnectOnly && busy}
          onClick={() => void start(reconnectCredentialId)}
        >
          Reconnect Claude
        </Button>
      )}
      {!reconnectOnly && !(signingIn && !modal) && (
        <Button
          size={inline ? "small" : undefined}
          style={
            inline
              ? { maxWidth: "100%" }
              : { maxWidth: "100%", height: "auto", whiteSpace: "normal" }
          }
          aria-haspopup={modal ? "dialog" : undefined}
          disabled={disabled || signingIn}
          loading={busy}
          onClick={() => {
            if (modal) setOpen(true);
            void start();
          }}
        >
          {hasConnection
            ? compact
              ? "Connect another subscription"
              : "Connect another Claude subscription"
            : "Connect Claude Pro/Max"}
        </Button>
      )}
      {justConnected && (
        <Typography.Text type="success" role="status">
          <Icon name="check-circle" /> Claude subscription connected.
        </Typography.Text>
      )}
      {modal ? (
        <Modal
          title="Connect Claude Pro/Max"
          open={open}
          // Wide enough that a pasted sign-in code fits without wrapping.
          width={680}
          footer={null}
          onCancel={() => void cancel()}
          modalRender={(content) => (
            <KeyboardBoundary>{content}</KeyboardBoundary>
          )}
        >
          {signIn}
        </Modal>
      ) : (
        signIn
      )}
    </Space>
  );
}
