/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

import { Typography } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

export const COCALC_TRUST_CENTER_URL = "https://trust.cocalc.ai/";

const POLICY_DOCUMENT_CSS = `
  .cocalc-public-policy-article p,
  .cocalc-public-policy-article li {
    line-height: 1.75;
  }

  .cocalc-public-policy-article a {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .cocalc-public-policy-article table {
    border-collapse: collapse;
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }

  .cocalc-public-policy-article th,
  .cocalc-public-policy-article td {
    border: 1px solid ${PUBLIC_COLORS.border};
    padding: 0.5em;
    vertical-align: top;
  }

  .cocalc-public-policy-article .uppercase {
    text-transform: uppercase;
  }

  .cocalc-public-policy-article section {
    scroll-margin-top: var(--cocalc-public-anchor-offset);
  }

  @media print {
    .cocalc-public-policy-article {
      max-width: none !important;
    }

    .cocalc-public-policy-article h1,
    .cocalc-public-policy-article h2,
    .cocalc-public-policy-article h3 {
      break-after: avoid;
      page-break-after: avoid;
    }
  }
`;

export interface PolicyTitle {
  navLabel?: string;
  title: string;
}

export interface PublicPolicy extends PolicyTitle {
  content: ReactNode;
  description: string;
  slug: string;
  updated: string;
}

export interface PolicyHeadingProps extends PolicyTitle {
  children?: ReactNode;
  id?: string;
}

export interface PolicyTocItem extends PolicyTitle {
  id: string;
}

export interface PreparedPolicyContent {
  content: ReactNode;
  tocItems: PolicyTocItem[];
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

function isPolicySectionElement(
  element: ReactElement,
): element is ReactElement<PolicyHeadingProps> {
  return element.type === PolicySection;
}

function isPolicyHeadingElement(
  element: ReactElement,
): element is ReactElement<PolicyHeadingProps> {
  return element.type === PolicySection || element.type === PolicySubsection;
}

function collectExplicitPolicyHeadingIds(node: ReactNode, ids: Set<string>) {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;

    if (isPolicyHeadingElement(child)) {
      const props = child.props as PolicyHeadingProps;
      if (props.id != null) {
        ids.add(props.id);
      }
      collectExplicitPolicyHeadingIds(props.children, ids);
      return;
    }

    const props = child.props as { children?: ReactNode };
    collectExplicitPolicyHeadingIds(props.children, ids);
  });
}

function slugifyPolicyHeading(title: string): string {
  const slug =
    title
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";

  return /^[a-z]/.test(slug) ? slug : `section-${slug}`;
}

function createPolicyHeadingId(title: string, usedIds: Set<string>): string {
  const baseId = slugifyPolicyHeading(title);
  let id = baseId;
  let suffix = 2;

  while (usedIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(id);
  return id;
}

function preparePolicyNode(
  node: ReactNode,
  usedIds: Set<string>,
  tocItems: PolicyTocItem[],
): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement(child)) return child;

    if (isPolicySectionElement(child)) {
      const props = child.props as PolicyHeadingProps;
      const id = props.id ?? createPolicyHeadingId(props.title, usedIds);
      tocItems.push({
        id,
        navLabel: props.navLabel,
        title: props.title,
      });

      return cloneElement(
        child as ReactElement<PolicyHeadingProps>,
        { id },
        preparePolicyNode(props.children, usedIds, tocItems),
      );
    }

    const props = child.props as { children?: ReactNode };
    if (props.children == null) return child;

    return cloneElement(
      child as ReactElement<{ children?: ReactNode }>,
      undefined,
      preparePolicyNode(props.children, usedIds, tocItems),
    );
  });
}

export function preparePolicyContent(
  content: ReactNode,
): PreparedPolicyContent {
  const usedIds = new Set<string>();
  const tocItems: PolicyTocItem[] = [];

  collectExplicitPolicyHeadingIds(content, usedIds);

  return {
    content: preparePolicyNode(content, usedIds, tocItems),
    tocItems,
  };
}

export function PolicyDocument({
  beforeContent,
  content,
  policy,
  siteName,
}: {
  beforeContent?: ReactNode;
  content?: ReactNode;
  policy: PublicPolicy;
  siteName: string;
}) {
  const metadata = `${siteName} · Last Updated: ${policy.updated}`;

  return (
    <>
      <style>{POLICY_DOCUMENT_CSS}</style>
      <article
        className="cocalc-public-policy-article"
        style={{
          color: PUBLIC_COLORS.text,
          marginInline: "auto",
          maxWidth: "80ch",
        }}
      >
        <Title level={1}>{policy.title}</Title>
        <Paragraph>
          <Text type="secondary">{metadata}</Text>
        </Paragraph>
        {beforeContent}
        {content ?? policy.content}
      </article>
    </>
  );
}
