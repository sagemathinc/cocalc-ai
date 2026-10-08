/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Educational memberships: tiers an admin marked "available for instructor
// purchase". Eligible educators can subscribe or buy one fixed term; others
// can request manual approval through a support ticket.

import { Alert, Button, Modal, Space, Spin, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  educatorPriceSummary,
  educatorTermProduct,
  requestEducatorApproval,
  useEducatorOffers,
} from "./educator-offers-data";

import type {
  EducatorOfferTier,
  MembershipPackageQuote,
} from "@cocalc/conat/hub/api/purchases";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { TimeAgo } from "@cocalc/frontend/components";
import Payments from "@cocalc/frontend/purchases/payments";
import StripePayment from "@cocalc/frontend/purchases/stripe-payment";
import {
  getMembershipPackageQuote,
  isPurchaseAllowed,
  processPaymentIntents,
  purchaseMembershipPackages,
} from "@cocalc/frontend/purchases/api";
import { MEMBERSHIP_PACKAGE_PURCHASE } from "@cocalc/util/db-schema/purchases";
import { currency } from "@cocalc/util/misc";
import { moneyRound2Up, toDecimal } from "@cocalc/util/money";
import type { LineItem } from "@cocalc/util/stripe/types";

import MembershipPurchaseModal from "./membership-purchase-modal";
import { SettingsCard } from "./settings-card";

const { Paragraph, Text } = Typography;

export function EducatorOffersCard({ onChanged }: { onChanged?: () => void }) {
  const { offers, error } = useEducatorOffers();
  const [subscribeTier, setSubscribeTier] = useState<string | null>(null);
  const [termTier, setTermTier] = useState<EducatorOfferTier | null>(null);
  if (error || offers == null || offers.tiers.length === 0) {
    return null;
  }
  const { eligibility } = offers;
  return (
    <SettingsCard title="Educational memberships">
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {eligibility.eligible ? (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Your verified email address {eligibility.email_address} qualifies
            for educational pricing.
          </Paragraph>
        ) : (
          <Alert
            type="info"
            showIcon
            title="Educational pricing for instructors"
            description={
              <Space orientation="vertical">
                <span>
                  {eligibility.message ??
                    "Educational memberships require a verified academic email address."}
                </span>
                {eligibility.reason !== "no_verified_email" ? (
                  <Button
                    onClick={() =>
                      requestEducatorApproval(eligibility.email_address)
                    }
                  >
                    Request manual approval
                  </Button>
                ) : null}
              </Space>
            }
          />
        )}
        {offers.tiers.map((tier) => (
          <div key={tier.membership_class}>
            <Text strong>{tier.label}</Text>
            {tier.store_description ? (
              <Paragraph style={{ marginBottom: 4 }}>
                {tier.store_description}
              </Paragraph>
            ) : null}
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              {educatorPriceSummary(tier)}
            </Paragraph>
            {eligibility.eligible ? (
              <Space wrap>
                {tier.price_monthly != null || tier.price_yearly != null ? (
                  <Button
                    onClick={() => setSubscribeTier(tier.membership_class)}
                  >
                    Subscribe to {tier.label}
                  </Button>
                ) : null}
                {tier.term_price != null ? (
                  <Button type="primary" onClick={() => setTermTier(tier)}>
                    Buy one term of {tier.label}
                  </Button>
                ) : null}
              </Space>
            ) : null}
          </div>
        ))}
      </Space>
      <MembershipPurchaseModal
        open={subscribeTier != null}
        initialTargetClass={subscribeTier ?? undefined}
        onClose={() => setSubscribeTier(null)}
        onChanged={onChanged}
      />
      {termTier != null ? (
        <EducatorTermCheckoutModal
          tier={termTier}
          onClose={() => setTermTier(null)}
          onPurchased={async () => onChanged?.()}
        />
      ) : null}
    </SettingsCard>
  );
}

