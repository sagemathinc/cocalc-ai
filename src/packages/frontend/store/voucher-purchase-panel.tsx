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
  Space,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";

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

import { createVoucherPurchase } from "./api";

const { Paragraph, Text } = Typography;

const DEFAULT_AMOUNT = 25;
const DEFAULT_COUNT = 1;
const DEFAULT_TITLE = "CoCalc voucher";

export default function VoucherPurchasePanel({
  onOpenVoucherCenter,
}: {
  onOpenVoucherCenter: () => void;
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
  const [processing, setProcessing] = useState<boolean>(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string>("");
  const [actionLoading, setActionLoading] = useState<boolean>(false);

  const totalValue = useMemo(() => {
    if (!amount || !count) return toDecimal(0);
    return toDecimal(amount).mul(count);
  }, [amount, count]);

  useEffect(() => {
    let canceled = false;
    async function loadQuote() {
      if (!amount || !count) {
        setQuote(null);
        return;
      }
      setQuoteLoading(true);
      setQuoteError("");
      try {
        const result = await isPurchaseAllowed(
          "voucher",
          totalValue.toNumber(),
        );
        if (!canceled) {
          setQuote(result);
        }
      } catch (err) {
        if (!canceled) {
          setQuoteError(`${err}`);
        }
      } finally {
        if (!canceled) {
          setQuoteLoading(false);
        }
      }
    }
    loadQuote();
    return () => {
      canceled = true;
    };
  }, [amount, count, totalValue]);

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
    }
  }

  const canPurchase =
    amount > 0 && count > 0 && title.trim().length > 0 && !actionLoading;

  async function directPurchase() {
    if (!canPurchase) return;
    setActionError("");
    setActionLoading(true);
    try {
      const result = await createVoucherPurchase({
        amount,
        count,
        title: title.trim(),
      });
      setCodes(result.codes ?? []);
      onOpenVoucherCenter();
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Purchase credit vouchers to share with students, collaborators, or
        teammates. Vouchers redeem into account credit and do not expire.
      </Paragraph>
      <Flex gap="middle" wrap="wrap">
        <Space.Compact>
          <Button disabled tabIndex={-1}>
            $
          </Button>
          <InputNumber
            max={MAX_VOUCHER_VALUE}
            min={1}
            precision={2}
            step={5}
            value={amount}
            onChange={(value) => {
              setAmount(typeof value === "number" ? value : DEFAULT_AMOUNT);
            }}
          />
        </Space.Compact>
        <Space.Compact>
          <InputNumber
            max={MAX_VOUCHERS.now}
            min={1}
            value={count}
            onChange={(value) => {
              setCount(typeof value === "number" ? value : DEFAULT_COUNT);
            }}
          />
          <Button disabled tabIndex={-1}>
            {`voucher${count === 1 ? "" : "s"}`}
          </Button>
        </Space.Compact>
        <Input
          placeholder="Voucher title"
          style={{ minWidth: "240px" }}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Flex>
      <Text>
        Total face value: {currency(totalValue.toNumber())}{" "}
        {quoteLoading && (
          <Text type="secondary">(checking purchase limits)</Text>
        )}
      </Text>
      {quote?.discouraged && quote?.reason && (
        <Alert message={quote.reason} type="warning" />
      )}
      {quoteError && <Alert message={quoteError} type="error" />}
      {actionError && <Alert message={actionError} type="error" />}

      {!processing && chargeAmountValue.eq(0) && (
        <Button
          disabled={!canPurchase}
          loading={actionLoading}
          type="primary"
          onClick={directPurchase}
        >
          Create vouchers now
        </Button>
      )}

      {!processing && chargeAmountValue.gt(0) && (
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
              onOpenVoucherCenter();
            } catch (err) {
              setActionError(`${err}`);
            }
          }}
        />
      )}

      {processing && (
        <Alert
          message="Payment processing"
          description="Your voucher codes will appear in the Voucher Center shortly."
          type="info"
        />
      )}

      {codes.length > 0 && (
        <Alert
          message="Voucher codes created"
          description={codes.join(", ")}
          type="success"
        />
      )}

      <Button type="link" onClick={onOpenVoucherCenter}>
        Open Voucher Center
      </Button>
    </Space>
  );
}
