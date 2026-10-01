/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
/** Embedded/exam surfaces and the AI opt-out keep their existing navigation. */
export function usesWorkspaceShell({
  lite,
  aiDisabled,
  signedIn,
  examMode,
  fullscreen,
  activeTab,
}: {
  lite: boolean;
  aiDisabled: boolean;
  signedIn: boolean;
  examMode: boolean;
  fullscreen?: string;
  activeTab?: string;
}) {
  return (
    !lite &&
    !aiDisabled &&
    signedIn &&
    !examMode &&
    fullscreen !== "kiosk" &&
    fullscreen !== "project" &&
    activeTab !== "auth"
  );
}
