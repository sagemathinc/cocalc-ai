/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Space, Tag, Typography } from "antd";
import { useEffect, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  COOKIE_CATEGORIES,
  getConsentSnapshot,
  onConsentChange,
  showPreferences,
  type ConsentSnapshot,
} from "@cocalc/frontend/cookie-consent";

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
    <Space>
      <Text>{label}</Text>
      <Tag color={accepted ? "green" : undefined}>
        {accepted ? "Accepted" : "Off"}
      </Tag>
    </Space>
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
    <Card title="Cookie preferences">
      <Space vertical style={{ width: "100%" }}>
        {snap == null ? (
          <Alert
            type="warning"
            showIcon
            message="You have not yet acknowledged the cookie banner."
          />
        ) : (
          COOKIE_CATEGORIES.map((category) => (
            <CategoryStatus
              key={category.key}
              accepted={!!snap[category.key]}
              label={category.label}
            />
          ))
        )}
        <Button onClick={() => showPreferences()}>Manage</Button>
        {snap?.timestamp && (
          <Text type="secondary">
            Last updated: {formatTimestamp(snap.timestamp)}
          </Text>
        )}
      </Space>
    </Card>
  );
}
