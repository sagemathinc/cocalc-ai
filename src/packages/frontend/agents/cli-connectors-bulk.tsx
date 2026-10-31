/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Set a CLI connector (GitHub, Cloudflare) for many agents at once, from the
// Agents page: use one connected account, or turn it off.

import { Alert, Button, Modal, Select, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  CLI_CONNECTOR_INFO,
  type CliConnector,
} from "@cocalc/util/ai/cli-connectors";
import {
  FreshAuthModal,
  isFreshAuthRequiredError,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { personalAgentApi } from "./api";
import {
  agentGrant,
  refreshCliConnectors,
  useCliConnectors,
  type CliConnectorData,
} from "./cli-connectors-store";

const KEEP = "keep";
const OFF = "off";
// Saves at once: a few, so many agents do not flood the hub.
const CONCURRENCY = 4;

export interface ConnectorChange {
  agent: NamedAgent;
  enabled: boolean;
  connection_id?: string | null;
  expected_revision?: number;
}

/**
 * What applying one choice to these agents changes. "off" only affects
 * agents that have it on; using an account skips agents already using it.
 */
export function plannedConnectorChanges(
  data: CliConnectorData,
  agents: NamedAgent[],
  connector: CliConnector,
  choice: string,
): ConnectorChange[] {
  if (choice === KEEP) return [];
  const changes: ConnectorChange[] = [];
  for (const agent of agents) {
    const grant = agentGrant(data, agent, connector);
    if (choice === OFF) {
      if (grant?.enabled)
        changes.push({
          agent,
          enabled: false,
          connection_id: grant.connection_id,
          expected_revision: grant.revision,
        });
      continue;
    }
    if (grant?.enabled && grant.connection_id === choice) continue;
    changes.push({
      agent,
      enabled: true,
      connection_id: choice,
      ...(grant ? { expected_revision: grant.revision } : {}),
    });
  }
  return changes;
}

/** Run each change, a few at a time; collect failures by agent name. A
 * fresh-authentication error is rethrown, so the caller can ask for it and
 * run the whole set again (already-applied changes are then skipped). */
export async function applyConnectorChanges(
  connector: CliConnector,
  changes: ConnectorChange[],
  save = (
    opts: Parameters<
      ReturnType<typeof personalAgentApi>["saveCliConnectorGrant"]
    >[0],
  ) => personalAgentApi().saveCliConnectorGrant(opts),
): Promise<string[]> {
  const failures: string[] = [];
  let freshAuth: unknown;
  let next = 0;
  const worker = async () => {
    while (next < changes.length && freshAuth == null) {
      const change = changes[next++];
      try {
        await save({
          agent_id: change.agent.endpoint.agent_id,
          source_project_id: change.agent.endpoint.project_id,
          connector,
          connection_id: change.connection_id,
          enabled: change.enabled,
          ...(change.expected_revision != null
            ? { expected_revision: change.expected_revision }
            : {}),
        });
      } catch (err) {
        if (isFreshAuthRequiredError(err)) freshAuth ??= err;
        else failures.push(`@${change.agent.name}: ${err}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, changes.length) }, worker),
  );
  if (freshAuth != null) throw freshAuth;
  return failures;
}

export function SetConnectorsModal({
  open,
  agents,
  connectors,
  onClose,
}: {
  open: boolean;
  agents: NamedAgent[];
  /** The connectors this site has set up. */
  connectors: CliConnector[];
  onClose: () => void;
}) {
  const { data, error: loadError } = useCliConnectors();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [error, setError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  useEffect(() => {
    if (!open) return;
    setChoices({});
    setFailures([]);
    setError("");
  }, [open]);
  const choice = (connector: CliConnector) => choices[connector] ?? KEEP;
  const planned =
    data == null
      ? []
      : connectors.flatMap((connector) =>
          plannedConnectorChanges(data, agents, connector, choice(connector)),
        );
  const apply = async () => {
    if (data == null) return;
    setBusy(true);
    setError("");
    setFailures([]);
    const found: string[] = [];
    try {
      const completed = await runFreshAuthAction(async () => {
        // Again from the current settings on a retry after fresh auth.
        const current = await refreshAndLoad();
        found.length = 0;
        for (const connector of connectors) {
          const changes = plannedConnectorChanges(
            current,
            agents,
            connector,
            choice(connector),
          );
          found.push(...(await applyConnectorChanges(connector, changes)));
        }
      });
      refreshCliConnectors();
      if (!completed) return;
      if (found.length > 0) setFailures(found);
      else onClose();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  };
  const n = agents.length;
  return (
    <>
      <Modal
        open={open}
        title={`Set connectors for ${n} agent${n === 1 ? "" : "s"}`}
        okText="Apply"
        okButtonProps={{
          disabled: planned.length === 0 || data == null,
          loading: busy,
        }}
        onOk={() => void apply()}
        onCancel={onClose}
        destroyOnHidden
        modalRender={(node) => <KeyboardBoundary>{node}</KeyboardBoundary>}
      >
        {loadError ? (
          <Alert
            type="error"
            title="Unable to load connections"
            description={loadError}
            action={<Button onClick={refreshCliConnectors}>Retry</Button>}
          />
        ) : (
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
              Applies to these agents&apos; turns from now on. Accounts are
              connected and removed in Settings &gt; Connectors.
            </Typography.Paragraph>
            {connectors.map((connector) => {
              const { label } = CLI_CONNECTOR_INFO[connector];
              const connections = (data?.connections ?? []).filter(
                (connection) => connection.connector === connector,
              );
              const changes =
                data == null
                  ? []
                  : plannedConnectorChanges(
                      data,
                      agents,
                      connector,
                      choice(connector),
                    );
              return (
                <div key={connector}>
                  <Typography.Text strong>{label}</Typography.Text>
                  <Select
                    aria-label={`${label} for selected agents`}
                    value={choice(connector)}
                    loading={data == null}
                    onChange={(value) =>
                      setChoices((current) => ({
                        ...current,
                        [connector]: value,
                      }))
                    }
                    style={{ width: "100%", marginTop: 4 }}
                    options={[
                      { value: KEEP, label: "Leave unchanged" },
                      ...connections.map((connection) => ({
                        value: connection.connection_id,
                        label: `Use ${connection.description}`,
                      })),
                      { value: OFF, label: `Turn ${label} off` },
                    ]}
                  />
                  {choice(connector) !== KEEP && data != null && (
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12 }}
                      role="status"
                    >
                      {changes.length === 0
                        ? "Nothing to change: they are already set this way."
                        : `Changes ${changes.length} agent${changes.length === 1 ? "" : "s"}.`}
                    </Typography.Text>
                  )}
                </div>
              );
            })}
            {failures.length > 0 && (
              <Alert
                role="alert"
                type="error"
                showIcon
                title={`Not changed for ${failures.length} agent${failures.length === 1 ? "" : "s"}`}
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {failures.map((failure) => (
                      <li key={failure}>{failure}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {error && (
              <Alert role="alert" type="error" showIcon title={error} />
            )}
          </Space>
        )}
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}

async function refreshAndLoad(): Promise<CliConnectorData> {
  const api = personalAgentApi();
  const [connections, grants, setup] = await Promise.all([
    api.listCliConnections(),
    api.listCliConnectorGrants(),
    api.getCliConnectorSetup(),
  ]);
  return { connections, grants, setup };
}
