/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

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
import {
  user_search,
  type User,
} from "@cocalc/frontend/frame-editors/generic/client";
import { currency, is_valid_uuid_string } from "@cocalc/util/misc";
import { toDecimal } from "@cocalc/util/money";
import { MAX_VOUCHERS, MAX_VOUCHER_VALUE } from "@cocalc/util/vouchers";

import { adminPurchase } from "./api";

const { Paragraph, Text } = Typography;

type Product = "membership" | "voucher";

interface MembershipTier {
  disabled?: boolean;
  id: string;
  label?: string;
  price_monthly?: number;
  price_yearly?: number;
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
    async function loadTiers() {
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
    }
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
      return interval === "year"
        ? Number(tier.price_yearly ?? 0)
        : Number(tier.price_monthly ?? 0);
    }
    return toDecimal(voucherAmount).mul(voucherCount).toNumber();
  }, [
    product,
    tierById,
    membershipClass,
    interval,
    voucherAmount,
    voucherCount,
  ]);

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
  }, [basePrice, customPrice, discountAmount, discountPercent]);

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
  }, [basePrice, customPrice, discountAmount, discountPercent]);

  async function resolveTarget() {
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
      const results = await user_search({ admin: true, limit: 5, query });
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
  }

  const canSubmit =
    !!targetUser &&
    finalPrice.gte(0) &&
    (product !== "membership" || membershipClass);

  async function submit() {
    if (!targetUser) return;
    setActionError("");
    setResultMessage("");
    setVoucherCodes([]);
    setActionLoading(true);
    try {
      const result = await adminPurchase({
        comment: comment.trim() || undefined,
        interval: product === "membership" ? interval : undefined,
        membership_class:
          product === "membership" ? membershipClass : undefined,
        price: finalPrice.toNumber(),
        pricing_note: pricingNote,
        product,
        source,
        user_account_id: targetUser.account_id,
        voucher_amount: product === "voucher" ? voucherAmount : undefined,
        voucher_count: product === "voucher" ? voucherCount : undefined,
        voucher_title: product === "voucher" ? voucherTitle.trim() : undefined,
      });
      if (product === "voucher") {
        setVoucherCodes(result.voucher_codes ?? []);
        setResultMessage("Voucher purchase created.");
      } else {
        setResultMessage(
          result.expires_at
            ? `Membership assigned until ${new Date(
                result.expires_at,
              ).toLocaleDateString()}`
            : "Membership assigned.",
        );
      }
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <Card size="small" title="Admin-assisted purchase">
      <Paragraph type="secondary">
        Create a manual purchase for another user. This supports discounts,
        custom prices, credit-funded purchases, and fully free comps, matching
        the round-one admin workflow requirements.
      </Paragraph>

      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Input.Search
          enterButton="Resolve user"
          loading={targetLoading}
          placeholder="Account ID or email"
          value={targetQuery}
          onChange={(e) => setTargetQuery(e.target.value)}
          onSearch={resolveTarget}
        />
        {targetUser && (
          <Alert
            message={`Target: ${targetUser.name ?? targetUser.email_address ?? targetUser.account_id}`}
            type="success"
          />
        )}
        {targetError && <Alert message={targetError} type="error" />}

        <Divider style={{ margin: "8px 0" }} />

        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Text strong>Product</Text>
          <Select
            options={[
              { label: "Membership", value: "membership" },
              { label: "Credit voucher", value: "voucher" },
            ]}
            value={product}
            onChange={(value) => setProduct(value)}
          />
        </Space>

        {product === "membership" && (
          <Space direction="vertical" size="small" style={{ width: "100%" }}>
            <Text strong>Membership tier</Text>
            <Select
              loading={tierLoading}
              options={tiers
                .filter((tier) => !tier.disabled)
                .map((tier) => ({
                  label: tier.label ?? tier.id,
                  value: tier.id,
                }))}
              value={membershipClass}
              onChange={(value) => setMembershipClass(value)}
            />
            <Radio.Group
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            >
              <Radio value="month">Monthly</Radio>
              <Radio value="year">Yearly</Radio>
            </Radio.Group>
          </Space>
        )}

        {product === "voucher" && (
          <Space direction="vertical" size="small" style={{ width: "100%" }}>
            <Text strong>Voucher details</Text>
            <Flex gap="middle" wrap="wrap">
              <InputNumber
                addonBefore="$"
                max={MAX_VOUCHER_VALUE}
                min={1}
                precision={2}
                step={5}
                value={voucherAmount}
                onChange={(value) =>
                  setVoucherAmount(typeof value === "number" ? value : 25)
                }
              />
              <InputNumber
                addonAfter={`voucher${voucherCount === 1 ? "" : "s"}`}
                max={MAX_VOUCHERS.admin}
                min={1}
                value={voucherCount}
                onChange={(value) =>
                  setVoucherCount(typeof value === "number" ? value : 1)
                }
              />
            </Flex>
            <Input
              placeholder="Voucher title"
              value={voucherTitle}
              onChange={(e) => setVoucherTitle(e.target.value)}
            />
          </Space>
        )}

        <Divider style={{ margin: "8px 0" }} />

        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Text strong>Pricing</Text>
          <Flex gap="middle" wrap="wrap">
            <InputNumber
              formatter={(value) => `${value}%`}
              max={100}
              min={0}
              parser={(value) => parseFloat(value ?? "0")}
              value={discountPercent}
              onChange={(value) =>
                setDiscountPercent(typeof value === "number" ? value : 0)
              }
            />
            <InputNumber
              addonBefore="$"
              max={MAX_VOUCHER_VALUE * MAX_VOUCHERS.admin}
              min={0}
              value={discountAmount}
              onChange={(value) =>
                setDiscountAmount(typeof value === "number" ? value : 0)
              }
            />
            <InputNumber
              addonBefore="$"
              max={MAX_VOUCHER_VALUE * MAX_VOUCHERS.admin}
              min={0}
              placeholder="Custom price"
              value={customPrice ?? undefined}
              onChange={(value) =>
                setCustomPrice(typeof value === "number" ? value : null)
              }
            />
          </Flex>
          <Text type="secondary">
            Base {currency(basePrice ?? 0)} → Final{" "}
            {currency(finalPrice.toNumber())}
          </Text>
        </Space>

        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Text strong>Source of funds</Text>
          <Radio.Group
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <Radio value="credit">Use user credit</Radio>
            <Radio value="free">Free (offsetting credit)</Radio>
          </Radio.Group>
        </Space>

        <Input.TextArea
          placeholder="Admin comment or manual invoice reference"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />

        {actionError && <Alert message={actionError} type="error" />}
        {resultMessage && <Alert message={resultMessage} type="success" />}
        {voucherCodes.length > 0 && (
          <Alert
            description={voucherCodes.join(", ")}
            message="Voucher codes"
            type="success"
          />
        )}

        <Button
          disabled={!canSubmit}
          loading={actionLoading}
          type="primary"
          onClick={submit}
        >
          Create admin purchase
        </Button>
      </Space>
    </Card>
  );
}
