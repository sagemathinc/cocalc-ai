/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The browser tab title for the Agents page: the open agent's title (as its
// header shows it, which people rename to say what the agent is doing), so
// several agent tabs can be told apart. Kept here so switching back to the
// Agents tab restores it instead of a generic "Agents".
let current: string | undefined;

export function agentsWindowTitle(): string {
  return current || "Agents";
}

export function setAgentsWindowTitle(title: string | undefined): void {
  current = title?.trim() || undefined;
}

/** The open agent's title: its header title, else thread title, else @name. */
export function agentWindowTitle(agent: {
  name: string;
  thread_title?: string;
  headerTitle?: string;
}): string {
  return (
    agent.headerTitle?.trim() || agent.thread_title?.trim() || `@${agent.name}`
  );
}
