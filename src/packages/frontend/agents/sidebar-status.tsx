/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// With sidebar navigation, the controls that used to sit on the right of the
// top bar live at the sidebar's edges: notifications in its header, and
// account status (membership, balance, warnings, connection, appearance,
// full screen) just above the account menu.

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import MembershipBadge from "@cocalc/frontend/account/membership-badge";
import { useAppContext } from "@cocalc/frontend/app/context";
import { ConnectionIndicator } from "@cocalc/frontend/app/connection-indicator";
import { FullscreenButton } from "@cocalc/frontend/app/fullscreen-button";
import { Notification } from "@cocalc/frontend/app/notifications";
import { RunningGpuIndicator } from "@cocalc/frontend/app/running-gpu-indicator";
import { AppearanceControl } from "@cocalc/frontend/appearance/control";
import { AccountCpuWarning } from "@cocalc/frontend/purchases/account-cpu-warning";
import { AccountStorageWarning } from "@cocalc/frontend/purchases/account-storage-warning";
import { AIUsageWarning } from "@cocalc/frontend/purchases/ai-usage-warning";
import BalanceButton from "@cocalc/frontend/purchases/balance-button";
import { ManagedEgressWarning } from "@cocalc/frontend/purchases/managed-egress-warning";

export function SidebarNotifications() {
  const { pageStyle } = useAppContext();
  const active = useTypedRedux("page", "active_top_tab") === "notifications";
  return (
    <Notification type="notifications" active={active} pageStyle={pageStyle} />
  );
}

export function SidebarStatus() {
  const { pageStyle } = useAppContext();
  return (
    <div
      role="group"
      aria-label="Account status"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 4,
        padding: "0 4px 4px 6px",
      }}
    >
      <MembershipBadge />
      <RunningGpuIndicator />
      <BalanceButton minimal topBar />
      <AIUsageWarning pageStyle={pageStyle} />
      <AccountCpuWarning pageStyle={pageStyle} />
      <AccountStorageWarning pageStyle={pageStyle} />
      <ManagedEgressWarning pageStyle={pageStyle} />
      <ConnectionIndicator
        height={pageStyle.height}
        hideWhenConnected
        pageStyle={pageStyle}
      />
      <span style={{ flex: 1 }} />
      <AppearanceControl compact />
      {!pageStyle.isNarrow && <FullscreenButton pageStyle={pageStyle} />}
    </div>
  );
}
