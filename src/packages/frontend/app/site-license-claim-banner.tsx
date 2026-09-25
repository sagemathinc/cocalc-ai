/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Modal, Popconfirm, Space, Typography } from "antd";
import { lazy, Suspense, useEffect, useState } from "react";

import type { ClaimableMembershipPackage } from "@cocalc/conat/hub/api/purchases";
import {
  normalizeSiteLicenseReminderDismissals,
  SITE_LICENSE_REMINDER_DISMISSALS,
  siteLicenseReminderKey,
} from "@cocalc/frontend/account/site-license-reminder-preferences";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Loading } from "@cocalc/frontend/components";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";
import {
  claimMembershipPackageSeat,
  getClaimableMembershipPackages,
  requestSiteLicensePool,
} from "@cocalc/frontend/purchases/api";
import { is_valid_uuid_string } from "@cocalc/util/misc";

const { Text } = Typography;

const ClaimableMembershipPackagesPanel = lazy(async () => ({
  default: (await import("../account/membership-package-manager"))
    .ClaimableMembershipPackagesPanel,
}));

const REFRESH_MS = 15 * 60 * 1000;
const REMIND_LATER_MS = 7 * 24 * 60 * 60 * 1000;
const INSTRUCTOR_ACTIVITY_MS = 3 * 24 * 60 * 60 * 1000;
const REMIND_LATER_KEY = "site-license-claim-remind-later";
const COURSE_ACTIVITY_KEY = "site-license-course-editor-activity";

export function activeProjectIdForSiteLicenseBanner(
  activeTopTab: string | undefined,
): string {
  return activeTopTab != null && is_valid_uuid_string(activeTopTab)
    ? activeTopTab
    : "";
}

export type CourseRoleHint = "instructor" | "student" | undefined;

function seatStatus(
  opportunity: ClaimableMembershipPackage,
): NonNullable<ClaimableMembershipPackage["seat_status"]> {
  return (
    opportunity.seat_status ??
    (opportunity.pending_request_id ? "pending" : "claimable")
  );
}

