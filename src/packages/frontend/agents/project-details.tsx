import { Alert, Collapse, Space, Typography } from "antd";
import { useState } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  ProjectContext,
  useProjectContextProvider,
} from "@cocalc/frontend/project/context";
import { StartButton } from "@cocalc/frontend/project/start-button";
import { StopProject } from "@cocalc/frontend/project/settings/stop-project";
import { useProjectSettingsSections } from "@cocalc/frontend/project/settings/sections";
import DiskUsage from "@cocalc/frontend/project/disk-usage/disk-usage";
import useDiskUsage from "@cocalc/frontend/project/disk-usage/use-disk-usage";
import { ManagedEgress } from "@cocalc/frontend/project/settings/managed-egress";
import { useNamedAgents } from "./api";
import { AgentRunningIndicator } from "./agent-running-indicator";
import { parseManagedEgressBlockedError } from "@cocalc/frontend/purchases/managed-egress-blocked";

export default function ProjectDetails({ agent }: { agent: NamedAgent }) {
  const context = useProjectContextProvider({
    project_id: agent.endpoint.project_id,
    is_active: true,
    mainWidthPx: 560,
    manageWorkspaceSelection: false,
  });
  return (
    <ProjectContext.Provider value={context}>
      <Details agent={agent} />
    </ProjectContext.Provider>
  );
}

function Details({ agent }: { agent: NamedAgent }) {
  const projectId = agent.endpoint.project_id;
  const accountId = useTypedRedux("account", "account_id");
  const egress = parseManagedEgressBlockedError(
    useTypedRedux("account", "managed_egress_blocked_error"),
  );
  const projects = useTypedRedux("projects", "project_map");
  const project = projects?.get(projectId);
  const { directory } = useNamedAgents();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const state = project?.getIn(["state", "state"]);
  const peers =
    directory?.agents.filter(
      (item) => item.endpoint.project_id === projectId,
    ) ?? [];
  return (
    <Space vertical size="large" style={{ width: "100%" }}>
      {egress && (
        <Alert
          type="error"
          title={egress.title}
          description={egress.details.join("\n")}
        />
      )}
      <Typography.Paragraph>
        This project supplies the files and computing environment for these
        agents. Stopping it interrupts all its agents and other work, including
        collaborators' processes.
      </Typography.Paragraph>
      <Space wrap>
        <StartButton project_id={projectId} style={{ fontSize: 16 }} />
        <StopProject project_id={projectId} disabled={state !== "running"} />
      </Space>
      <Typography.Text type="secondary">
        Starting a project does not resend a message. Your draft stays in the
        composer.
      </Typography.Text>
      <section aria-label="Agents sharing this project">
        <Typography.Title level={5}>Agents in this project</Typography.Title>
        <Space wrap>
          {peers.map((peer) => (
            <AgentRunningIndicator key={peer.endpoint.agent_id} agent={peer}>
              <span style={{ paddingRight: 12 }}>@{peer.name}</span>
            </AgentRunningIndicator>
          ))}
        </Space>
      </section>
      <Storage projectId={projectId} />
      <section aria-label="Internet usage">
        <Typography.Title level={5}>Internet usage</Typography.Title>
        <ManagedEgress project_id={projectId} embedded />
      </section>
      <Collapse
        onChange={(keys) => setSettingsOpen(keys.includes("settings"))}
        items={[
          {
            key: "settings",
            label: "Project settings",
            children:
              settingsOpen && project ? (
                <Settings
                  projectId={projectId}
                  project={project}
                  accountId={accountId}
                />
              ) : null,
          },
        ]}
      />
    </Space>
  );
}

function Storage({ projectId }: { projectId: string }) {
  const { quotas, loading, error, collectedAt } = useDiskUsage({
    project_id: projectId,
  });
  const full = quotas.some(
    (quota) => quota.size > 0 && quota.used >= quota.size,
  );
  const near = quotas.some(
    (quota) => quota.size > 0 && quota.used >= quota.size * 0.9,
  );
  return (
    <section aria-label="Project storage">
      <Typography.Title level={5}>Storage</Typography.Title>
      {(full || near) && (
        <Alert
          type={full ? "error" : "warning"}
          title={full ? "Disk limit reached" : "Disk almost full"}
        />
      )}
      {error && <Alert type="warning" title="Storage status unavailable" />}
      {!loading && !quotas.length && (
        <Typography.Paragraph type="secondary">
          Storage usage unknown.
        </Typography.Paragraph>
      )}
      {collectedAt && (
        <Typography.Paragraph type="secondary">
          Last measured: {new Date(collectedAt).toLocaleString()}
        </Typography.Paragraph>
      )}
      <DiskUsage
        project_id={projectId}
        buttonText="Inspect storage and free space"
      />
    </section>
  );
}

function Settings({ projectId, project, accountId }) {
  const { sections } = useProjectSettingsSections({
    project_id: projectId,
    project,
    account_id: accountId,
    mode: "flyout",
  });
  return (
    <Collapse
      items={sections.map((section) => ({
        key: section.id,
        label: section.title,
        children: section.children,
      }))}
    />
  );
}
