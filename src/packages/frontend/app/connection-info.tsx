/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Modal, Select } from "antd";
import { FormattedMessage, useIntl } from "react-intl";
import { Button, Col, Row } from "@cocalc/frontend/antd-bootstrap";
import {
  React,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ConnectionTargetSnapshot } from "@cocalc/frontend/conat/client";
import { ConnectionStatsDisplay } from "./connection-status";

type ConnectionStatsSnapshot = ConnectionTargetSnapshot["status"]["stats"];

type ConnectionRateSnapshot = {
  sendMessagesPerSec: number;
  sendBytesPerSec: number;
  recvMessagesPerSec: number;
  recvBytesPerSec: number;
  sampleWindowSec?: number;
};

type ConnectionSample = {
  at: number;
  stats: ConnectionStatsSnapshot;
};

type ConnectionSampleHistory = ConnectionSample[];

type SelectedTargetPingStatus = "idle" | "measuring" | "ok" | "unavailable";

type LatencySample = {
  at: number;
  ms: number;
};

type LatencySummary = {
  latest: number;
  best: number;
};

const LATENCY_HISTORY_LIMIT = 8;

function latencySummary(history?: LatencySample[]): LatencySummary | undefined {
  if (!history?.length) return undefined;
  return {
    latest: history[history.length - 1].ms,
    best: Math.min(...history.map(({ ms }) => ms)),
  };
}

function cloneConnectionStats(
  stats: ConnectionStatsSnapshot,
): ConnectionStatsSnapshot {
  return {
    send: {
      messages: stats?.send?.messages ?? 0,
      bytes: stats?.send?.bytes ?? 0,
    },
    recv: {
      messages: stats?.recv?.messages ?? 0,
      bytes: stats?.recv?.bytes ?? 0,
    },
    subs: stats?.subs ?? 0,
  };
}

function computeRates(
  history?: ConnectionSampleHistory,
): ConnectionRateSnapshot | undefined {
  if (!history || history.length < 2) return undefined;
  const first = history[0];
  const last = history[history.length - 1];
  const deltaMs = last.at - first.at;
  if (!(deltaMs > 0)) return undefined;
  const deltaSec = deltaMs / 1000;
  const delta = (current: number, prev: number) =>
    Math.max(0, current - prev) / deltaSec;
  return {
    sendMessagesPerSec: delta(
      last.stats.send.messages,
      first.stats.send.messages,
    ),
    sendBytesPerSec: delta(last.stats.send.bytes, first.stats.send.bytes),
    recvMessagesPerSec: delta(
      last.stats.recv.messages,
      first.stats.recv.messages,
    ),
    recvBytesPerSec: delta(last.stats.recv.bytes, first.stats.recv.bytes),
    sampleWindowSec: deltaSec,
  };
}

