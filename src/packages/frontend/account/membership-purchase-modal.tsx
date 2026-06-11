/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Flex, Modal, Space, Spin, Typography } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import api from "@cocalc/frontend/client/api";
import { Icon } from "@cocalc/frontend/components";
import StripePayment from "@cocalc/frontend/purchases/stripe-payment";
import Payments from "@cocalc/frontend/purchases/payments";
import {
  applyMembershipChange,
  getMembershipChangeQuote,
  type MembershipChangeQuote,
} from "@cocalc/frontend/purchases/api";
import {
  filterMembershipTiersForBillingInterval,
  isFreeMembershipTier,
  MembershipBillingSelector,
  MembershipPricingTierGrid,
  MembershipPricingTierTile,
  membershipPriceValue,
  type BillingInterval,
  type MembershipPricingTier,
} from "./membership-pricing-chooser";
import { MEMBERSHIP_CHANGE } from "@cocalc/util/db-schema/purchases";
import { sortMembershipTiersByDisplayOrder } from "@cocalc/util/membership-tier-order";
import { currency } from "@cocalc/util/misc";
import { moneyRound2Up, toDecimal, type MoneyValue } from "@cocalc/util/money";
import type { LineItem } from "@cocalc/util/stripe/types";
import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Text } = Typography;

interface MembershipTier extends MembershipPricingTier {
  id: string;
  label?: string;
  store_visible?: boolean;
  priority?: number;
  price_monthly?: MoneyValue;
  price_yearly?: MoneyValue;
  trial_days?: number;
  disabled?: boolean;
}

interface MembershipTiersResponse {
  tiers?: MembershipTier[];
}

function billingAdjective(interval: BillingInterval): string {
  return interval === "year" ? "annual" : "monthly";
}

function billingDescription(interval: BillingInterval): string {
  return interval === "year" ? "billed annually" : "billed monthly";
}

function formatCompactCurrency(value: unknown): string {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return currency(0, 0);
  const rounded = Math.round(numberValue);
  return Math.abs(numberValue - rounded) < 0.005
    ? currency(rounded, 0)
    : currency(numberValue);
}

