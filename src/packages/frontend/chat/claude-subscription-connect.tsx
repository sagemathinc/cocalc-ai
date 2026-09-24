/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Input, Space, Typography } from "antd";
import { useEffect, useEffectEvent, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";

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
}: {
  projectId: string;
  disabled?: boolean;
  onConnected: (credentialId: string) => Promise<void> | void;
}) {
  const [login, setLogin] = useState<LoginStatus>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connected = useEffectEvent(onConnected);

  useEffect(() => {
    if (!login || (login.state !== "pending" && login.state !== "verifying"))
      return;
    let active = true;
    let completed = false;
    const timer = setInterval(() => {
      void webapp_client.conat_client.hub.projects
        .claudeSubscriptionLoginStatus({ project_id: projectId, id: login.id })
        .then(async (next) => {
          if (!active) return;
          if (next.state === "completed" && next.credentialId && !completed) {
            completed = true;
            await connected(next.credentialId);
          }
          if (active) setLogin(next);
        })
        .catch((err) => {
          if (active) setError(`${err}`);
        });
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [login?.id, login?.state, projectId]);

  return (
    <Space orientation="vertical" size={4}>
      <Button
        disabled={
          disabled || login?.state === "pending" || login?.state === "verifying"
        }
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            setLogin(
              await webapp_client.conat_client.hub.projects.claudeSubscriptionLoginStart(
                { project_id: projectId },
              ),
            );
          } catch (err) {
            setError(`${err}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        Connect Claude Pro/Max (experimental)
      </Button>
      {login && (login.state === "pending" || login.state === "verifying") && (
        <Space orientation="vertical">
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
            <Space>
              <Input
                aria-label="Claude sign-in code"
                autoComplete="off"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button
                onClick={async () => {
                  try {
                    await webapp_client.conat_client.hub.projects.claudeSubscriptionLoginSubmitCode(
                      { project_id: projectId, id: login.id, code },
                    );
                    setCode("");
                  } catch (err) {
                    setError(`${err}`);
                  }
                }}
              >
                Submit code
              </Button>
            </Space>
          )}
          {login.state === "pending" && (
            <Button
              onClick={async () => {
                try {
                  await webapp_client.conat_client.hub.projects.claudeSubscriptionLoginCancel(
                    { project_id: projectId, id: login.id },
                  );
                  setLogin(undefined);
                } catch (err) {
                  setError(`${err}`);
                }
              }}
            >
              Cancel sign-in
            </Button>
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
    </Space>
  );
}
