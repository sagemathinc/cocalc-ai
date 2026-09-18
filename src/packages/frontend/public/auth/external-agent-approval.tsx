import { useEffect, useId, useState } from "react";
import { Alert, Button, Select, Space } from "antd";
import { postAuthApi } from "@cocalc/frontend/auth/api";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import type { AgentSessionDirectory } from "@cocalc/conat/agents/personal";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export function ExternalAgentApproval({
  challengeId,
  label,
  originBayId,
  isAuthenticated,
  accountLabel,
}: {
  challengeId: string;
  label: string;
  originBayId: string;
  isAuthenticated: boolean;
  accountLabel?: string;
}) {
  const [directory, setDirectory] = useState<AgentSessionDirectory>();
  const [selected, setSelected] = useState<string>();
  const [duration, setDuration] = useState(86400);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const durationId = useId();
  const origin = getControlPlaneOrigin();
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    origin,
  });
  useEffect(() => {
    let disposed = false;
    if (isAuthenticated) {
      void postAuthApi<AgentSessionDirectory>({
        origin,
        endpoint: "auth/cli/agent/destinations",
        body: {},
      })
        .then((result) => {
          if (!disposed) setDirectory(result);
        })
        .catch((err) => {
          if (!disposed) setError(`${err}`);
        });
    }
    return () => {
      disposed = true;
    };
  }, [isAuthenticated, origin]);

  async function approve() {
    if (!selected) return;
    setError("");
    setBusy(true);
    try {
      await runFreshAuthAction(async () => {
        await postAuthApi({
          origin,
          endpoint: "auth/cli/agent/approve",
          body: {
            challenge_id: challengeId,
            origin_bay_id: originBayId,
            agent_session_id: selected,
            ttl_seconds: duration,
          },
        });
        setApproved(true);
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Space
      orientation="vertical"
      size="middle"
      style={{ width: "100%", color: UI_COLORS.text }}
    >
      <h2>Connect External Agent</h2>
      <p>
        <strong>{label}</strong> is requesting a session-scoped external agent
        identity, not access to your CoCalc account.
      </p>
      {isAuthenticated && accountLabel && (
        <p>
          Approving account: <strong>{accountLabel}</strong>
        </p>
      )}
      {!isAuthenticated ? (
        <Alert
          type="info"
          role="note"
          title="Sign in to select the Agent Session this installation may join."
        />
      ) : approved ? (
        <Alert
          type="success"
          role="status"
          title="Approved. Return to the terminal to finish connecting."
        />
      ) : (
        <>
          <Alert
            type="warning"
            role="note"
            title="Only approve a request you started."
            description="Anyone who can read this installation's credential can send and receive messages as this external agent within the selected session until it expires or you revoke it. Every session member can exchange prompt data with it. This does not permit browsing project files."
          />
          {error && <Alert type="error" role="alert" title={error} />}
          {!directory ? (
            <p role="status">Loading your named agents...</p>
          ) : (
            <>
              <fieldset
                disabled={busy}
                style={{ border: 0, padding: 0, minWidth: 0 }}
              >
                <legend>Join one Agent Session</legend>
                {directory.sessions.filter(
                  (session) =>
                    session.state === "active" &&
                    session.members.length < directory.usage.member_limit,
                ).length === 0 && (
                  <p>
                    Create an Agent Session with room for another member, then
                    reopen this approval page.
                  </p>
                )}
                <Select
                  aria-label="Agent Session"
                  value={selected}
                  onChange={setSelected}
                  style={{ width: "100%" }}
                  placeholder="Select an Agent Session"
                  options={directory.sessions
                    .filter(
                      (session) =>
                        session.state === "active" &&
                        session.members.length < directory.usage.member_limit,
                    )
                    .map((session) => ({
                      value: session.agent_session_id,
                      label: `${session.title || "Untitled Agent Session"} (${session.members.length} members, ${session.delivery_mode})`,
                    }))}
                />
                {selected && (
                  <Alert
                    style={{ marginTop: 12 }}
                    type="info"
                    title="Two-way complete-graph membership"
                    description="This external agent and every current or future member of the selected session may message one another in both directions."
                  />
                )}
              </fieldset>
              <label htmlFor={durationId}>Credential expires after</label>
              <Select
                id={durationId}
                aria-label="Credential expires after"
                value={duration}
                onChange={setDuration}
                disabled={busy}
                style={{ width: "100%" }}
                options={[
                  { value: 3600, label: "1 hour" },
                  { value: 86400, label: "1 day" },
                  { value: 7 * 86400, label: "1 week" },
                  { value: 30 * 86400, label: "30 days" },
                ]}
              />
              <Button
                type="primary"
                onClick={approve}
                loading={busy}
                disabled={busy || !selected || directory.controls.paused}
              >
                Approve Session Membership
              </Button>
              {directory.controls.paused && (
                <Alert
                  type="info"
                  role="note"
                  title="Your agent messaging is paused. Resume it in Agents before approving this request."
                />
              )}
            </>
          )}
        </>
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
