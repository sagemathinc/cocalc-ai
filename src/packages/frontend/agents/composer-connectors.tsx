/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { ApartmentOutlined, ApiOutlined } from "@ant-design/icons";
import { Alert, Button, Dropdown, Modal, Spin } from "antd";
import type { MenuProps } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { CocalcConnectorConfig } from "@cocalc/conat/hub/api/agent";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { CocalcConnector } from "./cocalc-connector";
import { AgentNetworkTagsEditor } from "./agent-network-tags-editor";
import { AgentNetworkDetailsModal } from "./agent-network-details-modal";
import { activeNetworkMembers } from "./agent-network-utils";
import { refreshAgentNetworks, sameEndpoint, useAgentNetworks } from "./api";

/**
 * The managed CoCalc connector works with native Codex and the qualified
 * Claude Code harness, not with arbitrary ACP harnesses.
 */
export function supportsCocalcConnector(
  threadMetadata: { agent_runtime?: any } | null | undefined,
): boolean {
  if (threadMetadata == null) return false;
  const runtime = threadMetadata.agent_runtime;
  if (runtime?.kind !== "acp") return true;
  return runtime.profile?.version === 2 && runtime.profile.id === "claude-code";
}

interface Props {
  agent?: NamedAgent;
  supportsCocalcAccess: boolean;
  children: (items: MenuProps["items"]) => ReactNode;
}

export function ComposerConnectors({
  agent,
  supportsCocalcAccess,
  children,
}: Props) {
  return agent ? (
    <NamedAgentConnectors
      key={`${agent.endpoint.project_id}:${agent.endpoint.agent_id}`}
      agent={agent}
      supportsCocalcAccess={supportsCocalcAccess}
    >
      {children}
    </NamedAgentConnectors>
  ) : (
    children([])
  );
}

type CocalcState = {
  config: CocalcConnectorConfig | null;
  onOpen: () => void;
  loaded: boolean;
  loadError: string;
};

/** What CoCalc access currently lets the agent reach, in a few words. */
export function cocalcAccessSummary(
  config: CocalcConnectorConfig | null,
  ownProjectId: string,
): string {
  if (!config?.enabled) return "Off";
  const parts: string[] = [];
  if (config.scope.all_projects) {
    parts.push("all projects");
  } else {
    const n = config.scope.projects.filter(
      (grant) => grant.project_id !== ownProjectId,
    ).length;
    if (n > 0) parts.push(`${n} ${n === 1 ? "project" : "projects"}`);
  }
  if (config.scope.account.length > 0) parts.push("account");
  return parts.length > 0 ? parts.join(", ") : "On";
}

export function agentNetworksSummary(
  titles: string[],
  paused: boolean,
): string {
  if (titles.length === 0) return "None";
  const shown =
    titles.slice(0, 2).join(", ") +
    (titles.length > 2 ? ` +${titles.length - 2}` : "");
  return paused ? `Paused: ${shown}` : shown;
}

function Status({ text, warning }: { text: string; warning?: boolean }) {
  return (
    <span
      style={{
        color: warning ? UI_COLORS.warning : UI_COLORS.secondary,
        fontSize: "0.9em",
        marginLeft: 12,
      }}
    >
      {text}
    </span>
  );
}

// One button for all of the agent's connectors: it shows how many are on and
// opens the same list as the + menu.
function ConnectorsChip({
  label,
  active,
  warning,
  items,
  chipRef,
}: {
  label: string;
  active: number;
  warning: boolean;
  items: MenuProps["items"];
  chipRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Tooltip title={label}>
      <Dropdown
        trigger={["click"]}
        menu={{
          items,
          // Dialogs opened from this list restore focus to the chip.
          onClick: () => chipRef.current?.focus(),
        }}
      >
        <Button
          ref={chipRef}
          type="text"
          aria-label={label}
          aria-haspopup="menu"
          icon={<ApiOutlined aria-hidden />}
          style={{
            height: 32,
            minWidth: 32,
            paddingInline: active > 0 ? 8 : undefined,
            opacity: active > 0 || warning ? 1 : 0.6,
            color: warning ? UI_COLORS.warning : undefined,
          }}
        >
          {active > 0 ? active : null}
        </Button>
      </Dropdown>
    </Tooltip>
  );
}

