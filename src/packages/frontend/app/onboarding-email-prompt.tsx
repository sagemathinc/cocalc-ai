/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";
import {
  buildMarketingEmailConsentRecord,
  MARKETING_CONSENT_OTHER_SETTINGS_KEY,
  MARKETING_EMAIL_CONSENT_RECORD_OTHER_SETTINGS_KEY,
  OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
  setOnboardingEmailMode,
  setProductMarketingEmailMode,
} from "@cocalc/util/notification-preferences";
import { COLORS } from "@cocalc/util/theme";
import type { CSS } from "@cocalc/frontend/app-framework";
import { firstRunCompletedThisSession } from "./onboarding-session";

const PROMPT_DELAY_MS = 1_200;

const CONTAINER_STYLE: CSS = {
  position: "fixed",
  right: "16px",
  top: "56px",
  width: "min(430px, calc(100vw - 32px))",
  zIndex: 1100,
} as const;

const CARD_STYLE: CSS = {
  border: `1px solid ${COLORS.GRAY_L}`,
  borderRadius: 10,
  boxShadow: `0 6px 16px ${COLORS.GRAY_L}`,
} as const;

type Eligibility = "unknown" | "saw-zero" | "eligible" | "done";

export function OnboardingEmailPrompt(): React.JSX.Element | null {
  const accountActions = useActions("account");
  const accountId = useTypedRedux("account", "account_id");
  const accountReady = useTypedRedux("account", "is_ready");
  const isLoggedIn = useTypedRedux("account", "is_logged_in");
  const impersonation = useTypedRedux("account", "impersonation");
  const otherSettings = useTypedRedux("account", "other_settings");
  const activeTopTab = useTypedRedux("page", "active_top_tab");
  const fullscreen = useTypedRedux("page", "fullscreen");
  const projectMap = useTypedRedux("projects", "project_map");
  // Offering emailed guides only makes sense where the site sends email
  // (not, e.g., a default CoCalc Star server).
  const siteSendsEmail = !!useTypedRedux("customize", "email_enabled");
  const [visible, setVisible] = useState(false);
  const eligibilityRef = useRef<Eligibility>("unknown");

  const marketingEnabled =
    otherSettings?.get?.(MARKETING_CONSENT_OTHER_SETTINGS_KEY) === true;
  const hasConsentRecord =
    otherSettings?.get?.(MARKETING_EMAIL_CONSENT_RECORD_OTHER_SETTINGS_KEY) !=
    null;

  useEffect(() => {
    eligibilityRef.current = "unknown";
    setVisible(false);
  }, [accountId]);

  useEffect(() => {
    if (!accountReady || !isLoggedIn || projectMap == null) return;
    if (eligibilityRef.current === "done") return;
    if (projectMap.size === 0) {
      if (eligibilityRef.current === "unknown") {
        eligibilityRef.current = "saw-zero";
      }
      return;
    }
    if (eligibilityRef.current === "saw-zero") {
      eligibilityRef.current = "eligible";
    }
  }, [accountReady, isLoggedIn, projectMap]);

  useEffect(() => {
    if (marketingEnabled || hasConsentRecord) {
      eligibilityRef.current = "done";
      setVisible(false);
      return;
    }
    if (
      lite ||
      !siteSendsEmail ||
      !accountReady ||
      !isLoggedIn ||
      impersonation != null ||
      fullscreen ||
      firstRunCompletedThisSession() ||
      eligibilityRef.current !== "eligible" ||
      typeof activeTopTab !== "string" ||
      projectMap?.has?.(activeTopTab) !== true
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (eligibilityRef.current !== "eligible") return;
      eligibilityRef.current = "done";
      setVisible(true);
    }, PROMPT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    accountReady,
    activeTopTab,
    fullscreen,
    hasConsentRecord,
    impersonation,
    isLoggedIn,
    marketingEnabled,
    projectMap,
    siteSendsEmail,
  ]);

  function respond(enabled: boolean): void {
    accountActions.set_other_settings_many({
      [MARKETING_CONSENT_OTHER_SETTINGS_KEY]: enabled,
      [MARKETING_EMAIL_CONSENT_RECORD_OTHER_SETTINGS_KEY]:
        buildMarketingEmailConsentRecord({
          enabled,
          source: "first-project-open",
        }),
      [OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY]: setOnboardingEmailMode(
        setProductMarketingEmailMode(
          otherSettings?.get?.(OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY),
          enabled,
        ),
        enabled,
      ),
    });
    setVisible(false);
  }

  if (!visible || fullscreen) return null;

  return (
    <div
      aria-label="Email onboarding offer"
      aria-live="polite"
      role="region"
      style={CONTAINER_STYLE}
    >
      <Card size="small" style={CARD_STYLE}>
        <Space vertical size="small">
          <Typography.Title level={4} style={{ margin: 0 }}>
            Get productive with CoCalc faster
          </Typography.Title>
          <Typography.Paragraph style={{ margin: 0 }}>
            Receive short email guides covering projects, Jupyter,
            collaboration, and new features.
          </Typography.Paragraph>
          <Space wrap>
            <Button type="primary" onClick={() => respond(true)}>
              Email me guides
            </Button>
            <Button onClick={() => respond(false)}>No thanks</Button>
          </Space>
          <Typography.Text type="secondary">
            Unsubscribe anytime in Communication settings.
          </Typography.Text>
        </Space>
      </Card>
    </div>
  );
}
