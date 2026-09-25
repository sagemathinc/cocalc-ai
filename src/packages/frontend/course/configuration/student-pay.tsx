import {
  Alert,
  Button,
  Card,
  Checkbox,
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
import { Icon } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { openProjectDocs } from "@cocalc/frontend/docs/navigation";
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

export default function StudentPay({
  actions,
  settings,
  project_id,
  onManageSeats,
  onOpenComputeBudget,
}) {
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
  const siteLicenseChoices = useMemo(() => {
    const byTier = new Map<string, ClaimableMembershipPackage>();
    const packages = claimablePackages
      .filter(
        (membershipPackage) =>
          membershipPackage.kind === "site" &&
          !membershipPackage.requires_approval &&
          tierById.has(membershipPackage.membership_class),
      )
      .sort((left, right) => {
        const leftPriority = tierById.get(left.membership_class)?.priority ?? 0;
        const rightPriority =
          tierById.get(right.membership_class)?.priority ?? 0;
        return (
          leftPriority - rightPriority ||
          left.package_id.localeCompare(right.package_id)
        );
      });
    for (const membershipPackage of packages) {
      if (!byTier.has(membershipPackage.membership_class)) {
        byTier.set(membershipPackage.membership_class, membershipPackage);
      }
    }
    return Array.from(byTier.values());
  }, [claimablePackages, tierById]);
  const matchingSiteLicense =
    siteLicenseChoices.find(
      (membershipPackage) =>
        membershipPackage.membership_class === selectedTierId,
    ) ?? null;
  const matchingSiteLicenseTier = matchingSiteLicense
    ? (tierById.get(matchingSiteLicense.membership_class) ?? null)
    : null;
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
  const computeBudgetEnabled = !!settings?.get("compute_budget_enabled");

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
    const tier = tierById.get(required_membership_class);
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
    if (value === "site_license" && !matchingSiteLicense) {
      const defaultSiteLicense = siteLicenseChoices[0];
      if (defaultSiteLicense) {
        setSelectedTier(defaultSiteLicense.membership_class);
      }
    } else if (value !== "site_license" && !selectedTier) {
      const defaultCourseTier = courseTiers[0];
      if (defaultCourseTier) {
        setSelectedTier(defaultCourseTier.id);
      }
    }
    actions.configuration.set_pay_choice(value, true);
    actions.configuration.configure_all_projects();
  }

  function siteLicenseChoiceLabel(
    membershipPackage: ClaimableMembershipPackage,
  ) {
    const tier = tierById.get(membershipPackage.membership_class);
    const poolName =
      `${membershipPackage.pool_name ?? ""}`.trim() ||
      tier?.label ||
      membershipPackage.membership_class;
    const organization = `${
      membershipPackage.organization_name ??
      membershipPackage.site_license_name ??
      ""
    }`.trim();
    return organization ? `${poolName} - ${organization}` : poolName;
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
          (
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            onClick={() =>
              openProjectDocs({
                projectId: project_id,
                slug: "teaching/student-pay",
              })
            }
          >
            Docs
          </Button>
          )
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
        <Space vertical size="middle" style={{ width: "100%" }}>
          <div>
            <div style={{ marginBottom: "6px", fontWeight: 600 }}>
              Who pays?
            </div>
            <Radio.Group
              aria-label="Who pays?"
              value={selectedPayChoice}
              onChange={(e) => setPayChoice(e.target.value)}
              style={{ width: "100%" }}
            >
              <Space vertical style={{ width: "100%" }}>
                <Radio value="student">
                  {intl.formatMessage({
                    id: "course.student-pay.radio.students-pay",
                    defaultMessage: "Student pays directly",
                  })}
                </Radio>
                <Radio value="institute">
                  Institute or instructor pays directly
                </Radio>
                <Space size="small">
                  <Radio
                    value="site_license"
                    disabled={siteLicenseChoices.length === 0}
                  >
                    Site license
                  </Radio>
                  {siteLicenseChoices.length === 0 ? (
                    <Popover
                      title="No matching site license found"
                      content={
                        <div style={{ maxWidth: 360 }}>
                          A site license is an institution-managed membership
                          pool that can cover students automatically. Students
                          can still pay directly, or the instructor can buy
                          course seats. If a site license is expected, verify
                          the instructor email domain and confirm the license
                          has an automatically claimable student pool with
                          available seats.
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
          {selectedPayChoice === "site_license" ? (
            <Space vertical size="middle" style={{ width: "100%" }}>
              <div>
                <div style={{ marginBottom: "6px", fontWeight: 600 }}>
                  Site license student membership
                </div>
                <Select
                  aria-label="Site license student membership"
                  style={{ width: "100%" }}
                  value={matchingSiteLicense?.membership_class}
                  onChange={setSelectedTier}
                  options={siteLicenseChoices.map((membershipPackage) => ({
                    value: membershipPackage.membership_class,
                    label: siteLicenseChoiceLabel(membershipPackage),
                  }))}
                />
              </div>
              {matchingSiteLicense ? (
                <>
                  <Alert
                    type="success"
                    showIcon
                    title="Students are covered by the site license"
                    description={
                      <Space vertical size="small">
                        <span>
                          Students with a matching verified institutional email
                          can claim the{" "}
                          <strong>
                            {matchingSiteLicenseTier?.label ??
                              matchingSiteLicense.membership_class}
                          </strong>{" "}
                          membership from{" "}
                          <strong>
                            {matchingSiteLicense.organization_name ??
                              matchingSiteLicense.site_license_name ??
                              "this site license"}
                          </strong>
                          .
                        </span>
                        <span>
                          The retail course-seat price and duration do not
                          apply. Access follows the site-license term and
                          affiliation verification policy.
                        </span>
                        {matchingSiteLicense.expires_at ? (
                          <span>
                            Current site-license term ends{" "}
                            <strong>
                              {dayjs(matchingSiteLicense.expires_at).format(
                                "MMMM D, YYYY",
                              )}
                            </strong>
                            .
                          </span>
                        ) : null}
                      </Space>
                    }
                  />
                  {matchingSiteLicenseTier ? (
                    <MembershipTierBenefits
                      compact
                      tier={matchingSiteLicenseTier}
                    />
                  ) : null}
                </>
              ) : null}
            </Space>
          ) : selectedPayChoice ? (
            <Space vertical size="middle" style={{ width: "100%" }}>
              <div>
                <div style={{ marginBottom: "6px", fontWeight: 600 }}>
                  Required student course membership
                </div>
                <Select
                  aria-label="Required student course membership"
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
              {selectedTier ? (
                <Space vertical size="small" style={{ width: "100%" }}>
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
              ) : null}
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
                  Student-pay grace days are counted from this date. Set this to
                  the first day students should have full course access.
                </Text>
              </div>
              <InstitutePaySection
                project_id={project_id}
                enabled={selectedPayChoice === "institute"}
                showToggle={false}
                selectedTier={selectedTier}
                onManageSeats={onManageSeats}
                onToggle={(checked) => {
                  actions.configuration.set_pay_choice("institute", checked);
                  if (checked) {
                    actions.configuration.configure_all_projects();
                  }
                }}
              />
            </Space>
          ) : null}
        </Space>
      )}
      <div style={{ marginTop: 16 }}>
        <Checkbox
          checked={computeBudgetEnabled}
          onChange={(event) =>
            actions.configuration.set_compute_budget_enabled(
              event.target.checked,
            )
          }
        >
          Enable compute budget for this course
        </Checkbox>
        {computeBudgetEnabled && (
          <Button
            type="link"
            style={{ paddingInline: 8 }}
            onClick={onOpenComputeBudget}
          >
            Open compute budget
          </Button>
        )}
      </div>
    </Card>
  );
}
