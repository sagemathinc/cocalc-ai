/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU cost dashboard: what the pods a RunPod key pays for cost, which of them are
live, and a way to terminate one or all of them. The same component serves the
key owner (scope "funded") and, later, a course (scope {course_id}).

Spend is CoCalc's estimate (cost per hour × time, which slightly overcounts),
then RunPod's own per-pod billing once it arrives, about an hour late.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Typography,
} from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { moneyToCurrency } from "@cocalc/util/money";
import {
  GROUP_BY_LABELS,
  PERIOD_LABELS,
  hourlyRate,
  livePods,
  periodSince,
  podGpuLabel,
  podOwnerLabel,
  podStateLabel,
  spendTotals,
} from "./cost-dashboard-model";
import type { GpuSpendPeriod } from "./cost-dashboard-model";
import type {
  GpuCostDashboardApi,
  GpuPodScope,
  GpuPodSummary,
  GpuSpendGroupBy,
  GpuSpendResult,
} from "./types";

const REFRESH_MS = 15_000;

type Confirmation = { kind: "all" } | { kind: "pod"; pod: GpuPodSummary };

function errorText(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

export function GpuCostDashboard({
  api,
  scope = "funded",
  scopeLabel = "your RunPod key pays for",
}: {
  api: GpuCostDashboardApi;
  // What is shown is exactly what "Terminate all" terminates.
  scope?: GpuPodScope;
  // Completes "GPU pods ..." in headings and confirmations.
  scopeLabel?: string;
}) {
  const [period, setPeriod] = useState<GpuSpendPeriod>("7d");
  const [groupBy, setGroupBy] = useState<GpuSpendGroupBy>("beneficiary");
  // Each result is stored with the query it answers, and only shown while that
  // query is current, so new labels are never put on old numbers.
  const [podsResult, setPodsResult] = useState<{
    key: string;
    pods: GpuPodSummary[];
  }>();
  const [spendResult, setSpendResult] = useState<{
    key: string;
    spend: GpuSpendResult;
  }>();
  const [loadError, setLoadError] = useState("");
  const [confirm, setConfirm] = useState<Confirmation>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);

  // Callers may pass a new but equal scope object on every render.
  const scopeKey = JSON.stringify(scope);
  const spendKey = JSON.stringify([scope, period, groupBy]);
  const pods = podsResult?.key === scopeKey ? podsResult.pods : undefined;
  const spend = spendResult?.key === spendKey ? spendResult.spend : undefined;

  const refresh = useCallback(async () => {
    const version = ++generation.current;
    const query: GpuPodScope = JSON.parse(scopeKey);
    setLoadError("");
    try {
      const [nextPods, nextSpend] = await Promise.all([
        api.pods({ scope: query }),
        api.spend({
          scope: query,
          since: periodSince(period, Date.now()),
          group_by: groupBy,
        }),
      ]);
      if (generation.current !== version) return;
      setPodsResult({ key: scopeKey, pods: nextPods });
      setSpendResult({
        key: JSON.stringify([query, period, groupBy]),
        spend: nextSpend,
      });
    } catch (err) {
      if (generation.current === version) setLoadError(errorText(err));
    }
  }, [api, scopeKey, period, groupBy]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      generation.current++;
      clearInterval(interval);
    };
  }, [refresh]);

  const live = useMemo(() => livePods(pods ?? []), [pods]);
  const rate = useMemo(() => hourlyRate(live), [live]);
  const totals = useMemo(() => spendTotals(spend?.rows ?? []), [spend]);

  async function runConfirmed() {
    if (!confirm) return;
    setBusy(true);
    setActionError("");
    try {
      if (confirm.kind === "all") {
        const { terminating } = await api.killSwitch({ scope });
        setNotice(
          terminating === 1
            ? "Terminating 1 pod."
            : `Terminating ${terminating} pods.`,
        );
      } else {
        await api.terminate({ pod_id: confirm.pod.id });
        setNotice(`Terminating pod ${confirm.pod.handle}.`);
      }
      setConfirm(undefined);
      void refresh();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const groupLabel = GROUP_BY_LABELS[groupBy];
  // Missing numbers are never shown as zero.
  const pending = loadError ? "unavailable" : "…";

  return (
    <section aria-label="GPU spending" style={{ color: UI_COLORS.text }}>
      <Space
        wrap
        align="center"
        style={{ width: "100%", justifyContent: "space-between" }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          GPU pods {scopeLabel}
        </Typography.Title>
        <Space wrap>
          <Button onClick={() => void refresh()}>Refresh</Button>
          <Button danger onClick={() => setConfirm({ kind: "all" })}>
            Terminate all
          </Button>
        </Space>
      </Space>

      <div role="status" aria-live="polite" style={{ marginTop: 8 }}>
        {notice && (
          <Alert
            type="success"
            showIcon
            title={notice}
            closable
            onClose={() => setNotice("")}
          />
        )}
      </div>
      {loadError && (
        <Alert
          role="alert"
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          title="Couldn't load GPU spending"
          description={loadError}
        />
      )}

      <Space wrap size="large" style={{ marginTop: 12 }}>
        <span>
          <Typography.Text type="secondary">Live pods: </Typography.Text>
          <strong>{pods ? live.length : pending}</strong>
        </span>
        <span>
          <Typography.Text type="secondary">Live rate: </Typography.Text>
          <strong>{pods ? `${moneyToCurrency(rate)}/hour` : pending}</strong>
        </span>
        <span>
          <Typography.Text type="secondary">
            Estimated spend ({PERIOD_LABELS[period].toLowerCase()}):{" "}
          </Typography.Text>
          <strong>{spend ? moneyToCurrency(totals.estimated) : pending}</strong>
        </span>
        <span>
          <Typography.Text type="secondary">Billed by RunPod: </Typography.Text>
          <strong>
            {!spend
              ? pending
              : totals.billed == null
                ? "not yet billed"
                : moneyToCurrency(totals.billed)}
          </strong>
          {spend?.billed_through && (
            <Typography.Text type="secondary">
              {" "}
              (through {formatTime(spend.billed_through)})
            </Typography.Text>
          )}
        </span>
      </Space>

      <Typography.Title level={5} style={{ marginTop: 20 }}>
        Live pods
      </Typography.Title>
      <Table<GpuPodSummary>
        size="small"
        rowKey="id"
        loading={pods == null && !loadError}
        dataSource={live}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: loadError ? "Unavailable." : "No live pods." }}
        columns={[
          { title: "Pod", dataIndex: "handle", key: "handle" },
          {
            title: "For",
            key: "owner",
            render: (_, pod) => podOwnerLabel(pod),
          },
          {
            title: "GPU",
            key: "gpu",
            render: (_, pod) => podGpuLabel(pod),
          },
          {
            title: "State",
            key: "state",
            render: (_, pod) => podStateLabel(pod.state),
          },
          {
            title: "Rate",
            key: "rate",
            align: "right",
            render: (_, pod) => `${moneyToCurrency(pod.cost_per_hr)}/hour`,
          },
          {
            title: "Estimated cost",
            key: "estimated",
            align: "right",
            render: (_, pod) => moneyToCurrency(pod.estimated_cost),
          },
          {
            title: "Started",
            key: "created",
            render: (_, pod) => formatTime(pod.created),
          },
          {
            title: "Action",
            key: "action",
            render: (_, pod) => (
              <Button
                size="small"
                danger
                disabled={pod.state === "terminating"}
                aria-label={`Terminate pod ${pod.handle}`}
                onClick={() => setConfirm({ kind: "pod", pod })}
              >
                Terminate
              </Button>
            ),
          },
        ]}
      />

      <Space
        wrap
        align="center"
        style={{
          marginTop: 20,
          width: "100%",
          justifyContent: "space-between",
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          Spending by {groupLabel.toLowerCase()}
        </Typography.Title>
        <Space wrap>
          <Radio.Group
            aria-label="Period"
            optionType="button"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            options={(Object.keys(PERIOD_LABELS) as GpuSpendPeriod[]).map(
              (value) => ({ value, label: PERIOD_LABELS[value] }),
            )}
          />
          <Select<GpuSpendGroupBy>
            aria-label="Group spending by"
            value={groupBy}
            onChange={setGroupBy}
            style={{ minWidth: 120 }}
            options={(Object.keys(GROUP_BY_LABELS) as GpuSpendGroupBy[]).map(
              (value) => ({ value, label: GROUP_BY_LABELS[value] }),
            )}
          />
        </Space>
      </Space>
      <Table
        size="small"
        style={{ marginTop: 8 }}
        rowKey="key"
        loading={spend == null && !loadError}
        dataSource={spend?.rows ?? []}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{
          emptyText: loadError
            ? "Unavailable."
            : "No GPU spending in this period.",
        }}
        columns={[
          { title: groupLabel, dataIndex: "label", key: "label" },
          {
            title: "Estimated",
            key: "estimated",
            align: "right",
            render: (_, row) => moneyToCurrency(row.estimated),
          },
          {
            title: "Billed by RunPod",
            key: "billed",
            align: "right",
            render: (_, row) =>
              row.billed == null ? "not yet" : moneyToCurrency(row.billed),
          },
          {
            title: "Live pods",
            dataIndex: "pods_live",
            key: "pods_live",
            align: "right",
          },
        ]}
      />
      {spend && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
          As of {formatTime(spend.as_of)}. Estimates are cost per hour × time
          since launch, which slightly overcounts; RunPod bills each hour about
          an hour after it ends.
        </Typography.Paragraph>
      )}

      <Modal
        open={confirm != null}
        title={
          confirm?.kind === "pod"
            ? `Terminate pod ${confirm.pod.handle}?`
            : `Terminate all GPU pods ${scopeLabel}?`
        }
        okText={confirm?.kind === "pod" ? "Terminate pod" : "Terminate all"}
        okButtonProps={{ danger: true, loading: busy }}
        cancelButtonProps={{ disabled: busy }}
        onOk={() => void runConfirmed()}
        onCancel={() => {
          if (busy) return;
          setConfirm(undefined);
          setActionError("");
        }}
        destroyOnHidden
      >
        {confirm?.kind === "pod" ? (
          <p>
            {podGpuLabel(confirm.pod)} for {podOwnerLabel(confirm.pod)}, at{" "}
            {moneyToCurrency(confirm.pod.cost_per_hr)}/hour.
          </p>
        ) : (
          <p>
            This terminates every GPU pod {scopeLabel}, including pods started
            by agents and students.{" "}
            {pods == null
              ? "The number of live pods and their rate are unavailable right now."
              : `${live.length === 1 ? "1 pod is" : `${live.length} pods are`} live now, at ${moneyToCurrency(rate)}/hour.`}
          </p>
        )}
        <p>
          Terminated pods and their disks are deleted at RunPod and can't be
          restarted.
        </p>
        {actionError && (
          <Alert role="alert" type="error" showIcon title={actionError} />
        )}
      </Modal>
    </section>
  );
}
