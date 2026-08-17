/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Alert, Button, Space, Typography } from "antd";

import { React, useState } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import type { HostRecoveryDisplay } from "@cocalc/frontend/projects/host-operational";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text } = Typography;

interface HostRecoveryBannerProps {
  assignedHostLabel: string;
  canReconnectAutomatically: boolean;
  hostUnavailableReason: string;
  onCheckStatus: () => Promise<void>;
  recovery: HostRecoveryDisplay;
}

export function HostRecoveryBanner({
  assignedHostLabel,
  canReconnectAutomatically,
  hostUnavailableReason,
  onCheckStatus,
  recovery,
}: HostRecoveryBannerProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [checkingHost, setCheckingHost] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const detailsId = React.useId();
  const startedAt = recovery.startedAt
    ? new Date(recovery.startedAt)
    : undefined;

  async function checkStatus(): Promise<void> {
    try {
      setCheckingHost(true);
      setCheckError(undefined);
      await onCheckStatus();
    } catch {
      setCheckError(
        "Status could not be refreshed just now. CoCalc will keep retrying automatically.",
      );
    } finally {
      setCheckingHost(false);
    }
  }

  return (
    <Alert
      banner
      showIcon
      style={{ padding: "10px 16px" }}
      title={
        <div style={{ maxWidth: 840, width: "100%" }}>
          <div
            style={{
              alignItems: "center",
              columnGap: 20,
              display: "flex",
              flexWrap: "wrap",
              rowGap: 6,
            }}
          >
            <div style={{ flex: "1 1 360px", minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>
                {canReconnectAutomatically
                  ? "Reconnecting to your project"
                  : "Project host is unavailable"}
              </div>
              <Space
                size={7}
                split={<span aria-hidden="true">·</span>}
                style={{ fontSize: 12, marginTop: 2 }}
                wrap
              >
                {canReconnectAutomatically ? (
                  <Text style={{ color: COLORS.ANTD_GREEN_D }}>
                    <Icon name="check-circle" /> Saved files are safe
                  </Text>
                ) : (
                  <Text type="danger">
                    <Icon name="exclamation-triangle" /> Automatic reconnection
                    is not possible
                  </Text>
                )}
                <Text type="secondary">
                  {!canReconnectAutomatically ? (
                    `${assignedHostLabel}: ${hostUnavailableReason}`
                  ) : startedAt ? (
                    <>
                      Started{" "}
                      <TimeAgo click_to_toggle={false} date={startedAt} live />
                    </>
                  ) : (
                    "Recovery is in progress"
                  )}
                </Text>
              </Space>
            </div>
            <Button
              aria-controls={detailsId}
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
              size="small"
              type="text"
            >
              {canReconnectAutomatically
                ? "What's happening?"
                : "What can I do?"}{" "}
              <Icon name={detailsOpen ? "chevron-up" : "chevron-down"} />
            </Button>
          </div>

          {canReconnectAutomatically ? (
            <div
              aria-label="Project reconnection is in progress"
              role="progressbar"
              style={{
                background: COLORS.ANTD_BG_BLUE_L,
                borderRadius: 4,
                height: 6,
                marginTop: 8,
                maxWidth: 520,
                overflow: "hidden",
                width: "100%",
              }}
            >
              <div
                className="cocalc-indeterminate-progress"
                style={{
                  background: COLORS.ANTD_LINK_BLUE,
                  borderRadius: 4,
                  height: "100%",
                  width: "45%",
                }}
              />
            </div>
          ) : null}

          {detailsOpen ? (
            <div
              id={detailsId}
              style={{
                borderTop: `1px solid ${COLORS.GRAY_LL}`,
                lineHeight: 1.5,
                marginTop: 10,
                maxWidth: 760,
                paddingTop: 10,
              }}
            >
              <Text strong>
                {!canReconnectAutomatically
                  ? `CoCalc cannot reconnect automatically to ${assignedHostLabel}.`
                  : recovery.active
                    ? (recovery.title ??
                      "CoCalc is reconnecting automatically.")
                    : "CoCalc is reconnecting automatically."}
              </Text>
              <Paragraph style={{ margin: "3px 0 5px", maxWidth: 720 }}>
                {!canReconnectAutomatically ? (
                  <>
                    Start the assigned host if it still exists, or open Project
                    Settings and move this project to an available host. If the
                    old host was deleted, moving restores the latest available
                    backup; changes newer than that backup are not available
                    from the deleted disk.
                  </>
                ) : recovery.active ? (
                  <>
                    {recovery.description ??
                      "CoCalc is restoring the computer running this project."}{" "}
                  </>
                ) : (
                  <>
                    CoCalc temporarily lost contact with the computer running
                    this project and is reconnecting automatically.{" "}
                  </>
                )}
                Editing, terminals, and notebooks will resume when the
                connection is restored.
              </Paragraph>
              {canReconnectAutomatically && recovery.timingDescription ? (
                <Paragraph style={{ margin: "0 0 6px", maxWidth: 720 }}>
                  {recovery.timingDescription}
                </Paragraph>
              ) : null}
              {startedAt ? (
                <div style={{ fontSize: 12 }}>
                  <Text type="secondary">
                    Connection lost at {startedAt.toLocaleString()}.
                  </Text>
                </div>
              ) : null}
              {canReconnectAutomatically && !recovery.active ? (
                <div style={{ fontSize: 12, marginTop: 2 }}>
                  <Text type="secondary">
                    Technical status: {assignedHostLabel}:{" "}
                    {hostUnavailableReason}
                  </Text>
                </div>
              ) : null}
              <Button
                loading={checkingHost}
                onClick={checkStatus}
                size="small"
                style={{ marginTop: 8 }}
              >
                <Icon name="refresh" /> Check again
              </Button>
              {checkError ? (
                <div style={{ marginTop: 5 }}>
                  <Text type="danger">{checkError}</Text>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      }
      type={canReconnectAutomatically ? "warning" : "error"}
    />
  );
}