function formatLongDate(value?: Date | string): string | undefined {
  if (value == null) return;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function projectedPeriodEnd({
  interval,
  quote,
}: {
  interval: BillingInterval;
  quote: MembershipChangeQuote;
}): Date {
  if (quote.trial_available && quote.trial_days) {
    return dayjs().add(quote.trial_days, "day").toDate();
  }
  return dayjs()
    .add(1, interval === "year" ? "year" : "month")
    .toDate();
}

function monthlyRate({
  interval,
  tier,
}: {
  interval: BillingInterval;
  tier: MembershipTier;
}): string | undefined {
  const price =
    interval === "year"
      ? membershipPriceValue(tier.price_yearly)
      : membershipPriceValue(tier.price_monthly);
  if (price == null || price <= 0) return;
  const monthly = interval === "year" ? price / 12 : price;
  return `${formatCompactCurrency(monthly)}/month`;
}

interface Props {
  currentClassOverride?: string;
  currentIntervalOverride?: BillingInterval;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

export default function MembershipPurchaseModal({
  currentClassOverride,
  currentIntervalOverride,
  open,
  onClose,
  onChanged,
}: Props) {
  const [membership, setMembership] = useState<MembershipResolution | null>(
    null,
  );
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [interval, setInterval] = useState<BillingInterval>("year");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [quote, setQuote] = useState<MembershipChangeQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState<boolean>(false);
  const [quoteError, setQuoteError] = useState<string>("");
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [place, setPlace] = useState<
    "choose" | "checkout" | "processing" | "done"
  >("choose");
  const numPaymentsRef = useRef<number | null>(null);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setQuoteError(`${err}`),
  });

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [membershipResult, tiersResult] = await Promise.all([
        api("purchases/get-membership"),
        api("purchases/get-membership-tiers"),
      ]);
      setMembership(membershipResult as MembershipResolution);
      setTiers((tiersResult as MembershipTiersResponse)?.tiers ?? []);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setSelectedTierId(null);
    setQuote(null);
    setQuoteError("");
    setInterval("year");
    setPlace("choose");
    load();
  }, [open]);

  const availableTiers = useMemo(() => {
    return sortMembershipTiersByDisplayOrder(
      tiers.filter((tier) => tier.store_visible && !tier.disabled),
    );
  }, [tiers]);
  const visibleTiers = useMemo(
    () => filterMembershipTiersForBillingInterval(availableTiers, interval),
    [availableTiers, interval],
  );

  const tierById = useMemo(() => {
    return availableTiers.reduce(
      (acc, tier) => {
        acc[tier.id] = tier;
        return acc;
      },
      {} as Record<string, MembershipTier>,
    );
  }, [availableTiers]);

  useEffect(() => {
    if (!open || !selectedTierId || place === "choose") return;
    const loadQuote = async () => {
      setQuote(null);
      setQuoteError("");
      setQuoteLoading(true);
      try {
        const result = await getMembershipChangeQuote({
          class: selectedTierId,
          interval,
          allow_downgrade: true,
        });
        setQuote(result);
      } catch (err) {
        setQuoteError(`${err}`);
      } finally {
        setQuoteLoading(false);
      }
    };
    loadQuote();
  }, [open, selectedTierId, interval, place]);

  const currentPersonalClass =
    currentClassOverride ??
    (membership?.source === "subscription" || membership?.source === "free"
      ? membership.class
      : undefined);
  const currentPersonalInterval =
    currentIntervalOverride ??
    (membership?.source === "subscription"
      ? membership.subscription_interval
      : undefined);
  const selectedTier = selectedTierId ? tierById[selectedTierId] : undefined;
  const selectedLabel = selectedTier?.label ?? selectedTier?.id ?? "";

  const quoteChargeValue = toDecimal(quote?.charge ?? 0);
  const quotePriceValue = toDecimal(quote?.price ?? 0);
  const rawChargeAmount =
    quote?.charge_amount ??
    (quote as { chargeAmount?: number } | null)?.chargeAmount;
  const chargeAmountValue =
    rawChargeAmount != null ? toDecimal(rawChargeAmount) : quoteChargeValue;
  const paymentRequired =
    quote?.allowed === false &&
    rawChargeAmount != null &&
    chargeAmountValue.gt(0);
  const refundValue = toDecimal(quote?.refund ?? 0);

  const lineItems: LineItem[] = [];
  if (quote && selectedTier && chargeAmountValue.gt(0)) {
    const targetLineDescription = `${selectedLabel} membership, ${billingAdjective(interval)}`;
    lineItems.push({
      description: targetLineDescription,
      amount: moneyRound2Up(
        refundValue.gt(0) ? quotePriceValue : quoteChargeValue,
      ).toNumber(),
    });
    if (refundValue.gt(0)) {
      const existingLabel = quote.existing_class
        ? (tierById[quote.existing_class]?.label ?? quote.existing_class)
        : "current";
      lineItems.push({
        description: `Prorated credit for current ${existingLabel} membership`,
        amount: moneyRound2Up(refundValue.neg()).toNumber(),
      });
    }
    const lineItemTotal = lineItems.reduce(
      (total, lineItem) => total.add(toDecimal(lineItem.amount)),
      toDecimal(0),
    );
    if (chargeAmountValue.lt(lineItemTotal)) {
      lineItems.push({
        description: "Account credit applied",
        amount: chargeAmountValue.sub(lineItemTotal).toNumber(),
      });
    } else if (chargeAmountValue.gt(lineItemTotal)) {
      lineItems.push({
        description: "Additional account credit",
        amount: chargeAmountValue.sub(lineItemTotal).toNumber(),
      });
    }
  }

  const canProceed = quote?.allowed !== false || paymentRequired;
  const showFullPaymentSummary = lineItems.length > 1;
  const targetMonthlyRate = selectedTier
    ? monthlyRate({ interval, tier: selectedTier })
    : undefined;
  const targetSummary =
    selectedTier == null
      ? ""
      : targetMonthlyRate == null
        ? `${selectedLabel} membership`
        : `${selectedLabel}: ${targetMonthlyRate}, ${billingDescription(
            interval,
          )}${
            quote?.change === "downgrade"
              ? ""
              : quote?.trial_available && quote?.trial_days
                ? `, ${Math.floor(quote.trial_days)}-day free trial`
                : ", starts today"
          }`;
  const targetSummaryText = targetSummary ? `${targetSummary}.` : "";
  const currentPeriodEndText = formatLongDate(quote?.current_period_end);
  const upcomingRenewalText =
    quote && quote.change !== "downgrade" && quotePriceValue.gt(0)
      ? formatLongDate(projectedPeriodEnd({ interval, quote }))
      : undefined;
  const confirmChangeLabel =
    quote?.change === "downgrade" ? "Confirm downgrade" : "Confirm change";

  function isCurrentChoice(tier: MembershipTier): boolean {
    if (tier.id !== currentPersonalClass) return false;
    if (isFreeMembershipTier(tier)) return true;
    return (
      currentPersonalInterval == null || currentPersonalInterval === interval
    );
  }

  function selectTier(tier: MembershipTier) {
    if (isCurrentChoice(tier)) return;
    setSelectedTierId(tier.id);
    setQuote(null);
    setQuoteError("");
    setPlace("checkout");
  }

  function backToChooser() {
    setSelectedTierId(null);
    setQuote(null);
    setQuoteError("");
    setPlace("choose");
  }

  const directChange = async () => {
    if (!selectedTierId) return;
    setActionLoading(true);
    setQuoteError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        await applyMembershipChange({
          class: selectedTierId,
          interval,
          allow_downgrade: true,
        });
        setPlace("done");
        await load();
        onChanged?.();
      });
      if (!completed) {
        return;
      }
    } catch (err) {
      setQuoteError(`${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const refreshStatus = async () => {
    await load();
    onChanged?.();
  };

  const modalWidth = place === "choose" ? 1180 : 600;

  function renderChooseStep() {
    return (
      <Space vertical size="large" style={{ width: "100%" }}>
        <MembershipBillingSelector
          billingInterval={interval}
          setBillingInterval={setInterval}
        />
        {visibleTiers.length === 0 ? (
          <Alert
            showIcon
            type="info"
            title={`No ${interval === "month" ? "monthly" : "annual"} membership tiers are currently available.`}
          />
        ) : (
          <MembershipPricingTierGrid>
            {visibleTiers.map((tier) => {
              const current = isCurrentChoice(tier);
              return (
                <MembershipPricingTierTile
                  billingInterval={interval}
                  current={current}
                  key={tier.id}
                  onClick={current ? undefined : () => selectTier(tier)}
                  tier={tier}
                />
              );
            })}
          </MembershipPricingTierGrid>
        )}
        <Flex justify="center">
          <Button
            href={joinUrlPath(appBasePath, "pricing")}
            rel="noreferrer"
            target="_blank"
          >
            Compare membership details <Icon name="external-link" />
          </Button>
        </Flex>
      </Space>
    );
  }

  function renderCheckoutStep() {
    if (!quote || !selectedTierId) return null;
    return (
      <Space align="center" vertical style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon={false}
          style={{ width: "100%" }}
          message={
            <Space align="center" vertical>
              {targetSummaryText ? (
                <Text strong style={{ fontSize: 16 }}>
                  {targetSummaryText}
                </Text>
              ) : null}
              {quote.change === "downgrade" ? (
                <>
                  {currentPeriodEndText ? (
                    <Text>
                      Your current membership remains active until{" "}
                      {currentPeriodEndText}. {selectedLabel} starts after that
                      date.
                    </Text>
                  ) : null}
                  <Text>No payment is due now.</Text>
                </>
              ) : upcomingRenewalText ? (
                <Text>
                  Upcoming renewal: {formatCompactCurrency(quote.price)} on{" "}
                  {upcomingRenewalText}, unless canceled.
                </Text>
              ) : null}
            </Space>
          }
        />
        <Button onClick={backToChooser}>Change selection</Button>
        {quote.trial_requires_payment_method && quote.allowed === false && (
          <Button
            href={joinUrlPath(appBasePath, "settings/payment-methods")}
            target="_blank"
            type="primary"
          >
            Add payment method to start free trial
          </Button>
        )}
        {canProceed && quoteChargeValue.gt(0) && chargeAmountValue.gt(0) && (
          <StripePayment
            disabled={actionLoading}
            lineItems={lineItems}
            description={`${selectedLabel} membership, ${billingAdjective(
              interval,
            )}`}
            purpose={MEMBERSHIP_CHANGE}
            summaryMode={showFullPaymentSummary ? "full" : "total-only"}
            title={null}
            metadata={{
              membership_class: selectedTierId,
              membership_interval: interval,
              allow_downgrade: "true",
            }}
            onFinished={async (total) => {
              if (!total) {
                await directChange();
              } else {
                setPlace("processing");
              }
            }}
          />
        )}
        {canProceed && (quoteChargeValue.eq(0) || chargeAmountValue.eq(0)) && (
          <Space>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="primary"
              loading={actionLoading}
              onClick={directChange}
            >
              {confirmChangeLabel}
            </Button>
          </Space>
        )}
      </Space>
    );
  }

  function renderProcessingStep() {
    return (
      <Space vertical size="middle">
        <Alert
          type="info"
          title="Payment is processing. Your membership will update once the payment completes."
        />
        <Payments
          purpose={MEMBERSHIP_CHANGE}
          numPaymentsRef={numPaymentsRef}
          limit={5}
        />
        <Space>
          <Button onClick={refreshStatus}>Refresh membership</Button>
          <Button type="primary" onClick={onClose}>
            Close
          </Button>
        </Space>
      </Space>
    );
  }

  function renderSelectedStep() {
    if (!selectedTierId) return null;
    return (
      <Space vertical size="middle" style={{ width: "100%" }}>
        {quoteLoading && <Spin />}
        {quoteError && <Alert type="error" title={quoteError} />}
        {quote &&
          quote.allowed === false &&
          quote.reason &&
          !paymentRequired &&
          !quote.trial_requires_payment_method && (
            <Alert type="error" title={quote.reason} />
          )}
        {place === "checkout" && renderCheckoutStep()}
        {place === "processing" && renderProcessingStep()}
        {place === "done" && (
          <Alert type="success" title="Membership updated." />
        )}
      </Space>
    );
  }

  function renderModalBody() {
    if (loading) {
      return (
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          <Spin />
        </div>
      );
    }
    if (error) {
      return <Alert type="error" title={error} />;
    }
    if (place === "choose") {
      return renderChooseStep();
    }
    return renderSelectedStep();
  }

  return (
    <Modal
      footer={null}
      open={open}
      onCancel={onClose}
      onOk={onClose}
      style={{ maxWidth: "calc(100vw - 32px)" }}
      width={modalWidth}
      title="Change Membership"
    >
      {renderModalBody()}
      <FreshAuthModal {...freshAuthModalProps} />
    </Modal>
  );
}
