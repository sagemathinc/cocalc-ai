import { lazy, Suspense, useEffect, useState } from "react";
import { Button, Drawer, Spin } from "antd";
import {
  useProjectFromMap,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { useProjectRunQuota } from "@cocalc/frontend/project/use-project-run-quota";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { normalizeProjectStateForDisplay } from "@cocalc/frontend/projects/host-operational";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { agentProjectTitle } from "./project-title";
import { ProjectUpdateIndicator } from "@cocalc/frontend/project/page/project-version-update";
import { Icon } from "@cocalc/frontend/components";

const ProjectDetails = lazy(() => import("./project-details"));
const WIDTH_KEY = "cocalc-agents-project-drawer-width";

export function projectStatusLabel(state?: string, network?: unknown): string {
  if (network === false || network === 0) return "Internet access blocked";
  switch (state) {
    case "running":
      return "Running";
    case "starting":
      return "Starting…";
    case "stopping":
      return "Stopping…";
    case "opened":
    case "closed":
    case "stopped":
      return "Stopped";
    default:
      return state ? `Project ${state}` : "Status unknown";
  }
}

const RESTART_LABEL_MAX_MS = 5 * 60_000;

// A restart passes through stopping, stopped and starting (and is shown as
// "starting" before it even stops). Say "Restarting…" for all of it: from the
// request until the project runs again with a new start time.
function useRestarting(
  projectId: string,
  state: string | undefined,
  startedAt: string | undefined,
): boolean {
  const request = useTypedRedux({ project_id: projectId }, "restart_request");
  const token = request?.get?.("token") as string | undefined;
  const [restart, setRestart] = useState<{
    token: string;
    startedAt?: string;
    at: number;
  }>();
  useEffect(() => {
    if (token && token !== restart?.token) {
      setRestart({ token, startedAt, at: Date.now() });
    }
  }, [token]);
  useEffect(() => {
    if (!restart) return;
    if (state === "running" && startedAt !== restart.startedAt) {
      setRestart(undefined);
      return;
    }
    const timer = setTimeout(
      () => setRestart(undefined),
      Math.max(0, restart.at + RESTART_LABEL_MAX_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [restart, state, startedAt]);
  return restart != null;
}

// A dot in the header says what the words used to: green running, amber
// changing, grey stopped, red blocked. The words stay in the tooltip.
export function projectStatusColor(
  state?: string,
  network?: unknown,
  blocked?: boolean,
): string {
  if (blocked || network === false || network === 0) return "#cf1322";
  switch (state) {
    case "running":
      return "#52c41a";
    case "starting":
    case "stopping":
      return "#faad14";
    default:
      return "#8c8c8c";
  }
}

export function AgentProjectStatus({
  agent,
  active = true,
}: {
  agent: NamedAgent;
  active?: boolean;
}) {
  const projectId = agent.endpoint.project_id;
  const project = useProjectFromMap<any>(projectId);
  const { runQuota } = useProjectRunQuota(projectId, { enabled: active });
  const egressError = useTypedRedux("account", "managed_egress_blocked_error");
  const hostId = project?.get("host_id");
  const hostInfo = useHostInfo(hostId);
  const state = normalizeProjectStateForDisplay({
    projectState: project?.getIn(["state", "state"]),
    hostId,
    hostInfo,
  });
  const restarting = useRestarting(
    projectId,
    state,
    project?.getIn(["state", "started_at"]),
  );
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(WIDTH_KEY)) || 560;
    } catch {
      return 560;
    }
  });
  const title = agentProjectTitle(agent, project?.get("title"));
  const status = egressError
    ? "Account internet usage blocked"
    : restarting
      ? "Restarting…"
      : projectStatusLabel(state, runQuota?.network);
  const label = `Project: ${title} · ${status}`;
  const dot = projectStatusColor(
    restarting ? "starting" : state,
    runQuota?.network,
    !!egressError,
  );
  function resize(value: number) {
    const next = Math.max(280, Math.min(window.innerWidth, value));
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {}
  }
  return (
    <>
      <Button
        type="text"
        size="small"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        style={{
          color: "inherit",
          maxWidth: "100%",
          height: 24,
          padding: 0,
          flex: "0 1 auto",
          minWidth: 0,
          overflow: "hidden",
          whiteSpace: "nowrap",
          textAlign: "left",
        }}
      >
        <Icon name="folder-open" style={{ fontSize: 11 }} />
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: dot,
            flex: "0 0 auto",
          }}
        />
      </Button>
      {active && <ProjectUpdateIndicator project_id={projectId} />}
      <Drawer
        title={title}
        open={open && active}
        onClose={() => setOpen(false)}
        placement="right"
        size={width}
        destroyOnHidden
        resizable={{ onResize: resize }}
        extra={
          <Button onClick={() => resize(width === 560 ? 400 : 560)}>
            Resize
          </Button>
        }
      >
        <KeyboardBoundary>
          {open && active && (
            <Suspense fallback={<Spin />}>
              <ProjectDetails
                key={projectId}
                agent={agent}
                onClose={() => setOpen(false)}
              />
            </Suspense>
          )}
        </KeyboardBoundary>
      </Drawer>
    </>
  );
}
