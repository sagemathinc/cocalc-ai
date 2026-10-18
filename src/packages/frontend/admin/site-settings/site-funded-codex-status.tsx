/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import { Alert, Button, Card, Progress, Space, Statistic, Tag } from "antd";
import { useEffect, useState } from "react";
import type { SiteFundedCodexStatus } from "@cocalc/util/ai/site-funded-codex";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { Icon } from "@cocalc/frontend/components";

function dollars(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

function poolLabel(poolId: string): string {
  if (poolId.endsWith("global")) return "Combined site budget";
  if (poolId.endsWith("paid")) return "Paid/member sub-pool";
  return "Free sub-pool";
}

export default function SiteFundedCodexStatusCard() {
  const [status, setStatus] = useState<SiteFundedCodexStatus>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setStatus(
        await webapp_client.conat_client.hub.system.getSiteFundedCodexAdminStatus(
          {},
        ),
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <Card
      size="small"
      title="Site-funded AI pool"
      extra={
        <Button
          size="small"
          loading={loading}
          icon={<Icon name="refresh" />}
          onClick={() => void load()}
        >
          Refresh
        </Button>
      }
      style={{ marginBottom: 20, width: "100%" }}
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          title="Could not load pool status"
          description={error}
        />
      ) : null}
      {!error && !loading && !status?.pools.length ? (
        <Alert
          type="info"
          showIcon
          title="No funding period has been created yet"
          description="A pool appears after the first funded turn reservation."
        />
      ) : null}
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        {status?.pools.map((pool) => {
          const exposure = pool.committedMicrousd + pool.reservedMicrousd;
          const percent = Math.min(100, Math.round(pool.utilization * 100));
          const progressStatus = percent >= 100 ? "exception" : "active";
          return (
            <div key={pool.poolId}>
              <Space wrap style={{ marginBottom: 6 }}>
                <b>{poolLabel(pool.poolId)}</b>
                <Tag>{pool.activeReservations} active turns</Tag>
                <span>
                  {new Date(pool.periodStart).toLocaleDateString()} through{" "}
                  {new Date(pool.periodEnd).toLocaleDateString()}
                </span>
              </Space>
              <Progress percent={percent} status={progressStatus} />
              <Space wrap size={24}>
                <Statistic
                  title="Committed"
                  value={dollars(pool.committedMicrousd)}
                />
                <Statistic
                  title="Reserved"
                  value={dollars(pool.reservedMicrousd)}
                />
                <Statistic title="Exposure" value={dollars(exposure)} />
                <Statistic
                  title="Remaining"
                  value={dollars(Math.max(0, pool.limitMicrousd - exposure))}
                />
                <Statistic
                  title="Weekly limit"
                  value={dollars(pool.limitMicrousd)}
                />
              </Space>
            </div>
          );
        })}
        {status?.reconciliation ? (
          <Alert
            type={
              status.reconciliation.available &&
              Math.abs(status.reconciliation.discrepancyPercent ?? 0) <= 5
                ? "success"
                : status.reconciliation.available
                  ? "warning"
                  : "info"
            }
            showIcon
            title={
              status.reconciliation.available
                ? "OpenAI cost reconciliation"
                : "OpenAI reconciliation is not configured"
            }
            description={
              status.reconciliation.available ? (
                <span>
                  Local committed{" "}
                  {dollars(status.reconciliation.localCommittedMicrousd)};
                  OpenAI billed{" "}
                  {dollars(status.reconciliation.providerCostMicrousd ?? 0)};
                  discrepancy{" "}
                  {dollars(status.reconciliation.discrepancyMicrousd ?? 0)} (
                  {(status.reconciliation.discrepancyPercent ?? 0).toFixed(1)}
                  %). Provider costs can lag the local ledger.
                </span>
              ) : (
                status.reconciliation.reason
              )
            }
          />
        ) : null}
      </Space>
    </Card>
  );
}
