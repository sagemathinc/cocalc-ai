/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Input,
  InputNumber,
  Modal,
  Radio,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Icon, Loading } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import MoneyStatistic from "@cocalc/frontend/purchases/money-statistic";
import Payments from "@cocalc/frontend/purchases/payments";
import {
  assignMembershipPackageSeat,
  claimMembershipPackageSeat,
  getClaimableMembershipPackages,
  getMembershipPackageQuote,
  getMembershipPackages,
  isPurchaseAllowed,
  processPaymentIntents,
  purchaseMembershipPackage,
  revokeMembershipPackageSeat,
} from "@cocalc/frontend/purchases/api";
import StripePayment from "@cocalc/frontend/purchases/stripe-payment";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  ClaimableMembershipPackage,
  MembershipClass,
  MembershipPackageAssignment,
  MembershipPackageDetails,
  MembershipPackageKind,
  MembershipPackageQuote,
} from "@cocalc/conat/hub/api/purchases";
import { MEMBERSHIP_PACKAGE_PURCHASE } from "@cocalc/util/db-schema/purchases";
import {
  capitalize,
  currency,
  is_valid_email_address as isValidEmailAddress,
} from "@cocalc/util/misc";
import { moneyRound2Up, toDecimal } from "@cocalc/util/money";
import type { LineItem } from "@cocalc/util/stripe/types";

const { Paragraph, Text, Title } = Typography;

interface MembershipTierLike {
  id: string;
  label?: string;
  store_visible?: boolean;
  disabled?: boolean;
}

interface Props {
  tiers: MembershipTierLike[];
  onChanged?: () => void;
}

interface PackageUserSearchResult {
  account_id: string;
  first_name?: string;
  last_name?: string;
  email_address?: string;
}

interface ClaimableMembershipPackagesPanelProps {
  onChanged?: () => void;
}

function toTime(value?: Date | null): number {
  return value instanceof Date ? value.valueOf() : 0;
}

function isActiveAssignment(
  assignment?: MembershipPackageAssignment | null,
): boolean {
  return !!assignment && !assignment.revoked_at;
}

function sortPackagesByRecent(
  packages: MembershipPackageDetails[],
): MembershipPackageDetails[] {
  return [...packages].sort(
    (left, right) =>
      toTime(right.updated) - toTime(left.updated) ||
      toTime(right.created) - toTime(left.created),
  );
}

function getPackageKindLabel(kind: MembershipPackageKind): string {
  switch (kind) {
    case "team":
      return "Team package";
    case "domain":
    case "site":
      return "Site license";
    case "course":
      return "Course package";
  }
}

function getTeamSeatTiers(tiers: MembershipTierLike[]): MembershipTierLike[] {
  return tiers
    .filter(
      (tier) =>
        !tier.disabled &&
        tier.store_visible !== false &&
        tier.id !== "free" &&
        tier.id !== "student",
    )
    .sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id));
}

function getPackageDomains(
  membershipPackage: MembershipPackageDetails,
): string[] {
  const candidates = [
    membershipPackage.metadata?.allowed_domains,
    membershipPackage.metadata?.domains,
    membershipPackage.metadata?.email_domains,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
    }
  }
  return [];
}

function getAccountDisplayName(
  assignment: MembershipPackageAssignment,
  names: Record<
    string,
    { first_name?: string; last_name?: string } | undefined
  >,
): string {
  if (!assignment.account_id) {
    return assignment.email_address ?? "Pending email claim";
  }
  const name = names[assignment.account_id];
  const fullName = `${name?.first_name ?? ""} ${name?.last_name ?? ""}`.trim();
  return fullName || assignment.account_id;
}

function getAccountSecondaryLabel(
  assignment: MembershipPackageAssignment,
  names: Record<
    string,
    { first_name?: string; last_name?: string } | undefined
  >,
): string | undefined {
  if (!assignment.account_id) {
    return "Reserved by email";
  }
  const name = names[assignment.account_id];
  const fullName = `${name?.first_name ?? ""} ${name?.last_name ?? ""}`.trim();
  if (!fullName) return;
  return assignment.account_id;
}

function getClaimReasonLabel(
  claimablePackage: ClaimableMembershipPackage,
): string {
  return claimablePackage.reason === "email-assignment"
    ? `Assigned to verified email ${claimablePackage.matched_email_address}`
    : `Verified domain match via ${claimablePackage.matched_email_address}`;
}

