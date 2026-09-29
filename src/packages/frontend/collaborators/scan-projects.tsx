/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Input, Modal, Progress, Space } from "antd";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { progressBarStatus } from "@cocalc/frontend/lro/utils";
import { uuid } from "@cocalc/util/misc";
import { scanChildTerminal } from "@cocalc/util/collaboration-scan-batch";
import type {
  ScanBatchSummary,
  ScanProjectsRequest,
  ScanProjectsResponse,
} from "@cocalc/util/collaboration-scan-batch";
import type { DirectoryApi } from "./workspace-api";

export function ScanProjects({
  api,
  accountId,
}: {
  api: DirectoryApi;
  accountId: string;
}) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<ScanProjectsResponse>();
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
  async function projects(after?: string) {
    setPage(await call({ action: "projects", search, after }));
  }
  async function refresh(after?: string) {
    resultAfter.current = after;
    await call({ action: "status", op_id: operation?.op_id, after });
  }
  useEffect(() => {
    if (!open) return;
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
  }, [open, busy, operation?.op_id]);
  if (!api.scanProjects) return null;
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
          void perform(async () => {
            const saved = sessionStorage.getItem(storageKey);
            if (saved) pending.current = JSON.parse(saved);
            await call({ action: "status" });
            await projects();
          });
        }}
      >
        Scan projects
      </Button>
      <Modal
        title="Scan projects"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={640}
        destroyOnHidden
      >
        <KeyboardBoundary>
          <p>
            Discover supported resources in selected project storage. Normal
            open and write activity indexes resources automatically. Scan never
            starts project compute.
          </p>
          {!enabled && (
            <p>
              New scans are disabled by the administrator. Existing operations
              remain available for inspection and cancellation.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(() => projects());
            }}
          >
            <label htmlFor={`scan-search-${accountId}`}>Search projects</label>
            <Space.Compact style={{ width: "100%" }}>
              <Input
                id={`scan-search-${accountId}`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button htmlType="submit" disabled={busy}>
                Search
              </Button>
            </Space.Compact>
          </form>
          <Checkbox
            checked={all}
            disabled={!!active || busy || !enabled}
            onChange={(event) => {
              setAll(event.target.checked);
              pending.current = undefined;
              sessionStorage.removeItem(storageKey);
            }}
          >
            Select all eligible projects ({page?.total ?? 0})
          </Checkbox>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              maxHeight: 240,
              overflowY: "auto",
            }}
            aria-label="Projects to scan"
            tabIndex={0}
          >
            {page?.projects?.map((project) => (
              <li key={project.project_id}>
                <Checkbox
                  checked={all || selected.includes(project.project_id)}
                  disabled={all || !!active || busy || !enabled}
                  onChange={(event) => {
                    setSelected((ids) =>
                      event.target.checked
                        ? [...ids, project.project_id]
                        : ids.filter((id) => id !== project.project_id),
                    );
                    pending.current = undefined;
                    sessionStorage.removeItem(storageKey);
                  }}
                >
                  {project.title}
                </Checkbox>
              </li>
            ))}
          </ul>
          <Space wrap>
            <Button
              disabled={busy}
              onClick={() => void perform(() => projects())}
            >
              First project page
            </Button>
            <Button
              disabled={busy || !page?.next}
              onClick={() => void perform(() => projects(page?.next))}
            >
              Next project page
            </Button>
          </Space>
          <p>
            {all
              ? `All eligible projects (${page?.total ?? 0})`
              : `${selected.length} projects`}{" "}
            selected. The server fixes and authorizes the selection when you
            start.
          </p>
          {cooldown > now && (
            <p>
              Next scan available at {new Date(cooldown).toLocaleTimeString()}.
            </p>
          )}
          <Space wrap>
            <Button
              type="primary"
              disabled={
                busy ||
                !!active ||
                !enabled ||
                cooldown > now ||
                (!all && !selected.length && !pending.current)
              }
              onClick={() =>
                void perform(async () => {
                  const request = pending.current ?? {
                    action: "start" as const,
                    request_id: uuid(),
                    project_ids: all ? ("all" as const) : selected,
                  };
                  // Save before RPC. A failure to persist must prevent submission.
                  sessionStorage.setItem(storageKey, JSON.stringify(request));
                  pending.current = request;
                  const response = await call(request);
                  if (response.operation) {
                    pending.current = undefined;
                    sessionStorage.removeItem(storageKey);
                  }
                })
              }
            >
              {pending.current ? "Retry same scan request" : "Start scan"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => void perform(() => refresh())}
            >
              Refresh scan status
            </Button>
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
          </Space>
          {operation && (
            <section aria-label="Scan progress">
              <p role="status" aria-live="polite">
                {operation.cancelling
                  ? "Cancelling — waiting for running projects to stop."
                  : active
                    ? "Scanning projects."
                    : "Processing ended."}{" "}
                {operation.processed} of {operation.total} projects processed.
              </p>
              <Progress
                aria-label="Projects processed"
                percent={Math.round(
                  (100 * operation.processed) / operation.total,
                )}
                status={progressBarStatus(operation.status)}
              />
              <p>
                {[
                  "successful",
                  "failed",
                  "unavailable",
                  "truncated",
                  "cancelled",
                  "deferred",
                ]
                  .map((state) => `${state}: ${operation.counts[state] ?? 0}`)
                  .join("; ")}
              </p>
              <ul aria-label="Project scan results" style={{ paddingLeft: 20 }}>
                {operation.children.map((child) => (
                  <li
                    key={child.project_id}
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {child.project_id}: {child.state}
                    {child.entries != null
                      ? `; ${child.entries} entries examined`
                      : ""}
                    {child.candidates != null
                      ? `; ${child.candidates} sources found`
                      : ""}
                    . {child.message}
                    {child.next_eligible_at && child.next_eligible_at > now
                      ? ` Next eligible at ${new Date(child.next_eligible_at).toLocaleTimeString()}.`
                      : ""}
                  </li>
                ))}
              </ul>
              <Space wrap>
                <Button
                  disabled={busy}
                  onClick={() => void perform(() => refresh())}
                >
                  First result page
                </Button>
                <Button
                  disabled={busy || !operation.next}
                  onClick={() => void perform(() => refresh(operation.next))}
                >
                  Next result page
                </Button>
                {!active && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const ids: string[] = [];
                        let after: string | undefined;
                        do {
                          const result = await api.scanProjects!({
                            action: "status",
                            op_id: operation.op_id,
                            after,
                          });
                          for (const child of result.operation?.children ?? [])
                            if (
                              scanChildTerminal(child.state) &&
                              child.state !== "successful"
                            )
                              ids.push(child.project_id);
                          after = result.operation?.next;
                        } while (after);
                        setAll(false);
                        setSelected(ids);
                        pending.current = undefined;
                        sessionStorage.removeItem(storageKey);
                      })
                    }
                  >
                    Select unsuccessful projects for retry
                  </Button>
                )}
              </Space>
              <p>
                Completed traversal is best-effort under concurrent writes, not
                a filesystem snapshot. People views may still be catching up.
                Cancellation retains metadata already indexed.
              </p>
              <details>
                <summary>Operation identifier</summary>
                {operation.op_id}
              </details>
            </section>
          )}
        </KeyboardBoundary>
      </Modal>
    </>
  );
}
