/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A turn a sensor started (a wake, a scheduled prompt or a reminder), shown
// as one compact line that expands to the full prompt the agent received.

import { InfoCircleOutlined } from "@ant-design/icons";
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
  /** The sensor and when it ran, for the details. */
  sensor_id?: string;
  at?: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  let sensor_id: string | undefined;
  let at: string | undefined;
  for (const token of tokens) {
    const [key, raw = ""] = token.split("=", 2);
    if (
      key === "kind" &&
      (raw === "wake" || raw === "prompt" || raw === "reminder")
    )
      kind = raw;
    else if (key === "title") title = decoded(raw, 100) ?? "";
    else if (key === "summary") summary = decoded(raw, 500) ?? "";
    else if (key === "sensor" && UUID.test(raw)) sensor_id = raw;
    else if (key === "at" && !Number.isNaN(Date.parse(raw))) at = raw;
    else return;
  }
  return {
    type: "sensor-wake",
    kind,
    title,
    summary,
    ...(sensor_id ? { sensor_id } : {}),
    ...(at ? { at } : {}),
    children: markdown_to_slate(value, true),
  };
}

/** The fence message.tsx wraps a sensor's turn in. */
export function sensorWakeFence({
  kind,
  title,
  summary,
  sensor_id,
  at,
  value,
}: {
  kind: SensorWakeKind;
  title: string;
  summary: string;
  sensor_id?: string;
  at?: string;
  value: string;
}): string {
  let fence = "```";
  while (value.includes(fence)) fence += "`";
  const info = [
    "sensor-wake",
    `kind=${kind}`,
    title ? `title=${encodeURIComponent(title)}` : undefined,
    summary ? `summary=${encodeURIComponent(summary)}` : undefined,
    sensor_id && UUID.test(sensor_id) ? `sensor=${sensor_id}` : undefined,
    at && !Number.isNaN(Date.parse(at)) ? `at=${at}` : undefined,
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
  const [info, setInfo] = useState(false);
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
        {expanded ? "Hide" : wake.kind === "wake" ? "Read wake" : "Read prompt"}
      </button>
      <button
        type="button"
        contentEditable={false}
        aria-label={info ? "Hide sensor details" : "Sensor details"}
        aria-expanded={info}
        title={info ? "Hide sensor details" : "Sensor details"}
        onClick={() => setInfo((value) => !value)}
        style={{
          appearance: "none",
          border: 0,
          borderRadius: 6,
          padding: 4,
          background: "transparent",
          color: UI_COLORS.secondary,
          cursor: "pointer",
          lineHeight: 1,
          flex: "0 0 auto",
        }}
      >
        <InfoCircleOutlined />
      </button>
      {info && (
        <div
          contentEditable={false}
          style={{
            flex: "1 0 100%",
            color: UI_COLORS.secondary,
            background: UI_COLORS.inset,
            borderRadius: 8,
            padding: "9px 10px",
            fontSize: 12,
            lineHeight: 1.45,
            overflowWrap: "anywhere",
          }}
        >
          <div>
            Started by {wake.kind === "reminder" ? "a reminder" : "a sensor"}
            {wake.title ? ` ("${wake.title}")` : ""}
            {wake.at ? `, ${new Date(wake.at).toLocaleString()}` : ""}: not a
            message from a person.
          </div>
          {wake.sensor_id && (
            <div style={{ marginTop: 4 }}>
              Manage it in this agent's Sensors dialog, or with{" "}
              <code>cocalc sensor show {wake.sensor_id}</code>.
            </div>
          )}
        </div>
      )}
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
      sensor_id: node.sensor_id,
      at: node.at,
      value: children.trimEnd(),
    })}\n\n`,
});
