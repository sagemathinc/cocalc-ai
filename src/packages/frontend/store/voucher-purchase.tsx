import { Alert, Button, Flex, Input, InputNumber, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { isPurchaseAllowed, processPaymentIntents } from "@cocalc/frontend/purchases/api";
import StripePayment from "@cocalc/frontend/purchases/stripe-payment";
import { currency } from "@cocalc/util/misc";
import { toDecimal, moneyRound2Up } from "@cocalc/util/money";
import type { LineItem } from "@cocalc/util/stripe/types";
import { MAX_VOUCHERS, MAX_VOUCHER_VALUE } from "@cocalc/util/vouchers";
import { createVoucherPurchase } from "./voucher-purchase-api";
import { VOUCHER_PURCHASE } from "@cocalc/util/db-schema/purchases";

const { Paragraph, Text } = Typography;

const DEFAULT_AMOUNT = 25;
const DEFAULT_COUNT = 1;
const DEFAULT_TITLE = "CoCalc voucher";

export default function VoucherPurchasePanel() {
  const [amount, setAmount] = useState<number>(DEFAULT_AMOUNT);
  const [count, setCount] = useState<number>(DEFAULT_COUNT);
  const [title, setTitle] = useState<string>(DEFAULT_TITLE);
  const [quoteError, setQuoteError] = useState<string>("");
  const [quoteLoading, setQuoteLoading] = useState<boolean>(false);
  const [quote, setQuote] = useState<{
    allowed: boolean;
    discouraged?: boolean;
    reason?: string;
    chargeAmount?: number;
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
    const loadQuote = async () => {
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
    };
    loadQuote();
    return () => {
      canceled = true;
    };
  }, [amount, count, totalValue.toNumber()]);

  const chargeAmountValue = useMemo(() => {
    if (!quote?.chargeAmount && quote?.chargeAmount !== 0) {
      return totalValue;
    }
    return toDecimal(quote.chargeAmount);
  }, [quote, totalValue]);

  const paymentRequired =
    quote?.allowed === false && chargeAmountValue.gt(0);

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
    amount > 0 &&
    count > 0 &&
    title.trim().length > 0 &&
    (!quote || quote.allowed || paymentRequired);

  const directPurchase = async () => {
    if (!amount || !count) return;
    setActionError("");
    setActionLoading(true);
    try {
      const result = await createVoucherPurchase({
        amount,
        count,
        title: title.trim(),
      });
      setCodes(result.codes ?? []);
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Purchase credit vouchers to share with others. Vouchers are redeemed for
        account credit and never expire.
      </Paragraph>
      <Flex gap="middle" wrap="wrap">
        <InputNumber
          min={1}
          max={MAX_VOUCHER_VALUE}
          precision={2}
          step={5}
          value={amount}
          addonBefore="$"
          onChange={(value) => {
            setAmount(typeof value === "number" ? value : DEFAULT_AMOUNT);
          }}
        />
        <InputNumber
          min={1}
          max={MAX_VOUCHERS.now}
          value={count}
          onChange={(value) => {
            setCount(typeof value === "number" ? value : DEFAULT_COUNT);
          }}
          addonAfter={`voucher${count === 1 ? "" : "s"}`}
        />
        <Input
          style={{ minWidth: "220px" }}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Voucher title"
        />
      </Flex>
      <Text>
        Total: {currency(totalValue.toNumber())}{" "}
        {quoteLoading && <Text type="secondary">(checking)</Text>}
      </Text>
      {quote?.discouraged && quote?.reason && (
        <Alert type="warning" message={quote.reason} />
      )}
      {quoteError && <Alert type="error" message={quoteError} />}
      {actionError && <Alert type="error" message={actionError} />}

      {!processing && chargeAmountValue.eq(0) && (
        <Button
          type="primary"
          disabled={!canPurchase || actionLoading}
          loading={actionLoading}
          onClick={directPurchase}
        >
          Create vouchers
        </Button>
      )}

      {!processing && chargeAmountValue.gt(0) && (
        <StripePayment
          description="Voucher purchase"
          lineItems={lineItems}
          purpose={VOUCHER_PURCHASE}
          metadata={{
            voucher_amount: `${amount}`,
            voucher_count: `${count}`,
            voucher_title: title.trim(),
          }}
          onFinished={async (total) => {
            if (!total) {
              await directPurchase();
              return;
            }
            setProcessing(true);
            try {
              await processPaymentIntents();
            } catch (err) {
              setActionError(`${err}`);
            }
          }}
        />
      )}

      {processing && (
        <Alert
          type="info"
          message="Payment processing. Your voucher codes will appear in the Voucher Center shortly."
        />
      )}

      {codes.length > 0 && (
        <Alert
          type="success"
          message={
            <div>
              <div>Voucher codes created:</div>
              <div style={{ marginTop: "6px" }}>{codes.join(", ")}</div>
            </div>
          }
        />
      )}
    </Space>
  );
}