export function ClaimableMembershipPackagesPanel({
  onChanged,
}: ClaimableMembershipPackagesPanelProps) {
  const account_id = useTypedRedux("account", "account_id");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [claimingPackageId, setClaimingPackageId] = useState<string>("");
  const [claimables, setClaimables] = useState<ClaimableMembershipPackage[]>(
    [],
  );

  async function refreshClaimables() {
    if (!account_id) {
      setClaimables([]);
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setClaimables(await getClaimableMembershipPackages());
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshClaimables();
  }, [account_id]);

  if (!account_id) {
    return null;
  }

  return (
    <div>
      <Text strong>Claim memberships</Text>
      <Paragraph type="secondary" style={{ marginTop: "6px" }}>
        If a seat was reserved for one of your verified email addresses, or if
        your verified domain matches an available site license, you can claim
        that membership here.
      </Paragraph>
      {loading ? <Loading /> : null}
      {error ? (
        <Alert type="error" title={error} style={{ marginBottom: 12 }} />
      ) : null}
      {!loading && !error && claimables.length === 0 ? (
        <Alert
          type="info"
          showIcon
          title="No claimable memberships right now"
          description="Verify the relevant email address first if you expect a reserved team or site-license seat to appear here."
        />
      ) : null}
      {!loading && claimables.length > 0 ? (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {claimables.map((claimablePackage) => (
            <Card
              key={`${claimablePackage.package_id}-${claimablePackage.reason}-${claimablePackage.assignment_id ?? "open"}`}
              size="small"
              title={
                <Space wrap>
                  <span>{getPackageKindLabel(claimablePackage.kind)}</span>
                  <Tag color="blue">
                    {capitalize(claimablePackage.membership_class)}
                  </Tag>
                </Space>
              }
              extra={
                <Button
                  type="primary"
                  loading={claimingPackageId === claimablePackage.package_id}
                  onClick={async () => {
                    setClaimingPackageId(claimablePackage.package_id);
                    setError("");
                    try {
                      await claimMembershipPackageSeat({
                        package_id: claimablePackage.package_id,
                      });
                      await refreshClaimables();
                      onChanged?.();
                    } catch (err) {
                      setError(`${err}`);
                    } finally {
                      setClaimingPackageId("");
                    }
                  }}
                >
                  Claim seat
                </Button>
              }
            >
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="Eligibility">
                  {getClaimReasonLabel(claimablePackage)}
                </Descriptions.Item>
                <Descriptions.Item label="Available seats">
                  {claimablePackage.available_seat_count}
                </Descriptions.Item>
                {claimablePackage.expires_at ? (
                  <Descriptions.Item label="Expires">
                    <TimeAgo date={claimablePackage.expires_at} />
                  </Descriptions.Item>
                ) : null}
              </Descriptions>
            </Card>
          ))}
        </Space>
      ) : null}
    </div>
  );
}

