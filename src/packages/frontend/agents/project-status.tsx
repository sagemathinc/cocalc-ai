import { useEffect, useState } from "react";
import { Button } from "antd";
import {
  useProjectFromMap,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { useProjectRunQuota } from "@cocalc/frontend/project/use-project-run-quota";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { normalizeProjectStateForDisplay } from "@cocalc/frontend/projects/host-operational";
import { ProjectSettingsDrawer } from "./project-settings-drawer";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { agentProjectTitle } from "./project-title";

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
  const title = agentProjectTitle(agent, project?.get("title"));
  const label = `Project: ${title} · ${egressError ? "Account internet usage blocked" : projectStatusLabel(state, runQuota?.network)}`;
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
          flex: "1 1 0",
          minWidth: 0,
          overflow: "hidden",
          whiteSpace: "nowrap",
          textAlign: "left",
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      </Button>
      <ProjectSettingsDrawer
        projectId={projectId}
        title={title}
        open={open && active}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
