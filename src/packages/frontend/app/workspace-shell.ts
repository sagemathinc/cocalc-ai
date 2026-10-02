/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
/** Everything signed in except embedded, exam and Lite surfaces. */
export function usesWorkspaceShell({
  lite,
  signedIn,
  examMode,
  fullscreen,
  activeTab,
}: {
  lite: boolean;
  signedIn: boolean;
  examMode: boolean;
  fullscreen?: string;
  activeTab?: string;
}) {
  return (
    !lite &&
    signedIn &&
    !examMode &&
    fullscreen !== "kiosk" &&
    fullscreen !== "project" &&
    activeTab !== "auth"
  );
}
