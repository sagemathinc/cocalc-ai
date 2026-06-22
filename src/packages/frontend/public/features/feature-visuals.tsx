/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import {
  PUBLIC_ELEVATION,
  PUBLIC_COLORS,
  PUBLIC_DARK,
  PUBLIC_RADIUS,
} from "@cocalc/frontend/public/theme";

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
        borderRadius: PUBLIC_RADIUS.panel,
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
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.media,
        height: "100%",
        padding: 22,
      }}
    >
      <Flex vertical gap={14}>
        <IconBadge accent={accent} icon={icon} />
        <Title level={3} style={{ margin: 0 }}>
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
        background: PUBLIC_DARK.terminalSurface,
        borderRadius: PUBLIC_RADIUS.panel,
        color: PUBLIC_DARK.mockText,
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
        {[PUBLIC_DARK.dotRed, PUBLIC_DARK.dotAmber, PUBLIC_DARK.dotGreen].map(
          (color) => (
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
          ),
        )}
        <Text style={{ color: PUBLIC_DARK.mockText, marginLeft: 8 }}>
          {title}
        </Text>
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
            style={{
              color:
                index % 2 ? PUBLIC_DARK.mockTextAlt : PUBLIC_DARK.mockTextDim,
            }}
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
        borderRadius: PUBLIC_RADIUS.panel,
        boxShadow: PUBLIC_ELEVATION.panelStrong,
        color: PUBLIC_COLORS.heading,
        padding: 26,
      }}
    >
      <Title
        level={3}
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

export function FeatureFinalBand({
  action,
  children,
  relatedLinks,
  relatedTitle = "Related",
  title,
}: {
  action: {
    body: ReactNode;
    href: string;
    label: string;
    title: ReactNode;
  };
  children: ReactNode;
  relatedLinks?: { href: string; label: ReactNode }[];
  relatedTitle?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div
      className="cocalc-feature-final-band"
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        padding: 24,
      }}
    >
      <Row gutter={[24, 24]} align="middle">
        <Col xs={24} lg={15}>
          <Flex vertical gap={14}>
            <Title level={3} style={{ margin: 0 }}>
              {title}
            </Title>
            {children}
          </Flex>
        </Col>
        <Col xs={24} lg={9}>
          <div
            className="cocalc-feature-final-panel"
            style={{
              background: PUBLIC_COLORS.surfaceMuted,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PUBLIC_RADIUS.panel,
              color: PUBLIC_COLORS.heading,
              height: "100%",
              padding: 22,
            }}
          >
            <Flex vertical gap={14}>
              <Title
                level={3}
                style={{ color: PUBLIC_COLORS.heading, margin: 0 }}
              >
                {action.title}
              </Title>
              <Paragraph style={{ color: PUBLIC_COLORS.mutedText, margin: 0 }}>
                {action.body}
              </Paragraph>
              <Button
                href={action.href}
                size="large"
                style={{ marginTop: 4, width: "fit-content" }}
                type="primary"
              >
                {action.label}
              </Button>
            </Flex>
          </div>
        </Col>
        {relatedLinks?.length ? (
          <Col xs={24}>
            <Flex vertical gap={8}>
              <Text strong style={{ color: PUBLIC_COLORS.mutedText }}>
                {relatedTitle}
              </Text>
              <Flex wrap gap={12}>
                {relatedLinks.map(({ href, label }) => (
                  <Button
                    href={href}
                    key={href}
                    style={{ minHeight: 24, paddingInline: 0 }}
                    type="link"
                  >
                    {label}
                  </Button>
                ))}
              </Flex>
            </Flex>
          </Col>
        ) : null}
      </Row>
    </div>
  );
}
