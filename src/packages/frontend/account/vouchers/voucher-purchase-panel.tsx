/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Flex,
  Input,
  InputNumber,
  Modal,
  Space,
  Typography,
} from "antd";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";

import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import StripePayment from "@cocalc/frontend/purchases/stripe-payment";
import {
  isPurchaseAllowed,
  processPaymentIntents,
} from "@cocalc/frontend/purchases/api";
import { VOUCHER_PURCHASE } from "@cocalc/util/db-schema/purchases";
import { currency } from "@cocalc/util/misc";
import { moneyRound2Up, toDecimal } from "@cocalc/util/money";
import type { LineItem } from "@cocalc/util/stripe/types";
import { MAX_VOUCHERS, MAX_VOUCHER_VALUE } from "@cocalc/util/vouchers";

import { createVoucherPurchase } from "@cocalc/frontend/store/api";

const { Text } = Typography;

const DEFAULT_AMOUNT = 25;
const DEFAULT_COUNT = 1;
const DEFAULT_TITLE = "CoCalc voucher";

function normalizeVoucherCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_COUNT;
  }
  return Math.max(1, Math.min(MAX_VOUCHERS.now, Math.trunc(value)));
}

function VoucherField({
  children,
  label,
  style,
}: {
  children: ReactNode;
  label: string;
  style?: CSSProperties;
}) {
  return (
    <Space vertical size={4} style={style}>
      <Text strong>{label}</Text>
      {children}
    </Space>
  );
}

