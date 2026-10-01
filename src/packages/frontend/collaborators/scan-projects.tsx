/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Input, Progress, Space, Tag } from "antd";
import { SearchOutlined, SyncOutlined } from "@ant-design/icons";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import "./scan-projects.css";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { VirtualCheckboxList } from "@cocalc/frontend/components/virtual-checkbox-list";
import { DocsLink } from "@cocalc/frontend/docs/link";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { useDebounce } from "use-debounce";
import { uuid } from "@cocalc/util/misc";
import { scanChildTerminal } from "@cocalc/util/collaboration-scan-batch";
import { collaborationSourceIssueMessage } from "@cocalc/util/collaboration-census";
import type {
  ScanBatchSummary,
  ScanProjectsRequest,
  ScanProjectChoice,
} from "@cocalc/util/collaboration-scan-batch";
import type { DirectoryApi } from "./workspace-api";

export function ScanFiles({
  api,
  accountId,
}: {
  api: DirectoryApi;
  accountId: string;
}) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const projectTitles = useRef(new Map<string, string>());
  const [projectChoices, setProjectChoices] = useState<ScanProjectChoice[]>([]);
  const projectsActions = useActions("projects");
  const hostInfo = useTypedRedux("projects", "host_info");
  const projectsList = useMemo(
    () =>
      projectChoices.filter((project) => {
        const host = hostInfo?.get(project.host_id ?? "");
        return (
          host?.get("status") === "running" &&
          host.get("online") === true &&
          host.get("ready") === true &&
          !host.get("reason_unavailable")
        );
      }),
    [projectChoices, hostInfo],
  );
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [filter] = useDebounce(search, 150);
  const filteredProjects = useMemo(
    () =>
      projectsList.filter((p) =>
        (p.title || "Untitled project")
          .toLocaleLowerCase()
          .includes(filter.trim().toLocaleLowerCase()),
      ),
    [projectsList, filter],
  );
  const changedProjects = useMemo(
    () => projectsList.filter((p) => p.changed_since_scan),
    [projectsList],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [operation, setOperation] = useState<ScanBatchSummary>();
  const [cooldown, setCooldown] = useState(0);
  const [now, setNow] = useState(Date.now());
  const pending = useRef<
    Extract<ScanProjectsRequest, { action: "start" }> | undefined
  >(undefined);
  const mounted = useRef(true);
  const resultAfter = useRef<string | undefined>(undefined);
  const observation = useRef(0);
  const storageKey = `people-scan-batch:${accountId}`;
  const active = operation && ["queued", "running"].includes(operation.status);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const available = new Set(
      projectsList.map((project) => project.project_id),
    );
    setSelected((value) => {
      const next = value.filter((id) => available.has(id));
      return next.length === value.length ? value : next;
    });
  }, [projectsList]);
  async function call(request: ScanProjectsRequest) {
    const sequence =
      request.action === "projects"
        ? observation.current
        : ++observation.current;
    const result = await api.scanProjects!(request);
    if (!mounted.current) return result;
    setEnabled(result.enabled);
    if (result.operation && sequence === observation.current) {
      setOperation(result.operation);
      setCooldown(result.operation.next_eligible_at);
    }
    if (result.next_eligible_at) setCooldown(result.next_eligible_at);
    return result;
  }
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch {
      if (mounted.current)
        setError(
          "The outcome could not be confirmed. Refresh status or retry the same saved request; no replacement scan was started.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function projects() {
    setLoadingProjects(true);
    try {
      const items = new Map<string, ScanProjectChoice>();
      let after: string | undefined;
      do {
        const result = await call({ action: "projects", after, limit: 250 });
        for (const project of result.projects ?? []) {
          items.set(project.project_id, project);
          projectTitles.current.set(project.project_id, project.title);
        }
        after = result.next;
        if (!mounted.current) return;
        setProjectChoices([...items.values()]);
      } while (after);
      // Share the routed, cached status used by project views. Limit concurrent
      // lookups and resolve each host once, regardless of its project count.
      const hosts = [
        ...new Set(
          [...items.values()]
            .map((p) => p.host_id)
            .filter((host): host is string => !!host),
        ),
      ];
      let next = 0;
      void Promise.all(
        Array.from({ length: Math.min(4, hosts.length) }, async () => {
          while (next < hosts.length && mounted.current) {
            await projectsActions
              .ensure_host_info(hosts[next++])
              .catch(() => {});
          }
        }),
      );
    } finally {
      if (mounted.current) setLoadingProjects(false);
    }
  }
  async function refresh(after?: string) {
    resultAfter.current = after;
    await call({ action: "status", op_id: operation?.op_id, after });
    if (!after) await projects();
  }
  useEffect(() => {
    if (!api.scanProjects) return;
    void perform(async () => {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) pending.current = JSON.parse(saved);
      await call({ action: "status" });
      await projects();
    });
  }, [api, accountId]);
  useEffect(() => {
    if (!api.scanProjects) return;
    let stopped = false;
    const timer = setInterval(() => {
      setNow(Date.now());
      // Observation only. Reopening and polling never submit filesystem work.
      if (!busy && !stopped)
        void call({
          action: "status",
          op_id: operation?.op_id,
          after: resultAfter.current,
        }).catch(() => {});
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [busy, operation?.op_id]);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active)
      void projects().catch(() =>
        setError(
          "Project selection could not be refreshed. Use Refresh scan status to try again.",
        ),
      );
    wasActive.current = !!active;
  }, [active]);
  async function startScan() {
    const request = pending.current ?? {
      action: "start" as const,
      request_id: uuid(),
      project_ids: all
        ? projectsList.map((project) => project.project_id)
        : selected.filter((id) =>
            projectsList.some((project) => project.project_id === id),
          ),
    };
    // Save before RPC. A failure to persist must prevent submission.
    sessionStorage.setItem(storageKey, JSON.stringify(request));
    pending.current = request;
    const response = await call(request);
    if (response.operation) {
      pending.current = undefined;
      sessionStorage.removeItem(storageKey);
    }
  }
  async function selectUnsuccessful() {
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const result = await api.scanProjects!({
        action: "status",
        op_id: operation!.op_id,
        after,
      });
      for (const child of result.operation?.children ?? [])
        if (scanChildTerminal(child.state) && child.state !== "successful")
          ids.push(child.project_id);
      after = result.operation?.next;
    } while (after);
    setAll(false);
    setSelected(ids);
    pending.current = undefined;
    sessionStorage.removeItem(storageKey);
  }
  function clearPending() {
    pending.current = undefined;
    sessionStorage.removeItem(storageKey);
  }
  if (!api.scanProjects) return null;
  const selectedCount = all ? projectsList.length : selected.length;
  const outcomes = [
    ["successful", "Scanned"],
    ["unavailable", "Unavailable"],
    ["failed", "Failed"],
    ["truncated", "Partial"],
    ["cancelled", "Cancelled"],
    ["deferred", "Deferred"],
  ] as const;
  const unsuccessful =
    operation &&
    outcomes.some(
      ([state]) => state !== "successful" && (operation.counts[state] ?? 0) > 0,
    );
  const scanned =
    (operation?.counts.successful ?? 0) + (operation?.counts.truncated ?? 0);
  const cancelled =
    operation?.status === "canceled" || (operation?.counts.cancelled ?? 0) > 0;
  const selectionDisabled = !!active || busy || loadingProjects || !enabled;
  const panelStyle = {
    background: UI_COLORS.surface,
    color: UI_COLORS.text,
    borderColor: UI_COLORS.border,
  };
  return (
    <div className="people-scan">
      <KeyboardBoundary>
        <header className="people-scan-heading">
          <h2>Scan files</h2>
          <p style={{ color: UI_COLORS.muted }}>
            <DocsLink drawer slug="collaboration/scan-files">
              How indexing and manual scans work
            </DocsLink>
          </p>
        </header>
        {!enabled && (
          <Alert
            type="info"
            showIcon
            title="New scans are disabled by the administrator."
            description="You can still inspect or cancel an existing scan."
          />
        )}
        {error && <Alert type="warning" showIcon title={error} role="alert" />}
        <section
          className="people-scan-panel"
          style={panelStyle}
          aria-label="Choose projects"
        >
          <div className="people-scan-picker-heading">
            <h3>Choose projects</h3>
            <span style={{ color: UI_COLORS.muted }}>
              {selectedCount
                ? `${selectedCount} selected`
                : "Select projects to scan"}
            </span>
          </div>
          <div className="people-scan-search">
            <label
              className="people-scan-sr-only"
              htmlFor={`scan-search-${accountId}`}
            >
              Search projects
            </label>
            <Input
              id={`scan-search-${accountId}`}
              value={search}
              prefix={<SearchOutlined aria-hidden />}
              placeholder="Search projects…"
              allowClear
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div
            className="people-scan-selection"
            style={{ borderColor: UI_COLORS.border }}
          >
            <Checkbox
              checked={
                all ||
                (projectsList.length > 0 &&
                  selected.length === projectsList.length)
              }
              indeterminate={
                !all &&
                selected.length > 0 &&
                selected.length < projectsList.length
              }
              disabled={selectionDisabled || !projectsList.length}
              aria-label={`Select all eligible projects (${projectsList.length})`}
              onChange={(event) => {
                setAll(event.target.checked);
                setSelected(
                  event.target.checked
                    ? projectsList.map((p) => p.project_id)
                    : [],
                );
                clearPending();
              }}
            >
              All eligible projects ({projectsList.length})
            </Checkbox>
            <Button
              type="text"
              disabled={selectionDisabled || !changedProjects.length}
              onClick={() => {
                setAll(false);
                setSelected(changedProjects.map((p) => p.project_id));
                clearPending();
              }}
            >
              Changed since last scan ({changedProjects.length})
            </Button>
          </div>
          <VirtualCheckboxList
            items={filteredProjects}
            itemId={(p) => p.project_id}
            itemLabel={(p) => p.title?.trim() || "Untitled project"}
            selected={all ? projectsList.map((p) => p.project_id) : selected}
            disabled={selectionDisabled}
            onChange={(ids) => {
              setAll(false);
              setSelected(ids);
              clearPending();
            }}
            label="Projects to scan"
            className="people-scan-projects"
          />
          {(!filteredProjects.length || loadingProjects) && (
            <p
              className="people-scan-empty"
              aria-live="polite"
              style={{ color: UI_COLORS.muted }}
            >
              {loadingProjects
                ? "Loading projects…"
                : filter
                  ? "No projects match your search."
                  : "No eligible projects."}
            </p>
          )}
          <div
            className="people-scan-actions"
            style={{ borderColor: UI_COLORS.border }}
          >
            <div style={{ color: UI_COLORS.muted }}>
              <div>Scans files without starting project compute.</div>
              {selected.length === 1 &&
                projectsList
                  .filter((p) => p.project_id === selected[0])
                  .map((p) => (
                    <small key={p.project_id} style={{ display: "block" }}>
                      {p.last_success != null
                        ? `Last successful scan: ${new Date(p.last_success).toLocaleString()}. `
                        : "No successful scan yet. "}
                      {p.last_fail != null &&
                        `Last failed scan: ${new Date(p.last_fail).toLocaleString()}.`}
                    </small>
                  ))}
              {cooldown > now && (
                <small>
                  Scan request cooldown. Next scan at{" "}
                  {new Date(cooldown).toLocaleTimeString()}.
                </small>
              )}
            </div>
            <Button
              type="primary"
              disabled={
                busy ||
                loadingProjects ||
                !!active ||
                !enabled ||
                cooldown > now ||
                (!all && !selected.length && !pending.current)
              }
              onClick={() => void perform(startScan)}
            >
              {pending.current ? "Retry same scan request" : "Start scan"}
            </Button>
          </div>
        </section>
        {operation && (
          <section
            className="people-scan-panel people-scan-results"
            style={panelStyle}
            aria-label="Scan progress"
          >
            <div className="people-scan-result-heading">
              <div role="status" aria-live="polite">
                <h3>
                  {operation.cancelling
                    ? "Cancelling scan"
                    : active
                      ? "Scanning files"
                      : cancelled
                        ? "Scan ended after cancellation"
                        : unsuccessful
                          ? "Scan finished with exceptions"
                          : "Scan finished"}
                </h3>
                <span style={{ color: UI_COLORS.muted }}>
                  {scanned} of {operation.total} projects scanned.
                  {!!active &&
                    ` ${operation.total - operation.processed} pending.`}
                  {operation.cancelling && " Waiting for active scans to stop."}
                </span>
              </div>
              <Button
                type="text"
                icon={<SyncOutlined />}
                aria-label="Refresh scan status"
                disabled={busy}
                onClick={() => void perform(() => refresh())}
              />
            </div>
            <Progress
              aria-label="Scan progress"
              percent={
                operation.total
                  ? Math.round((100 * operation.processed) / operation.total)
                  : 0
              }
              showInfo={false}
              status={
                active
                  ? "active"
                  : (operation.counts.failed ?? 0) > 0 && !cancelled
                    ? "exception"
                    : "normal"
              }
              strokeColor={cancelled ? UI_COLORS.muted : undefined}
            />
            <div className="people-scan-outcomes">
              {outcomes
                .filter(([state]) => (operation.counts[state] ?? 0) > 0)
                .map(([state, label]) => (
                  <Tag key={state}>
                    {operation.counts[state]} {label.toLowerCase()}
                  </Tag>
                ))}
            </div>
            {active && (
              <Button
                disabled={busy || operation.cancelling}
                onClick={() =>
                  void perform(async () => {
                    await call({ action: "cancel", op_id: operation.op_id });
                  })
                }
              >
                Cancel scan
              </Button>
            )}
            <details className="people-scan-details">
              <summary>Scan details</summary>
              <ul aria-label="Project scan results">
                {operation.children.map((child) => (
                  <li key={child.project_id}>
                    <div className="people-scan-child-heading">
                      <strong>
                        {child.title?.trim() ||
                          projectTitles.current.get(child.project_id)?.trim() ||
                          "Untitled project"}
                      </strong>
                      <Tag>
                        {outcomes.find(
                          ([state]) => state === child.state,
                        )?.[1] ?? child.state}
                      </Tag>
                    </div>
                    <p style={{ color: UI_COLORS.muted }}>
                      {child.candidates === 0 && child.last_success != null
                        ? "No changed chat files to index. "
                        : child.indexed != null && child.candidates != null
                          ? `${child.indexed} of ${child.candidates} chat files indexed. `
                          : child.candidates != null
                            ? `${child.candidates} chat files found. `
                            : ""}
                      {child.message}
                      {child.next_eligible_at && child.next_eligible_at > now
                        ? ` Next eligible at ${new Date(child.next_eligible_at).toLocaleTimeString()}.`
                        : ""}
                    </p>
                    {(child.last_success != null ||
                      child.last_fail != null) && (
                      <p style={{ color: UI_COLORS.muted }}>
                        {child.last_success != null &&
                          `Last successful scan: ${new Date(child.last_success).toLocaleString()}. `}
                        {child.last_fail != null &&
                          `Last failed scan: ${new Date(child.last_fail).toLocaleString()}. `}
                        {child.last_fail != null &&
                          (child.last_success == null ||
                            child.last_fail > child.last_success) &&
                          "Changes since the last successful scan will be retried."}
                      </p>
                    )}
                    {!!child.source_issues?.length && (
                      <ul aria-label="Files needing attention">
                        {child.source_issues.map((issue) => (
                          <li key={issue.chat_path}>
                            <code>{issue.chat_path}</code>:{" "}
                            {collaborationSourceIssueMessage(issue.reason)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
              {(operation.next || resultAfter.current) && (
                <Space wrap>
                  <Button
                    size="small"
                    disabled={busy || !resultAfter.current}
                    onClick={() => void perform(() => refresh())}
                  >
                    First result page
                  </Button>
                  <Button
                    size="small"
                    disabled={busy || !operation.next}
                    onClick={() => void perform(() => refresh(operation.next))}
                  >
                    Next result page
                  </Button>
                </Space>
              )}
              <p style={{ color: UI_COLORS.muted }}>
                Files may change during a scan. Indexed results may take a
                moment to appear. Cancelling keeps results already indexed.
              </p>
              <p
                className="people-scan-operation"
                style={{ color: UI_COLORS.muted }}
              >
                Operation: {operation.op_id}
              </p>
            </details>
            {!active && unsuccessful && (
              <Button
                type="link"
                className="people-scan-retry"
                disabled={busy}
                onClick={() => void perform(selectUnsuccessful)}
              >
                Select unsuccessful projects for retry
              </Button>
            )}
          </section>
        )}
        {!operation && (
          <Button
            type="text"
            icon={<SyncOutlined />}
            disabled={busy}
            onClick={() => void perform(() => refresh())}
          >
            Refresh scan status
          </Button>
        )}
      </KeyboardBoundary>
    </div>
  );
}
