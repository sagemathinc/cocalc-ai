/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A turn a sensor started (a wake, a scheduled prompt or a reminder), shown
// as one compact line that expands to the full prompt the agent received.

import { useState } from "react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { markdown_to_slate } from "../markdown-to-slate";
import {
  register,
  type RenderElementProps,
  type SlateElement,
} from "./register";

export type SensorWakeKind = "wake" | "prompt" | "reminder";

export interface SensorWake extends SlateElement {
  type: "sensor-wake";
  kind: SensorWakeKind;
  title: string;
  summary: string;
}

const KIND_LABEL: Record<SensorWakeKind, string> = {
  wake: "Sensor",
  prompt: "Scheduled prompt",
  reminder: "Reminder",
};

function decoded(value: string, max: number): string | undefined {
  try {
    const text = decodeURIComponent(value).replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  } catch {
    return;
  }
}

export function sensorWakeFromMarkdownFence({
  info,
  value,
}: {
  info: string;
  value: string;
}): SensorWake | undefined {
  const [kindToken, ...tokens] = info.trim().split(/\s+/);
  if (kindToken.toLowerCase() !== "sensor-wake") return;
  let kind: SensorWakeKind = "wake";
  let title = "";
  let summary = "";
  for (const token of tokens) {
    const [key, raw = ""] = token.split("=", 2);
    if (
      key === "kind" &&
      (raw === "wake" || raw === "prompt" || raw === "reminder")
    )
      kind = raw;
    else if (key === "title") title = decoded(raw, 100) ?? "";
    else if (key === "summary") summary = decoded(raw, 500) ?? "";
    else return;
  }
  return {
    type: "sensor-wake",
    kind,
    title,
    summary,
    children: markdown_to_slate(value, true),
  };
}

/** The fence message.tsx wraps a sensor's turn in. */
export function sensorWakeFence({
  kind,
  title,
  summary,
  value,
}: {
  kind: SensorWakeKind;
  title: string;
  summary: string;
  value: string;
}): string {
  let fence = "```";
  while (value.includes(fence)) fence += "`";
  const info = [
    "sensor-wake",
    `kind=${kind}`,
    title ? `title=${encodeURIComponent(title)}` : undefined,
    summary ? `summary=${encodeURIComponent(summary)}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `${fence}${info}\n${value}\n${fence}`;
}

export function SensorWakeElement({
  attributes,
  children,
  element,
}: RenderElementProps) {
  const [expanded, setExpanded] = useState(false);
  if (element.type !== "sensor-wake")
    throw new Error("Expected sensor-wake element");
  const wake = element as SensorWake;
  const label = KIND_LABEL[wake.kind] ?? "Sensor";
  return (
    <section
      {...attributes}
      aria-label={`${label}: ${wake.title}`}
      className="cocalc-slate-sensor-wake"
      style={{
        margin: "6px 0",
        padding: "6px 8px",
        borderRadius: 9,
        background: UI_COLORS.surface,
        color: UI_COLORS.text,
        border: `1px solid ${UI_COLORS.border}`,
        display: "flex",
        alignItems: "center",
        gap: 7,
        flexWrap: "wrap",
      }}
    >
      <span
        contentEditable={false}
        style={{
          color: UI_COLORS.info,
          fontSize: 13,
          fontWeight: 650,
          whiteSpace: "nowrap",
          flex: "0 0 auto",
          maxWidth: "45%",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
        {wake.title ? ` · ${wake.title}` : ""}
      </span>
      <span
        contentEditable={false}
        aria-hidden="true"
        style={{ color: UI_COLORS.muted }}
      >
        :
      </span>
      <span
        contentEditable={false}
        style={{
          flex: "1 1 200px",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {wake.summary}
      </span>
      <button
        type="button"
        contentEditable={false}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        style={{
          appearance: "none",
          border: 0,
          background: "transparent",
          color: UI_COLORS.link,
          cursor: "pointer",
          padding: "4px 6px",
        }}
      >
        {expanded ? "Hide details" : "Show details"}
      </button>
      <div
        className="cocalc-slate-sensor-wake-body"
        style={{
          display: expanded ? "block" : "none",
          flex: "1 0 100%",
          maxHeight: "55vh",
          overflow: "auto",
          overflowWrap: "anywhere",
        }}
      >
        {children}
      </div>
    </section>
  );
}

register({
  slateType: "sensor-wake",
  Element: SensorWakeElement,
  StaticElement: SensorWakeElement,
  fromSlate: ({ children, node }) =>
    `${sensorWakeFence({
      kind: node.kind,
      title: node.title ?? "",
      summary: node.summary ?? "",
      value: children.trimEnd(),
    })}\n\n`,
});
