import {
  Alert,
  Button,
  Card,
  Divider,
  Flex,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import api from "@cocalc/frontend/client/api";
import { user_search, type User } from "@cocalc/frontend/frame-editors/generic/client";
import { currency, is_valid_uuid_string } from "@cocalc/util/misc";
import { toDecimal } from "@cocalc/util/money";
import { MAX_VOUCHERS, MAX_VOUCHER_VALUE } from "@cocalc/util/vouchers";
import { adminPurchase } from "./admin-purchase-api";

const { Paragraph, Text } = Typography;

type Product = "membership" | "voucher";

interface MembershipTier {
  id: string;
  label?: string;
  price_monthly?: number;
  price_yearly?: number;
  disabled?: boolean;
}

export default function AdminPurchasePanel() {
  const [product, setProduct] = useState<Product>("membership");
  const [targetQuery, setTargetQuery] = useState<string>("");
  const [targetUser, setTargetUser] = useState<User | null>(null);
  const [targetError, setTargetError] = useState<string>("");
  const [targetLoading, setTargetLoading] = useState<boolean>(false);

  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [tierLoading, setTierLoading] = useState<boolean>(false);
  const [membershipClass, setMembershipClass] = useState<string>("");
  const [interval, setInterval] = useState<"month" | "year">("month");

  const [voucherAmount, setVoucherAmount] = useState<number>(25);
  const [voucherCount, setVoucherCount] = useState<number>(1);
  const [voucherTitle, setVoucherTitle] = useState<string>("CoCalc voucher");

  const [discountPercent, setDiscountPercent] = useState<number>(0);
  const [discountAmount, setDiscountAmount] = useState<number>(0);
  const [customPrice, setCustomPrice] = useState<number | null>(null);
  const [source, setSource] = useState<"credit" | "free">("credit");
  const [comment, setComment] = useState<string>("");

  const [actionError, setActionError] = useState<string>("");
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [resultMessage, setResultMessage] = useState<string>("");
  const [voucherCodes, setVoucherCodes] = useState<string[]>([]);

  useEffect(() => {
    let canceled = false;
    const loadTiers = async () => {
      setTierLoading(true);
      try {
        const result = await api("purchases/get-membership-tiers");
        const next = (result?.tiers ?? []) as MembershipTier[];
        if (!canceled) {
          setTiers(next);
        }
      } catch (err) {
        if (!canceled) {
          setActionError(`${err}`);
        }
      } finally {
        if (!canceled) {
          setTierLoading(false);
        }
      }
    };
    loadTiers();
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!membershipClass && tiers.length > 0) {
      const first = tiers.find((tier) => !tier.disabled) ?? tiers[0];
      if (first) {
        setMembershipClass(first.id);
      }
    }
  }, [tiers, membershipClass]);

  const tierById = useMemo(() => {
    return tiers.reduce(
      (acc, tier) => {
        acc[tier.id] = tier;
        return acc;
      },
      {} as Record<string, MembershipTier>,
    );
  }, [tiers]);

  const basePrice = useMemo(() => {
    if (product === "membership") {
      const tier = tierById[membershipClass];
      if (!tier) return 0;
      return interval === "year" ? tier.price_yearly ?? 0 : tier.price_monthly ?? 0;
    }
    return toDecimal(voucherAmount).mul(voucherCount).toNumber();
  }, [product, tierById, membershipClass, interval, voucherAmount, voucherCount]);

  const finalPrice = useMemo(() => {
    const base = toDecimal(basePrice ?? 0);
    if (customPrice != null && Number.isFinite(customPrice)) {
      const custom = toDecimal(customPrice);
      return custom.lt(0) ? toDecimal(0) : custom;
    }
    const percent = toDecimal(discountPercent || 0).div(100);
    const amount = toDecimal(discountAmount || 0);
    const computed = base.sub(base.mul(percent)).sub(amount);
    return computed.lt(0) ? toDecimal(0) : computed;
  }, [basePrice, discountPercent, discountAmount, customPrice]);

  const pricingNote = useMemo(() => {
    const pieces = [
      `Base ${currency(basePrice ?? 0)}`,
      `Discount ${discountPercent || 0}%`,
      `Discount ${currency(discountAmount || 0)}`,
    ];
    if (customPrice != null) {
      pieces.push(`Custom ${currency(customPrice)}`);
    }
    return pieces.join("; ");
  }, [basePrice, discountPercent, discountAmount, customPrice]);

  const resolveTarget = async () => {
    setTargetError("");
    setTargetUser(null);
    const query = targetQuery.trim();
    if (!query) {
      setTargetError("Enter an account_id or email address.");
      return;
    }
    setTargetLoading(true);
    try {
      if (is_valid_uuid_string(query)) {
        setTargetUser({ account_id: query });
        return;
      }
      const results = await user_search({ query, limit: 5, admin: true });
      if (results.length === 1) {
        setTargetUser(results[0]);
      } else if (results.length > 1) {
        setTargetError("Multiple matches. Use a full email or account_id.");
      } else {
        setTargetError("No matching user found.");
      }
    } catch (err) {
      setTargetError(`${err}`);
    } finally {
      setTargetLoading(false);
    }
  };

  const canSubmit =
    !!targetUser &&
    finalPrice.gte(0) &&
    (product !== "membership" || membershipClass);

  const submit = async () => {
    if (!targetUser) return;
    setActionError("");
    setResultMessage("");
    setVoucherCodes([]);
    setActionLoading(true);
    try {
      const result = await adminPurchase({
        user_account_id: targetUser.account_id,
        product,
        source,
        price: finalPrice.toNumber(),
        pricing_note: pricingNote,
        comment: comment.trim() || undefined,
        membership_class: product === "membership" ? membershipClass : undefined,
        interval: product === "membership" ? interval : undefined,
        voucher_amount: product === "voucher" ? voucherAmount : undefined,
        voucher_count: product === "voucher" ? voucherCount : undefined,
        voucher_title: product === "voucher" ? voucherTitle : undefined,
      });
      if (product === "voucher") {
        setVoucherCodes(result.voucher_codes ?? []);
      }
      if (product === "membership") {
        setResultMessage(
          result.expires_at
            ? `Membership assigned until ${new Date(result.expires_at).toLocaleDateString()}`
            : "Membership assigned.",
        );
      } else {
        setResultMessage("Admin purchase created.");
      }
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <Card title="Admin purchase" size="small">
      <Paragraph type="secondary">
        Create a manual purchase for another user. Use this for trials, comps,
        or manual invoicing.
      </Paragraph>

      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Input.Search
          value={targetQuery}
          onChange={(e) => setTargetQuery(e.target.value)}
          placeholder="Account ID or email"
          enterButton="Resolve user"
          onSearch={resolveTarget}
          loading={targetLoading}
        />
        {targetUser && (
          <Alert
            type="success"
            message={`Target: ${targetUser.name ?? targetUser.email_address ?? targetUser.account_id}`}
          />
        )}
        {targetError && <Alert type="error" message={targetError} />}

        <Divider style={{ margin: "8px 0" }} />

        <Space direction="vertical" style={{ width: "100%" }} size="small">
          <Text strong>Product</Text>
          <Select
            value={product}
            onChange={(value) => setProduct(value)}
            options={[
              { value: "membership", label: "Membership" },
              { value: "voucher", label: "Credit voucher" },
            ]}
          />
        </Space>

        {product === "membership" && (
          <Space direction="vertical" style={{ width: "100%" }} size="small">
            <Text strong>Membership tier</Text>
            <Select
              value={membershipClass}
              loading={tierLoading}
              onChange={(value) => setMembershipClass(value)}
              options={tiers
                .filter((tier) => !tier.disabled)
                .map((tier) => ({
                  value: tier.id,
                  label: tier.label ?? tier.id,
                }))}
            />
            <Radio.Group
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            >
              <Radio.Button value="month">Monthly</Radio.Button>
              <Radio.Button value="year">Yearly</Radio.Button>
            </Radio.Group>
          </Space>
        )}

        {product === "voucher" && (
          <Space direction="vertical" style={{ width: "100%" }} size="small">
            <Text strong>Voucher details</Text>
            <Flex gap="middle" wrap="wrap">
              <InputNumber
                min={1}
                max={MAX_VOUCHER_VALUE}
                precision={2}
                step={5}
                value={voucherAmount}
                addonBefore="$"
                onChange={(value) =>
                  setVoucherAmount(typeof value === "number" ? value : 25)
                }
              />
              <InputNumber
                min={1}
                max={MAX_VOUCHERS.admin}
                value={voucherCount}
                addonAfter={`voucher${voucherCount === 1 ? "" : "s"}`}
                onChange={(value) =>
                  setVoucherCount(typeof value === "number" ? value : 1)
                }
              />
            </Flex>
            <Input
              value={voucherTitle}
              onChange={(e) => setVoucherTitle(e.target.value)}
              placeholder="Voucher title"
            />
          </Space>
        )}

        <Divider style={{ margin: "8px 0" }} />

        <Space direction="vertical" style={{ width: "100%" }} size="small">
          <Text strong>Pricing</Text>
          <Flex gap="middle" wrap="wrap">
            <InputNumber
              min={0}
              max={100}
              value={discountPercent}
              formatter={(value) => `${value}%`}
              parser={(value) => parseFloat(value ?? "0")}
              onChange={(value) =>
                setDiscountPercent(typeof value === "number" ? value : 0)
              }
            />
            <InputNumber
              min={0}
              max={MAX_VOUCHER_VALUE * MAX_VOUCHERS.admin}
              value={discountAmount}
              addonBefore="$"
              onChange={(value) =>
                setDiscountAmount(typeof value === "number" ? value : 0)
              }
            />
            <InputNumber
              min={0}
              max={MAX_VOUCHER_VALUE * MAX_VOUCHERS.admin}
              value={customPrice ?? undefined}
              addonBefore="$"
              placeholder="Custom price"
              onChange={(value) =>
                setCustomPrice(typeof value === "number" ? value : null)
              }
            />
          </Flex>
          <Text type="secondary">
            Base {currency(basePrice ?? 0)} → Final {currency(finalPrice.toNumber())}
          </Text>
        </Space>

        <Space direction="vertical" style={{ width: "100%" }} size="small">
          <Text strong>Source of funds</Text>
          <Radio.Group
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <Radio value="credit">Use user credit</Radio>
            <Radio value="free">Free (offset credit)</Radio>
          </Radio.Group>
        </Space>

        <Input.TextArea
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Admin comment"
        />

        {actionError && <Alert type="error" message={actionError} />}
        {resultMessage && <Alert type="success" message={resultMessage} />}
        {voucherCodes.length > 0 && (
          <Alert
            type="success"
            message={
              <div>
                <div>Voucher codes:</div>
                <div style={{ marginTop: "6px" }}>{voucherCodes.join(", ")}</div>
              </div>
            }
          />
        )}

        <Button
          type="primary"
          disabled={!canSubmit || actionLoading}
          loading={actionLoading}
          onClick={submit}
        >
          Create admin purchase
        </Button>
      </Space>
    </Card>
  );
}
