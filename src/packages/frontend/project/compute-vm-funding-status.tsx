/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Alert, Descriptions, Progress, Space, Typography } from "antd";
import type { ComputeVmFundingStatus } from "@cocalc/util/compute-vm-funding";
import { moneyToCurrency, toDecimal } from "@cocalc/util/money";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";

export function vmFundingAmounts(funding: ComputeVmFundingStatus): {
  remaining?: string;
  total?: string;
  percentRemaining?: number;
} {
  const remaining = funding.remaining_usd ?? funding.committed_usd;
  if (remaining == null) return {};
  const total = toDecimal(funding.spent_usd).plus(remaining);
  const percentRemaining = total.eq(0)
    ? 0
    : Math.max(
        0,
        Math.min(100, toDecimal(remaining).div(total).mul(100).toNumber()),
      );
  return { remaining, total: total.toFixed(), percentRemaining };
}

export default function VmFundingStatus({
  funding,
  now = Date.now(),
  compact = false,
}: {
  funding?: ComputeVmFundingStatus;
  now?: number;
  compact?: boolean;
}) {
  if (!funding) return null;
  const personal = funding.source.kind === "personal";
  const amounts = vmFundingAmounts(funding);
  const asOf = Date.parse(funding.as_of);
  const stale =
    !Number.isFinite(asOf) || now - asOf > 45_000 || asOf > now + 5_000;
  const fundingLabel = personal ? "Personal funding" : "Course funding";
  if (compact) {
    return (
      <section aria-label={`${fundingLabel} summary`}>
        <Space orientation="vertical" size={2} style={{ width: "100%" }}>
          <Typography.Text strong>{fundingLabel}</Typography.Text>
          {amounts.remaining != null && amounts.total != null ? (
            <>
              <Typography.Text>
                {moneyToCurrency(amounts.remaining)} remaining of{" "}
                {moneyToCurrency(amounts.total)}
              </Typography.Text>
              <Progress
                aria-label={`${fundingLabel}: ${moneyToCurrency(amounts.remaining)} remaining of ${moneyToCurrency(amounts.total)}`}
                percent={amounts.percentRemaining}
                showInfo={false}
                size="small"
                status={amounts.percentRemaining === 0 ? "exception" : "normal"}
              />
            </>
          ) : (
            <Typography.Text type="secondary">
              Remaining funding is unavailable.
            </Typography.Text>
          )}
          {funding.stop_at && (
            <Typography.Text type="secondary">
              Funding stops this VM <TimeAgo date={new Date(funding.stop_at)} />
            </Typography.Text>
          )}
          {stale && (
            <Typography.Text type="warning">
              Funding status is out of date.
            </Typography.Text>
          )}
        </Space>
      </section>
    );
  }
  return (
    <section
      aria-label={personal ? "VM personal funding" : "VM course funding"}
    >
      <Typography.Title level={5}>{funding.label}</Typography.Title>
      {stale && (
        <Alert type="warning" showIcon title="Funding status is out of date." />
      )}
      <Descriptions size="small" column={1} layout="vertical">
        <Descriptions.Item label="Funding state">
          {
            {
              pending: "Pending",
              running: "Running",
              stopped: "Stopped",
              settling: "Finalizing charges",
              closed: "Settled",
            }[funding.state]
          }
        </Descriptions.Item>
        <Descriptions.Item label="Spent">
          {moneyToCurrency(funding.spent_usd)}
        </Descriptions.Item>
        <Descriptions.Item label="Remaining">
          {amounts.remaining == null
            ? "Unavailable"
            : moneyToCurrency(amounts.remaining)}
        </Descriptions.Item>
        {amounts.total != null && (
          <Descriptions.Item label="Starting amount">
            {moneyToCurrency(amounts.total)}
          </Descriptions.Item>
        )}
        {funding.protected_storage_usd != null && (
          <Descriptions.Item label="Protected storage and cleanup">
            {moneyToCurrency(funding.protected_storage_usd)}
          </Descriptions.Item>
        )}
        {funding.egress_cap_usd != null && (
          <Descriptions.Item
            label={
              personal
                ? "Maximum personal network charge"
                : "Maximum sponsored network charge"
            }
          >
            {moneyToCurrency(funding.egress_cap_usd)}
          </Descriptions.Item>
        )}
        {funding.authorized_until && (
          <Descriptions.Item label="Runtime authorized until">
            {new Date(funding.authorized_until).toLocaleString()}
          </Descriptions.Item>
        )}
        {funding.stop_at && (
          <Descriptions.Item label="Financial stop deadline">
            {new Date(funding.stop_at).toLocaleString()}
          </Descriptions.Item>
        )}
        {funding.storage_delete_at && (
          <Descriptions.Item label="Storage deletion deadline">
            {new Date(funding.storage_delete_at).toLocaleString()}
          </Descriptions.Item>
        )}
        <Descriptions.Item label="Updated">
          {Number.isFinite(asOf)
            ? new Date(asOf).toLocaleString()
            : "Unavailable"}
        </Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary">
        {personal
          ? "Charges use your approved personal limit. "
          : "Course funding does not authorize personal charges. "}
        Deleting this VM removes its software and remote data, not notebooks
        saved in your CoCalc project. VM files are not backed up automatically.
      </Typography.Paragraph>
    </section>
  );
}