export function MembershipPackageManager({ tiers, onChanged }: Props) {
  const account_id = useTypedRedux("account", "account_id");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [membershipPackages, setMembershipPackages] = useState<
    MembershipPackageDetails[]
  >([]);
  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [purchaseTarget, setPurchaseTarget] = useState<
    MembershipPackageDetails | null | undefined
  >(undefined);
  const [assignmentTarget, setAssignmentTarget] =
    useState<MembershipPackageDetails | null>(null);
  const [accountNames, setAccountNames] = useState<
    Record<string, { first_name?: string; last_name?: string } | undefined>
  >({});

  const refreshPackages = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await getMembershipPackages();
      setMembershipPackages(sortPackagesByRecent(next));
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!account_id) {
      setMembershipPackages([]);
      setAccountNames({});
      setError("");
      setLoading(false);
      return;
    }
    void refreshPackages();
  }, [account_id, refreshToken]);

  const assignedAccountIds = useMemo(() => {
    return Array.from(
      new Set(
        membershipPackages.flatMap((membershipPackage) =>
          membershipPackage.assignments
            .filter(isActiveAssignment)
            .map((assignment) => assignment.account_id)
            .filter((value): value is string => !!value),
        ),
      ),
    );
  }, [membershipPackages]);

  useEffect(() => {
    let canceled = false;
    async function loadNames() {
      if (assignedAccountIds.length === 0) {
        setAccountNames({});
        return;
      }
      try {
        const next =
          await webapp_client.users_client.getNames(assignedAccountIds);
        if (!canceled) {
          setAccountNames(next ?? {});
        }
      } catch (_err) {
        if (!canceled) {
          setAccountNames({});
        }
      }
    }
    void loadNames();
    return () => {
      canceled = true;
    };
  }, [assignedAccountIds]);

  const teamPackages = useMemo(
    () =>
      membershipPackages.filter(
        (membershipPackage) => membershipPackage.kind === "team",
      ),
    [membershipPackages],
  );
  const sitePackages = useMemo(
    () =>
      membershipPackages.filter(
        (membershipPackage) =>
          membershipPackage.kind === "site" ||
          membershipPackage.kind === "domain",
      ),
    [membershipPackages],
  );

  const handleChanged = async () => {
    await refreshPackages();
    onChanged?.();
  };

  if (!account_id) {
    return null;
  }

  return (
    <div>
      <Text strong>Team and site licenses</Text>
      <Paragraph type="secondary" style={{ marginTop: "6px" }}>
        Team packages let you buy seats and grant memberships to specific
        accounts. Site licenses are provisioned by support or admins, then
        managed here. There is no self-serve site-license creation flow yet.
      </Paragraph>
      {error && (
        <Alert type="error" title={error} style={{ marginBottom: 12 }} />
      )}
      <Space wrap style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setPurchaseTarget(null)}>
          <Icon name="shopping-cart" /> Buy team seats
        </Button>
        <Button onClick={() => setRefreshToken((value) => value + 1)}>
          <Icon name="refresh" /> Refresh packages
        </Button>
      </Space>
      {loading ? (
        <Loading />
      ) : (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <PackageGroup
            title="Team packages"
            emptyTitle="No team packages yet"
            emptyDescription="Buy team seats here, then assign them to the accounts that should receive membership access."
            membershipPackages={teamPackages}
            tiers={tiers}
            accountNames={accountNames}
            onAddSeats={(membershipPackage) =>
              setPurchaseTarget(membershipPackage)
            }
            onAssignSeat={(membershipPackage) =>
              setAssignmentTarget(membershipPackage)
            }
            onRevokeSeat={async (membershipPackage, assignment) => {
              await revokeMembershipPackageSeat({
                package_id: membershipPackage.id,
                target_account_id: assignment.account_id ?? undefined,
                target_email_address: assignment.email_address ?? undefined,
              });
              await handleChanged();
            }}
          />
          <PackageGroup
            title="Site licenses"
            emptyTitle="No site licenses provisioned"
            emptyDescription="Site licenses are provisioned by support or admins. Once they exist, assign seats from here to the accounts that should receive access."
            membershipPackages={sitePackages}
            tiers={tiers}
            accountNames={accountNames}
            onAssignSeat={(membershipPackage) =>
              setAssignmentTarget(membershipPackage)
            }
            onRevokeSeat={async (membershipPackage, assignment) => {
              await revokeMembershipPackageSeat({
                package_id: membershipPackage.id,
                target_account_id: assignment.account_id ?? undefined,
                target_email_address: assignment.email_address ?? undefined,
              });
              await handleChanged();
            }}
          />
        </Space>
      )}
      <TeamPackagePurchaseModal
        open={purchaseTarget !== undefined}
        membershipPackage={purchaseTarget ?? undefined}
        tiers={tiers}
        onClose={() => setPurchaseTarget(undefined)}
        onPurchased={handleChanged}
      />
      <AssignMembershipSeatModal
        open={assignmentTarget != null}
        membershipPackage={assignmentTarget}
        onClose={() => setAssignmentTarget(null)}
        onAssigned={async () => {
          setAssignmentTarget(null);
          await handleChanged();
        }}
      />
    </div>
  );
}