export const ConnectionInfo: React.FC = React.memo(() => {
  const intl = useIntl();

  const ping = useTypedRedux("page", "ping");
  const avgping = useTypedRedux("page", "avgping");
  const status = useTypedRedux("page", "connection_status");
  const conat = useTypedRedux("page", "conat");
  const page_actions = useActions("page");
  const [targets, setTargets] = React.useState<ConnectionTargetSnapshot[]>([]);
  const [selectedTargetId, setSelectedTargetId] = React.useState("hub");
  const [selectedTargetPing, setSelectedTargetPing] = React.useState<
    number | undefined
  >();
  const [selectedTargetPingStatus, setSelectedTargetPingStatus] =
    React.useState<SelectedTargetPingStatus>("idle");
  const [samples, setSamples] = React.useState<
    Record<string, ConnectionSampleHistory>
  >({});
  const [latencySamples, setLatencySamples] = React.useState<
    Record<string, LatencySample[]>
  >({});

  React.useEffect(() => {
    const refresh = () => {
      setTargets(webapp_client.conat_client.getConnectionTargets());
    };
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, []);

  React.useEffect(() => {
    if (targets.some((target) => target.id === selectedTargetId)) {
      return;
    }
    setSelectedTargetId("hub");
  }, [selectedTargetId, targets]);

  React.useEffect(() => {
    const at = Date.now();
    setSamples((prev) => {
      const next: Record<string, ConnectionSampleHistory> = {};
      for (const target of targets) {
        const current: ConnectionSample = {
          at,
          stats: cloneConnectionStats(target.status.stats),
        };
        const history = [...(prev[target.id] ?? []), current];
        next[target.id] = history.slice(-8);
      }
      return next;
    });
  }, [targets]);

  const selectedTarget = React.useMemo(() => {
    return (
      targets.find((target) => target.id === selectedTargetId) ??
      targets.find((target) => target.id === "hub")
    );
  }, [selectedTargetId, targets]);

  const selectedStatus = React.useMemo(() => {
    if (selectedTarget?.id === "hub" && conat != null) {
      return conat.toJS();
    }
    return selectedTarget?.status;
  }, [conat, selectedTarget]);

  const selectedRates = React.useMemo(
    () => computeRates(samples[selectedTargetId]),
    [samples, selectedTargetId],
  );

  React.useEffect(() => {
    const targetId = selectedTarget?.id;
    const targetState = selectedTarget?.status.state;
    if (!targetId || targetId === "hub") {
      setSelectedTargetPing(undefined);
      setSelectedTargetPingStatus("idle");
      return;
    }
    if (targetState !== "connected") {
      setSelectedTargetPing(undefined);
      setSelectedTargetPingStatus("unavailable");
      return;
    }
    let cancelled = false;
    const probe = async () => {
      setSelectedTargetPingStatus((status) =>
        status === "ok" ? status : "measuring",
      );
      try {
        const nextPing =
          await webapp_client.conat_client.probeConnectionTarget(targetId);
        if (!cancelled) {
          if (typeof nextPing === "number") {
            const roundedPing = Math.round(nextPing);
            setSelectedTargetPing(roundedPing);
            setLatencySamples((prev) => {
              const history = [
                ...(prev[targetId] ?? []),
                { at: Date.now(), ms: roundedPing },
              ].slice(-LATENCY_HISTORY_LIMIT);
              return { ...prev, [targetId]: history };
            });
            setSelectedTargetPingStatus("ok");
          } else {
            setSelectedTargetPing(undefined);
            setSelectedTargetPingStatus("unavailable");
          }
        }
      } catch {
        if (!cancelled) {
          setSelectedTargetPing(undefined);
          setSelectedTargetPingStatus("unavailable");
        }
      }
    };
    void probe();
    const interval = setInterval(() => {
      void probe();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedTarget?.id, selectedTarget?.status.state]);

  const targetSelector = React.useMemo(() => {
    if (targets.length <= 1) {
      return selectedTarget?.label ?? "hub";
    }
    return (
      <Select
        size="small"
        value={selectedTargetId}
        style={{ minWidth: 220 }}
        onChange={setSelectedTargetId}
        options={targets.map((target) => ({
          value: target.id,
          label: target.label,
        }))}
      />
    );
  }, [selectedTarget, selectedTargetId, targets]);

  const selectedLatencySummary = React.useMemo(
    () => latencySummary(latencySamples[selectedTargetId]),
    [latencySamples, selectedTargetId],
  );

  const exportSelectedConnectionStats = React.useCallback(() => {
    if (typeof window === "undefined" || !selectedTarget || !selectedStatus) {
      return;
    }
    const payload = {
      export_version: 1,
      exported_at: new Date().toISOString(),
      selected_target: {
        id: selectedTarget.id,
        kind: selectedTarget.kind,
        label: selectedTarget.label,
        address: selectedTarget.address,
      },
      ping:
        selectedTarget.id === "hub"
          ? { latest_ms: ping, average_ms: avgping }
          : {
              latest_ms: selectedTargetPing,
              best_ms: selectedLatencySummary?.best,
              status: selectedTargetPingStatus,
            },
      status: {
        state: selectedStatus.state,
        reason: selectedStatus.reason,
        details: selectedStatus.details,
      },
      stats: cloneConnectionStats(selectedStatus.stats),
      rates_per_sec: selectedRates ?? null,
      all_targets: targets.map((target) => ({
        id: target.id,
        kind: target.kind,
        label: target.label,
        address: target.address,
        state: target.status.state,
        reason: target.status.reason,
        details: target.status.details,
        stats: cloneConnectionStats(target.status.stats),
        rates_per_sec: computeRates(samples[target.id]) ?? null,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = selectedTarget.id.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const url = window.URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `connection-stats-${target}-${timestamp}.json`;
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  }, [
    avgping,
    ping,
    selectedLatencySummary,
    samples,
    selectedRates,
    selectedStatus,
    selectedTarget,
    selectedTargetPing,
    selectedTargetPingStatus,
    targets,
  ]);

  function close() {
    page_actions.show_connection(false);
  }

  return (
    <Modal
      width={700}
      open
      onCancel={close}
      onOk={close}
      title={
        <div
          style={{ display: "flex", alignItems: "center", marginRight: "30px" }}
        >
          <Icon name="wifi" style={{ marginRight: "1em" }} />{" "}
          {intl.formatMessage(labels.connection)}
          <div style={{ flex: 1 }} />
          <Button
            onClick={exportSelectedConnectionStats}
            disabled={selectedTarget == null || selectedStatus == null}
            style={{ marginRight: "8px" }}
          >
            <Icon name="download" /> Export stats
          </Button>
          <Button
            onClick={() => {
              webapp_client.conat_client.reconnect();
            }}
          >
            <Icon name="repeat" spin={status === "connecting"} />{" "}
            {intl.formatMessage(labels.reconnect)}
          </Button>
        </div>
      }
    >
      <div>
        {selectedTarget != null && selectedStatus != null && (
          <Row>
            <Col sm={12}>
              <ConnectionStatsDisplay
                status={selectedStatus}
                targetLabel={targetSelector}
                address={selectedTarget.address}
                rates={selectedRates}
              />
            </Col>
          </Row>
        )}
        {(selectedTarget?.id === "hub" && ping != null) ||
        selectedTarget?.kind === "project-host" ? (
          <div
            style={{
              alignItems: "baseline",
              display: "flex",
              gap: "12px",
              marginTop: "30px",
            }}
          >
            <h5 style={{ margin: 0, minWidth: 95 }}>
              <FormattedMessage
                id="connection-info.ping"
                defaultMessage="Latency"
                description={"Latency for how long a server takes to respond"}
              />
            </h5>
            <code style={{ whiteSpace: "nowrap" }}>
              {selectedTarget?.id === "hub" ? (
                <FormattedMessage
                  id="connection-info.ping_info"
                  defaultMessage="{avgping}ms avg (latest: {ping}ms)"
                  description={
                    "Short string stating the average and the most recent latency in milliseconds."
                  }
                  values={{ avgping, ping }}
                />
              ) : selectedTargetPingStatus === "ok" &&
                selectedTargetPing != null &&
                selectedLatencySummary != null ? (
                <FormattedMessage
                  id="connection-info.project_host_ping_info"
                  defaultMessage="{best}ms best (latest: {latest}ms)"
                  description={
                    "Short string stating the best and latest measured project-host latency in milliseconds."
                  }
                  values={{
                    best: selectedLatencySummary.best,
                    latest: selectedLatencySummary.latest,
                  }}
                />
              ) : selectedTargetPingStatus === "measuring" ? (
                <FormattedMessage
                  id="connection-info.project_host_ping_measuring"
                  defaultMessage="measuring..."
                  description={
                    "Shown while measuring project-host ping in the connection dialog."
                  }
                />
              ) : (
                <FormattedMessage
                  id="connection-info.project_host_ping_unavailable"
                  defaultMessage="not available"
                  description={
                    "Shown when project-host ping is not currently available in the connection dialog."
                  }
                />
              )}
            </code>
          </div>
        ) : undefined}
      </div>
    </Modal>
  );
});
