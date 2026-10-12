/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Fenced blocks CoCalc writes that render as their own elements instead of
// code: human guidance, an agent's message, a sensor's wake. Both code-block
// registrations (the editor's and the public viewer's) use this one list, so
// a new kind cannot be recognized by one and shown as raw code by the other.

import type { Element } from "slate";
import { guidanceFromMarkdownFence } from "./guidance";
import { agentMessageFromMarkdownFence } from "./agent-message";
import { sensorWakeFromMarkdownFence } from "./sensor-wake";

export function specialFenceElement(fence: {
  info: string;
  value: string;
}): Element | undefined {
  return (guidanceFromMarkdownFence(fence) ??
    agentMessageFromMarkdownFence(fence) ??
    sensorWakeFromMarkdownFence(fence)) as Element | undefined;
}
