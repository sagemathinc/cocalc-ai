/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Flex, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";

const { Paragraph, Text, Title } = Typography;

export function IconBadge({
  accent = PUBLIC_COLORS.brand,
  icon,
  size = "lg",
}: {
  accent?: string;
  icon: IconName;
  size?: "sm" | "md" | "lg";
}) {
  const { box, font } = {
    sm: { box: 36, font: 18 },
    md: { box: 46, font: 22 },
    lg: { box: 52, font: 24 },
  }[size];
  return (
    <span
      style={{
        alignItems: "center",
        background: `${accent}14`,
        border: `1px solid ${accent}33`,
        borderRadius: 8,
        color: accent,
        display: "inline-flex",
        flex: "0 0 auto",
        fontSize: font,
        height: box,
        justifyContent: "center",
        width: box,
      }}
    >
      <Icon name={icon} />
    </span>
  );
}

export function StoryCard({
  accent = PUBLIC_COLORS.brand,
  children,
  icon,
  title,
}: {
  accent?: string;
  children: ReactNode;
  icon: IconName;
  title: string;
}) {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        boxShadow: "0 14px 40px rgba(33, 49, 57, 0.07)",
        height: "100%",
        padding: 22,
      }}
    >
      <Flex vertical gap={14}>
        <IconBadge accent={accent} icon={icon} />
        <Title level={4} style={{ margin: 0 }}>
          {title}
        </Title>
        <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
          {children}
        </Paragraph>
      </Flex>
    </div>
  );
}

export function ContextList({
  accent = PUBLIC_COLORS.brand,
  items,
  title,
}: {
  accent?: string;
  items: { icon: IconName; label: ReactNode }[];
  title?: ReactNode;
}) {
  return (
    <div
      className="cocalc-feature-context-list"
      style={{
        borderLeft: `3px solid ${accent}33`,
        paddingLeft: 18,
      }}
    >
      <Flex vertical gap={12}>
        {title != null && <Text strong>{title}</Text>}
        {items.map(({ icon, label }, index) => (
          <Flex align="center" gap={10} key={`${icon}-${index}`}>
            <Icon
              name={icon}
              style={{
                color: accent,
                flex: "0 0 auto",
                fontSize: 17,
              }}
            />
            <Text strong>{label}</Text>
          </Flex>
        ))}
      </Flex>
    </div>
  );
}

export function TerminalMock({
  rows,
  title = "terminal",
}: {
  rows: ReactNode[];
  title?: ReactNode;
}) {
  return (
    <div
      style={{
        background: "#0b1522",
        borderRadius: 8,
        color: "#dbeafe",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "rgba(255,255,255,0.08)",
          display: "flex",
          gap: 8,
          padding: "10px 14px",
        }}
      >
        {["#ff6b6b", "#ffd166", "#06d6a0"].map((color) => (
          <span
            aria-hidden="true"
            key={color}
            style={{
              background: color,
              borderRadius: "50%",
              height: 10,
              width: 10,
            }}
          />
        ))}
        <Text style={{ color: "#dbeafe", marginLeft: 8 }}>{title}</Text>
      </div>
      <Flex
        vertical
        gap={8}
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          padding: 16,
        }}
      >
        {rows.map((row, index) => (
          <Text
            key={index}
            style={{ color: index % 2 ? "#86efac" : "#bfdbfe" }}
          >
            {row}
          </Text>
        ))}
      </Flex>
    </div>
  );
}

export function StartCard({
  body,
  href,
  label,
  title,
}: {
  body: ReactNode;
  href: string;
  label: string;
  title: ReactNode;
}) {
  return (
    <div
      className="cocalc-feature-final-panel"
      style={{
        background: PUBLIC_COLORS.surfaceMuted,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        boxShadow: "0 18px 52px rgba(33, 49, 57, 0.12)",
        color: PUBLIC_COLORS.heading,
        padding: 26,
      }}
    >
      <Title
        level={4}
        style={{ color: PUBLIC_COLORS.heading, margin: "0 0 10px" }}
      >
        {title}
      </Title>
      <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
        {body}
      </Paragraph>
      <Button
        href={href}
        size="large"
        style={{ marginTop: 22, width: "fit-content" }}
        type="primary"
      >
        {label}
      </Button>
    </div>
  );
}
