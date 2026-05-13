/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties, ReactNode } from "react";
import { Suspense, lazy } from "react";

import { Button, Empty, Flex, Spin, Typography } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getSiteName, type PublicConfig } from "@cocalc/frontend/public/config";
import {
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import type { PublicTopNavActiveKey } from "@cocalc/frontend/public/layout/top-nav";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const Markdown = lazy(() => import("@cocalc/frontend/markdown/component"));
const { Text } = Typography;

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

export function PublicSectionShell({
  active,
  beforeTitle,
  children,
  config,
  title,
}: {
  active?: PublicTopNavActiveKey;
  beforeTitle?: ReactNode;
  children: ReactNode;
  config?: PublicConfig;
  title?: ReactNode;
}) {
  return (
    <PublicPage
      active={active}
      beforeTitle={beforeTitle}
      config={config}
      title={title}
    >
      {children}
    </PublicPage>
  );
}
