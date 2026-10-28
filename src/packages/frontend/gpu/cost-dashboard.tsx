/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU cost dashboard: what the pods a RunPod key pays for cost, which of them are
live, and a way to terminate one or all of them. The same component serves the
key owner (scope "funded") and, later, a course: the API it is given is bound
to one scope, and everything shown and done is for that scope.

Spend comes from the server (gpu.spend): settled spend, CoCalc's estimate for
live pods (computed as settlement will), and quarantined holds.
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
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { moneyToCurrency, toDecimal } from "@cocalc/util/money";
import {
  GROUP_BY_LABELS,
  defaultScopeLabel,
  PERIOD_LABELS,
  hourlyRate,
  livePods,
  periodSince,
  podGpuLabel,
  podOwnerLabel,
  podStateLabel,
  spendRowLabel,
} from "./cost-dashboard-model";
import type { GpuSpendPeriod } from "./cost-dashboard-model";
import type {
  DashboardPod,
  GpuBudget,
  GpuCostDashboardApi,
  GpuSpendGroupBy,
  GpuSpendResult,
} from "./types";

const REFRESH_MS = 15_000;
// Data older than this is last known, not live, even with no error: a refresh
// can hang instead of failing.
const STALE_MS = 2 * REFRESH_MS;

type Confirmation = { kind: "all" } | { kind: "pod"; pod: DashboardPod };