function EducatorTermCheckoutModal({
  tier,
  onClose,
  onPurchased,
}: {
  tier: EducatorOfferTier;
  onClose: () => void;
  onPurchased: () => Promise<void>;
}) {
  const product = useMemo(() => educatorTermProduct(tier), [tier]);
  const [quote, setQuote] = useState<MembershipPackageQuote | null>(null);
  const [chargeAmount, setChargeAmount] = useState<number>(0);
  const [error, setError] = useState<string>("");
  const [disabled, setDisabled] = useState<boolean>(false);
  const [place, setPlace] = useState<"checkout" | "processing" | "done">(
    "checkout",
  );
  const numPaymentsRef = useRef<number | null>(null);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const next = await getMembershipPackageQuote(product);
        const allowed = await isPurchaseAllowed("membership", next.total_price);
        if (canceled) return;
        setQuote(next);
        setChargeAmount(allowed.chargeAmount ?? next.total_price ?? 0);
      } catch (err) {
        if (!canceled) setError(`${err}`);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [product]);

  const total = toDecimal(quote?.total_price ?? 0);
  const charge = toDecimal(chargeAmount);
  const lineItems: LineItem[] = [];
  if (quote) {
    lineItems.push({
      description: `${tier.label}: one ${tier.term_days}-day term`,
      amount: moneyRound2Up(total).toNumber(),
    });
    if (charge.lt(total)) {
      lineItems.push({
        description: "Apply account credit",
        amount: charge.sub(total).toNumber(),
      });
    } else if (charge.gt(total)) {
      lineItems.push({
        description: "Minimum charge top-up added to account credit",
        amount: charge.sub(total).toNumber(),
      });
    }
  }

  async function completePurchase() {
    setError("");
    setDisabled(true);
    try {
      const completed = await runFreshAuthAction(async () => {
        await purchaseMembershipPackages({ products: [product] });
        await onPurchased();
        setPlace("done");
      });
      if (!completed) return;
    } catch (err) {
      setError(`${err}`);
    } finally {
      setDisabled(false);
    }
  }

  async function refreshProcessing() {
    setError("");
    try {
      const { count } = await processPaymentIntents();
      if (count > 0) {
        await onPurchased();
        setPlace("done");
      }
    } catch (err) {
      setError(`${err}`);
    }
  }

  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={720}
      title={`Buy one term of ${tier.label}`}
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {!quote && !error ? <Spin /> : null}
        {quote ? (
          <Paragraph style={{ marginBottom: 0 }}>
            {currency(quote.total_price)} for {tier.label} membership for you,
            {quote.starts_at ? (
              <>
                {" "}
                from <TimeAgo date={quote.starts_at} />
              </>
            ) : null}
            {quote.expires_at ? (
              <>
                {" "}
                until <TimeAgo date={quote.expires_at} />
              </>
            ) : null}
            . It does not renew automatically.
          </Paragraph>
        ) : null}
        {place === "checkout" && quote ? (
          <StripePayment
            disabled={disabled}
            description={`${tier.label}: one educator term`}
            lineItems={lineItems}
            purpose={MEMBERSHIP_PACKAGE_PURCHASE}
            metadata={{
              membership_package_products: JSON.stringify([product]),
            }}
            onFinished={async (paid) => {
              if (!paid) {
                await completePurchase();
                return;
              }
              setPlace("processing");
              await refreshProcessing();
            }}
          />
        ) : null}
        {place === "processing" ? (
          <>
            <Alert
              type="info"
              showIcon
              title="Payment submitted"
              description="Your membership starts as soon as the payment finishes processing."
            />
            <Payments
              purpose={MEMBERSHIP_PACKAGE_PURCHASE}
              numPaymentsRef={numPaymentsRef}
              limit={5}
            />
            <Button onClick={refreshProcessing}>Refresh status</Button>
          </>
        ) : null}
        {place === "done" ? (
          <Alert
            type="success"
            showIcon
            title={`${tier.label} membership is active`}
          />
        ) : null}
      </Space>
      <FreshAuthModal {...freshAuthModalProps} />
    </Modal>
  );
}