function NamedAgentConnectors({
  agent,
  supportsCocalcAccess,
  children,
}: Props & { agent: NamedAgent }) {
  const { directory, error } = useAgentNetworks();
  const menuRef = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const [networksOpen, setNetworksOpen] = useState(false);
  const [detailsId, setDetailsId] = useState<string>();
  const networks = directory?.networks ?? [];
  const assigned = networks.filter(
    (network) =>
      network.state !== "closed" &&
      activeNetworkMembers(network).some(
        (member) =>
          member.kind === "registered" &&
          sameEndpoint(member.endpoint, agent.endpoint),
      ),
  );
  const paused =
    directory?.controls.paused ||
    assigned.every((network) => network.state !== "active");
  const openNetworks = () => setNetworksOpen(true);
  const networksStatus = error
    ? "Unable to load"
    : directory
      ? agentNetworksSummary(
          assigned.map(({ title }) => title),
          !!paused && assigned.length > 0,
        )
      : "";

  const render = (cocalc?: CocalcState) => {
    const cocalcStatus = !supportsCocalcAccess
      ? "Codex and Claude only"
      : cocalc?.loadError
        ? "Unable to load"
        : cocalc?.loaded
          ? cocalcAccessSummary(cocalc.config, agent.endpoint.project_id)
          : "";
    const connectors: MenuProps["items"] = [
      {
        type: "group",
        key: "connectors",
        label: `Connectors for @${agent.name}`,
        children: [
          {
            key: "cocalc-connector",
            label: "CoCalc access",
            extra: cocalcStatus ? (
              <Status text={cocalcStatus} warning={!!cocalc?.loadError} />
            ) : undefined,
            disabled: !supportsCocalcAccess,
            icon: (
              <span aria-hidden>
                <Icon name="cocalc-ring" />
              </span>
            ),
            onClick: cocalc?.onOpen,
          },
          {
            key: "agent-networks",
            label: "Agent Networks",
            extra: networksStatus ? (
              <Status text={networksStatus} warning={!!error} />
            ) : undefined,
            icon: <ApartmentOutlined aria-hidden />,
            onClick: openNetworks,
          },
        ],
      },
    ];
    const cocalcConfigured = supportsCocalcAccess && cocalc?.config != null;
    const cocalcOn = cocalcConfigured && cocalc?.config?.enabled === true;
    const networksOn = assigned.length > 0 && !paused;
    const active = Number(cocalcOn) + Number(networksOn);
    const parts = [
      ...(cocalcConfigured ? [`CoCalc access ${cocalcStatus}`] : []),
      ...(assigned.length > 0 ? [`Agent Networks ${networksStatus}`] : []),
    ];
    return (
      <>
        <span ref={menuRef} style={{ display: "inline-flex" }}>
          {children(connectors)}
        </span>
        {parts.length > 0 && (
          <ConnectorsChip
            label={`Connectors for @${agent.name}: ${parts.join("; ")}`}
            active={active}
            warning={!!cocalc?.loadError || !!error}
            items={connectors}
            chipRef={chipRef}
          />
        )}
      </>
    );
  };

  return (
    <>
      {supportsCocalcAccess ? (
        <CocalcConnector
          agent={agent}
          onRemoved={() =>
            (chipRef.current?.isConnected
              ? chipRef.current
              : menuRef.current?.querySelector("button")
            )?.focus()
          }
          renderTrigger={render}
        />
      ) : (
        render()
      )}
      {directory ? (
        <AgentNetworkTagsEditor
          open={networksOpen}
          agent={agent}
          directory={directory}
          onClose={() => setNetworksOpen(false)}
          onOpenNetwork={(network) => setDetailsId(network.agent_network_id)}
        />
      ) : (
        <Modal
          open={networksOpen}
          title={`Network tags for @${agent.name}`}
          onCancel={() => setNetworksOpen(false)}
          footer={null}
          modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
        >
          {error ? (
            <Alert
              type="error"
              title="Unable to load Agent Networks"
              description={error}
              action={
                <Button onClick={() => void refreshAgentNetworks()}>
                  Retry
                </Button>
              }
            />
          ) : (
            <Spin aria-label="Loading Agent Networks" />
          )}
        </Modal>
      )}
      <AgentNetworkDetailsModal
        network={networks.find(
          (network) => network.agent_network_id === detailsId,
        )}
        networks={networks}
        onSelectNetwork={(network) => setDetailsId(network.agent_network_id)}
        onClose={() => setDetailsId(undefined)}
        onChanged={refreshAgentNetworks}
      />
    </>
  );
}
