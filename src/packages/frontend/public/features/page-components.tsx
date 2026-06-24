/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

// The one shared copyable-code component lives in ../common; re-export it so
// feature pages can keep importing it from page-components.
export { CodeBlock } from "../common";

export function featureAppPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

export function featureSupportPath({
  body,
  context,
  subject,
  title,
}: {
  body: string;
  context: string;
  subject: string;
  title: string;
}): string {
  const params = new URLSearchParams({
    body,
    context: `feature-${context}`,
    subject,
    title,
    type: "support",
  });
  return `${featureAppPath("support/new")}?${params.toString()}`;
}

export function FeatureImage({
  alt,
  aspectRatio = "16 / 9",
  objectFit = "cover",
  src,
}: {
  alt: string;
  aspectRatio?: string;
  objectFit?: "contain" | "cover";
  src?: string;
}) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      style={{
        aspectRatio,
        background: PUBLIC_COLORS.surfaceMuted,
        borderRadius: 14,
        display: "block",
        objectFit,
        width: "100%",
      }}
    />
  );
}

export function BulletList({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 20 }}>
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 8 }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

export function LinkButton({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <Button type="link" href={href} style={{ minHeight: 24, paddingInline: 0 }}>
      {children}
    </Button>
  );
}
