import { useEffect, useId, useState } from "react";
import { Alert, Button, Select, Space } from "antd";
import { postAuthApi } from "@cocalc/frontend/auth/api";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import type { NamedAgentDirectory } from "@cocalc/conat/agents/personal";
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
  const [directory, setDirectory] = useState<NamedAgentDirectory>();
  const [selected, setSelected] = useState<string[]>([]);
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
      void postAuthApi<NamedAgentDirectory>({
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
    const targets =
      directory?.agents
        .filter((agent) => selected.includes(agent.name) && agent.available)
        .map((agent) => agent.endpoint) ?? [];
    if (!targets.length) return;
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
            targets,
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
        <strong>{label}</strong> is requesting its own send-only identity, not
        access to your CoCalc account.
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
          title="Sign in to select the agents this installation may message."
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
            description="Anyone who can read this installation's credential can use it until it expires or you revoke it. Messages may start projects and agent work under your account, subject to your normal permissions and limits. This does not allow receiving messages or browsing project files."
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
                <legend>Allow sending to these agents</legend>
                {directory.agents.length === 0 && (
                  <p>
                    Name an agent in CoCalc first, then reopen this approval
                    page.
                  </p>
                )}
                {directory.agents.map((agent) => (
                  <label
                    key={agent.name}
                    style={{
                      display: "flex",
                      alignItems: "start",
                      gap: 8,
                      marginBottom: 12,
                      overflowWrap: "anywhere",
                    }}
                  >
                    <input
                      type="checkbox"
                      disabled={
                        !agent.available ||
                        (!selected.includes(agent.name) &&
                          selected.length >= 32)
                      }
                      checked={selected.includes(agent.name)}
                      onChange={(event) =>
                        setSelected((values) =>
                          event.target.checked
                            ? [...values, agent.name]
                            : values.filter((name) => name !== agent.name),
                        )
                      }
                    />
                    <span>
                      <strong>@{agent.name}</strong>
                      {!agent.available && " (unavailable)"}
                      <br />
                      {[agent.project_title, agent.thread_title]
                        .filter(Boolean)
                        .join(" / ")}
                    </span>
                  </label>
                ))}
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
                disabled={!selected.length || directory.controls?.paused}
              >
                Approve Send-Only Access
              </Button>
              {directory.controls?.paused && (
                <Alert
                  type="info"
                  role="note"
                  title="Your agent connections are paused. Resume them in My Agents before approving this request."
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
