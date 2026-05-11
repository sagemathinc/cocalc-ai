import {
  Alert,
  Card,
  Checkbox,
  InputNumber,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import type { ClaimableMembershipPackage } from "@cocalc/conat/hub/api/purchases";
import api from "@cocalc/frontend/client/api";
import { Icon } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { getClaimableMembershipPackages } from "@cocalc/frontend/purchases/api";
import { currency } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { InstitutePaySection } from "./institute-pay";

interface CourseMembershipTier {
  id: string;
  label?: string;
  priority?: number;
  course_store_visible?: boolean;
  course_price?: number;
  course_duration_days?: number;
  course_grace_days?: number;
  disabled?: boolean;
}

interface MembershipTiersResponse {
  tiers?: CourseMembershipTier[];
}

const DEFAULT_GRACE_DAYS = 14;

export default function StudentPay({ actions, settings, project_id }) {
  const intl = useIntl();
  const [tiers, setTiers] = useState<CourseMembershipTier[]>([]);
  const [claimablePackages, setClaimablePackages] = useState<
    ClaimableMembershipPackage[]
  >([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const siteLicenseDefaultedForTier = useRef<Set<string>>(new Set());

  async function loadTiers() {
    setLoading(true);
    setError("");
    try {
      const [result, claimables] = await Promise.all([
        api(
          "purchases/get-membership-tiers",
        ) as Promise<MembershipTiersResponse>,
        getClaimableMembershipPackages(),
      ]);
      setTiers(result.tiers ?? []);
      setClaimablePackages(claimables);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTiers();
  }, []);

  const courseTiers = useMemo(() => {
    return tiers
      .filter((tier) => tier.course_store_visible && !tier.disabled)
      .sort((a, b) => {
        const ap = a.priority ?? 0;
        const bp = b.priority ?? 0;
        if (ap !== bp) return ap - bp;
        return a.id.localeCompare(b.id);
      });
  }, [tiers]);

  const selectedTierId = `${settings?.get("required_membership_class") ?? ""}`;
  const selectedTier =
    courseTiers.find((tier) => tier.id === selectedTierId) ?? null;
  const tierById = useMemo(() => {
    return new Map(tiers.map((tier) => [tier.id, tier]));
  }, [tiers]);
  const matchingSiteLicense = useMemo(() => {
    if (!selectedTier) {
      return null;
    }
    const requiredPriority = selectedTier.priority ?? 0;
    return (
      claimablePackages
        .filter((membershipPackage) => membershipPackage.kind === "site")
        .filter((membershipPackage) => {
          const siteTier = tierById.get(membershipPackage.membership_class);
          return (siteTier?.priority ?? 0) >= requiredPriority;
        })
        .sort((left, right) => {
          const leftPriority =
            tierById.get(left.membership_class)?.priority ?? 0;
          const rightPriority =
            tierById.get(right.membership_class)?.priority ?? 0;
          if (rightPriority !== leftPriority) {
            return rightPriority - leftPriority;
          }
          return left.package_id.localeCompare(right.package_id);
        })[0] ?? null
    );
  }, [claimablePackages, selectedTier, tierById]);
  const selectedTierGraceDays = Number(selectedTier?.course_grace_days);
  const defaultGraceDays = Number.isFinite(selectedTierGraceDays)
    ? selectedTierGraceDays
    : DEFAULT_GRACE_DAYS;
  const configuredGraceDaysRaw = settings?.get("student_membership_grace_days");
  const configuredGraceDays =
    configuredGraceDaysRaw == null ? undefined : Number(configuredGraceDaysRaw);
  const graceDays =
    configuredGraceDays != null && Number.isFinite(configuredGraceDays)
      ? configuredGraceDays
      : defaultGraceDays;
  const paymentEnabled = !!(
    settings?.get("student_pay") ||
    settings?.get("institute_pay") ||
    settings?.get("site_license_pay")
  );

  useEffect(() => {
    if (
      !actions ||
      !selectedTierId ||
      paymentEnabled ||
      !matchingSiteLicense ||
      siteLicenseDefaultedForTier.current.has(selectedTierId)
    ) {
      return;
    }
    siteLicenseDefaultedForTier.current.add(selectedTierId);
    actions.configuration.set_pay_choice("site_license", true);
    actions.configuration.configure_all_projects();
  }, [actions, matchingSiteLicense, paymentEnabled, selectedTierId]);

  if (settings == null || actions == null) {
    return <Spin />;
  }

  function setSelectedTier(required_membership_class: string) {
    const tier = courseTiers.find(
      (tier) => tier.id === required_membership_class,
    );
    const tierGraceDays = Number(tier?.course_grace_days);
    actions.configuration.set_course_membership({
      required_membership_class,
      student_membership_grace_days: Number.isFinite(tierGraceDays)
        ? tierGraceDays
        : DEFAULT_GRACE_DAYS,
    });
  }

  function setGraceDays(student_membership_grace_days: number | null) {
    actions.configuration.set_course_membership({
      required_membership_class: selectedTierId,
      student_membership_grace_days:
        student_membership_grace_days ?? defaultGraceDays,
    });
  }

  return (
    <Card
      style={!paymentEnabled ? { background: COLORS.YELL_LLL } : undefined}
      title={
        <>
          <Icon name="dashboard" />{" "}
          <FormattedMessage
            id="course.student-pay.title"
            defaultMessage={"Course Payment Options"}
          />
        </>
      }
    >
      <ShowError error={error} setError={setError} />
      {loading ? (
        <Spin />
      ) : courseTiers.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          title="No course memberships are configured"
          description="An admin must mark at least one membership tier as course-visible before courses can use student pay or instructor-paid seats."
        />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            title="Choose the membership students need for this course"
            description="Pricing comes from the selected course-visible membership tier. It is not based on course dates or project quota settings."
          />
          <div>
            <div style={{ marginBottom: "6px", fontWeight: 600 }}>
              Required student course membership
            </div>
            <Select
              style={{ width: "100%" }}
              placeholder="Select a course membership tier"
              value={selectedTierId || undefined}
              onChange={setSelectedTier}
              options={courseTiers.map((tier) => ({
                value: tier.id,
                label: `${tier.label ?? tier.id} (${currency(
                  Number(tier.course_price ?? 0),
                )} / ${Number(tier.course_duration_days ?? 0)} days)`,
              }))}
            />
          </div>
          {selectedTier && (
            <Space wrap>
              <Tag color="blue">{selectedTier.label ?? selectedTier.id}</Tag>
              <Tag>{currency(Number(selectedTier.course_price ?? 0))}</Tag>
              <Tag>{Number(selectedTier.course_duration_days ?? 0)} days</Tag>
              <Tag>{graceDays} grace days</Tag>
              <Tag>priority {selectedTier.priority ?? 0}</Tag>
            </Space>
          )}
          <div>
            <div style={{ marginBottom: "6px", fontWeight: 600 }}>
              Student grace period
            </div>
            <InputNumber
              min={0}
              precision={0}
              value={graceDays}
              onChange={setGraceDays}
            />{" "}
            <span style={{ color: COLORS.GRAY }}>
              days of full access before payment is required
            </span>
          </div>
          <Checkbox
            checked={!!settings?.get("site_license_pay")}
            disabled={!selectedTier || !matchingSiteLicense}
            onChange={(e) => {
              actions.configuration.set_pay_choice(
                "site_license",
                e.target.checked,
              );
              if (e.target.checked) {
                actions.configuration.configure_all_projects();
              }
            }}
          >
            Use matching site license
          </Checkbox>
          {selectedTier && matchingSiteLicense ? (
            <Alert
              type="success"
              showIcon
              title="Matching site license available"
              description={
                <>
                  The verified email{" "}
                  <strong>{matchingSiteLicense.matched_email_address}</strong>{" "}
                  can claim a site license for{" "}
                  <strong>{matchingSiteLicense.membership_class}</strong>. This
                  option is selected by default when no other course payment
                  mode has been chosen.
                </>
              }
            />
          ) : selectedTier ? (
            <Alert
              type="info"
              showIcon
              title="No matching site license found"
              description="Students can still pay directly or the instructor can buy course seats. If a site license is expected, verify the instructor email domain and confirm the site license has available seats."
            />
          ) : null}
          <Checkbox
            checked={!!settings?.get("student_pay")}
            disabled={!selectedTier}
            onChange={(e) => {
              actions.configuration.set_pay_choice("student", e.target.checked);
              if (e.target.checked) {
                actions.configuration.configure_all_projects();
              }
            }}
          >
            {intl.formatMessage({
              id: "course.student-pay.checkbox.students-pay",
              defaultMessage: "Students pay directly",
            })}
          </Checkbox>
          <InstitutePaySection
            project_id={project_id}
            enabled={!!settings?.get("institute_pay")}
            selectedTier={selectedTier}
            onToggle={(checked) => {
              actions.configuration.set_pay_choice("institute", checked);
              if (checked) {
                actions.configuration.configure_all_projects();
              }
            }}
          />
        </Space>
      )}
    </Card>
  );
}
