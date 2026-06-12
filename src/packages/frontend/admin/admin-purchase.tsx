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
  Table,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";

import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import {
  MembershipTierBenefits,
  type MembershipTierWithPresentation,
} from "@cocalc/frontend/account/membership-tier-benefits";
import api from "@cocalc/frontend/client/api";
import {
  user_search,
  type User,
} from "@cocalc/frontend/frame-editors/generic/client";
import { currency, is_valid_uuid_string } from "@cocalc/util/misc";
import { toDecimal } from "@cocalc/util/money";
import { sortMembershipTiersByDisplayOrder } from "@cocalc/util/membership-tier-order";
import { MAX_COST, type Purchase } from "@cocalc/util/db-schema/purchases";

import { adminPurchase } from "@cocalc/frontend/store/api";
import { getPurchasesAdmin } from "@cocalc/frontend/purchases/api";

const { Paragraph, Text } = Typography;

type Product = "balance" | "membership";

interface MembershipTier extends MembershipTierWithPresentation {
  disabled?: boolean;
  id: string;
  label?: string;
  price_monthly?: number;
  price_yearly?: number;
  priority?: number;
}

export function AdminPurchaseAdmin() {
  const [product, setProduct] = useState<Product>("membership");
  const [targetQuery, setTargetQuery] = useState<string>("");
  const [targetUser, setTargetUser] = useState<User | null>(null);
  const [targetError, setTargetError] = useState<string>("");
  const [targetLoading, setTargetLoading] = useState<boolean>(false);

  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [tierLoading, setTierLoading] = useState<boolean>(false);
  const [membershipClass, setMembershipClass] = useState<string>("");
  const [interval, setInterval] = useState<"month" | "year">("month");

  const [balanceAdjustment, setBalanceAdjustment] = useState<number>(25);
  const [balanceUserNote, setBalanceUserNote] = useState<string>(
    "Admin balance adjustment",
  );

  const [discountPercent, setDiscountPercent] = useState<number>(0);
  const [discountAmount, setDiscountAmount] = useState<number>(0);
  const [customPrice, setCustomPrice] = useState<number | null>(null);
  const [source, setSource] = useState<"credit" | "free">("credit");
  const [comment, setComment] = useState<string>("");

  const [actionError, setActionError] = useState<string>("");
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [resultMessage, setResultMessage] = useState<string>("");
  const [recentAdminPurchases, setRecentAdminPurchases] = useState<
    Purchase[] | null
  >(null);
  const [recentAdminPurchasesError, setRecentAdminPurchasesError] =
    useState<string>("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setActionError(`${err}`),
  });

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

  async function loadRecentAdminPurchases() {
    setRecentAdminPurchasesError("");
    try {
      const result = await getPurchasesAdmin({
        includeName: true,
        limit: 25,
        tag: "admin-purchase",
      });
      setRecentAdminPurchases(result.purchases);
    } catch (err) {
      setRecentAdminPurchasesError(`${err}`);
      setRecentAdminPurchases([]);
    }
  }

  useEffect(() => {
    void loadRecentAdminPurchases();
  }, []);

  const sortedTiers = useMemo(
    () => sortMembershipTiersByDisplayOrder(tiers),
    [tiers],
  );

  useEffect(() => {
    if (!membershipClass && sortedTiers.length > 0) {
      const first =
        sortedTiers.find((tier) => !tier.disabled) ?? sortedTiers[0];
      if (first) {
        setMembershipClass(first.id);
      }
    }
  }, [sortedTiers, membershipClass]);

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
    if (product === "balance") {
      return Math.abs(balanceAdjustment || 0);
    }
    if (product === "membership") {
      const tier = tierById[membershipClass];
      if (!tier) return 0;
      return interval === "year"
        ? Number(tier.price_yearly ?? 0)
        : Number(tier.price_monthly ?? 0);
    }
    return 0;
  }, [product, tierById, membershipClass, interval, balanceAdjustment]);

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
    (product === "balance"
      ? Number.isFinite(balanceAdjustment) && balanceAdjustment !== 0
      : finalPrice.gte(0)) &&
    (product !== "membership" || membershipClass);

  async function submit() {
    if (!targetUser) return;
    setActionError("");
    setResultMessage("");
    try {
      await runFreshAuthAction(async () => {
        setActionLoading(true);
        try {
          const result = await adminPurchase({
            balance_admin_note:
              product === "balance" ? comment.trim() || undefined : undefined,
            balance_user_note:
              product === "balance"
                ? balanceUserNote.trim() || undefined
                : undefined,
            comment:
              product === "balance" ? undefined : comment.trim() || undefined,
            interval: product === "membership" ? interval : undefined,
            membership_class:
              product === "membership" ? membershipClass : undefined,
            price:
              product === "balance" ? balanceAdjustment : finalPrice.toNumber(),
            pricing_note: product === "balance" ? undefined : pricingNote,
            product,
            source,
            user_account_id: targetUser.account_id,
          });
          if (product === "balance") {
            setResultMessage(
              `Balance adjusted by ${currency(result.adjustment_amount ?? balanceAdjustment)}.`,
            );
          } else {
            setResultMessage(
              result.expires_at
                ? `Membership assigned until ${new Date(
                    result.expires_at,
                  ).toLocaleDateString()}`
                : "Membership assigned.",
            );
          }
          void loadRecentAdminPurchases();
        } finally {
          setActionLoading(false);
        }
      });
    } catch (err) {
      setActionError(`${err}`);
    }
  }

  function renderRecentAdminPurchases() {
    return (
      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
        <Divider style={{ margin: "8px 0" }} />
        <Flex align="center" justify="space-between">
          <Text strong>Recent admin purchases and balance edits</Text>
          <Button size="small" onClick={() => void loadRecentAdminPurchases()}>
            Refresh
          </Button>
        </Flex>
        {recentAdminPurchasesError ? (
          <Alert title={recentAdminPurchasesError} type="error" />
        ) : null}
        <Table
          dataSource={recentAdminPurchases ?? []}
          loading={recentAdminPurchases == null}
          pagination={false}
          rowKey="id"
          size="small"
          columns={[
            {
              title: "Time",
              dataIndex: "time",
              key: "time",
              render: (time) =>
                time ? new Date(time).toLocaleString() : "unknown",
            },
            {
              title: "User",
              key: "user",
              render: (_, purchase) => {
                const record = purchase as Purchase & {
                  email_address?: string;
                  first_name?: string;
                  last_name?: string;
                };
                return (
                  record.email_address ||
                  `${record.first_name ?? ""} ${record.last_name ?? ""}`.trim() ||
                  record.account_id
                );
              },
            },
            {
              title: "Service",
              dataIndex: "service",
              key: "service",
            },
            {
              title: "Amount",
              dataIndex: "cost",
              key: "cost",
              render: (cost) =>
                cost == null ? "" : currency(toDecimal(cost).neg().toNumber()),
            },
            {
              title: "User note",
              key: "description",
              render: (_, purchase) =>
                `${purchase.description?.["description"] ?? ""}`,
            },
            {
              title: "Admin notes",
              dataIndex: "notes",
              key: "notes",
              ellipsis: true,
            },
          ]}
        />
      </Space>
    );
  }

  return (
    <>
      <Paragraph type="secondary">
        Create a manual purchase for another user. This supports discounts,
        custom prices, credit-funded purchases, and fully free comps, matching
        the round-one admin workflow requirements.
      </Paragraph>

      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
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
            title={`Target: ${
              `${targetUser.first_name ?? ""} ${targetUser.last_name ?? ""}`.trim() ||
              targetUser.email_address ||
              targetUser.account_id
            }`}
            type="success"
          />
        )}
        {targetError && <Alert title={targetError} type="error" />}

        <Divider style={{ margin: "8px 0" }} />

        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <Text strong>Product</Text>
          <Select
            options={[
              { label: "Balance adjustment", value: "balance" },
              { label: "Membership", value: "membership" },
            ]}
            style={{ maxWidth: "100%", width: 260 }}
            value={product}
            onChange={(value) => setProduct(value)}
          />
        </Space>

        {product === "membership" && (
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            <Text strong>Membership tier</Text>
            <Select
              loading={tierLoading}
              options={sortedTiers
                .filter((tier) => !tier.disabled)
                .map((tier) => ({
                  label: tier.label ?? tier.id,
                  value: tier.id,
                }))}
              value={membershipClass}
              onChange={(value) => setMembershipClass(value)}
            />
            {tierById[membershipClass] != null && (
              <MembershipTierBenefits
                compact
                showBilling={false}
                tier={tierById[membershipClass]}
              />
            )}
            <Radio.Group
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
            >
              <Radio value="month">Monthly</Radio>
              <Radio value="year">Yearly</Radio>
            </Radio.Group>
          </Space>
        )}

        {product === "balance" && (
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            <Text strong>Balance adjustment</Text>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Positive amounts add account credit. Negative amounts remove
              account credit. This creates an audited ledger entry, not a Stripe
              payment.
            </Paragraph>
            <Space.Compact>
              <Button disabled tabIndex={-1}>
                $
              </Button>
              <InputNumber
                max={MAX_COST}
                min={-MAX_COST}
                precision={2}
                step={5}
                value={balanceAdjustment}
                onChange={(value) =>
                  setBalanceAdjustment(
                    typeof value === "number" ? value : balanceAdjustment,
                  )
                }
              />
            </Space.Compact>
            <Input
              placeholder="User-visible note"
              value={balanceUserNote}
              onChange={(e) => setBalanceUserNote(e.target.value)}
            />
          </Space>
        )}

        {product !== "balance" && <Divider style={{ margin: "8px 0" }} />}

        {product !== "balance" && (
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
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
              <Space.Compact>
                <Button disabled tabIndex={-1}>
                  $
                </Button>
                <InputNumber
                  max={MAX_COST}
                  min={0}
                  value={discountAmount}
                  onChange={(value) =>
                    setDiscountAmount(typeof value === "number" ? value : 0)
                  }
                />
              </Space.Compact>
              <Space.Compact>
                <Button disabled tabIndex={-1}>
                  $
                </Button>
                <InputNumber
                  max={MAX_COST}
                  min={0}
                  placeholder="Custom price"
                  value={customPrice ?? undefined}
                  onChange={(value) =>
                    setCustomPrice(typeof value === "number" ? value : null)
                  }
                />
              </Space.Compact>
            </Flex>
            <Text type="secondary">
              Base {currency(basePrice ?? 0)} → Final{" "}
              {currency(finalPrice.toNumber())}
            </Text>
          </Space>
        )}

        {product !== "balance" && (
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            <Text strong>Source of funds</Text>
            <Radio.Group
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <Radio value="credit">Use user credit</Radio>
              <Radio value="free">Free (offsetting credit)</Radio>
            </Radio.Group>
          </Space>
        )}

        <Input.TextArea
          placeholder={
            product === "balance"
              ? "Admin-only note or support ticket reference"
              : "Admin comment or manual invoice reference"
          }
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />

        {actionError && <Alert title={actionError} type="error" />}
        {resultMessage && <Alert title={resultMessage} type="success" />}

        <Button
          disabled={!canSubmit}
          loading={actionLoading}
          type="primary"
          onClick={submit}
        >
          Create admin purchase
        </Button>
        {renderRecentAdminPurchases()}
      </Space>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}