export default function VoucherPurchasePanel({
  onPurchased,
}: {
  onPurchased?: () => void | Promise<void>;
}) {
  const [amount, setAmount] = useState<number>(DEFAULT_AMOUNT);
  const [count, setCount] = useState<number>(DEFAULT_COUNT);
  const [title, setTitle] = useState<string>(DEFAULT_TITLE);
  const [quoteError, setQuoteError] = useState<string>("");
  const [quoteLoading, setQuoteLoading] = useState<boolean>(false);
  const [quote, setQuote] = useState<{
    allowed: boolean;
    chargeAmount?: number;
    discouraged?: boolean;
    reason?: string;
  } | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState<boolean>(false);
  const [processing, setProcessing] = useState<boolean>(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string>("");
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setActionError(`${err}`),
  });

  const totalValue = useMemo(() => {
    if (!amount || !count) return toDecimal(0);
    return toDecimal(amount).mul(count);
  }, [amount, count]);

  const chargeAmountValue = useMemo(() => {
    if (quote?.chargeAmount == null) {
      return totalValue;
    }
    return toDecimal(quote.chargeAmount);
  }, [quote, totalValue]);

  const lineItems: LineItem[] = [];
  if (totalValue.gt(0)) {
    lineItems.push({
      description: `${count} voucher${count === 1 ? "" : "s"} (${currency(
        amount,
      )} each)`,
      amount: moneyRound2Up(totalValue).toNumber(),
    });
    if (chargeAmountValue.lt(totalValue)) {
      lineItems.push({
        description: "Apply account credit toward vouchers",
        amount: chargeAmountValue.sub(totalValue).toNumber(),
      });
    } else if (chargeAmountValue.gt(totalValue)) {
      lineItems.push({
        description: "Minimum charge top-up added to account credit",
        amount: chargeAmountValue.sub(totalValue).toNumber(),
      });
    }
  }

  const canPurchase =
    amount > 0 &&
    count > 0 &&
    title.trim().length > 0 &&
    !actionLoading &&
    !quoteLoading;
  const canCompleteQuote =
    quote != null &&
    (quote.allowed !== false ||
      (quote.chargeAmount != null && toDecimal(quote.chargeAmount).gt(0)));
  const quoteWarning =
    quote?.reason && (quote.discouraged || quote.allowed === false)
      ? quote.reason
      : "";

  async function beginCheckout() {
    if (!canPurchase) {
      setQuoteError("Enter a voucher value, count, and description first.");
      return;
    }
    setQuoteError("");
    setActionError("");
    setQuote(null);
    setProcessing(false);
    setCodes([]);
    setQuoteLoading(true);
    try {
      const result = await isPurchaseAllowed("voucher", totalValue.toNumber());
      const canComplete =
        result.allowed !== false ||
        (result.chargeAmount != null && toDecimal(result.chargeAmount).gt(0));
      setQuote(result);
      if (!canComplete) {
        setQuoteError(result.reason ?? "This voucher purchase is not allowed.");
        return;
      }
      setCheckoutOpen(true);
    } catch (err) {
      setQuoteError(`${err}`);
    } finally {
      setQuoteLoading(false);
    }
  }

  async function directPurchase() {
    if (!canPurchase) return;
    setActionError("");
    setActionLoading(true);
    try {
      await runFreshAuthAction(async () => {
        const result = await createVoucherPurchase({
          amount,
          count,
          title: title.trim(),
        });
        setCodes(result.codes ?? []);
        await onPurchased?.();
        setCheckoutOpen(false);
      });
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <Space vertical style={{ width: "100%" }}>
      <Flex align="end" gap="middle" wrap="wrap">
        <VoucherField label="Credit per voucher">
          <InputNumber
            max={MAX_VOUCHER_VALUE}
            min={1}
            precision={2}
            prefix="$"
            step={5}
            style={{ width: "160px" }}
            value={amount}
            onChange={(value) => {
              setAmount(typeof value === "number" ? value : DEFAULT_AMOUNT);
            }}
          />
        </VoucherField>
        <VoucherField label="Number of vouchers">
          <InputNumber
            max={MAX_VOUCHERS.now}
            min={1}
            precision={0}
            step={1}
            style={{ width: "160px" }}
            value={count}
            onChange={(value) => {
              setCount(normalizeVoucherCount(value));
            }}
          />
        </VoucherField>
        <VoucherField
          label="Description"
          style={{ flex: "1 1 240px", maxWidth: "420px" }}
        >
          <Input
            placeholder="Description shown in your voucher list"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </VoucherField>
      </Flex>
      {quoteError && <Alert title={quoteError} type="error" />}
      {!checkoutOpen && actionError && (
        <Alert title={actionError} type="error" />
      )}

      <Button
        disabled={!canPurchase}
        loading={quoteLoading}
        type="primary"
        onClick={beginCheckout}
      >
        Buy vouchers
      </Button>

      {codes.length > 0 && (
        <Alert
          title="Voucher codes created"
          description={codes.join(", ")}
          type="success"
        />
      )}

      <Modal
        destroyOnHidden
        footer={null}
        open={checkoutOpen}
        title="Buy vouchers"
        width={820}
        onCancel={() => setCheckoutOpen(false)}
      >
        <Space vertical size="middle" style={{ width: "100%" }}>
          <Space vertical size={4}>
            <Text strong>Voucher purchase</Text>
            <Text>
              {count} voucher{count === 1 ? "" : "s"} at {currency(amount)}{" "}
              each, for {currency(totalValue.toNumber())} total credit.
            </Text>
          </Space>
          {quoteWarning && <Alert title={quoteWarning} type="warning" />}
          {actionError && <Alert title={actionError} type="error" />}
          {!processing && canCompleteQuote && chargeAmountValue.eq(0) && (
            <Button
              disabled={!canPurchase}
              loading={actionLoading}
              type="primary"
              onClick={directPurchase}
            >
              Create vouchers now
            </Button>
          )}
          {!processing && canCompleteQuote && chargeAmountValue.gt(0) && (
            <StripePayment
              description="Voucher purchase"
              lineItems={lineItems}
              metadata={{
                voucher_amount: `${amount}`,
                voucher_count: `${count}`,
                voucher_title: title.trim(),
              }}
              purpose={VOUCHER_PURCHASE}
              onFinished={async (total) => {
                if (!total) {
                  await directPurchase();
                  return;
                }
                setProcessing(true);
                try {
                  await processPaymentIntents();
                  await onPurchased?.();
                } catch (err) {
                  setActionError(`${err}`);
                }
              }}
            />
          )}
          {processing && (
            <Alert
              title="Payment processing"
              description="Your voucher codes will appear below shortly."
              type="info"
            />
          )}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </Space>
  );
}
