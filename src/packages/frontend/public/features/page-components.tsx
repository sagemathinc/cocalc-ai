/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { App as AntdApp, Button } from "antd";

import { Icon } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

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
    <Button type="link" href={href} style={{ paddingInline: 0 }}>
      {children}
    </Button>
  );
}

function CodeCopyButton({ value }: { value: string }) {
  const { message } = AntdApp.useApp();
  return (
    <Button
      aria-label="Copy to clipboard"
      icon={<Icon name="copy" />}
      onClick={() => {
        if (typeof navigator === "undefined" || navigator.clipboard == null) {
          void message.info("Copy the code manually.");
          return;
        }
        void navigator.clipboard.writeText(value).then(
          () => void message.success("Copied"),
          () => void message.error("Could not copy."),
        );
      }}
      size="small"
      style={{ position: "absolute", right: 8, top: 8 }}
      type="text"
    />
  );
}

// Shared, copyable multi-line code block for public pages (curl examples,
// snippets). Light + on-token to match the products install commands.
export function CodeBlock({
  ariaLabel = "Code example",
  code,
}: {
  ariaLabel?: string;
  code: string;
}) {
  return (
    <div
      aria-label={ariaLabel}
      style={{
        background: PUBLIC_COLORS.surfaceMuted,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        position: "relative",
      }}
    >
      <CodeCopyButton value={code} />
      <pre
        style={{
          color: PUBLIC_COLORS.heading,
          fontFamily: MONO,
          fontSize: 13,
          lineHeight: 1.7,
          margin: 0,
          overflowX: "auto",
          padding: "14px 44px 14px 16px",
          whiteSpace: "pre",
        }}
      >
        {code}
      </pre>
    </div>
  );
}
