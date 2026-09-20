/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Descriptions, Progress, Space, Typography } from "antd";
import type { ComputeVmFundingStatus } from "@cocalc/util/compute-vm-funding";
import { moneyToCurrency, toDecimal } from "@cocalc/util/money";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { useEffect, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { CourseFundingSourceSummary } from "@cocalc/conat/hub/api/compute-funding";

export function vmFundingAmounts(
  funding: ComputeVmFundingStatus,
  course?: CourseFundingSourceSummary,
): {
  remaining?: string;
  total?: string;
  percentRemaining?: number;
} {
  if (funding.source.kind === "course" && !course) return {};
  const remaining = course
    ? toDecimal(course.authorized_usd)
        .minus(course.spent_usd)
        .minus(course.released_usd)
        .toFixed()
    : (funding.remaining_usd ?? funding.committed_usd);
  if (remaining == null) return {};
  const total = course
    ? toDecimal(course.authorized_usd)
    : toDecimal(funding.spent_usd).plus(remaining);
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
  courseBudget,
}: {
  funding?: ComputeVmFundingStatus;
  now?: number;
  compact?: boolean;
  courseBudget?: CourseFundingSourceSummary;
}) {
  const [loadedBudget, setLoadedBudget] =
    useState<CourseFundingSourceSummary>();
  const [budgetFailed, setBudgetFailed] = useState(false);
  const grantId =
    funding?.source.kind === "course" ? funding.source.grant_id : undefined;
  const api = webapp_client.conat_client?.hub?.computeFunding;
  useEffect(() => {
    setLoadedBudget(undefined);
    if (!grantId || courseBudget || !api) return;
    let active = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api.listSources({ include_inactive: true });
        if (active) {
          setLoadedBudget(
            result.sources.find((source) => source.grant_id === grantId),
          );
          setBudgetFailed(false);
        }
      } catch {
        if (active) setBudgetFailed(true);
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, grantId, courseBudget]);
  if (!funding) return null;
  const personal = funding.source.kind === "personal";
  const course =
    courseBudget ??
    (loadedBudget?.grant_id === grantId ? loadedBudget : undefined);
  const amounts = vmFundingAmounts(funding, course);
  const asOf = Date.parse(funding.as_of);
  const stale =
    budgetFailed ||
    !Number.isFinite(asOf) ||
    now - asOf > 45_000 ||
    asOf > now + 5_000;
  const fundingLabel = personal ? "Personal funding" : "Course funding";
  const summary = (
    <section aria-label={`${fundingLabel} summary`}>
      <Space orientation="vertical" size={2} style={{ width: "100%" }}>
        <Typography.Text strong>{fundingLabel}</Typography.Text>
        {amounts.remaining != null && amounts.total != null ? (
          <>
            <Typography.Text
              strong={!compact}
              style={compact ? undefined : { fontSize: 20 }}
            >
              {moneyToCurrency(amounts.remaining)} unspent of{" "}
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
            {personal
              ? "VM funding unavailable."
              : "Course balance unavailable."}
          </Typography.Text>
        )}
        {course?.forecast_exhausts_at && funding.state === "running" && (
          <Typography.Text type="secondary">
            Estimated credit cutoff{" "}
            <TimeAgo date={new Date(course.forecast_exhausts_at)} />
          </Typography.Text>
        )}
        <Typography.Text type="secondary">
          {funding.committed_usd != null
            ? `${moneyToCurrency(funding.committed_usd)} reserved for this VM`
            : "VM reservation unavailable"}
        </Typography.Text>
        {funding.state === "stopped" && (
          <Typography.Text type="secondary">
            Stopped
            {funding.stopped_at && (
              <>
                {" "}
                <TimeAgo date={new Date(funding.stopped_at)} />
              </>
            )}
            ; retained disks may still use credit.
          </Typography.Text>
        )}
        {stale && (
          <Typography.Text type="warning" role="alert">
            Funding status is out of date.
          </Typography.Text>
        )}
      </Space>
    </section>
  );
  if (compact) return summary;
  return (
    <section
      aria-label={personal ? "VM personal funding" : "VM course funding"}
    >
      {summary}
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer" }}>Funding details</summary>
        <Descriptions
          style={{ marginTop: 12 }}
          size="small"
          column={1}
          styles={{
            label: { maxWidth: 160 },
            content: { overflowWrap: "anywhere" },
          }}
        >
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
          <Descriptions.Item label="VM charges recorded">
            {moneyToCurrency(funding.spent_usd)}
          </Descriptions.Item>
          <Descriptions.Item
            label={personal ? "Unspent VM funding" : "Unspent course credit"}
          >
            {amounts.remaining == null
              ? "Unavailable"
              : moneyToCurrency(amounts.remaining)}
          </Descriptions.Item>
          {amounts.total != null && (
            <Descriptions.Item
              label={personal ? "VM funding amount" : "Course allocation"}
            >
              {moneyToCurrency(amounts.total)}
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Reserved for this VM">
            {funding.committed_usd == null
              ? "Unavailable"
              : moneyToCurrency(funding.committed_usd)}
          </Descriptions.Item>
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
              <TimeAgo date={new Date(funding.authorized_until)} />
            </Descriptions.Item>
          )}
          {funding.stop_at && (
            <Descriptions.Item label="Service authorization">
              {Date.parse(funding.stop_at) <= now ? "Ended " : "Renews before "}
              <TimeAgo date={new Date(funding.stop_at)} />
            </Descriptions.Item>
          )}
          {funding.storage_delete_at && (
            <Descriptions.Item label="Storage deletion deadline">
              <TimeAgo date={new Date(funding.storage_delete_at)} />
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Updated">
            {Number.isFinite(asOf) ? (
              <TimeAgo date={new Date(asOf)} />
            ) : (
              "Unavailable"
            )}
          </Descriptions.Item>
        </Descriptions>
      </details>
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
