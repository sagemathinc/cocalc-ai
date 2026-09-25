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
  const title = project?.get("title") || agent.project_title || "Agent project";
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
        style={{
          color: "inherit",
          maxWidth: "100%",
          height: "auto",
          whiteSpace: "normal",
          textAlign: "left",
        }}
      >
        Project: {title} ·{" "}
        {egressError
          ? "Account internet usage blocked"
          : projectStatusLabel(state, runQuota?.network)}
      </Button>
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
