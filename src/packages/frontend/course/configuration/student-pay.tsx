import {
  Alert,
  Button,
  Card,
  DatePicker,
  Popover,
  Radio,
  Select,
  Space,
  Spin,
  Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import type { ClaimableMembershipPackage } from "@cocalc/conat/hub/api/purchases";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import api from "@cocalc/frontend/client/api";
import {
  MembershipTierBenefits,
  type MembershipTierWithPresentation,
} from "@cocalc/frontend/account/membership-tier-benefits";
import { A, Icon } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { getClaimableMembershipPackages } from "@cocalc/frontend/purchases/api";
import { currency } from "@cocalc/util/misc";
import { membershipTierVisibleForVerifiedInstructorEmail } from "@cocalc/util/membership-tier-domains";
import { InstitutePaySection } from "./institute-pay";

const { Text } = Typography;

interface CourseMembershipTier extends MembershipTierWithPresentation {
  id: string;
  label?: string;
  priority?: number;
  course_store_visible?: boolean;
  course_price?: number;
  course_duration_days?: number;
  course_grace_days?: number;
  course_allowed_domains?: readonly string[] | null;
  disabled?: boolean;
}

interface MembershipTiersResponse {
  tiers?: CourseMembershipTier[];
}

const DEFAULT_GRACE_DAYS = 14;
type CoursePayChoice = "student" | "institute" | "site_license";

export default function StudentPay({ actions, settings, project_id }) {
  const intl = useIntl();
  const emailAddress = useTypedRedux("account", "email_address");
  const emailAddressVerified = useTypedRedux(
    "account",
    "email_address_verified",
  );
  const [tiers, setTiers] = useState<CourseMembershipTier[]>([]);
  const [claimablePackages, setClaimablePackages] = useState<
    ClaimableMembershipPackage[]
  >([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const paymentDefaultedForTier = useRef<Set<string>>(new Set());

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
    const currentEmailIsVerified =
      !!emailAddress && !!(emailAddressVerified as any)?.get?.(emailAddress);
    return tiers
      .filter((tier) => tier.course_store_visible && !tier.disabled)
      .filter((tier) =>
        membershipTierVisibleForVerifiedInstructorEmail({
          emailAddress,
          emailVerified: currentEmailIsVerified,
          tier,
        }),
      )
      .sort((a, b) => {
        const ap = a.priority ?? 0;
        const bp = b.priority ?? 0;
        if (ap !== bp) return ap - bp;
        return a.id.localeCompare(b.id);
      });
  }, [emailAddress, emailAddressVerified, tiers]);
  const courseVisibleTierCount = useMemo(
    () =>
      tiers.filter((tier) => tier.course_store_visible && !tier.disabled)
        .length,
    [tiers],
  );
  const hiddenByInstructorDomainCount =
    courseVisibleTierCount - courseTiers.length;

  const selectedTierId = `${settings?.get("required_membership_class") ?? ""}`;
  const selectedTier =
    courseTiers.find((tier) => tier.id === selectedTierId) ?? null;
  const courseStartDateString = `${
    settings?.get("student_membership_required_at") ?? ""
  }`;
  const courseStartDate = dayjs(courseStartDateString);
  const selectedGraceDays = Number(
    settings?.get("student_membership_grace_days") ??
      selectedTier?.course_grace_days ??
      DEFAULT_GRACE_DAYS,
  );
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
  const paymentEnabled = !!(
    settings?.get("student_pay") ||
    settings?.get("institute_pay") ||
    settings?.get("site_license_pay")
  );
  const selectedPayChoice: CoursePayChoice | undefined = settings?.get(
    "site_license_pay",
  )
    ? "site_license"
    : settings?.get("institute_pay")
      ? "institute"
      : settings?.get("student_pay")
        ? "student"
        : undefined;

  useEffect(() => {
    if (
      !actions ||
      !selectedTierId ||
      !selectedTier ||
      paymentEnabled ||
      paymentDefaultedForTier.current.has(selectedTierId)
    ) {
      return;
    }
    paymentDefaultedForTier.current.add(selectedTierId);
    actions.configuration.set_pay_choice(
      matchingSiteLicense ? "site_license" : "student",
      true,
    );
    actions.configuration.configure_all_projects();
  }, [
    actions,
    matchingSiteLicense,
    paymentEnabled,
    selectedTier,
    selectedTierId,
  ]);

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

  function setCourseStartDate(value: Dayjs | null) {
    actions.configuration.set_course_membership({
      required_membership_class: selectedTierId,
      student_membership_required_at: value
        ? value.startOf("day").toISOString()
        : "",
      student_membership_grace_days: Number.isFinite(selectedGraceDays)
        ? selectedGraceDays
        : DEFAULT_GRACE_DAYS,
    });
  }

  function setPayChoice(value: CoursePayChoice) {
    actions.configuration.set_pay_choice(value, true);
    actions.configuration.configure_all_projects();
  }

  return (
    <Card
      title={
        <>
          <Icon name="dashboard" />{" "}
          <FormattedMessage
            id="course.student-pay.title"
            defaultMessage={"Course Payment Options"}
          />{" "}
          (<A href="/app-docs/teaching/student-pay">Docs</A>)
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
          title={
            hiddenByInstructorDomainCount > 0
              ? "No course memberships are available for your verified email domain"
              : "No course memberships are configured"
          }
          description={
            hiddenByInstructorDomainCount > 0
              ? "Some course membership tiers are limited to instructors with specific verified email domains. Verify your institutional email address, or ask an admin to update the tier domain allowlist."
              : "An admin must mark at least one membership tier as course-visible before courses can use student pay or instructor-paid seats."
          }
        />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
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
            <Space direction="vertical" size="small" style={{ width: "100%" }}>
              <Text type="secondary">
                {currency(Number(selectedTier.course_price ?? 0))} for{" "}
                {Number(selectedTier.course_duration_days ?? 0)} days per
                student.
              </Text>
              <Text type="secondary">
                Grace period:{" "}
                <Text strong>
                  {Number.isFinite(selectedGraceDays)
                    ? selectedGraceDays
                    : DEFAULT_GRACE_DAYS}{" "}
                  days after the course start date
                </Text>
                .
              </Text>
              <MembershipTierBenefits compact tier={selectedTier} />
            </Space>
          )}
          <div>
            <div style={{ marginBottom: "6px", fontWeight: 600 }}>
              Course start date
            </div>
            <DatePicker
              disabled={!selectedTier}
              style={{ width: "100%" }}
              value={courseStartDate.isValid() ? courseStartDate : null}
              onChange={setCourseStartDate}
            />
            <Text type="secondary">
              Student-pay grace days are counted from this date. Set this to the
              first day students should have full course access.
            </Text>
          </div>
          <div>
            <div style={{ marginBottom: "6px", fontWeight: 600 }}>
              Who pays?
            </div>
            <Radio.Group
              value={selectedPayChoice}
              onChange={(e) => setPayChoice(e.target.value)}
              style={{ width: "100%" }}
            >
              <Space direction="vertical" style={{ width: "100%" }}>
                <Radio value="student" disabled={!selectedTier}>
                  {intl.formatMessage({
                    id: "course.student-pay.radio.students-pay",
                    defaultMessage: "Student pays directly",
                  })}
                </Radio>
                <Radio value="institute" disabled={!selectedTier}>
                  Institute or instructor pays directly
                </Radio>
                <Space size="small">
                  <Radio
                    value="site_license"
                    disabled={!selectedTier || !matchingSiteLicense}
                  >
                    Site license
                  </Radio>
                  {selectedTier && !matchingSiteLicense ? (
                    <Popover
                      title="No matching site license found"
                      content={
                        <div style={{ maxWidth: 360 }}>
                          A site license is an institution-managed membership
                          pool that can cover students automatically. Students
                          can still pay directly, or the instructor can buy
                          course seats. If a site license is expected, verify
                          the instructor email domain and confirm the license
                          has available seats.
                        </div>
                      }
                    >
                      <Button type="link" size="small" style={{ padding: 0 }}>
                        <strong>No matching site license found</strong>
                      </Button>
                    </Popover>
                  ) : null}
                </Space>
              </Space>
            </Radio.Group>
          </div>
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
                  option is selected by default for this membership when no
                  other course payment mode has been chosen.
                </>
              }
            />
          ) : null}
          <InstitutePaySection
            project_id={project_id}
            enabled={selectedPayChoice === "institute"}
            showToggle={false}
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
