/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The sign-in sessions (this browser, other browsers, CLIs) whose fresh auth is
still active, each with a countdown and an "End now" button. A fresh auth can
last up to 72 hours (util/auth/fresh-auth-duration), so the owner must always
be able to see and end every one of them.
*/

import { Alert, Button, Card, Flex, Popconfirm, Tag, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";

import { postAuthApi } from "@cocalc/frontend/auth/api";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import { formatFreshAuthRemaining } from "@cocalc/util/auth/fresh-auth-duration";

export type ActiveFreshAuthSession = {
  id: string;
  current: boolean;
  fresh_auth_until: string;
  factor_level?: string | null;
  created?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
};

const REFRESH_MS = 60_000;

function describeClient(session: ActiveFreshAuthSession): string {
  const agent = `${session.user_agent ?? ""}`.trim();
  const parts = [
    agent ? agent.slice(0, 80) : "Unknown client",
    session.ip_address ? `from ${session.ip_address}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export default function ActiveFreshAuth({
  reloadKey,
}: {
  // Change this to reload the list (e.g., after a new verification).
  reloadKey?: unknown;
}) {
  const authOrigin = getControlPlaneOrigin();
  const [sessions, setSessions] = useState<ActiveFreshAuthSession[] | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const now = useNow(1000);

  const load = useCallback(async () => {
    try {
      const result = await postAuthApi<{
        sessions: ActiveFreshAuthSession[];
      }>({
        endpoint: "auth/fresh-auth-sessions",
        origin: authOrigin,
        body: {},
      });
      setSessions(result.sessions ?? []);
      setError("");
    } catch (err) {
      setError(`${err}`);
    }
  }, [authOrigin]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, reloadKey]);

  async function end(body: { id?: string; all?: boolean }) {
    setBusy(body.all ? "all" : (body.id ?? ""));
    setError("");
    try {
      await postAuthApi({
        endpoint: "auth/fresh-auth-end",
        origin: authOrigin,
        body,
      });
      await load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy("");
    }
  }

  const active = (sessions ?? []).filter(
    (session) => formatFreshAuthRemaining(session.fresh_auth_until, now) !== "",
  );

  return (
    <Flex vertical gap="small">
      <Typography.Title level={2} style={{ margin: 0, fontSize: 18 }}>
        Active verifications
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        While a verification is active, that browser or CLI can do security
        actions without asking again. Ending one keeps it signed in.
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon title={error} /> : undefined}
      {sessions != null && active.length === 0 ? (
        <Typography.Text type="secondary">
          No verification is active.
        </Typography.Text>
      ) : undefined}
      {active.map((session) => (
        <Card key={session.id} size="small">
          <Flex align="center" justify="space-between" gap="small" wrap>
            <Flex vertical gap={2}>
              <Typography.Text>
                {session.current ? <Tag color="blue">This browser</Tag> : null}
                {describeClient(session)}
              </Typography.Text>
              <Typography.Text strong>
                {formatFreshAuthRemaining(session.fresh_auth_until, now)} left
              </Typography.Text>
              <Typography.Text type="secondary">
                Until {new Date(session.fresh_auth_until).toLocaleString()}
              </Typography.Text>
            </Flex>
            <Button
              danger
              loading={busy === session.id}
              disabled={busy !== ""}
              onClick={() => void end({ id: session.id })}
            >
              End now
            </Button>
          </Flex>
        </Card>
      ))}
      {active.length > 1 ? (
        <div>
          <Popconfirm
            title="End every active verification?"
            okText="End all"
            onConfirm={() => end({ all: true })}
          >
            <Button danger loading={busy === "all"} disabled={busy !== ""}>
              End all
            </Button>
          </Popconfirm>
        </div>
      ) : undefined}
    </Flex>
  );
}
