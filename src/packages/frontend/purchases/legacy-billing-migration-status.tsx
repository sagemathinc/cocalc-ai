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
import MembershipPurchaseModal from "@cocalc/frontend/account/membership-purchase-modal";
import type { BillingInterval } from "@cocalc/frontend/account/membership-pricing-chooser";

const { Text } = Typography;

function formatMoney(value: number | null | undefined): string {
  const amount =
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function membershipLabel(value: string | null | undefined): string {
  if (!value) return "membership";
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)} membership`;
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

export default function LegacyBillingMigrationStatus({
  onApplied,
}: {
  onApplied?: () => Promise<void> | void;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const legacyMigrationEnabled = !!useTypedRedux(
    "customize",
    "legacy_migration_enabled",
  );
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);
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

  async function apply() {
    if (!preview?.can_apply) return;
    setApplying(true);
    setError("");
    try {
      await webapp_client.conat_client.hub.legacyMigration.applyFinancialMigration(
        {
          membership_class: preview.suggested_membership_class ?? null,
          membership_interval: preview.suggested_membership_interval,
        },
      );
      await load();
      await onApplied?.();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setApplying(false);
    }
  }

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
  const continueMembership = preview.membership_renewal_configured
    ? null
    : preview.applied_membership_class;
  const continueInterval =
    preview.applied_membership_interval ??
    preview.suggested_membership_interval;
  const suggestedMembership = preview.suggested_membership_class;
  const suggestedMembershipLabel = membershipLabel(suggestedMembership);
  const continueMembershipLabel = membershipLabel(continueMembership);
  const grantDays = preview.suggested_membership_grant_days ?? 30;
  const pendingEntitlementCredit = preview.legacy_accounts.reduce(
    (total, account) =>
      account.claimed_by_account_id
        ? total
        : total + (account.entitlement_credit_amount ?? 0),
    0,
  );
  const unvaluedSiteLicenseCount = preview.legacy_accounts.reduce(
    (total, account) =>
      account.claimed_by_account_id
        ? total
        : total + (account.unvalued_active_site_license_count ?? 0),
    0,
  );

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
        <Space>
          {preview?.can_apply ? (
            <Button
              loading={applying}
              onClick={() => void apply()}
              size="small"
              type="primary"
            >
              Apply now
            </Button>
          ) : null}
          <Button loading={loading} onClick={() => void load()} size="small">
            Refresh
          </Button>
        </Space>
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
              ? `Click Apply now to add positive credit, remaining paid legacy value, Stripe customer metadata, and ${
                  suggestedMembership
                    ? `a free ${grantDays}-day ${suggestedMembershipLabel} grant for active legacy subscriptions. It does not auto-charge; choose a paid plan later to continue.`
                    : "legacy billing metadata."
                } No project restore action is required.`
              : "Migrated legacy billing items are recorded in your CoCalc billing history and membership status."
          }
        />
        {continueMembership ? (
          <Alert
            showIcon
            type="success"
            message={`Free ${grantDays}-day ${continueMembershipLabel} grant`}
            description={
              <Space direction="vertical" size="small">
                <span>
                  Keep this membership after the free migration grant by setting
                  up renewal now. Your paid membership continues after the grant
                  period; this does not remove the free month.
                </span>
                <Button
                  onClick={() => setContinueOpen(true)}
                  size="small"
                  type="primary"
                >
                  Continue {continueMembershipLabel}
                </Button>
              </Space>
            }
          />
        ) : null}
        <Space wrap size="large">
          <Space direction="vertical" size={0}>
            <Text type="secondary">Pending credit</Text>
            <Text strong>{formatMoney(preview.pending_credit_amount)}</Text>
          </Space>
          <Space direction="vertical" size={0}>
            <Text type="secondary">Remaining paid value</Text>
            <Text>{formatMoney(pendingEntitlementCredit)}</Text>
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
            <Text type="secondary">Membership grant</Text>
            <Text>
              {suggestedMembership
                ? `${grantDays} days of ${suggestedMembershipLabel}`
                : preview.membership_already_applied
                  ? "Already applied"
                  : "None"}
            </Text>
          </Space>
          <Space direction="vertical" size={0}>
            <Text type="secondary">Stripe customer</Text>
            <Text copyable={!!preview.stripe_customer_id}>
              {preview.stripe_customer_id ?? "None found"}
            </Text>
          </Space>
        </Space>
        {unvaluedSiteLicenseCount > 0 ? (
          <Alert
            showIcon
            type="warning"
            message="Some active legacy site licenses need review"
            description={`${unvaluedSiteLicenseCount} active site license${unvaluedSiteLicenseCount === 1 ? "" : "s"} did not include enough price metadata to compute automatic credit. Support can review these manually.`}
          />
        ) : null}
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
                account.entitlement_credit_amount
                  ? `remaining paid value: ${formatMoney(account.entitlement_credit_amount)}`
                  : "",
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
      <MembershipPurchaseModal
        initialTargetClass={continueMembership ?? undefined}
        initialTargetInterval={
          (continueInterval ?? undefined) as BillingInterval | undefined
        }
        open={continueOpen}
        onChanged={() => void load()}
        onClose={() => setContinueOpen(false)}
        replaceCurrentCanceledSubscription
      />
    </Card>
  );
}
