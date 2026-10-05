/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { headerColors } from "@cocalc/frontend/components/header-colors";
import type { ThreadMetadataSnapshot } from "@cocalc/frontend/chat/actions";
import { deriveThreadLabel } from "@cocalc/frontend/chat/threads";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

export type AgentHeaderAppearance = Pick<
  ThreadMetadataSnapshot,
  | "name"
  | "thread_color"
  | "thread_accent_color"
  | "thread_icon"
  | "thread_image"
>;

export function sameAgentHeaderAppearance(
  left: AgentHeaderAppearance | undefined,
  right: AgentHeaderAppearance,
): boolean {
  return (
    left?.name === right.name &&
    left?.thread_color === right.thread_color &&
    left?.thread_accent_color === right.thread_accent_color &&
    left?.thread_icon === right.thread_icon &&
    left?.thread_image === right.thread_image
  );
}

export function resolveAgentHeaderTheme({
  appearance,
  fallbackTitle,
}: {
  appearance?: AgentHeaderAppearance;
  fallbackTitle: string;
}) {
  const accentColor = appearance?.thread_accent_color?.trim() || undefined;
  const primaryColor = appearance?.thread_color?.trim() || undefined;
  return {
    accentColor,
    primaryColor,
    ...headerColors({ primaryColor, accentColor }),
    title: appearance?.name?.trim() || fallbackTitle,
  };
}

export function resolveNamedAgentTheme(
  agent: Pick<NamedAgent, "name" | "thread_title">,
  appearance?: AgentHeaderAppearance,
) {
  return resolveAgentHeaderTheme({
    appearance,
    fallbackTitle: agent.thread_title || `@${agent.name}`,
  });
}

export function readAgentThreadAppearance(
  actions: any,
  threadId: string,
): AgentHeaderAppearance {
  const lookupKey =
    actions?.messageCache?.getThreadKeyByThreadId?.(threadId) ?? threadId;
  const metadata = actions?.getThreadMetadata?.(lookupKey, { threadId });
  const rootMessage = actions
    ?.getThreadIndex?.()
    ?.get?.(lookupKey)?.rootMessage;
  return {
    name:
      metadata?.name?.trim() ||
      (rootMessage ? deriveThreadLabel(rootMessage, lookupKey) : undefined),
    thread_color: metadata?.thread_color,
    thread_accent_color: metadata?.thread_accent_color,
    thread_icon: metadata?.thread_icon,
    thread_image: metadata?.thread_image,
  };
}

export {
  autoThemeColor,
  themeIdentityColor,
} from "@cocalc/frontend/components/identity-color";
