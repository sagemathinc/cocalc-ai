/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Checkbox,
  Divider,
  InputNumber,
  Modal,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import Payments from "@cocalc/frontend/purchases/payments";
import StripePayment from "@cocalc/frontend/purchases/stripe-payment";
import {
  getMembershipPackageQuote,
  getMembershipPackages,
  isPurchaseAllowed,
  processPaymentIntents,
  purchaseMembershipPackage,
} from "@cocalc/frontend/purchases/api";
import MoneyStatistic from "@cocalc/frontend/purchases/money-statistic";
import type {
  MembershipPackageDetails,
  MembershipPackageQuote,
} from "@cocalc/conat/hub/api/purchases";
import { MEMBERSHIP_PACKAGE_PURCHASE } from "@cocalc/util/db-schema/purchases";
import { currency } from "@cocalc/util/misc";
import { moneyRound2Up, toDecimal } from "@cocalc/util/money";
import type { LineItem } from "@cocalc/util/stripe/types";
import {
  getCourseMembershipPackage,
  isCourseMembershipPackageForProject,
} from "../membership-packages";

const { Paragraph, Text } = Typography;

interface InstitutePaySectionProps {
  project_id: string;
  enabled: boolean;
  selectedTier: {
    id: string;
    label?: string;
    course_price?: number;
    course_duration_days?: number;
  } | null;
  onToggle: (checked: boolean) => void;
}

export function InstitutePaySection({
  project_id,
  enabled,
  selectedTier,
  onToggle,
}: InstitutePaySectionProps) {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [packages, setPackages] = useState<MembershipPackageDetails[]>([]);
  const [purchaseOpen, setPurchaseOpen] = useState<boolean>(false);

  async function refreshPackages() {
    setLoading(true);
    setError("");
    try {
      const next = await getMembershipPackages();
      setPackages(
        next.filter((membershipPackage) =>
          isCourseMembershipPackageForProject(membershipPackage, project_id),
        ),
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!enabled) {
      return;
    }
    refreshPackages();
  }, [enabled, project_id]);

  const membershipPackage = useMemo(
    () => getCourseMembershipPackage(packages, project_id),
    [packages, project_id],
  );

  return (
    <div style={{ marginTop: "20px" }}>
      <Checkbox checked={enabled} onChange={(e) => onToggle(e.target.checked)}>
        Institute or team pays for all students
      </Checkbox>
      {enabled && (
        <div style={{ marginTop: "15px" }}>
          <ShowError error={error} setError={setError} />
          {!selectedTier && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: "15px" }}
              title="Select a course membership first"
              description="Choose the course-visible membership tier students need before purchasing instructor-paid seats."
            />
          )}
          <Space style={{ marginBottom: "15px" }} wrap>
            <Button
              type="primary"
              disabled={!selectedTier}
              onClick={() => setPurchaseOpen(true)}
            >
              <Icon name="shopping-cart" />{" "}
              {membershipPackage ? "Add seats..." : "Buy seats..."}
            </Button>
            <Button onClick={refreshPackages} disabled={loading}>
              <Icon name="refresh" /> Refresh seats
            </Button>
          </Space>
          {loading && <Spin />}
          {membershipPackage ? (
            <>
              <Space wrap style={{ marginBottom: "10px" }}>
                <MoneyStatistic
                  title="Seat price"
                  value={Number(
                    membershipPackage.metadata?.seat_price ??
                      selectedTier?.course_price ??
                      0,
                  )}
                />
                <MoneyStatistic
                  title="Purchased seats"
                  value={membershipPackage.seat_count}
                />
                <MoneyStatistic
                  title="Assigned seats"
                  value={membershipPackage.active_assignment_count}
                />
                <MoneyStatistic
                  title="Available seats"
                  value={membershipPackage.available_seat_count}
                />
              </Space>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Seats are assigned per student account from the Students tab.
                The current package covers the term
                {membershipPackage.expires_at ? (
                  <>
                    {" "}
                    through <TimeAgo date={membershipPackage.expires_at} />.
                  </>
                ) : (
                  "."
                )}
              </Paragraph>
            </>
          ) : (
            <Alert
              type="info"
              showIcon
              title="No institute-paid seats purchased yet"
              description="Purchase seats for this course, then assign them to students from the Students tab."
            />
          )}
          <PurchaseCourseSeatsModal
            open={purchaseOpen}
            onClose={() => setPurchaseOpen(false)}
            project_id={project_id}
            membershipPackage={membershipPackage}
            selectedTier={selectedTier}
            onPurchased={async () => {
              await refreshPackages();
            }}
          />
          {selectedTier && (
            <Paragraph type="secondary" style={{ marginTop: "15px" }}>
              Students will not be asked to pay directly. You manage the seat
              count here and assign purchased seats to student accounts
              individually.
            </Paragraph>
          )}
        </div>
      )}
    </div>
  );
}

