/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Settings > Connectors > RunPod: the projects whose GPU use the account
// approved, paid by its RunPod key (PROJECT_FUNDING.md §6), with their spend
// and an End button.

import { Alert, Button, Modal, Table, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { FundedProject } from "@cocalc/util/gpu/project-funding";

const { Text } = Typography;

const usd = (v: string) => `$${Number(v).toFixed(2)}`;

export function FundedProjectsSection() {
  const projectMap = useTypedRedux("projects", "project_map");
  const [rows, setRows] = useState<FundedProject[]>();
  // older ended approvals weren't listed (every active one always is)
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string>();
  const [ending, setEnding] = useState<FundedProject>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await webapp_client.conat_client.hub.gpu.fundedProjects(
        {},
      );
      setRows(result.approvals);
      setTruncated(result.history_truncated);
      setError(undefined);
    } catch (err) {
      setError(`${(err as Error)?.message ?? err}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const end = async (row: FundedProject) => {
    setBusy(true);
    try {
      await webapp_client.conat_client.hub.gpu.revokeProjectFunding({
        approval_id: row.approval_id,
      });
    } catch (err) {
      setError(`${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (rows == null && !error) return null;
  const title = (project_id: string) =>
    projectMap?.getIn([project_id, "title"]) ?? project_id;

  return (
    <div style={{ marginTop: 16 }}>
      <Typography.Title level={5}>Projects you fund</Typography.Title>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {rows && rows.length === 0 ? (
        <Text type="secondary">
          You haven't approved GPU use in any project. A collaborator can ask
          for it from a project; you approve it there.
        </Text>
      ) : null}
      {rows && rows.length > 0 ? (
        <Table<FundedProject>
          size="small"
          rowKey="approval_id"
          pagination={false}
          dataSource={rows}
          columns={[
            {
              title: "Project",
              render: (_, r) => `${title(r.project_id)}`,
            },
            {
              title: "Spent",
              render: (_, r) =>
                `${usd(r.spent_usd)} of ${usd(r.authorized_usd)} (${usd(r.reserved_usd)} held)`,
            },
            {
              title: "Until",
              render: (_, r) => new Date(r.ends_at).toLocaleDateString(),
            },
            {
              title: "State",
              render: (_, r) =>
                r.state === "active"
                  ? r.activated
                    ? "active"
                    : "activating"
                  : r.state,
            },
            { title: "Live GPUs", dataIndex: "live_pods" },
            {
              title: "",
              render: (_, r) =>
                r.state === "active" ? (
                  <Button
                    size="small"
                    danger
                    disabled={busy}
                    onClick={() => setEnding(r)}
                  >
                    End…
                  </Button>
                ) : null,
            },
          ]}
        />
      ) : null}
      {truncated ? (
        <Text type="secondary">
          Every active approval is listed; older ended ones are not.
        </Text>
      ) : null}
      <Modal
        open={ending != null}
        title="End this approval?"
        okText="End it and terminate its GPUs"
        okButtonProps={{ danger: true }}
        onOk={() => {
          const r = ending;
          setEnding(undefined);
          if (r) void end(r);
        }}
        onCancel={() => setEnding(undefined)}
      >
        No new GPU can be launched in that project on your account, and CoCalc
        terminates the GPUs it paid for.
      </Modal>
    </div>
  );
}