function poolSearchText(opportunity: ClaimableMembershipPackage): string {
  return [
    opportunity.pool_name,
    opportunity.pool_description,
    opportunity.membership_class,
    opportunity.metadata?.role,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function siteLicenseOpportunityRoleScore(
  opportunity: ClaimableMembershipPackage,
  roleHint: CourseRoleHint,
): number {
  const text = poolSearchText(opportunity);
  let score = opportunity.requires_approval ? 0 : 5;
  if (roleHint === "instructor") {
    if (/instructor|teacher|faculty|educator/.test(text)) score += 100;
    if (opportunity.requires_approval) score += 15;
  } else if (roleHint === "student") {
    if (/student|learner|pupil/.test(text)) score += 100;
    if (!opportunity.requires_approval) score += 15;
  }
  return score;
}

export function sortSiteLicenseOpportunities(
  opportunities: ClaimableMembershipPackage[],
  roleHint: CourseRoleHint,
): ClaimableMembershipPackage[] {
  return opportunities
    .map((opportunity, index) => ({ opportunity, index }))
    .sort(
      (left, right) =>
        siteLicenseOpportunityRoleScore(right.opportunity, roleHint) -
          siteLicenseOpportunityRoleScore(left.opportunity, roleHint) ||
        left.index - right.index,
    )
    .map(({ opportunity }) => opportunity);
}

export function hasVisibleStudentCourseProject({
  accountId,
  projectMap,
}: {
  accountId?: string;
  projectMap: any;
}): boolean {
  if (!accountId || projectMap == null) return false;
  let found = false;
  projectMap.forEach?.((project: any) => {
    if (found || project?.getIn?.(["users", accountId, "hide"]) === true) {
      return;
    }
    const course = project?.get?.("course");
    if (course == null) return;
    const type = course?.get?.("type") ?? course?.type;
    if (type == null || type === "student") found = true;
  });
  return found;
}

function isCourseEditorTab(activeProjectTab: unknown): boolean {
  if (typeof activeProjectTab !== "string") return false;
  const path = activeProjectTab.startsWith("editor-")
    ? activeProjectTab.slice("editor-".length)
    : activeProjectTab;
  return path.toLowerCase().endsWith(".course");
}

function opportunityFingerprint(
  opportunities: ClaimableMembershipPackage[],
): string {
  return opportunities
    .map(
      (opportunity) =>
        `${siteLicenseReminderKey(opportunity)}:${opportunity.package_id}`,
    )
    .sort()
    .join("|");
}

function isTemporarilyDismissed(
  accountId: string,
  fingerprint: string,
): boolean {
  const dismissedAt = LS.get<number>([
    REMIND_LATER_KEY,
    accountId,
    fingerprint,
  ]);
  return (
    typeof dismissedAt === "number" &&
    Date.now() < dismissedAt + REMIND_LATER_MS
  );
}

function siteLicenseDisplayName(
  opportunities: ClaimableMembershipPackage[],
): string {
  const names = Array.from(
    new Set(
      opportunities
        .flatMap((opportunity) => [
          `${opportunity.organization_name ?? ""}`.trim(),
          `${opportunity.site_license_name ?? ""}`.trim(),
        ])
        .filter(Boolean),
    ),
  );
  return names[0] ?? "Your institution";
}

function primaryActionLabel(
  opportunity: ClaimableMembershipPackage,
  roleHint: CourseRoleHint,
): string {
  const instructorPool = /instructor|teacher|faculty|educator/.test(
    poolSearchText(opportunity),
  );
  if (opportunity.requires_approval) {
    return instructorPool || roleHint === "instructor"
      ? "Request instructor access"
      : "Request access";
  }
  return roleHint === "student" ? "Claim student membership" : "Claim now";
}

export interface SiteLicenseClaimBannerState {
  dismissPermanently: () => void;
  dismissTemporarily: () => void;
  loading: boolean;
  markCompleted: (opportunities: ClaimableMembershipPackage[]) => void;
  opportunities: ClaimableMembershipPackage[];
  roleHint: CourseRoleHint;
  suppressTrial: boolean;
  visible: boolean;
}

export function useSiteLicenseClaimBannerState({
  enabled,
}: {
  enabled: boolean;
}): SiteLicenseClaimBannerState {
  const accountActions = useActions("account");
  const accountId = useTypedRedux("account", "account_id");
  const accountReady = useTypedRedux("account", "is_ready");
  const impersonation = useTypedRedux("account", "impersonation");
  const isLoggedIn = useTypedRedux("account", "is_logged_in");
  const otherSettings = useTypedRedux("account", "other_settings");
  const projectMap = useTypedRedux("projects", "project_map");
  const activeTopTab = useTypedRedux("page", "active_top_tab");
  const activeProjectTab = useTypedRedux(
    { project_id: activeProjectIdForSiteLicenseBanner(activeTopTab) },
    "active_project_tab",
  );
  const [data, setData] = useState<{
    accountId: string;
    rows: ClaimableMembershipPackage[];
  }>();
  const [localDismissedKeys, setLocalDismissedKeys] = useState<string[]>([]);
  const [localCompletedKeys, setLocalCompletedKeys] = useState<string[]>([]);
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string>();
  const [recentInstructorAt, setRecentInstructorAt] = useState<number>();

  const savedDismissals = normalizeSiteLicenseReminderDismissals(
    otherSettings?.get?.(SITE_LICENSE_REMINDER_DISMISSALS),
  );
  const dismissedKeys = new Set([
    ...Object.keys(savedDismissals),
    ...localDismissedKeys,
  ]);

  useEffect(() => {
    setLocalDismissedKeys([]);
    setLocalCompletedKeys([]);
    setDismissedFingerprint(undefined);
    if (!accountId) {
      setRecentInstructorAt(undefined);
      return;
    }
    setRecentInstructorAt(LS.get<number>([COURSE_ACTIVITY_KEY, accountId]));
  }, [accountId]);

  useEffect(() => {
    if (!accountId || !isCourseEditorTab(activeProjectTab)) return;
    const now = Date.now();
    LS.set([COURSE_ACTIVITY_KEY, accountId], now);
    setRecentInstructorAt(now);
  }, [accountId, activeProjectTab]);

  useEffect(() => {
    setData(undefined);
    if (
      !enabled ||
      !accountReady ||
      !isLoggedIn ||
      !accountId ||
      impersonation != null
    ) {
      return;
    }
    let canceled = false;
    let inFlight = false;
    let forceAfterFlight = false;
    let loadedAt = 0;
    const load = async (force = false) => {
      if (canceled) return;
      if (inFlight) {
        forceAfterFlight ||= force;
        return;
      }
      if (!force && Date.now() < loadedAt + REFRESH_MS) return;
      inFlight = true;
      try {
        const rows = await getClaimableMembershipPackages({
          include_claimed_site_license_pools: true,
          site_only: true,
        });
        if (!canceled) setData({ accountId, rows });
      } catch {
        if (!canceled) setData({ accountId, rows: [] });
      } finally {
        loadedAt = Date.now();
        inFlight = false;
        if (forceAfterFlight) {
          forceAfterFlight = false;
          void load(true);
        }
      }
    };
    const onMembershipChanged = () => void load(true);
    const onVisibility = () => {
      if (!document.hidden) void load();
    };
    void load(true);
    window.addEventListener("cocalc:membership-changed", onMembershipChanged);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      canceled = true;
      window.removeEventListener(
        "cocalc:membership-changed",
        onMembershipChanged,
      );
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [accountId, accountReady, enabled, impersonation, isLoggedIn]);

  const allRows = data?.accountId === accountId ? data.rows : [];
  const completedKeys = new Set([
    ...localCompletedKeys,
    ...allRows
      .filter(
        (row) =>
          row.kind === "site" &&
          (seatStatus(row) === "claimed" || seatStatus(row) === "pending"),
      )
      .map(siteLicenseReminderKey),
  ]);
  const availableRows = allRows.filter(
    (row) =>
      row.kind === "site" &&
      seatStatus(row) === "claimable" &&
      !completedKeys.has(siteLicenseReminderKey(row)),
  );
  const actionableRows = availableRows.filter(
    (row) => !dismissedKeys.has(siteLicenseReminderKey(row)),
  );
  const suppressTrial = allRows.some((row) => row.kind === "site");
  const instructorRecent =
    typeof recentInstructorAt === "number" &&
    Date.now() < recentInstructorAt + INSTRUCTOR_ACTIVITY_MS;
  const roleHint: CourseRoleHint = instructorRecent
    ? "instructor"
    : hasVisibleStudentCourseProject({ accountId, projectMap })
      ? "student"
      : undefined;
  const opportunities = sortSiteLicenseOpportunities(actionableRows, roleHint);
  const fingerprint = opportunityFingerprint(opportunities);
  const temporaryDismissal =
    !!accountId &&
    !!fingerprint &&
    (dismissedFingerprint === fingerprint ||
      isTemporarilyDismissed(accountId, fingerprint));
  const visible = opportunities.length > 0 && !temporaryDismissal;

  return {
    suppressTrial,
    loading:
      enabled &&
      !!accountReady &&
      !!isLoggedIn &&
      !!accountId &&
      impersonation == null &&
      data?.accountId !== accountId,
    opportunities,
    roleHint,
    visible,
    markCompleted: (completedOpportunities) => {
      const keys = completedOpportunities.map(siteLicenseReminderKey);
      setLocalCompletedKeys((current) =>
        Array.from(new Set([...current, ...keys])),
      );
    },
    dismissTemporarily: () => {
      if (!accountId || !fingerprint) return;
      LS.set([REMIND_LATER_KEY, accountId, fingerprint], Date.now());
      setDismissedFingerprint(fingerprint);
    },
    dismissPermanently: () => {
      const keys = Array.from(
        new Set(opportunities.map(siteLicenseReminderKey)),
      );
      if (!keys.length) return;
      const next = { ...savedDismissals };
      const now = Date.now();
      for (const key of keys) next[key] = now;
      setLocalDismissedKeys((current) =>
        Array.from(new Set([...current, ...keys])),
      );
      accountActions.set_other_settings(SITE_LICENSE_REMINDER_DISMISSALS, next);
    },
  };
}

export function SiteLicenseClaimBanner({
  state,
}: {
  state: SiteLicenseClaimBannerState;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [manageOpen, setManageOpen] = useState(false);

  if (!state.visible) return null;
  const primary = state.opportunities[0];
  const canActDirectly = !primary.requires_terms_acceptance;
  const institution = siteLicenseDisplayName(state.opportunities);

  async function actDirectly() {
    setBusy(true);
    setError("");
    try {
      if (primary.requires_approval) {
        await requestSiteLicensePool({
          owner_account_id: primary.owner_account_id,
          package_id: primary.package_id,
        });
      } else {
        await claimMembershipPackageSeat({ package_id: primary.package_id });
      }
      state.markCompleted([primary]);
      window.dispatchEvent(new Event("cocalc:membership-changed"));
    } catch (err) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Alert
        banner
        showIcon
        type={error ? "error" : "success"}
        style={{ paddingBlock: 7 }}
        title={
          <Space size="small" wrap>
            <strong>{institution} provides you a CoCalc membership</strong>
            <Text>Use your verified institutional email to activate it.</Text>
            {error ? <Text type="danger">{error}</Text> : null}
            <Button
              size="small"
              type="primary"
              loading={busy}
              onClick={() =>
                canActDirectly ? void actDirectly() : setManageOpen(true)
              }
            >
              {canActDirectly
                ? primaryActionLabel(primary, state.roleHint)
                : "Review membership options"}
            </Button>
            {canActDirectly && state.opportunities.length > 1 ? (
              <Button size="small" onClick={() => setManageOpen(true)}>
                Other membership options
              </Button>
            ) : null}
            <Button
              size="small"
              onClick={() => openAccountSettings({ page: "membership" })}
            >
              Membership page
            </Button>
            <Button size="small" onClick={state.dismissTemporarily}>
              Remind me in 7 days
            </Button>
            <Popconfirm
              title="Stop showing these site-license offers?"
              description="You can restore reminders from Membership settings. New site licenses will still be shown."
              okText="Don't show these offers"
              onConfirm={state.dismissPermanently}
            >
              <Button size="small" type="text">
                Don&apos;t show these offers
              </Button>
            </Popconfirm>
          </Space>
        }
      />
      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setManageOpen(false)}
        open={manageOpen}
        title={`Claim ${institution} membership`}
        width={720}
      >
        <Suspense fallback={<Loading />}>
          <ClaimableMembershipPackagesPanel
            siteOnly
            onChanged={() => {
              setManageOpen(false);
              state.markCompleted(state.opportunities);
              window.dispatchEvent(new Event("cocalc:membership-changed"));
            }}
          />
        </Suspense>
      </Modal>
    </>
  );
}
