/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Space, Typography } from "antd";
import { useEffect, useState } from "react";

import { Panel } from "@cocalc/frontend/antd-bootstrap";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import {
  COOKIE_CATEGORIES,
  getConsentSnapshot,
  onConsentChange,
  showPreferences,
  type ConsentSnapshot,
} from "@cocalc/frontend/cookie-consent";
import { COLORS } from "@cocalc/util/theme";

const { Text } = Typography;

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return timestamp;
  return date.toLocaleString();
}

function CategoryStatus({
  accepted,
  label,
}: {
  accepted: boolean;
  label: string;
}) {
  return (
    <div>
      <Icon
        name={accepted ? "check-square" : "minus-square"}
        style={{ color: accepted ? COLORS.BS_GREEN_D : COLORS.BS_RED }}
      />{" "}
      {label}
    </div>
  );
}

export function CookieConsentSettings(): React.JSX.Element | null {
  const cookieBannerEnabled = useTypedRedux(
    "customize",
    "cookie_banner_enabled",
  );
  const [snap, setSnap] = useState<ConsentSnapshot | null>(() =>
    getConsentSnapshot(),
  );

  useEffect(() => onConsentChange(setSnap), []);

  if (!cookieBannerEnabled) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <Panel
        size="small"
        header={
          <>
            <Icon name="lock" /> Cookie preferences
          </>
        }
      >
        {snap == null ? (
          <Alert
            type="warning"
            showIcon
            message="You have not yet acknowledged the cookie banner."
          />
        ) : (
          <Space vertical size="small" style={{ width: "100%" }}>
            {COOKIE_CATEGORIES.map((category) => (
              <CategoryStatus
                key={category.key}
                accepted={!!snap[category.key]}
                label={category.label}
              />
            ))}
            {snap.timestamp && (
              <Text type="secondary">
                Last updated: {formatTimestamp(snap.timestamp)}
              </Text>
            )}
          </Space>
        )}
        <div style={{ marginTop: 12 }}>
          <Button onClick={() => showPreferences()}>
            <Icon name="cog" /> Manage cookie preferences
          </Button>
        </div>
      </Panel>
    </div>
  );
}