function PurchaseCourseSeatsModal({
  open,
  onClose,
  project_id,
  membershipPackage,
  selectedTier,
  onPurchased,
}: {
  open: boolean;
  onClose: () => void;
  project_id: string;
  membershipPackage?: MembershipPackageDetails;
  selectedTier: {
    id: string;
    label?: string;
    course_price?: number;
    course_duration_days?: number;
  } | null;
  onPurchased: () => Promise<void>;
}) {
  const [seatCount, setSeatCount] = useState<number>(1);
  const [quote, setQuote] = useState<MembershipPackageQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState<boolean>(false);
  const [quoteError, setQuoteError] = useState<string>("");
  const [actionError, setActionError] = useState<string>("");
  const [disabled, setDisabled] = useState<boolean>(false);
  const [place, setPlace] = useState<"checkout" | "processing" | "done">(
    "checkout",
  );
  const numPaymentsRef = useRef<number | null>(null);
  const [chargeAmount, setChargeAmount] = useState<number>(0);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setActionError(`${err}`),
  });

  const product = useMemo(
    () => ({
      package_id: membershipPackage?.id,
      kind: "course" as const,
      membership_class: selectedTier?.id,
      seat_count: seatCount,
      course_project_id: membershipPackage ? undefined : project_id,
    }),
    [membershipPackage, project_id, seatCount, selectedTier?.id],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setPlace("checkout");
    setSeatCount(1);
    setActionError("");
    setQuoteError("");
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let canceled = false;
    async function loadQuote() {
      if (!seatCount || seatCount < 1) {
        setQuote(null);
        return;
      }
      setQuoteLoading(true);
      setQuoteError("");
      try {
        const nextQuote = await getMembershipPackageQuote(product);
        const purchaseAllowed = await isPurchaseAllowed(
          "membership",
          nextQuote.total_price,
        );
        if (!canceled) {
          setQuote(nextQuote);
          setChargeAmount(
            purchaseAllowed.chargeAmount ?? nextQuote.total_price ?? 0,
          );
        }
      } catch (err) {
        if (!canceled) {
          setQuoteError(`${err}`);
          setQuote(null);
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
  }, [open, product, seatCount]);

  const totalValue = toDecimal(quote?.total_price ?? 0);
  const chargeAmountValue = toDecimal(chargeAmount);
  const lineItems: LineItem[] = [];
  if (quote) {
    lineItems.push({
      description: `${seatCount} course seat${seatCount === 1 ? "" : "s"} (${currency(
        quote.seat_price,
      )} each)`,
      amount: moneyRound2Up(totalValue).toNumber(),
    });
    if (chargeAmountValue.lt(totalValue)) {
      lineItems.push({
        description: "Apply account credit toward course seats",
        amount: chargeAmountValue.sub(totalValue).toNumber(),
      });
    } else if (chargeAmountValue.gt(totalValue)) {
      lineItems.push({
        description: "Minimum charge top-up added to account credit",
        amount: chargeAmountValue.sub(totalValue).toNumber(),
      });
    }
  }

  async function completePurchase() {
    setActionError("");
    setDisabled(true);
    try {
      const completed = await runFreshAuthAction(async () => {
        await purchaseMembershipPackage(product);
        await onPurchased();
        setPlace("done");
      });
      if (!completed) {
        return;
      }
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setDisabled(false);
    }
  }

  async function refreshProcessing() {
    setActionError("");
    try {
      const { count } = await processPaymentIntents();
      if (count > 0) {
        await onPurchased();
        setPlace("done");
      }
    } catch (err) {
      setActionError(`${err}`);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      width={820}
      destroyOnHidden
      footer={null}
      title={
        <>
          <Icon name="shopping-cart" style={{ marginRight: "10px" }} />
          {membershipPackage
            ? "Add institute-paid seats"
            : "Purchase institute-paid seats"}
        </>
      }
    >
      <ShowError
        error={quoteError || actionError}
        setError={(value) => {
          setQuoteError(value);
          setActionError(value);
        }}
      />
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Purchase seats for this course, then assign them to student accounts
          from the Students tab. Mid-term seat increases use the same per-seat
          price as the original package.
        </Paragraph>
        <Space wrap>
          <Tag color="blue">
            {membershipPackage
              ? "Existing course package"
              : "New course package"}
          </Tag>
          {selectedTier != null && (
            <Tag>{`${selectedTier.label ?? selectedTier.id}: ${currency(
              Number(selectedTier.course_price ?? 0),
            )} / ${Number(selectedTier.course_duration_days ?? 0)} days`}</Tag>
          )}
        </Space>
        <div>
          <Text strong>
            {membershipPackage ? "Additional seats" : "Seats to purchase"}
          </Text>
          <div style={{ marginTop: "8px" }}>
            <InputNumber
              min={1}
              precision={0}
              value={seatCount}
              onChange={(value) =>
                setSeatCount(typeof value === "number" ? value : 1)
              }
            />
          </div>
        </div>
        {quoteLoading && <Spin />}
        {quote && (
          <>
            <Space wrap>
              <MoneyStatistic title="Total price" value={quote.total_price} />
              <MoneyStatistic title="Seat price" value={quote.seat_price} />
              <Statistic
                title="Seats after purchase"
                value={(membershipPackage?.seat_count ?? 0) + seatCount}
                precision={0}
              />
            </Space>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              Access runs
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
              .
            </Paragraph>
            {chargeAmountValue.gt(totalValue) && (
              <Alert
                type="warning"
                showIcon
                title={`The minimum immediate charge is ${currency(
                  chargeAmountValue.toNumber(),
                )}.`}
                description="Any amount above the seat price is added to account credit and can be used for future purchases."
              />
            )}
          </>
        )}
        <Divider style={{ margin: "8px 0" }} />
        {place === "checkout" && quote && (
          <StripePayment
            disabled={disabled}
            description={
              membershipPackage
                ? "Add institute-paid course seats"
                : "Purchase institute-paid course seats"
            }
            lineItems={lineItems}
            purpose={MEMBERSHIP_PACKAGE_PURCHASE}
            metadata={{
              membership_package_product: JSON.stringify({
                type: "membership-package",
                ...product,
              }),
            }}
            onFinished={async (total) => {
              if (!total) {
                await completePurchase();
                return;
              }
              setPlace("processing");
              await refreshProcessing();
            }}
          />
        )}
        {place === "processing" && (
          <>
            <Alert
              type="info"
              showIcon
              title="Payment submitted"
              description="We are waiting for the payment to finish processing. When it does, the purchased seats will appear on this course."
            />
            <Payments
              purpose={MEMBERSHIP_PACKAGE_PURCHASE}
              numPaymentsRef={numPaymentsRef}
              limit={5}
            />
            <Button onClick={refreshProcessing}>
              <Icon name="refresh" /> Refresh status
            </Button>
          </>
        )}
        {place === "done" && (
          <Alert
            type="success"
            showIcon
            title="Course seats purchased"
            description="The updated seat count is now available. Assign seats to students from the Students tab."
          />
        )}
        <FreshAuthModal {...freshAuthModalProps} />
      </Space>
    </Modal>
  );
}
