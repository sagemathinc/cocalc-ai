/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Segmented, Space, Tag, Typography } from "antd";
import { useEffect, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, Loading } from "@cocalc/frontend/components";
import { load_target } from "@cocalc/frontend/history";
import openSupportTab from "@cocalc/frontend/support/open";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { LegacyMigrationFinancialPreviewResponse } from "@cocalc/conat/hub/api/legacy-migration";
import { legacyBillingMigrationReviewRequested } from "./legacy-billing-migration-review";
import { getPaymentMethods } from "./api";

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
  if (value === "member") return "Standard membership";
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)} membership`;
}

function planIntervalPriceLabel(
  plan: LegacyMigrationFinancialPreviewResponse["plans"][number] | undefined,
  interval: "month" | "year",
): string | null {
  const price = interval === "year" ? plan?.price_yearly : plan?.price_monthly;
  if (price == null) return null;
  return `${formatMoney(price)}/${interval}`;
}

function hasVisibleLegacyBilling(
  preview: LegacyMigrationFinancialPreviewResponse,
): boolean {
  return (
    !!preview.email_verification_required ||
    (preview.legacy_accounts.length > 0 &&
      (preview.pending_credit_amount > 0 ||
        preview.applied_credit_amount > 0 ||
        preview.active_subscription_count > 0 ||
        preview.membership_already_applied ||
        !!preview.stripe_customer_id ||
        preview.legacy_accounts.some(
          (account) => account.unvalued_active_site_license_count > 0,
        )))
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
  const helpEmail = useTypedRedux("customize", "help_email");
  const stripeEnabled = !!useTypedRedux("customize", "stripe_enabled");
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [renewalInterval, setRenewalInterval] = useState<"month" | "year">(
    "month",
  );
  const [renewalSaving, setRenewalSaving] = useState<
    "cancel" | "basic" | "member" | "pro" | null
  >(null);
  const [hasPaymentMethods, setHasPaymentMethods] = useState<boolean | null>(
    null,
  );
  const [preview, setPreview] =
    useState<LegacyMigrationFinancialPreviewResponse>();
  const reviewRequested = legacyBillingMigrationReviewRequested(account_id);

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

  useEffect(() => {
    if (!preview) return;
    setRenewalInterval(
      preview.membership_renewal_interval ??
        preview.applied_membership_interval ??
        preview.suggested_membership_interval,
    );
  }, [
    preview?.membership_renewal_interval,
    preview?.applied_membership_interval,
    preview?.suggested_membership_interval,
  ]);

  useEffect(() => {
    if (!legacyMigrationEnabled || !stripeEnabled) {
      setHasPaymentMethods(false);
      return;
    }
    (async () => {
      try {
        const paymentMethods = await getPaymentMethods({ limit: 1 });
        setHasPaymentMethods(paymentMethods.data.length > 0);
      } catch (_err) {
        setHasPaymentMethods(false);
      }
    })();
  }, [legacyMigrationEnabled, stripeEnabled]);

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

  async function configureRenewal(
    membership_class: "basic" | "member" | "pro" | null,
  ) {
    if (!preview?.applied_membership_class) return;
    setRenewalSaving(membership_class ?? "cancel");
    setError("");
    try {
      await webapp_client.conat_client.hub.legacyMigration.configureFinancialMembershipRenewal(
        {
          membership_class,
          membership_interval:
            membership_class == null ? null : renewalInterval,
        },
      );
      await load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRenewalSaving(null);
    }
  }

  if (!legacyMigrationEnabled) return null;
  if ((loading || reviewRequested) && !preview) {
    return (
      <Card size="small">
        <Space>
          <Loading theme="medium" />
          <Text>Loading billing migration...</Text>
        </Space>
      </Card>
    );
  }
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

  const verificationEmail = `${preview.email_verification_email ?? ""}`.trim();
  if (preview.email_verification_required) {
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
        <Alert
          showIcon
          type="warning"
          message="Verify your email address to migrate legacy billing"
          description={
            <span>
              {verificationEmail ? (
                <>
                  Your current email address{" "}
                  <Text code>{verificationEmail}</Text> matches legacy
                  cocalc.com billing data, but it is not verified yet.
                </>
              ) : (
                <>
                  Your account needs a verified email address before CoCalc can
                  match legacy billing data.
                </>
              )}{" "}
              Open{" "}
              <a
                href="/settings/profile"
                onClick={(event) => {
                  event.preventDefault();
                  load_target("settings/profile");
                }}
              >
                profile settings
              </a>{" "}
              to verify it, then return here and refresh.
            </span>
          }
        />
      </Card>
    );
  }

  const pending =
    preview.pending_credit_amount > 0 || preview.active_subscription_count > 0;
  const continueMembership = preview.applied_membership_class;
  const suggestedMembership = preview.suggested_membership_class;
  const suggestedMembershipLabel = membershipLabel(suggestedMembership);
  const continueMembershipLabel = membershipLabel(continueMembership);
  const standardRenewalLabel =
    continueMembership === "member"
      ? "Continue Standard"
      : "Upgrade to Standard";
  const basicRenewalLabel =
    continueMembership === "basic" ? "Continue Basic" : "Switch to Basic";
  const grantDays = preview.suggested_membership_grant_days ?? 30;
  const basicPlan = preview.plans.find((plan) => plan.id === "basic");
  const memberPlan = preview.plans.find((plan) => plan.id === "member");
  const proPlan = preview.plans.find((plan) => plan.id === "pro");
  const basicIntervalPrice = planIntervalPriceLabel(basicPlan, renewalInterval);
  const memberIntervalPrice = planIntervalPriceLabel(
    memberPlan,
    renewalInterval,
  );
  const proIntervalPrice = planIntervalPriceLabel(proPlan, renewalInterval);
  const proRenewalLabel =
    continueMembership === "pro" ? "Continue Pro" : "Upgrade to Pro";
  const activeRenewalClass = preview.membership_renewal_configured
    ? preview.membership_renewal_class
    : null;
  const pendingEntitlementCredit = preview.legacy_accounts.reduce(
    (total, account) =>
      account.claimed_by_account_id
        ? total
        : total + (account.entitlement_credit_amount ?? 0),
    0,
  );
  const unvaluedSiteLicenseCount = preview.legacy_accounts.reduce(
    (total, account) =>
      total + (account.unvalued_active_site_license_count ?? 0),
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
              ? suggestedMembership
                ? `Click the blue Apply now button to add positive credit including remaining paid license/subscription value, Stripe customer metadata, and a free ${grantDays}-day ${suggestedMembershipLabel} grant. The grant starts when you click Apply now. It does not auto-charge; please choose a paid plan later to continue.`
                : "Click the blue Apply now button to add positive credit including remaining paid license/subscription value and Stripe customer metadata."
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
                  You can use the free membership until the grant ends. Choose
                  what should happen after that; you can change this any time
                  before the free month ends. There is no immediate charge. The
                  free {grantDays}-day grant starts when you click Apply now.
                </span>
                {preview.membership_grant_ends_at ? (
                  <Text type="secondary">
                    Free membership ends{" "}
                    {new Date(
                      preview.membership_grant_ends_at,
                    ).toLocaleDateString()}
                    .
                  </Text>
                ) : null}
                <Segmented<"month" | "year">
                  options={[
                    { label: "Monthly", value: "month" },
                    { label: "Yearly", value: "year" },
                  ]}
                  value={renewalInterval}
                  onChange={setRenewalInterval}
                />
                <Space wrap>
                  <Button
                    loading={renewalSaving === "cancel"}
                    onClick={() => void configureRenewal(null)}
                    size="small"
                    type={activeRenewalClass == null ? "primary" : "default"}
                  >
                    Cancel at period end
                  </Button>
                  <Button
                    disabled={!memberPlan}
                    loading={renewalSaving === "member"}
                    onClick={() => void configureRenewal("member")}
                    size="small"
                    type={
                      activeRenewalClass === "member" ? "primary" : "default"
                    }
                  >
                    {standardRenewalLabel}
                    {memberIntervalPrice ? ` (${memberIntervalPrice})` : ""}
                  </Button>
                  <Button
                    disabled={!basicPlan}
                    loading={renewalSaving === "basic"}
                    onClick={() => void configureRenewal("basic")}
                    size="small"
                    type={
                      activeRenewalClass === "basic" ? "primary" : "default"
                    }
                  >
                    {basicRenewalLabel}
                    {basicIntervalPrice ? ` (${basicIntervalPrice})` : ""}
                  </Button>
                  <Button
                    disabled={!proPlan}
                    loading={renewalSaving === "pro"}
                    onClick={() => void configureRenewal("pro")}
                    size="small"
                    type={activeRenewalClass === "pro" ? "primary" : "default"}
                  >
                    {proRenewalLabel}
                    {proIntervalPrice ? ` (${proIntervalPrice})` : ""}
                  </Button>
                </Space>
                <Text type="secondary">
                  Compare membership tiers on the{" "}
                  <a href="/pricing" rel="noreferrer" target="_blank">
                    pricing page
                  </a>
                  .
                </Text>
                {preview.membership_renewal_configured ? (
                  <Text type="secondary">
                    Current selection:{" "}
                    {membershipLabel(preview.membership_renewal_class)}{" "}
                    {preview.membership_renewal_interval}.
                  </Text>
                ) : (
                  <Text type="secondary">
                    Current selection: cancel at period end.
                  </Text>
                )}
                {preview.membership_renewal_configured &&
                hasPaymentMethods === false ? (
                  <Alert
                    showIcon
                    type="warning"
                    message="Add a payment method before renewal"
                    description={
                      <span>
                        Renewal is scheduled after the free month, but CoCalc
                        does not currently see a payment method on file.{" "}
                        <a
                          href="/settings/payment-methods"
                          onClick={(event) => {
                            event.preventDefault();
                            load_target("settings/payment-methods");
                          }}
                        >
                          Add or review payment methods
                        </a>
                        .
                      </span>
                    }
                  />
                ) : null}
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
            <Text type="secondary">Membership grant</Text>
            <Text>
              {suggestedMembership ? (
                <>
                  Free {grantDays} days of{" "}
                  <a href="/pricing" rel="noreferrer" target="_blank">
                    {suggestedMembershipLabel}
                  </a>
                  starting when you click Apply now
                </>
              ) : preview.membership_already_applied ? (
                "Already applied"
              ) : (
                "None"
              )}
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
            message="Some active legacy site licenses need manual review"
            description={
              <Space direction="vertical" size="small">
                <span>
                  {unvaluedSiteLicenseCount} active legacy site license
                  {unvaluedSiteLicenseCount === 1 ? "" : "s"} did not include
                  enough price metadata to compute automatic credit. This does
                  not block applying the automatic credit and membership grant,
                  but support should review these manually.
                </span>
                <Space wrap>
                  <Button
                    onClick={() =>
                      openSupportTab({
                        type: "purchase",
                        subject: "Legacy site license migration review",
                        body: `Please review ${unvaluedSiteLicenseCount} active legacy site license(s) that did not include enough price metadata for automatic migration.`,
                      })
                    }
                    size="small"
                  >
                    Create support ticket
                  </Button>
                  {helpEmail ? (
                    <Button href={`mailto:${helpEmail}`} size="small">
                      Email {helpEmail}
                    </Button>
                  ) : null}
                </Space>
              </Space>
            }
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
                account.unvalued_active_site_license_count
                  ? `site licenses needing review: ${account.unvalued_active_site_license_count}`
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
    </Card>
  );
}
