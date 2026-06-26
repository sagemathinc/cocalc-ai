/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Space, Tag, Typography } from "antd";
import { useEffect, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Loading } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { LegacyMigrationFinancialPreviewResponse } from "@cocalc/conat/hub/api/legacy-migration";

const { Text } = Typography;

function formatMoney(value: number | null | undefined): string {
  const amount =
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function hasVisibleLegacyBilling(
  preview: LegacyMigrationFinancialPreviewResponse,
): boolean {
  return (
    preview.legacy_accounts.length > 0 &&
    (preview.pending_credit_amount > 0 ||
      preview.applied_credit_amount > 0 ||
      preview.active_subscription_count > 0 ||
      preview.membership_already_applied ||
      !!preview.stripe_customer_id)
  );
}

export default function LegacyBillingMigrationStatus() {
  const account_id = useTypedRedux("account", "account_id");
  const legacyMigrationEnabled = !!useTypedRedux(
    "customize",
    "legacy_migration_enabled",
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] =
    useState<LegacyMigrationFinancialPreviewResponse>();

  async function load() {
    if (!account_id || !legacyMigrationEnabled) return;
    setLoading(true);
    setError("");
    try {
      setPreview(
        await webapp_client.conat_client.hub.legacyMigration.previewFinancialMigration(),
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [account_id, legacyMigrationEnabled]);

  if (!legacyMigrationEnabled) return null;
  if (loading && !preview) return <Loading />;
  if (error) {
    return (
      <Alert
        showIcon
        type="warning"
        message="Legacy billing migration status is unavailable"
        description={error}
      />
    );
  }
  if (!preview || !hasVisibleLegacyBilling(preview)) return null;

  const pending =
    preview.pending_credit_amount > 0 || preview.active_subscription_count > 0;

  return (
    <Card
      size="small"
      title={
        <Space>
          <Icon name="exchange" />
          <span>Legacy billing migration</span>
        </Space>
      }
      extra={
        <Button loading={loading} onClick={() => void load()} size="small">
          Refresh
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Alert
          showIcon
          type={pending ? "info" : "success"}
          message={
            pending
              ? "Legacy billing data found"
              : "Legacy billing data migrated"
          }
          description={
            pending
              ? "Positive credit, Stripe customer metadata, and a one-month Basic membership for active legacy subscriptions are applied automatically. No project restore action is required."
              : "Migrated legacy billing items are recorded in your CoCalc billing history and membership status."
          }
        />
        <Space wrap size="large">
          <Space direction="vertical" size={0}>
            <Text type="secondary">Pending credit</Text>
            <Text strong>{formatMoney(preview.pending_credit_amount)}</Text>
          </Space>
          <Space direction="vertical" size={0}>
            <Text type="secondary">Migrated credit</Text>
            <Text>{formatMoney(preview.applied_credit_amount)}</Text>
          </Space>
          <Space direction="vertical" size={0}>
            <Text type="secondary">Legacy subscriptions</Text>
            <Text>
              {preview.active_subscription_count} active
              {preview.active_subscription_count > 0
                ? ` (${formatMoney(preview.active_subscription_annualized)}/year legacy total)`
                : ""}
            </Text>
          </Space>
          <Space direction="vertical" size={0}>
            <Text type="secondary">Stripe customer</Text>
            <Text copyable={!!preview.stripe_customer_id}>
              {preview.stripe_customer_id ?? "None found"}
            </Text>
          </Space>
        </Space>
        <Space wrap size={[4, 4]}>
          {preview.legacy_accounts.map((account) => (
            <Tag
              color={
                account.claimed_by_account_id
                  ? account.claimed_by_account_id === account_id
                    ? "green"
                    : "red"
                  : "gold"
              }
              key={account.legacy_account_id}
              title={[
                account.legacy_account_id,
                `credit: ${formatMoney(account.credit_amount)}`,
                account.active_subscription_count
                  ? `subscriptions: ${account.active_subscription_count}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n")}
            >
              {account.email_address ??
                account.display_name ??
                account.legacy_account_id}
            </Tag>
          ))}
        </Space>
      </Space>
    </Card>
  );
}
