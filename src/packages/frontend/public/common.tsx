/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { Suspense, lazy } from "react";

import { App as AntdApp, Button, Empty, Flex, Spin, Typography } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  getPublicMarketingConfig,
  getPublicMarketingSiteName,
  getSiteName,
  publicPoliciesUseBuiltin,
  type PublicConfig,
} from "@cocalc/frontend/public/config";
import {
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import type { PublicTopNavActiveKey } from "@cocalc/frontend/public/layout/top-nav";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const Markdown = lazy(() => import("@cocalc/frontend/markdown/component"));
const { Text } = Typography;

export { getPublicMarketingSiteName, getSiteName };
export type { PublicConfig };

export const MUTED_STYLE: CSSProperties = {
  color: PUBLIC_COLORS.mutedText,
} as const;

export async function fetchJson<T>(path: string): Promise<T> {
  const resp = await fetch(path);
  return await resp.json();
}

export function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

export function builtinPolicyPath(
  config: PublicConfig | undefined,
  slug: string,
): string | undefined {
  return publicPoliciesUseBuiltin(config)
    ? appPath(`policies/${slug}`)
    : undefined;
}

export function MarkdownSection({ value }: { value: string }) {
  return (
    <PublicSection>
      <Suspense fallback={<div>Loading content…</div>}>
        <Markdown value={value} />
      </Suspense>
    </PublicSection>
  );
}

export function LoadingSection({ label }: { label: string }) {
  return (
    <PublicSection>
      <Flex align="center" gap={12}>
        <Spin size="small" />
        <Text>{label}</Text>
      </Flex>
    </PublicSection>
  );
}

export function EmptySection({ label }: { label: string }) {
  return (
    <PublicSection>
      <Empty description={label} image={Empty.PRESENTED_IMAGE_SIMPLE} />
    </PublicSection>
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
    <Button href={href} style={{ paddingInline: 0 }} type="link">
      {children}
    </Button>
  );
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

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

// Shared, copyable code block for public pages — curl examples, install
// commands, snippets. The one copyable-code pattern across features + products.
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

// Shared conversion footer so trust/supporting pages route back into the
// funnel instead of dead-ending. Mirrors the home page PathSection so the
// "next step" is identical across the site.
export function PublicNextStep({
  authenticated,
  heading = "Ready to choose how CoCalc runs for your team?",
}: {
  authenticated?: boolean;
  heading?: ReactNode;
}) {
  return (
    <PublicSection ariaLabel="Next step" title={heading}>
      <Flex gap={12} wrap>
        <Button
          href={appPath(authenticated ? "projects" : "auth/sign-up")}
          type="primary"
        >
          {authenticated ? "Open projects" : "Start on CoCalc.ai"}
        </Button>
        <Button href={appPath("products")}>Compare operating models</Button>
        <Button href={appPath("support")}>Talk with CoCalc</Button>
      </Flex>
    </PublicSection>
  );
}

export function PublicSectionShell({
  active,
  beforeTitle,
  children,
  config,
  sider,
  siderLabel,
  title,
}: {
  active?: PublicTopNavActiveKey;
  beforeTitle?: ReactNode;
  children: ReactNode;
  config?: PublicConfig;
  sider?: ReactNode;
  siderLabel?: string;
  title?: ReactNode;
}) {
  return (
    <PublicPage
      active={active}
      beforeTitle={beforeTitle}
      config={getPublicMarketingConfig(config)}
      sider={sider}
      siderLabel={siderLabel}
      title={title}
    >
      {children}
    </PublicPage>
  );
}