function errorText(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

function formatTime(value: string | number): string {
  return new Date(value).toLocaleString();
}

// Last-known values are shown with their age, never as live.
function asOf(value: string, at: number | undefined): string {
  return at == null
    ? value
    : `${value} (as of ${formatTime(at)}; not updating)`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function rateText(rate: { total: string; unpriced: number }): string {
  const priced = `${moneyToCurrency(rate.total)}/hour`;
  return rate.unpriced > 0
    ? `${priced} plus ${plural(rate.unpriced, "pod")} not priced yet`
    : priced;
}

/** Polls `load`, scheduling each request only after the previous one settles.
 * The returned restart() starts a fresh loop at once (e.g. a manual Refresh):
 * the old loop stops scheduling, and the new request's generation supersedes a
 * hung one, so a manual refresh also revives automatic polling. */
function usePolling(
  load: () => Promise<void>,
  generation: { current: number },
): () => void {
  const restartRef = useRef<() => void>(() => {});
  useEffect(() => {
    let loop = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function start() {
      const mine = ++loop;
      if (timer != null) clearTimeout(timer);
      async function poll() {
        await load();
        if (loop === mine) timer = setTimeout(poll, REFRESH_MS);
      }
      void poll();
    }
    restartRef.current = start;
    start();
    return () => {
      loop++;
      generation.current++;
      if (timer != null) clearTimeout(timer);
      restartRef.current = () => {};
    };
  }, [load, generation]);
  return useCallback(() => restartRef.current(), []);
}

export function GpuCostDashboard({
  api,
  scopeLabel: scopeLabelOverride,
  viewerAccountId,
}: {
  // Bound to one scope: what is shown is exactly what "Terminate all" ends.
  api: GpuCostDashboardApi;
  // Completes "GPU pods ..." in headings and confirmations; defaults to a
  // label derived from the API's scope.
  scopeLabel?: string;
  // The signed-in account, so its own pods read "You".
  viewerAccountId?: string;
}) {
  // Callers may pass a new but equal API object on every render: the loaders
  // read it from a ref and depend only on the scope's value.
  const apiRef = useRef(api);
  apiRef.current = api;
  // the viewer is part of every cache key: another account's data is never
  // shown under this one
  const scopeKey = JSON.stringify([api.scope, viewerAccountId ?? null]);
  const scopeLabel = scopeLabelOverride ?? defaultScopeLabel(api.scope);
  const [period, setPeriod] = useState<GpuSpendPeriod>("7d");
  const [groupBy, setGroupBy] = useState<GpuSpendGroupBy>("beneficiary");
  // Each result is stored with the query it answers, and only shown while that
  // query is current, so new labels are never put on old numbers.
  const [podsResult, setPodsResult] = useState<{
    key: string;
    pods: DashboardPod[];
    at: number;
  }>();
  const [spendResult, setSpendResult] = useState<{
    key: string;
    spend: GpuSpendResult;
    at: number;
  }>();
  const [budgetResult, setBudgetResult] = useState<{
    key: string;
    budget: GpuBudget;
  }>();
  const [names, setNames] = useState<Record<string, string | undefined>>({});
  // Pods and spend load and fail independently: a spend outage must not hide
  // the pod list and its per-pod terminate buttons, nor the reverse. Errors
  // are kept per query and cleared only by a successful read, so a cached
  // result after a failed refresh is shown as last known, never live.
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
  // the pause the kill switch reported in this session
  const [paused, setPaused] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const podsGeneration = useRef(0);
  const spendGeneration = useRef(0);

  const spendKey = JSON.stringify([scopeKey, period, groupBy]);
  const podsLoaded = podsResult?.key === scopeKey ? podsResult : undefined;
  const spendLoaded = spendResult?.key === spendKey ? spendResult : undefined;
  const pods = podsLoaded?.pods;
  const spend = spendLoaded?.spend;
  const budget =
    budgetResult?.key === scopeKey ? budgetResult.budget : undefined;
  const podsError = podsFailure?.key === scopeKey ? podsFailure.message : "";
  const spendError = spendFailure?.key === spendKey ? spendFailure.message : "";
  // Fresh: loaded for this query, recently, and not followed by a failure.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  const podsAged = podsLoaded != null && now - podsLoaded.at > STALE_MS;
  const spendAged = spendLoaded != null && now - spendLoaded.at > STALE_MS;
  const podsFresh = pods != null && !podsError && !podsAged;
  const spendFresh = spend != null && !spendError && !spendAged;

  const refreshPods = useCallback(async () => {
    const version = ++podsGeneration.current;
    const current = apiRef.current;
    // the budget is a side read: its failure never hides the pods
    const budgetRead = current.budget?.().catch(() => undefined);
    try {
      const next = await current.pods();
      if (podsGeneration.current !== version) return;
      const at = Date.now();
      setPodsResult({ key: scopeKey, pods: next, at });
      setNow(at);
      setPodsFailure(undefined);
    } catch (err) {
      if (podsGeneration.current === version)
        setPodsFailure({ key: scopeKey, message: errorText(err) });
    }
    const b = await budgetRead;
    if (b != null && podsGeneration.current === version)
      setBudgetResult({ key: scopeKey, budget: b });
  }, [scopeKey]);

  const refreshSpend = useCallback(async () => {
    const version = ++spendGeneration.current;
    const current = apiRef.current;
    const key = JSON.stringify([scopeKey, period, groupBy]);
    try {
      const next = await current.spend({
        since: periodSince(period, Date.now()),
        group_by: groupBy,
      });
      if (spendGeneration.current !== version) return;
      const at = Date.now();
      setSpendResult({ key, spend: next, at });
      setNow(at);
      setSpendFailure(undefined);
      if (groupBy === "beneficiary" && current.names) {
        const ids = next.rows.map((row) => row.key).filter(Boolean);
        if (ids.length > 0) {
          current
            .names(ids)
            .then((found) => setNames((old) => ({ ...old, ...found })))
            .catch(() => {});
        }
      }
    } catch (err) {
      if (spendGeneration.current === version)
        setSpendFailure({ key, message: errorText(err) });
    }
  }, [scopeKey, period, groupBy]);

  // Each endpoint polls itself: the next request is scheduled only after the
  // previous one settles, so a slow endpoint never piles up requests. A query
  // change restarts the loop, and its generation supersedes the old request.
  const restartPods = usePolling(refreshPods, podsGeneration);
  const restartSpend = usePolling(refreshSpend, spendGeneration);

  function refresh() {
    restartPods();
    restartSpend();
  }

  const live = useMemo(() => livePods(pods ?? []), [pods]);
  const rate = useMemo(() => hourlyRate(live), [live]);
  const projectTitle = useCallback(
    (project_id: string) => apiRef.current.projectTitle?.(project_id),
    [],
  );

  async function runConfirmed() {
    if (!confirm) return;
    setBusy(true);
    setActionError("");
    try {
      if (confirm.kind === "all") {
        const result = await apiRef.current.killSwitch();
        setPaused(result.paused);
        setNotice(
          [
            `Marked ${plural(result.marked, "pod")} for termination.`,
            result.remaining > 0
              ? `${plural(result.remaining, "pod")} still terminating; CoCalc keeps at it.`
              : "",
            result.paused ? "New launches are paused." : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
      } else {
        await apiRef.current.terminate({ pod_id: confirm.pod.id });
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

  async function resume() {
    const resumeApi = apiRef.current.resume;
    if (!resumeApi || busy) return;
    setBusy(true);
    setResumeError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        await resumeApi();
      });
      if (completed) {
        setPaused(false);
        setNotice("New launches are allowed again.");
      }
    } catch (err) {
      setResumeError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const groupLabel = GROUP_BY_LABELS[groupBy];
  // Missing numbers are never shown as zero.
  const podsPending = podsError || podsAged ? "unavailable" : "…";
  const spendPending = spendError || spendAged ? "unavailable" : "…";
  const spendValue = (value: string) =>
    spendFresh
      ? value
      : spendLoaded
        ? asOf(value, spendLoaded.at)
        : spendPending;
  const held = spend ? toDecimal(spend.totals.held_usd) : toDecimal(0);

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
      {paused && api.resume && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          title="New launches are paused"
          description="Terminate all paused launches with this key. Resume when you are ready (you'll be asked to sign in again)."
          action={
            <Button disabled={busy} onClick={() => void resume()}>
              Resume launches
            </Button>
          }
        />
      )}
      {resumeError && (
        <Alert
          role="alert"
          type="error"
          showIcon
          style={{ marginTop: 8 }}
          title={resumeError}
        />
      )}

      <Space wrap size="large" style={{ marginTop: 12 }}>
        <span>
          <Typography.Text type="secondary">Live pods: </Typography.Text>
          <strong>
            {podsFresh
              ? live.length
              : podsLoaded
                ? asOf(`${live.length}`, podsLoaded.at)
                : podsPending}
          </strong>
        </span>
        <span>
          <Typography.Text type="secondary">Live rate: </Typography.Text>
          <strong>
            {podsFresh
              ? rateText(rate)
              : podsLoaded
                ? asOf(rateText(rate), podsLoaded.at)
                : podsPending}
          </strong>
        </span>
        <span>
          <Typography.Text type="secondary">
            Spent ({PERIOD_LABELS[period].toLowerCase()}):{" "}
          </Typography.Text>
          <strong>
            {spendValue(spend ? moneyToCurrency(spend.totals.spent_usd) : "")}
          </strong>
        </span>
        <span>
          <Typography.Text type="secondary">
            Live pods so far (estimate):{" "}
          </Typography.Text>
          <strong>
            {spendValue(
              spend ? moneyToCurrency(spend.totals.live_estimate_usd) : "",
            )}
          </strong>
        </span>
        {held.gt(0) && (
          <span>
            <Typography.Text type="secondary">
              Held (unconfirmed):{" "}
            </Typography.Text>
            <strong>
              {spendValue(moneyToCurrency(spend!.totals.held_usd))}
            </strong>
          </span>
        )}
        {budget && (
          <span>
            <Typography.Text type="secondary">Budget: </Typography.Text>
            <strong>
              {budget.over_budget_usd
                ? `over by ${moneyToCurrency(budget.over_budget_usd)}`
                : `${moneyToCurrency(budget.available_usd)} left of ${moneyToCurrency(budget.authorized_usd)}`}
            </strong>
          </span>
        )}
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
      {podsLoaded && (podsError || podsAged) && (
        <Typography.Paragraph type="secondary">
          Showing the pods last loaded at {formatTime(podsLoaded.at)}; not
          updating, so they may be out of date.
        </Typography.Paragraph>
      )}
      <Table<DashboardPod>
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
            render: (_, pod) => podOwnerLabel(pod, viewerAccountId),
          },
          {
            title: "GPU",
            key: "gpu",
            render: (_, pod) => podGpuLabel(pod),
          },
          {
            title: "State",
            key: "state",
            render: (_, pod) => podStateLabel(pod),
          },
          {
            title: "Rate",
            key: "rate",
            align: "right",
            render: (_, pod) =>
              pod.cost_per_hr == null
                ? "not priced yet"
                : `${moneyToCurrency(pod.cost_per_hr)}/hour`,
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
      {spendLoaded && (spendError || spendAged) && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
          Showing spending last loaded at {formatTime(spendLoaded.at)}; not
          updating, so it may be out of date.
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
          {
            title: groupLabel,
            key: "label",
            render: (_, row) =>
              spendRowLabel(row, groupBy, {
                viewerAccountId,
                names,
                projectTitle,
              }),
          },
          {
            title: "Spent",
            key: "spent",
            align: "right",
            render: (_, row) => moneyToCurrency(row.spent_usd),
          },
          {
            title: "Live (estimate)",
            key: "live",
            align: "right",
            render: (_, row) => moneyToCurrency(row.live_estimate_usd),
          },
          ...(held.gt(0)
            ? [
                {
                  title: "Held (unconfirmed)",
                  key: "held",
                  align: "right" as const,
                  render: (_, row) => moneyToCurrency(row.held_usd),
                },
              ]
            : []),
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
          As of {formatTime(spend.as_of)}.{" "}
          {spend.truncated ? "Only the largest groups are listed. " : ""}
          Spent is what finished pods cost. Live pods are CoCalc&apos;s estimate
          so far (cost per hour × time since the pod started running), settled
          when they end.
          {held.gt(0)
            ? " Held amounts belong to pods CoCalc couldn't confirm; see the alerts."
            : ""}
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
            {podGpuLabel(confirm.pod)} for{" "}
            {podOwnerLabel(confirm.pod, viewerAccountId)}
            {confirm.pod.cost_per_hr == null
              ? " (not priced yet)."
              : `, at ${moneyToCurrency(confirm.pod.cost_per_hr)}/hour.`}
          </p>
        ) : (
          <p>
            This terminates every GPU pod {scopeLabel}, including pods started
            by agents and students
            {api.resume
              ? ", and pauses new launches until you resume"
              : ""}.{" "}
            {podsFresh
              ? `${live.length === 1 ? "1 pod is" : `${live.length} pods are`} live now, at ${rateText(rate)}.`
              : podsLoaded
                ? `The pod list may be out of date: when it was last loaded at ${formatTime(podsLoaded.at)}, ${live.length === 1 ? "1 pod was" : `${live.length} pods were`} live, at ${rateText(rate)}. Every GPU pod ${scopeLabel} will be terminated, whatever the list shows.`
                : `The pod list is unavailable right now. Every GPU pod ${scopeLabel} will be terminated.`}
          </p>
        )}
        <p>
          Terminated pods and their disks are deleted at RunPod and can&apos;t
          be restarted.
        </p>
        {actionError && (
          <Alert role="alert" type="error" showIcon title={actionError} />
        )}
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </section>
  );
}
