/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Alert, Descriptions, Typography } from "antd";
import type { ComputeVmFundingStatus } from "@cocalc/util/compute-vm-funding";
import { moneyToCurrency } from "@cocalc/util/money";

export default function VmFundingStatus({
  funding,
  now = Date.now(),
}: {
  funding?: ComputeVmFundingStatus;
  now?: number;
}) {
  if (!funding) return null;
  const personal = funding.source.kind === "personal";
  const asOf = Date.parse(funding.as_of);
  const stale =
    !Number.isFinite(asOf) || now - asOf > 45_000 || asOf > now + 5_000;
  return (
    <section
      aria-label={personal ? "VM personal funding" : "VM course funding"}
    >
      <Typography.Title level={5}>{funding.label}</Typography.Title>
      {stale && (
        <Alert type="warning" showIcon title="Funding status is out of date." />
      )}
      <Descriptions size="small" column={1} layout="vertical">
        <Descriptions.Item label="Spent">
          {moneyToCurrency(funding.spent_usd)}
        </Descriptions.Item>
        {funding.committed_usd != null && (
          <Descriptions.Item label="Committed to this VM">
            {moneyToCurrency(funding.committed_usd)}
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
