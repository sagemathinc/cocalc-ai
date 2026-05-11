/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Divider,
  Modal,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  CourseStudentAccessStatus,
  ProjectCourseInfo,
} from "@cocalc/conat/hub/api/projects";
import type {
  MembershipPackageDetails,
  MembershipPackageQuote,
} from "@cocalc/conat/hub/api/purchases";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import MoneyStatistic from "@cocalc/frontend/purchases/money-statistic";
import Payments from "@cocalc/frontend/purchases/payments";
import {
  assignMembershipPackageSeat,
  claimMembershipPackageSeat,
  getMembershipPackageQuote,
  getMembershipPackages,
  isPurchaseAllowed,
  processPaymentIntents,
  purchaseMembershipPackage,
} from "@cocalc/frontend/purchases/api";
import StripePayment from "@cocalc/frontend/purchases/stripe-payment";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { MEMBERSHIP_PACKAGE_PURCHASE } from "@cocalc/util/db-schema/purchases";
import { currency } from "@cocalc/util/misc";
import { moneyRound2Up, toDecimal } from "@cocalc/util/money";
import type { LineItem } from "@cocalc/util/stripe/types";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text } = Typography;

type CoursePackageProduct = {
  kind: "course";
  membership_class: string;
  seat_count: 1;
  course_project_id: string;
  metadata: {
    direct_student_purchase: true;
    grant_source: "student-course-purchase";
    project_id: string;
    course_project_id: string;
    course_path?: string;
  };
};

function getCourseProjectId(course?: ProjectCourseInfo): string | undefined {
  return `${course?.project_id ?? ""}`.trim() || undefined;
}

function getCourseTitle(course?: ProjectCourseInfo): string {
  const path = `${course?.path ?? ""}`.trim();
  return path || "this course";
}

function toTime(value?: Date | string | null): number {
  if (value instanceof Date) {
    return value.valueOf();
  }
  const time = Date.parse(`${value ?? ""}`);
  return Number.isFinite(time) ? time : 0;
}

function makeProduct({
  access,
  project_id,
}: {
  access: CourseStudentAccessStatus;
  project_id: string;
}): CoursePackageProduct | undefined {
  if (access.status !== "grace" && access.status !== "blocked") {
    return;
  }
  const course_project_id = getCourseProjectId(access.course);
  if (!course_project_id) {
    return;
  }
  return {
    kind: "course",
    membership_class: access.required_membership_class,
    seat_count: 1,
    course_project_id,
    metadata: {
      direct_student_purchase: true,
      grant_source: "student-course-purchase",
      project_id,
      course_project_id,
      course_path: access.course?.path,
    },
  };
}

function getRequiredMembershipLabel(access: CourseStudentAccessStatus): string {
  if (access.status === "grace" || access.status === "blocked") {
    return access.required_label ?? access.required_membership_class;
  }
  return "course membership";
}

function isMatchingDirectStudentPackage({
  membershipPackage,
  product,
}: {
  membershipPackage: MembershipPackageDetails;
  product: CoursePackageProduct;
}): boolean {
  return (
    membershipPackage.kind === "course" &&
    membershipPackage.membership_class === product.membership_class &&
    membershipPackage.metadata?.direct_student_purchase === true &&
    membershipPackage.metadata?.course_project_id === product.course_project_id
  );
}

function latestMatchingDirectStudentPackage({
  packages,
  product,
}: {
  packages: MembershipPackageDetails[];
  product: CoursePackageProduct;
}): MembershipPackageDetails | undefined {
  return packages
    .filter((membershipPackage) =>
      isMatchingDirectStudentPackage({ membershipPackage, product }),
    )
    .filter((membershipPackage) => membershipPackage.available_seat_count > 0)
    .sort(
      (left, right) =>
        toTime(right.updated) - toTime(left.updated) ||
        toTime(right.created) - toTime(left.created),
    )[0];
}

