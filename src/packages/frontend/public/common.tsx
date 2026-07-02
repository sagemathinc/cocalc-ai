/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { Suspense, lazy } from "react";

import { Button, Empty, Flex, Spin, Typography } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
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
import "./code-block.css";

const Markdown = lazy(() => import("@cocalc/frontend/markdown/component"));
const StaticMarkdown = lazy(
  () => import("@cocalc/frontend/editors/slate/static-markdown-public"),
);
const { Text } = Typography;

export { getPublicMarketingSiteName };
export { getSiteName };
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

// Shared, copyable code block for public pages — curl examples, install
// commands, snippets. Render through the public Slate static markdown path so
// copy behavior and syntax highlighting stay consistent with docs pages.
export function CodeBlock({
  ariaLabel = "Code example",
  code,
  language = "",
}: {
  ariaLabel?: string;
  code: string;
  language?: string;
}) {
  return (
    <div aria-label={ariaLabel} className="cocalc-public-code-block">
      <Suspense fallback={<pre>{code}</pre>}>
        <StaticMarkdown value={toFencedCodeBlock(code, language)} />
      </Suspense>
    </div>
  );
}

function toFencedCodeBlock(content: string, language = ""): string {
  const text = `${content ?? ""}`;
  const fence = "`".repeat(Math.max(3, maxBacktickRun(text) + 1));
  const info = language.trim();
  return `${fence}${info}\n${text}\n${fence}`;
}

function maxBacktickRun(text: string): number {
  let run = 0;
  let max = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      max = Math.max(max, run);
    } else {
      run = 0;
    }
  }
  return max;
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
      config={config}
      sider={sider}
      siderLabel={siderLabel}
      title={title}
    >
      {children}
    </PublicPage>
  );
}