function PackageGroup({
  title,
  emptyTitle,
  emptyDescription,
  membershipPackages,
  tiers,
  accountNames,
  onAddSeats,
  onAssignSeat,
  onRevokeSeat,
}: {
  title: string;
  emptyTitle: string;
  emptyDescription: string;
  membershipPackages: MembershipPackageDetails[];
  tiers: MembershipTierLike[];
  accountNames: Record<
    string,
    { first_name?: string; last_name?: string } | undefined
  >;
  onAddSeats?: (membershipPackage: MembershipPackageDetails) => void;
  onAssignSeat: (membershipPackage: MembershipPackageDetails) => void;
  onRevokeSeat: (
    membershipPackage: MembershipPackageDetails,
    assignment: MembershipPackageAssignment,
  ) => Promise<void>;
}) {
  if (membershipPackages.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }
  return (
    <div>
      <Title level={5} style={{ marginTop: 0 }}>
        {title}
      </Title>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {membershipPackages.map((membershipPackage) => (
          <MembershipPackageCard
            key={membershipPackage.id}
            membershipPackage={membershipPackage}
            tierLabel={
              tiers.find(
                (tier) => tier.id === membershipPackage.membership_class,
              )?.label ?? capitalize(membershipPackage.membership_class)
            }
            accountNames={accountNames}
            onAddSeats={onAddSeats}
            onAssignSeat={onAssignSeat}
            onRevokeSeat={onRevokeSeat}
          />
        ))}
      </Space>
    </div>
  );
}