export function CourseMembershipBanner({ project_id }: { project_id: string }) {
  const [access, setAccess] = useState<CourseStudentAccessStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [purchaseOpen, setPurchaseOpen] = useState<boolean>(false);
  const [claiming, setClaiming] = useState<boolean>(false);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setAccess(
        await webapp_client.conat_client.hub.projects.getCourseStudentAccess({
          project_id,
        }),
      );
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [project_id]);

  async function claimSiteLicense(package_id: string) {
    setClaiming(true);
    setError("");
    try {
      await claimMembershipPackageSeat({ package_id });
      await refresh();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setClaiming(false);
    }
  }

  if (loading && access == null) {
    return null;
  }
  if (access == null || access.status === "not-required") {
    return null;
  }

  const title = access.required_label ?? access.required_membership_class;
  const courseTitle = getCourseTitle(access.course);

  if (access.status === "active") {
    return null;
  }

  return (
    <>
      <ShowError error={error} setError={setError} />
      {access.status === "site-license-claimable" ? (
        <Alert
          type="info"
          showIcon
          style={{ margin: "12px" }}
          message="Course membership is available from your site license"
          description={
            <Space direction="vertical" size="small">
              <span>
                Your verified email{" "}
                <Text strong>{access.matched_email_address}</Text> can claim{" "}
                <Text strong>{access.membership_class}</Text> access for{" "}
                {courseTitle}.
              </span>
              <Button
                type="primary"
                loading={claiming}
                onClick={() => claimSiteLicense(access.package_id)}
              >
                <Icon name="check" /> Claim site license access
              </Button>
            </Space>
          }
        />
      ) : (
        <Alert
          type={access.status === "blocked" ? "error" : "warning"}
          showIcon
          style={{ margin: "12px" }}
          message={`Course membership required: ${title}`}
          description={
            <Space direction="vertical" size="small">
              <span>
                {access.status === "grace" ? (
                  <>
                    You have full access until{" "}
                    <Text strong>
                      <TimeAgo date={access.deadline} />
                    </Text>
                    .
                  </>
                ) : (
                  <>
                    The grace period for this course has ended
                    {access.deadline ? (
                      <>
                        {" "}
                        (<TimeAgo date={access.deadline} />)
                      </>
                    ) : null}
                    .
                  </>
                )}{" "}
                Purchase the course membership to keep using {courseTitle}.
              </span>
              <Space wrap>
                <Tag color={access.status === "blocked" ? "red" : "gold"}>
                  {access.status === "blocked" ? "Payment required" : "Grace"}
                </Tag>
                <Button type="primary" onClick={() => setPurchaseOpen(true)}>
                  <Icon name="shopping-cart" /> Buy course membership
                </Button>
              </Space>
            </Space>
          }
        />
      )}
      <StudentCoursePurchaseModal
        open={purchaseOpen}
        onClose={() => setPurchaseOpen(false)}
        project_id={project_id}
        access={access}
        onPurchased={refresh}
      />
    </>
  );
}

