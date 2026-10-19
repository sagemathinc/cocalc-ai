import { useEffect, useId, useState } from "react";
import { Alert, Button, Select, Space } from "antd";
import { postAuthApi } from "@cocalc/frontend/auth/api";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import type { AgentNetworkDirectory } from "@cocalc/conat/agents/personal";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { AgentNetworkSummary } from "@cocalc/frontend/agents/agent-network-summary";

// Warn when the enrollment request is this close to expiring.
const EXPIRY_WARNING_MS = 10 * 60_000;

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ExternalAgentApproval({
  challengeId,
  label,
  originBayId,
  isAuthenticated,
  accountLabel,
  expiresAt,
  state,
}: {
  challengeId: string;
  label: string;
  originBayId: string;
  isAuthenticated: boolean;
  accountLabel?: string;
  /** When the enrollment request (not the credential) expires. */
  expiresAt?: string;
  state?: "pending" | "approved" | "redeemed" | "canceled";
}) {
  const [directory, setDirectory] = useState<AgentNetworkDirectory>();
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
  const [now, setNow] = useState(() => Date.now());
  const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(expiresMs)) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [expiresMs]);
  // Say so as soon as the page opens, not after the form is filled out.
  const closedReason =
    state === "approved" || state === "redeemed"
      ? "It was already approved."
      : state === "canceled"
        ? "It was canceled."
        : Number.isFinite(expiresMs) && now >= expiresMs
          ? `It expired at ${timeLabel(expiresMs)}.`
          : undefined;
  const closed = closedReason != null;
  const expiresSoon =
    Number.isFinite(expiresMs) && expiresMs - now <= EXPIRY_WARNING_MS;
  const selectedNetwork = directory?.networks.find(
    ({ agent_network_id }) => agent_network_id === selected,
  );
  useEffect(() => {
    let disposed = false;
    if (isAuthenticated && !closed) {
      void postAuthApi<AgentNetworkDirectory>({
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
  }, [isAuthenticated, origin, closed]);

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
            agent_network_id: selected,
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
        <strong>{label}</strong> is requesting a network-scoped external agent
        identity, not access to your CoCalc account.
      </p>
      {isAuthenticated && accountLabel && (
        <p>
          Approving account: <strong>{accountLabel}</strong>
        </p>
      )}
      {!approved && closed ? (
        <Alert
          type="error"
          role="alert"
          title="This enrollment request is no longer open."
          description={`${closedReason} Run the enrollment command (cocalc auth login --agent ...) again for a new link.`}
        />
      ) : (
        !approved &&
        Number.isFinite(expiresMs) && (
          <Alert
            type={expiresSoon ? "warning" : "info"}
            role="note"
            title={`This request expires at ${timeLabel(expiresMs)}${
              expiresSoon
                ? ` (in about ${Math.max(1, Math.ceil((expiresMs - now) / 60_000))} minutes)`
                : ""
            }.`}
          />
        )
      )}
      {closed && !approved ? null : !isAuthenticated ? (
        <Alert
          type="info"
          role="note"
          title="Sign in to select the Agent Network this installation may join."
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
            description="Anyone who can read this installation's credential can send and receive messages as this external agent within the selected network until it expires or you revoke it. Every network member can exchange prompt data with it. This does not permit browsing project files."
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
                <legend>Join one Agent Network</legend>
                {directory.networks.filter(
                  (network) =>
                    network.state === "active" &&
                    network.members.length < directory.usage.member_limit,
                ).length === 0 && (
                  <p>
                    Create an Agent Network with room for another member, then
                    reopen this approval page.
                  </p>
                )}
                <Select
                  aria-label="Agent Network"
                  value={selected}
                  onChange={setSelected}
                  style={{ width: "100%" }}
                  placeholder="Select an Agent Network"
                  options={directory.networks
                    .filter(
                      (network) =>
                        network.state === "active" &&
                        network.members.length < directory.usage.member_limit,
                    )
                    .map((network) => ({
                      value: network.agent_network_id,
                      label: `${network.title} (${network.members.length} members, ${network.delivery_mode})`,
                    }))}
                />
                {selectedNetwork && (
                  <Space
                    orientation="vertical"
                    style={{ width: "100%", marginTop: 12 }}
                  >
                    <AgentNetworkSummary network={selectedNetwork} />
                    <Alert
                      type="info"
                      title="Two-way complete-graph membership"
                      description="This external agent and every current or future member of the selected network may message one another in both directions."
                    />
                  </Space>
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
                Approve Network Membership
              </Button>
              {directory.controls.paused && (
                <Alert
                  type="info"
                  role="note"
                  title="Your agent messaging is paused. Resume it in Preferences > AI before approving this request."
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