export function AdminBalanceAdjustment({
  account_id,
  onAdjusted,
}: {
  account_id: string;
  onAdjusted?: () => void;
}) {
  const [amount, setAmount] = useState<number>(25);
  const [userNote, setUserNote] = useState<string>("Admin balance adjustment");
  const [adminNote, setAdminNote] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [success, setSuccess] = useState<string>("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setError(`${err}`),
  });

  async function submit() {
    setError("");
    setSuccess("");
    await runFreshAuthAction(async () => {
      setLoading(true);
      try {
        const result = await adminPurchase({
          balance_admin_note: adminNote.trim() || undefined,
          balance_user_note: userNote.trim() || undefined,
          price: amount,
          product: "balance",
          source: "free",
          user_account_id: account_id,
        });
        setSuccess(
          `Balance adjusted by ${currency(result.adjustment_amount ?? amount)}.`,
        );
        onAdjusted?.();
      } catch (err) {
        setError(`${err}`);
      } finally {
        setLoading(false);
      }
    });
  }

  return (
    <Card size="small" title="Admin balance adjustment">
      <Space orientation="vertical" size="small" style={{ width: "100%" }}>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Add or remove prepaid account credit with an audited ledger entry.
          Positive amounts add credit; negative amounts remove credit.
        </Paragraph>
        <Space.Compact>
          <Button disabled tabIndex={-1}>
            $
          </Button>
          <InputNumber
            max={MAX_COST}
            min={-MAX_COST}
            precision={2}
            step={5}
            value={amount}
            onChange={(value) =>
              setAmount(typeof value === "number" ? value : amount)
            }
          />
        </Space.Compact>
        <Input
          placeholder="User-visible note"
          value={userNote}
          onChange={(e) => setUserNote(e.target.value)}
        />
        <Input.TextArea
          placeholder="Admin-only note or support ticket reference"
          rows={3}
          value={adminNote}
          onChange={(e) => setAdminNote(e.target.value)}
        />
        {error ? <Alert title={error} type="error" /> : null}
        {success ? <Alert title={success} type="success" /> : null}
        <Button
          disabled={!Number.isFinite(amount) || amount === 0}
          loading={loading}
          type="primary"
          onClick={submit}
        >
          Adjust balance
        </Button>
      </Space>
      <FreshAuthModal {...freshAuthModalProps} />
    </Card>
  );
}

export function AdminBalanceAdjustmentButton({
  account_id,
}: {
  account_id: string;
}) {
  const [show, setShow] = useState<boolean>(false);
  return (
    <div>
      <Button onClick={() => setShow(!show)} type={show ? "dashed" : undefined}>
        Balance Adjustment
      </Button>
      {show ? (
        <div style={{ marginTop: "8px" }}>
          <AdminBalanceAdjustment account_id={account_id} />
        </div>
      ) : null}
    </div>
  );
}
