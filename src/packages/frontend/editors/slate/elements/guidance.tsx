/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { LoadingOutlined } from "@ant-design/icons";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { markdown_to_slate } from "../markdown-to-slate";
import { register, type SlateElement } from "./register";

export type GuidanceState = "sending" | "sent" | "queued" | "not-sent";

export interface Guidance extends SlateElement {
  type: "guidance";
  state?: GuidanceState;
}

const GUIDANCE_STATES = new Set<GuidanceState>([
  "sending",
  "sent",
  "queued",
  "not-sent",
]);

export function guidanceFromMarkdownFence({
  info,
  value,
}: {
  info: string;
  value: string;
}): Guidance | undefined {
  const parts = info.trim().split(/\s+/);
  if (parts[0]?.toLowerCase() !== "guidance") return;
  const requestedState = parts[1]?.toLowerCase() as GuidanceState | undefined;
  const state =
    requestedState != null && GUIDANCE_STATES.has(requestedState)
      ? requestedState
      : "sent";
  return {
    type: "guidance",
    state,
    children: markdown_to_slate(value, true),
  };
}

function guidanceAppearance(state: GuidanceState | undefined) {
  switch (state) {
    case "sending":
      return {
        label: "Sending guidance",
        borderColor: UI_COLORS.infoBg,
        background: UI_COLORS.infoBg,
        pillBackground: UI_COLORS.infoBg,
        pillColor: UI_COLORS.info,
      };
    case "queued":
      return {
        label: "Guidance queued",
        borderColor: UI_COLORS.warningBg,
        background: UI_COLORS.warningBg,
        pillBackground: UI_COLORS.warningBg,
        pillColor: UI_COLORS.warning,
      };
    case "not-sent":
      return {
        label: "Guidance not sent",
        borderColor: UI_COLORS.dangerBg,
        background: UI_COLORS.dangerBg,
        pillBackground: UI_COLORS.dangerBg,
        pillColor: UI_COLORS.danger,
      };
    default:
      return {
        label: "Guidance sent",
        borderColor: UI_COLORS.infoBg,
        background: UI_COLORS.infoBg,
        pillBackground: UI_COLORS.infoBg,
        pillColor: UI_COLORS.info,
      };
  }
}

const Element = ({ attributes, children, element }) => {
  const guidance = element as Guidance;
  const appearance = guidanceAppearance(guidance.state);
  return (
    <section
      {...attributes}
      aria-label={appearance.label}
      className="cocalc-slate-guidance"
      style={{
        margin: "6px 0",
        padding: "8px 10px 10px",
        borderRadius: 10,
        background: appearance.background,
        color: UI_COLORS.text,
        border: `1px solid ${appearance.borderColor}`,
      }}
    >
      <div contentEditable={false} style={{ marginBottom: 7 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            borderRadius: 999,
            background: appearance.pillBackground,
            color: appearance.pillColor,
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.2,
          }}
        >
          {guidance.state === "sending" ? (
            <LoadingOutlined spin style={{ fontSize: 12 }} />
          ) : null}
          {appearance.label}
        </span>
      </div>
      <div
        className="cocalc-slate-guidance-content"
        style={{ minWidth: 0, overflowWrap: "anywhere" }}
      >
        {children}
      </div>
    </section>
  );
};

register({
  slateType: "guidance",
  Element,
  StaticElement: Element,
  fromSlate: ({ children, node }) => {
    const guidance = node as Guidance;
    const body = children.trimEnd();
    let fence = "```";
    while (body.includes(fence)) {
      fence += "`";
    }
    const state =
      guidance.state && guidance.state !== "sent" ? ` ${guidance.state}` : "";
    return `${fence}guidance${state}\n${body}\n${fence}\n\n`;
  },
});
