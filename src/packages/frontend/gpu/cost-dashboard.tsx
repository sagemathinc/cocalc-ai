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

function formatTime(value: string | number): string {
  return new Date(value).toLocaleString();
}

function usePolling(
  load: () => Promise<void>,
  generation: { current: number },
) {
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      await load();
      if (active) timer = setTimeout(poll, REFRESH_MS);
    }
    void poll();
    return () => {
      active = false;
      generation.current++;
      if (timer != null) clearTimeout(timer);
    };
  }, [load, generation]);
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
    at: number;
  }>();
  const [spendResult, setSpendResult] = useState<{
    key: string;
    spend: GpuSpendResult;
    at: number;
  }>();
  // Pods and spend load and fail independently: a billing outage must not
  // hide the pod list and its per-pod terminate buttons, nor the reverse.
  // Errors are kept per query and cleared only by a successful read, so a
  // cached result after a failed refresh is shown as last known, never live.
  const [podsFailure, setPodsFailure] = useState<{
    key: string;
    message: string;
  }>();
  const [spendFailure, setSpendFailure] = useState<{
    key: string;
    message: string;
  }>();
  const [confirm, setConfirm] = useState<Confirmation>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const podsGeneration = useRef(0);
  const spendGeneration = useRef(0);

  // Callers may pass a new but equal scope object on every render.
  const scopeKey = JSON.stringify(scope);
  const spendKey = JSON.stringify([scope, period, groupBy]);
  const podsLoaded = podsResult?.key === scopeKey ? podsResult : undefined;
  const spendLoaded = spendResult?.key === spendKey ? spendResult : undefined;
  const pods = podsLoaded?.pods;
  const spend = spendLoaded?.spend;
  const podsError = podsFailure?.key === scopeKey ? podsFailure.message : "";
  const spendError = spendFailure?.key === spendKey ? spendFailure.message : "";
  // Fresh: loaded for this query and not followed by a failed refresh.
  const podsFresh = pods != null && !podsError;
  const spendFresh = spend != null && !spendError;

  const refreshPods = useCallback(async () => {
    const version = ++podsGeneration.current;
    try {
      const next = await api.pods({ scope: JSON.parse(scopeKey) });
      if (podsGeneration.current !== version) return;
      setPodsResult({ key: scopeKey, pods: next, at: Date.now() });
      setPodsFailure(undefined);
    } catch (err) {
      if (podsGeneration.current === version)
        setPodsFailure({ key: scopeKey, message: errorText(err) });
    }
  }, [api, scopeKey]);

  const refreshSpend = useCallback(async () => {
    const version = ++spendGeneration.current;
    const query: GpuPodScope = JSON.parse(scopeKey);
    const key = JSON.stringify([query, period, groupBy]);
    try {
      const next = await api.spend({
        scope: query,
        since: periodSince(period, Date.now()),
        group_by: groupBy,
      });
      if (spendGeneration.current !== version) return;
      setSpendResult({ key, spend: next, at: Date.now() });
      setSpendFailure(undefined);
    } catch (err) {
      if (spendGeneration.current === version)
        setSpendFailure({ key, message: errorText(err) });
    }
  }, [api, scopeKey, period, groupBy]);

  // Each endpoint polls itself: the next request is scheduled only after the
  // previous one settles, so a slow endpoint never piles up requests. A query
  // change restarts the loop, and its generation supersedes the old request.
  usePolling(refreshPods, podsGeneration);
  usePolling(refreshSpend, spendGeneration);

  function refresh() {
    void refreshPods();
    void refreshSpend();
  }

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
      refresh();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const groupLabel = GROUP_BY_LABELS[groupBy];
  // Missing numbers are never shown as zero.
  const podsPending = podsError ? "unavailable" : "…";
  const spendPending = spendError ? "unavailable" : "…";

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
          <Button onClick={refresh}>Refresh</Button>
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

      <Space wrap size="large" style={{ marginTop: 12 }}>
        <span>
          <Typography.Text type="secondary">Live pods: </Typography.Text>
          <strong>{podsFresh ? live.length : podsPending}</strong>
        </span>
        <span>
          <Typography.Text type="secondary">Live rate: </Typography.Text>
          <strong>
            {podsFresh ? `${moneyToCurrency(rate)}/hour` : podsPending}
          </strong>
        </span>
        <span>
          <Typography.Text type="secondary">
            Estimated spend ({PERIOD_LABELS[period].toLowerCase()}):{" "}
          </Typography.Text>
          <strong>
            {spendFresh ? moneyToCurrency(totals.estimated) : spendPending}
          </strong>
        </span>
        <span>
          <Typography.Text type="secondary">Billed by RunPod: </Typography.Text>
          <strong>
            {!spendFresh
              ? spendPending
              : totals.billed == null
                ? "not yet billed"
                : moneyToCurrency(totals.billed)}
          </strong>
          {spendFresh && spend?.billed_through && (
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
      {podsError && (
        <Alert
          role="alert"
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          title="Couldn't load live pods"
          description={podsError}
        />
      )}
      {podsError && podsLoaded && (
        <Typography.Paragraph type="secondary">
          Showing the pods last loaded at {formatTime(podsLoaded.at)}; they may
          be out of date.
        </Typography.Paragraph>
      )}
      <Table<GpuPodSummary>
        size="small"
        rowKey="id"
        loading={pods == null && !podsError}
        dataSource={live}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: podsError ? "Unavailable." : "No live pods." }}
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
      {spendError && (
        <Alert
          role="alert"
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          title="Couldn't load GPU spending"
          description={spendError}
        />
      )}
      {spendError && spendLoaded && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
          Showing spending last loaded at {formatTime(spendLoaded.at)}; it may
          be out of date.
        </Typography.Paragraph>
      )}
      <Table
        size="small"
        style={{ marginTop: 8 }}
        rowKey="key"
        loading={spend == null && !spendError}
        dataSource={spend?.rows ?? []}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{
          emptyText: spendError
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
            {!podsFresh
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