function StudentCoursePurchaseModal({
  open,
  onClose,
  project_id,
  access,
  onPurchased,
}: {
  open: boolean;
  onClose: () => void;
  project_id: string;
  access: CourseStudentAccessStatus;
  onPurchased: () => Promise<void>;
}) {
  const product = useMemo(
    () => makeProduct({ access, project_id }),
    [access, project_id],
  );
  const [quote, setQuote] = useState<MembershipPackageQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState<boolean>(false);
  const [quoteError, setQuoteError] = useState<string>("");
  const [actionError, setActionError] = useState<string>("");
  const [disabled, setDisabled] = useState<boolean>(false);
  const [chargeAmount, setChargeAmount] = useState<number>(0);
  const [place, setPlace] = useState<"checkout" | "processing" | "done">(
    "checkout",
  );
  const numPaymentsRef = useRef<number | null>(null);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => setActionError(`${err}`),
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    setPlace("checkout");
    setQuote(null);
    setActionError("");
    setQuoteError("");
  }, [open]);

  useEffect(() => {
    if (!open || product == null) {
      return;
    }
    const quoteProduct = product;
    let canceled = false;
    async function loadQuote() {
      setQuoteLoading(true);
      setQuoteError("");
      try {
        const nextQuote = await getMembershipPackageQuote(quoteProduct);
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
          setQuote(null);
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
  }, [open, product]);

  const totalValue = toDecimal(quote?.total_price ?? 0);
  const chargeAmountValue = toDecimal(chargeAmount);
  const lineItems: LineItem[] = [];
  if (quote) {
    lineItems.push({
      description: `${getRequiredMembershipLabel(access)} course membership`,
      amount: moneyRound2Up(totalValue).toNumber(),
    });
    if (chargeAmountValue.lt(totalValue)) {
      lineItems.push({
        description: "Apply account credit toward course membership",
        amount: chargeAmountValue.sub(totalValue).toNumber(),
      });
    } else if (chargeAmountValue.gt(totalValue)) {
      lineItems.push({
        description: "Minimum charge top-up added to account credit",
        amount: chargeAmountValue.sub(totalValue).toNumber(),
      });
    }
  }

  async function assignSelf(package_id: string) {
    if (product == null) {
      throw Error("course membership purchase is not available");
    }
    await assignMembershipPackageSeat({
      package_id,
      target_account_id: webapp_client.account_id,
      metadata: product.metadata,
    });
  }

  async function assignLatestPurchasedPackage() {
    if (product == null) {
      throw Error("course membership purchase is not available");
    }
    const packages = await getMembershipPackages();
    const membershipPackage = latestMatchingDirectStudentPackage({
      packages,
      product,
    });
    if (!membershipPackage) {
      throw Error("purchased course membership package not found yet");
    }
    await assignSelf(membershipPackage.id);
  }

  async function completePurchase() {
    if (product == null) {
      return;
    }
    setActionError("");
    setDisabled(true);
    try {
      const completed = await runFreshAuthAction(async () => {
        const { package_id } = await purchaseMembershipPackage(product);
        await assignSelf(package_id);
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
    setDisabled(true);
    try {
      const { count } = await processPaymentIntents();
      if (count > 0) {
        await assignLatestPurchasedPackage();
        await onPurchased();
        setPlace("done");
      }
    } catch (err) {
      setActionError(`${err}`);
    } finally {
      setDisabled(false);
    }
  }

  const courseTitle = getCourseTitle(access.course);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      width={760}
      destroyOnHidden
      footer={null}
      title={
        <>
          <Icon name="shopping-cart" style={{ marginRight: "10px" }} />
          Buy course membership
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
      {product == null ? (
        <Alert
          type="error"
          showIcon
          title="Course membership purchase is not available"
          description="This project does not include enough course metadata to create a direct student membership purchase."
        />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            This is a one-time purchase for {courseTitle}. If you already have
            an equal or higher active membership, this course is covered without
            buying again.
          </Paragraph>
          <Space wrap>
            <Tag color="blue">{getRequiredMembershipLabel(access)}</Tag>
            {quote?.expires_at ? (
              <Tag>Access until {<TimeAgo date={quote.expires_at} />}</Tag>
            ) : null}
          </Space>
          {quoteLoading && <Spin />}
          {quote && (
            <>
              <MoneyStatistic title="Total price" value={quote.total_price} />
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Course membership price: {currency(quote.seat_price)}.
              </Paragraph>
              {chargeAmountValue.gt(totalValue) && (
                <Alert
                  type="warning"
                  showIcon
                  title={`The minimum immediate charge is ${currency(
                    chargeAmountValue.toNumber(),
                  )}.`}
                  description="Any amount above the course membership price is added to account credit and can be used for future purchases."
                />
              )}
            </>
          )}
          <Divider style={{ margin: "8px 0" }} />
          {place === "checkout" && quote && (
            <StripePayment
              disabled={disabled}
              description="Buy course membership"
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
                description="We are waiting for the payment to finish processing. When it does, your course membership will be assigned to this account."
              />
              <Payments
                purpose={MEMBERSHIP_PACKAGE_PURCHASE}
                numPaymentsRef={numPaymentsRef}
                limit={5}
              />
              <Button disabled={disabled} onClick={refreshProcessing}>
                <Icon name="refresh" /> Refresh status
              </Button>
            </>
          )}
          {place === "done" && (
            <Alert
              type="success"
              showIcon
              title="Course membership active"
              description="This course project is now covered by your purchased course membership."
            />
          )}
          <Paragraph style={{ color: COLORS.GRAY, marginBottom: 0 }}>
            This purchase only needs to be made once for any course that accepts
            the same or a lower-priority membership while it remains active.
          </Paragraph>
          <FreshAuthModal {...freshAuthModalProps} />
        </Space>
      )}
    </Modal>
  );
}
