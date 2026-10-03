/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import { SidebarNotifications, SidebarStatus } from "./sidebar-status";

let mockNarrow = false;
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "notifications",
}));
jest.mock("@cocalc/frontend/app/context", () => ({
  useAppContext: () => ({ pageStyle: { height: 36, isNarrow: mockNarrow } }),
}));
jest.mock("@cocalc/frontend/account/membership-badge", () => ({
  __esModule: true,
  default: () => <span>membership</span>,
}));
jest.mock("@cocalc/frontend/purchases/balance-button", () => ({
  __esModule: true,
  default: () => <span>balance</span>,
}));
jest.mock("@cocalc/frontend/app/connection-indicator", () => ({
  ConnectionIndicator: ({ hideWhenConnected }) => (
    <span>{hideWhenConnected ? "connection-if-problem" : "connection"}</span>
  ),
}));
jest.mock("@cocalc/frontend/app/fullscreen-button", () => ({
  FullscreenButton: () => <span>fullscreen</span>,
}));
jest.mock("@cocalc/frontend/app/notifications", () => ({
  Notification: ({ active }) => <span>{active ? "bell-active" : "bell"}</span>,
}));
jest.mock("@cocalc/frontend/app/running-gpu-indicator", () => ({
  RunningGpuIndicator: () => <span>gpu</span>,
}));
jest.mock("@cocalc/frontend/appearance/control", () => ({
  AppearanceControl: () => <span>appearance</span>,
}));
jest.mock("@cocalc/frontend/purchases/account-cpu-warning", () => ({
  AccountCpuWarning: () => null,
}));
jest.mock("@cocalc/frontend/purchases/account-storage-warning", () => ({
  AccountStorageWarning: () => null,
}));
jest.mock("@cocalc/frontend/purchases/ai-usage-warning", () => ({
  AIUsageWarning: () => null,
}));
jest.mock("@cocalc/frontend/purchases/managed-egress-warning", () => ({
  ManagedEgressWarning: () => null,
}));

test("the status row carries what the top bar showed on the right", () => {
  render(<SidebarStatus />);
  for (const text of [
    "membership",
    "balance",
    "gpu",
    "connection-if-problem",
    "appearance",
    "fullscreen",
  ])
    expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Account status" })).toBeVisible();
});

test("no full screen control on narrow screens", () => {
  mockNarrow = true;
  render(<SidebarStatus />);
  expect(screen.queryByText("fullscreen")).toBeNull();
  mockNarrow = false;
});

test("notifications show as current on the notifications page", () => {
  render(<SidebarNotifications />);
  expect(screen.getByText("bell-active")).toBeInTheDocument();
});
