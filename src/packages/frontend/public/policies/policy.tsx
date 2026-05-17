/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Typography } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

export interface PolicyTitle {
  navLabel?: string;
  title: string;
}

export interface PublicPolicy extends PolicyTitle {
  content: ReactNode;
  description: string;
  slug: string;
  updated?: string;
}

export interface PolicyHeadingProps extends PolicyTitle {
  children?: ReactNode;
  id?: string;
}

export function getPolicyNavLabel(policy: PolicyTitle): string {
  return policy.navLabel ?? policy.title;
}

export function policyHref(href: string): string {
  if (href.includes("://") || href.startsWith("mailto:")) {
    return href;
  }
  if (appBasePath === "/") {
    return href;
  }
  return joinUrlPath(appBasePath, href);
}

export function A(props: Record<string, any>) {
  const { href } = props;
  if (href == null) {
    return <a {...props} />;
  }
  if (href.includes("://") || href.startsWith("mailto:")) {
    return <a {...props} href={href} rel="noopener" target="_blank" />;
  }
  return <a {...props} href={policyHref(href)} />;
}

export function PolicySection({ children, id, title }: PolicyHeadingProps) {
  return (
    <section id={id}>
      <Title level={2}>{title}</Title>
      {children}
    </section>
  );
}

export function PolicySubsection({ children, id, title }: PolicyHeadingProps) {
  return (
    <section id={id}>
      <Title level={3}>{title}</Title>
      {children}
    </section>
  );
}

export function PolicyDocument({ policy }: { policy: PublicPolicy }) {
  return (
    <article
      className="cocalc-public-policy-article"
      style={{
        color: PUBLIC_COLORS.text,
        maxWidth: "80ch",
      }}
    >
      <Title level={1}>{policy.title}</Title>
      {policy.updated != null ? (
        <Paragraph>
          <Text type="secondary">Last Updated: {policy.updated}</Text>
        </Paragraph>
      ) : null}
      {policy.content}
    </article>
  );
}
