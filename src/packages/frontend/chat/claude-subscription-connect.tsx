/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Input, Modal, Space, Spin, Typography } from "antd";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

type LoginStatus = {
  id: string;
  state: string;
  verificationUrl?: string;
  credentialId?: string;
  error?: string;
};

export function ClaudeSubscriptionConnect({
  projectId,
  disabled,
  onConnected,
  hasConnection = false,
  compact = false,
  modal = false,
  reconnectCredentialId,
}: {
  projectId: string;
  disabled?: boolean;
  hasConnection?: boolean;
  compact?: boolean;
  modal?: boolean;
  reconnectCredentialId?: string;
  onConnected: (credentialId: string) => Promise<void> | void;
}) {
  const [login, setLogin] = useState<LoginStatus>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
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
            if (active && started === attempt.current) setOpen(false);
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

  const signIn = (
    <Space
      orientation="vertical"
      size={12}
      style={{ width: "100%", minWidth: 0 }}
    >
      {busy && <span role="status">Opening Claude sign-in...</span>}
      {modal && login?.verificationUrl && (
        <Typography.Text>
          Sign in with your Claude Pro or Max subscription, then paste the code
          from Claude below.
        </Typography.Text>
      )}
      {login && (login.state === "pending" || login.state === "verifying") && (
        <Space orientation="vertical" style={{ width: "100%", minWidth: 0 }}>
          {(submitting || codeSubmitted || login.state === "verifying") && (
            <Space role="status" aria-live="polite">
              <Spin size="small" />
              {submitting
                ? "Submitting sign-in code..."
                : "Verifying Claude sign-in..."}
            </Space>
          )}
          {login.verificationUrl && (
            <a
              href={login.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Claude sign-in
            </a>
          )}
          {login.state === "pending" && login.verificationUrl && (
            <Space wrap style={{ width: "100%" }}>
              <Input
                aria-label="Claude sign-in code"
                placeholder="Paste the code from Claude"
                autoComplete="off"
                value={code}
                disabled={submitting || codeSubmitted}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button
                aria-label="Submit code"
                aria-busy={submitting || codeSubmitted}
                loading={submitting || codeSubmitted}
                disabled={submitting || codeSubmitted || !code.trim()}
                onClick={async () => {
                  const started = attempt.current;
                  setSubmitting(true);
                  setError("");
                  try {
                    await webapp_client.conat_client.hub.projects.claudeSubscriptionLoginSubmitCode(
                      { project_id: projectId, id: login.id, code },
                    );
                    if (started !== attempt.current) return;
                    setCode("");
                    setCodeSubmitted(true);
                  } catch (err) {
                    if (started === attempt.current) setError(`${err}`);
                  } finally {
                    if (started === attempt.current) setSubmitting(false);
                  }
                }}
              >
                Submit code
              </Button>
            </Space>
          )}
          {login.state === "pending" && (
            <Button onClick={() => void cancel()}>Cancel sign-in</Button>
          )}
        </Space>
      )}
      {login?.state === "completed" && (
        <Typography.Text role="status">
          Claude subscription connected.
        </Typography.Text>
      )}
      {login?.state === "failed" && (
        <div role="alert">{login.error || "Claude sign-in failed"}</div>
      )}
      {error && <div role="alert">Claude sign-in error: {error}</div>}
      {modal && !signingIn && (error || login?.state === "failed") && (
        <Button onClick={() => void start()}>Retry sign-in</Button>
      )}
    </Space>
  );
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
      {reconnectCredentialId && (
        <Button
          disabled={disabled || signingIn}
          onClick={() => void start(reconnectCredentialId)}
        >
          Reconnect Claude
        </Button>
      )}
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
      {modal ? (
        <Modal
          title="Connect Claude Pro/Max"
          open={open}
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
