/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Flex, Modal, Space, Spin, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import api from "@cocalc/frontend/client/api";
import { Icon } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
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

const { Text, Title } = Typography;

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
  if (quote && quoteChargeValue.gt(0)) {
    lineItems.push({
      description: `${selectedLabel} membership (${interval})`,
      amount: moneyRound2Up(quoteChargeValue).toNumber(),
    });
    if (chargeAmountValue.lt(quoteChargeValue)) {
      lineItems.push({
        description: "Apply account balance toward membership change",
        amount: chargeAmountValue.sub(quoteChargeValue).toNumber(),
      });
    }
  }

  const changeLabel =
    quote?.change === "upgrade"
      ? "Upgrade"
      : quote?.change === "downgrade"
        ? "Downgrade"
        : "Start";
  const canProceed = quote?.allowed !== false || paymentRequired;

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

  const modalWidth = place === "choose" ? 1180 : 900;

  return (
    <Modal
      footer={null}
      open={open}
      onCancel={onClose}
      onOk={onClose}
      style={{ maxWidth: "calc(100vw - 32px)" }}
      width={modalWidth}
      title={
        <Flex align="center" gap="small">
          <Icon name="user" />
          <Title level={4} style={{ margin: 0 }}>
            Change Membership
          </Title>
        </Flex>
      }
    >
      {loading && (
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" title={error} />}
      {!loading && !error && place === "choose" && (
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
      )}

      {!loading && !error && selectedTierId && place !== "choose" && (
        <Space vertical size="middle" style={{ width: "100%" }}>
          {place === "checkout" && (
            <div>
              <Button onClick={backToChooser}>Back</Button>
            </div>
          )}
          {quoteLoading && <Spin />}
          {quoteError && <Alert type="error" title={quoteError} />}
          {quote && quote.allowed === false && quote.reason && (
            <Alert
              type={paymentRequired ? "warning" : "error"}
              title={quote.reason}
            />
          )}
          {quote && place === "checkout" && (
            <div>
              <div style={{ marginBottom: "12px" }}>
                <Text strong>
                  {changeLabel} to {selectedLabel} ({interval})
                </Text>
              </div>
              {refundValue.gt(0) && (
                <Alert
                  type="info"
                  title={`Prorated credit applied: ${currency(
                    moneyRound2Up(refundValue).toNumber(),
                  )}`}
                />
              )}
              {quote.trial_available && quote.trial_days ? (
                <Alert
                  type="success"
                  showIcon
                  style={{ marginBottom: "12px" }}
                  title={`${quote.trial_days}-day free trial`}
                  description="You can cancel before the trial ends and you will not be charged. A payment method is required so the subscription can renew automatically if you keep it."
                />
              ) : null}
              {quote.trial_requires_payment_method &&
                quote.allowed === false && (
                  <div style={{ marginTop: "12px" }}>
                    <Button
                      href={joinUrlPath(
                        appBasePath,
                        "settings/payment-methods",
                      )}
                      target="_blank"
                    >
                      Add payment method
                    </Button>
                  </div>
                )}
              {quote.change === "downgrade" && quote.current_period_end && (
                <Alert
                  type="info"
                  title={
                    <span>
                      Downgrades take effect immediately. Current period ends{" "}
                      <TimeAgo date={quote.current_period_end} />.
                    </span>
                  }
                />
              )}
              {canProceed &&
                quoteChargeValue.gt(0) &&
                chargeAmountValue.gt(0) && (
                  <div style={{ marginTop: "12px" }}>
                    <StripePayment
                      disabled={actionLoading}
                      lineItems={lineItems}
                      description={`Membership change to ${selectedLabel} (${interval})`}
                      purpose={MEMBERSHIP_CHANGE}
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
                  </div>
                )}
              {canProceed &&
                (quoteChargeValue.eq(0) || chargeAmountValue.eq(0)) && (
                  <div style={{ marginTop: "12px" }}>
                    <Space>
                      <Button onClick={onClose}>Cancel</Button>
                      <Button
                        type="primary"
                        loading={actionLoading}
                        onClick={directChange}
                      >
                        Confirm change
                      </Button>
                    </Space>
                  </div>
                )}
            </div>
          )}
          {place === "processing" && (
            <div>
              <Alert
                type="info"
                title="Payment is processing. Your membership will update once the payment completes."
                style={{ marginBottom: "12px" }}
              />
              <Payments
                purpose={MEMBERSHIP_CHANGE}
                numPaymentsRef={numPaymentsRef}
                limit={5}
              />
              <div style={{ marginTop: "12px" }}>
                <Space>
                  <Button onClick={refreshStatus}>Refresh membership</Button>
                  <Button type="primary" onClick={onClose}>
                    Close
                  </Button>
                </Space>
              </div>
            </div>
          )}
          {place === "done" && (
            <Alert
              type="success"
              title="Membership updated."
              style={{ marginTop: "12px" }}
            />
          )}
        </Space>
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </Modal>
  );
}