function MembershipPackageCard({
  membershipPackage,
  tierLabel,
  accountNames,
  onAddSeats,
  onAssignSeat,
  onRevokeSeat,
}: {
  membershipPackage: MembershipPackageDetails;
  tierLabel: string;
  accountNames: Record<
    string,
    { first_name?: string; last_name?: string } | undefined
  >;
  onAddSeats?: (membershipPackage: MembershipPackageDetails) => void;
  onAssignSeat: (membershipPackage: MembershipPackageDetails) => void;
  onRevokeSeat: (
    membershipPackage: MembershipPackageDetails,
    assignment: MembershipPackageAssignment,
  ) => Promise<void>;
}) {
  const [revokingAccountId, setRevokingAccountId] = useState<string>("");
  const activeAssignments =
    membershipPackage.assignments.filter(isActiveAssignment);
  const domains = getPackageDomains(membershipPackage);
  const interval =
    `${membershipPackage.metadata?.interval ?? ""}` === "year"
      ? "yearly"
      : `${membershipPackage.metadata?.interval ?? ""}` === "month"
        ? "monthly"
        : undefined;

  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <span>{getPackageKindLabel(membershipPackage.kind)}</span>
          <Tag color="blue">{tierLabel}</Tag>
          {interval ? <Tag>{interval}</Tag> : null}
        </Space>
      }
      extra={
        <Space wrap>
          <Button
            type="primary"
            onClick={() => onAssignSeat(membershipPackage)}
            disabled={membershipPackage.available_seat_count <= 0}
          >
            Assign seat
          </Button>
          {membershipPackage.kind === "team" && onAddSeats ? (
            <Button onClick={() => onAddSeats(membershipPackage)}>
              Add seats
            </Button>
          ) : null}
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Tag>{`${membershipPackage.seat_count} purchased`}</Tag>
        <Tag color="green">{`${membershipPackage.active_assignment_count} assigned`}</Tag>
        <Tag color="gold">{`${membershipPackage.available_seat_count} available`}</Tag>
      </Space>
      <Descriptions size="small" column={1}>
        {membershipPackage.starts_at ? (
          <Descriptions.Item label="Starts">
            <TimeAgo date={membershipPackage.starts_at} />
          </Descriptions.Item>
        ) : null}
        {membershipPackage.expires_at ? (
          <Descriptions.Item label="Expires">
            <TimeAgo date={membershipPackage.expires_at} />
          </Descriptions.Item>
        ) : null}
        {membershipPackage.kind === "team" &&
        typeof membershipPackage.metadata?.seat_price === "number" ? (
          <Descriptions.Item label="Seat price">
            {currency(Number(membershipPackage.metadata?.seat_price))}
          </Descriptions.Item>
        ) : null}
        {domains.length > 0 ? (
          <Descriptions.Item label="Allowed domains">
            <Space wrap>
              {domains.map((domain) => (
                <Tag key={domain}>{domain}</Tag>
              ))}
            </Space>
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      <Divider style={{ margin: "12px 0" }} />
      <Text strong>Assigned seats</Text>
      {activeAssignments.length === 0 ? (
        <div style={{ marginTop: 6 }}>
          <Text type="secondary">No seats assigned yet.</Text>
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          <Space orientation="vertical" size="small" style={{ width: "100%" }}>
            {activeAssignments.map((assignment) => (
              <div
                key={assignment.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
                <Space orientation="vertical" size={0}>
                  <Text>{getAccountDisplayName(assignment, accountNames)}</Text>
                  <Space wrap>
                    {getAccountSecondaryLabel(assignment, accountNames) ? (
                      <Text type="secondary">
                        {getAccountSecondaryLabel(assignment, accountNames)}
                      </Text>
                    ) : null}
                    {assignment.assigned_at ? (
                      <Text type="secondary">
                        Assigned <TimeAgo date={assignment.assigned_at} />
                      </Text>
                    ) : null}
                  </Space>
                </Space>
                <Button
                  danger
                  size="small"
                  loading={
                    revokingAccountId ===
                    (assignment.account_id ?? assignment.email_address ?? "")
                  }
                  onClick={async () => {
                    setRevokingAccountId(
                      assignment.account_id ?? assignment.email_address ?? "",
                    );
                    try {
                      await onRevokeSeat(membershipPackage, assignment);
                    } finally {
                      setRevokingAccountId("");
                    }
                  }}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </Space>
        </div>
      )}
    </Card>
  );
}

function TeamPackagePurchaseModal({
  open,
  membershipPackage,
  tiers,
  onClose,
  onPurchased,
}: {
  open: boolean;
  membershipPackage?: MembershipPackageDetails;
  tiers: MembershipTierLike[];
  onClose: () => void;
  onPurchased: () => Promise<void>;
}) {
  const purchaseableTiers = useMemo(() => getTeamSeatTiers(tiers), [tiers]);
  const [selectedTierId, setSelectedTierId] = useState<string>("");
  const [interval, setInterval] = useState<"month" | "year">("month");
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

  useEffect(() => {
    if (!open) return;
    setPlace("checkout");
    setQuote(null);
    setQuoteError("");
    setActionError("");
    setDisabled(false);
    setSeatCount(1);
    if (membershipPackage) {
      setSelectedTierId(membershipPackage.membership_class);
      setInterval(
        `${membershipPackage.metadata?.interval ?? ""}` === "year"
          ? "year"
          : "month",
      );
    } else {
      setSelectedTierId(purchaseableTiers[0]?.id ?? "");
      setInterval("month");
    }
  }, [open, membershipPackage, purchaseableTiers]);

  const product = useMemo(
    () =>
      membershipPackage
        ? {
            package_id: membershipPackage.id,
            kind: "team" as const,
            seat_count: seatCount,
            membership_class:
              (membershipPackage.membership_class as MembershipClass) ??
              undefined,
            interval: (`${membershipPackage.metadata?.interval ?? interval}` ===
            "year"
              ? "year"
              : "month") as "month" | "year",
          }
        : {
            kind: "team" as const,
            membership_class:
              (selectedTierId as MembershipClass | "") || undefined,
            seat_count: seatCount,
            interval,
          },
    [membershipPackage, seatCount, selectedTierId, interval],
  );

  useEffect(() => {
    if (!open) return;
    if (!seatCount || seatCount < 1) {
      setQuote(null);
      return;
    }
    if (!membershipPackage && !selectedTierId) {
      setQuote(null);
      return;
    }
    let canceled = false;
    async function loadQuote() {
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
    void loadQuote();
    return () => {
      canceled = true;
    };
  }, [open, product, seatCount, membershipPackage, selectedTierId]);

  const selectedTierLabel =
    purchaseableTiers.find((tier) => tier.id === selectedTierId)?.label ??
    capitalize(selectedTierId || membershipPackage?.membership_class || "team");
  const totalValue = toDecimal(quote?.total_price ?? 0);
  const chargeAmountValue = toDecimal(chargeAmount);
  const lineItems: LineItem[] = [];
  if (quote) {
    lineItems.push({
      description: `${seatCount} ${selectedTierLabel} team seat${seatCount === 1 ? "" : "s"} (${currency(
        quote.seat_price,
      )} each)`,
      amount: moneyRound2Up(totalValue).toNumber(),
    });
    if (chargeAmountValue.lt(totalValue)) {
      lineItems.push({
        description: "Apply account credit toward team seats",
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
      footer={null}
      width={820}
      destroyOnHidden
      title={
        <>
          <Icon name="shopping-cart" style={{ marginRight: 10 }} />
          {membershipPackage ? "Add team seats" : "Purchase team seats"}
        </>
      }
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {quoteError || actionError ? (
          <Alert
            type="error"
            title={quoteError || actionError}
            closable
            onClose={() => {
              setQuoteError("");
              setActionError("");
            }}
          />
        ) : null}
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Team seats grant account-wide membership access. Mid-term seat
          increases use the same per-seat price as the original package.
        </Paragraph>
        <Space wrap>
          <Tag color="blue">
            {membershipPackage ? "Existing team package" : "New team package"}
          </Tag>
          {membershipPackage ? <Tag>{selectedTierLabel}</Tag> : null}
        </Space>
        {!membershipPackage ? (
          <>
            <div>
              <Text strong>Membership tier</Text>
              <div style={{ marginTop: 8 }}>
                <Radio.Group
                  value={selectedTierId}
                  onChange={(e) => setSelectedTierId(e.target.value)}
                >
                  <Space orientation="vertical">
                    {purchaseableTiers.map((tier) => (
                      <Radio key={tier.id} value={tier.id}>
                        {tier.label ?? capitalize(tier.id)}
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
              </div>
            </div>
            <div>
              <Text strong>Billing interval</Text>
              <div style={{ marginTop: 8 }}>
                <Radio.Group
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                >
                  <Space>
                    <Radio.Button value="month">Monthly</Radio.Button>
                    <Radio.Button value="year">Yearly</Radio.Button>
                  </Space>
                </Radio.Group>
              </div>
            </div>
          </>
        ) : null}
        <div>
          <Text strong>
            {membershipPackage ? "Additional seats" : "Seats to purchase"}
          </Text>
          <div style={{ marginTop: 8 }}>
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
        {quoteLoading ? <Spin /> : null}
        {quote ? (
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
            {chargeAmountValue.gt(totalValue) ? (
              <Alert
                type="warning"
                showIcon
                title={`The minimum immediate charge is ${currency(
                  chargeAmountValue.toNumber(),
                )}.`}
                description="Any amount above the seat price is added to account credit and can be used for future purchases."
              />
            ) : null}
          </>
        ) : null}
        <Divider style={{ margin: "8px 0" }} />
        {place === "checkout" && quote ? (
          <StripePayment
            disabled={disabled}
            description={
              membershipPackage ? "Add team seats" : "Purchase team seats"
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
        ) : null}
        {place === "processing" ? (
          <>
            <Alert
              type="info"
              showIcon
              title="Payment submitted"
              description="We are waiting for the payment to finish processing. When it does, the purchased seats will appear in this package."
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
        ) : null}
        {place === "done" ? (
          <Alert
            type="success"
            showIcon
            title="Team seats purchased"
            description="The package seat count has been updated. You can assign seats immediately."
          />
        ) : null}
        <FreshAuthModal {...freshAuthModalProps} />
      </Space>
    </Modal>
  );
}

function AssignMembershipSeatModal({
  open,
  membershipPackage,
  onClose,
  onAssigned,
}: {
  open: boolean;
  membershipPackage: MembershipPackageDetails | null;
  onClose: () => void;
  onAssigned: () => Promise<void>;
}) {
  const [query, setQuery] = useState<string>("");
  const [searching, setSearching] = useState<boolean>(false);
  const [results, setResults] = useState<PackageUserSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string>("");
  const [selectedTarget, setSelectedTarget] = useState<string>("");
  const [assigning, setAssigning] = useState<boolean>(false);
  const activeAccountIds = useMemo(
    () =>
      new Set(
        membershipPackage?.assignments
          .filter(isActiveAssignment)
          .map((assignment) => assignment.account_id) ?? [],
      ),
    [membershipPackage],
  );
  const activeEmailAddresses = useMemo(
    () =>
      new Set(
        membershipPackage?.assignments
          .filter(isActiveAssignment)
          .map((assignment) => assignment.email_address?.toLowerCase())
          .filter((value): value is string => !!value) ?? [],
      ),
    [membershipPackage],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSearching(false);
    setResults([]);
    setSearchError("");
    setSelectedTarget("");
    setAssigning(false);
  }, [open, membershipPackage?.id]);

  async function runSearch() {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchError("Enter a name or exact email address to search.");
      setResults([]);
      return;
    }
    setSearching(true);
    setSearchError("");
    try {
      const rawResults = await webapp_client.users_client.user_search({
        query: trimmed,
        limit: 20,
      });
      const next = (rawResults ?? [])
        .filter(
          (result): result is PackageUserSearchResult =>
            typeof result?.account_id === "string" &&
            result.account_id.length > 0 &&
            !activeAccountIds.has(result.account_id) &&
            !activeEmailAddresses.has(
              result.email_address?.toLowerCase() ?? "",
            ),
        )
        .slice(0, 20);
      setResults(next);
      if (next.length === 0) {
        const normalizedEmail = query.trim().toLowerCase();
        if (
          isValidEmailAddress(normalizedEmail) &&
          !activeEmailAddresses.has(normalizedEmail)
        ) {
          setSelectedTarget(`email:${normalizedEmail}`);
        } else {
          setSelectedTarget("");
        }
      } else if (
        !next.some(
          (result) => `account:${result.account_id}` === selectedTarget,
        )
      ) {
        setSelectedTarget(`account:${next[0].account_id}`);
      }
    } catch (err) {
      setSearchError(`${err}`);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function assign() {
    if (!membershipPackage || !selectedTarget) return;
    setAssigning(true);
    setSearchError("");
    try {
      if (selectedTarget.startsWith("account:")) {
        await assignMembershipPackageSeat({
          package_id: membershipPackage.id,
          target_account_id: selectedTarget.slice("account:".length),
        });
      } else if (selectedTarget.startsWith("email:")) {
        await assignMembershipPackageSeat({
          package_id: membershipPackage.id,
          target_email_address: selectedTarget.slice("email:".length),
        });
      }
      await onAssigned();
    } catch (err) {
      setSearchError(`${err}`);
    } finally {
      setAssigning(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={assign}
      okText="Assign seat"
      okButtonProps={{ disabled: !selectedTarget, loading: assigning }}
      destroyOnHidden
      title={`Assign ${membershipPackage ? getPackageKindLabel(membershipPackage.kind).toLowerCase() : "package"} seat`}
    >
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {membershipPackage ? (
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Search for an existing account or enter an exact email address to
            reserve a seat from the{" "}
            {getPackageKindLabel(membershipPackage.kind).toLowerCase()}.
            Reserved email seats appear as claimable memberships once that user
            verifies the address on their account.
          </Paragraph>
        ) : null}
        {searchError ? (
          <Alert
            type="error"
            title={searchError}
            closable
            onClose={() => setSearchError("")}
          />
        ) : null}
        <Input.Search
          placeholder="Search by name or exact email address"
          value={query}
          enterButton="Search"
          loading={searching}
          onChange={(e) => setQuery(e.target.value)}
          onSearch={() => {
            void runSearch();
          }}
        />
        {searching ? <Spin /> : null}
        {results.length > 0 ? (
          <Radio.Group
            value={selectedTarget}
            onChange={(e) => setSelectedTarget(e.target.value)}
            style={{ width: "100%" }}
          >
            <Space
              orientation="vertical"
              size="small"
              style={{ width: "100%" }}
            >
              {results.map((result) => {
                const fullName =
                  `${result.first_name ?? ""} ${result.last_name ?? ""}`.trim();
                return (
                  <Radio
                    key={result.account_id}
                    value={`account:${result.account_id}`}
                    style={{ width: "100%" }}
                  >
                    <Space orientation="vertical" size={0}>
                      <Text>{fullName || result.account_id}</Text>
                      <Text type="secondary">
                        {result.email_address || result.account_id}
                      </Text>
                    </Space>
                  </Radio>
                );
              })}
            </Space>
          </Radio.Group>
        ) : null}
        {!searching &&
        query.trim() &&
        results.length === 0 &&
        !searchError &&
        isValidEmailAddress(query.trim().toLowerCase()) &&
        !activeEmailAddresses.has(query.trim().toLowerCase()) ? (
          <Radio.Group
            value={selectedTarget}
            onChange={(e) => setSelectedTarget(e.target.value)}
            style={{ width: "100%" }}
          >
            <Radio value={`email:${query.trim().toLowerCase()}`}>
              <Space orientation="vertical" size={0}>
                <Text>{query.trim().toLowerCase()}</Text>
                <Text type="secondary">
                  Reserve this seat by email until the user verifies it
                </Text>
              </Space>
            </Radio>
          </Radio.Group>
        ) : null}
        {!searching && query.trim() && results.length === 0 && !searchError ? (
          <Alert
            type="info"
            showIcon
            title="No matching existing account found"
            description={
              isValidEmailAddress(query.trim().toLowerCase())
                ? "You can still reserve the seat by email above."
                : "Search by name or exact email address."
            }
          />
        ) : null}
      </Space>
    </Modal>
  );
}

export default MembershipPackageManager;
