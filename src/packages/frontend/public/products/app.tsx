/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Fragment, type ReactNode, useEffect } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";
import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { getPublicMarketingConfig } from "@cocalc/frontend/public/config";
import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_ELEVATION,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import { getHiddenPublicProductRedirect } from "@cocalc/util/public-product-availability";
import {
  getPublicProductPageCopy,
  getPublicWhereToRunActions,
  getPublicWhereToRunComparison,
  getPublicWhereToRunHeadline,
  getPublicWhereToRunIntro,
  getPublicWhereToRunPaths,
  publicProductTextParts,
  PUBLIC_PRODUCT_SHARED_NOTE,
  PUBLIC_WHERE_TO_RUN_COMPARISON_LINKS,
  PUBLIC_WHERE_TO_RUN_CONTACT,
  PUBLIC_WHERE_TO_RUN_PATHS_TITLE,
  PUBLIC_WHERE_TO_RUN_TITLE,
  PUBLIC_WHERE_TO_RUN_WORKFLOW,
  type PublicProductBlock,
  type PublicProductLink,
  type PublicProductPageCopy,
  type PublicWhereToRunComparison,
} from "@cocalc/util/public-products-content";
import {
  appPath,
  builtinPolicyPath,
  LinkButton,
  type PublicConfig,
  PublicSectionShell,
} from "../common";
import { navigatePublic } from "../navigation";
import { publicPath } from "../routes";
import { PublicGrid, PublicSection } from "../layout/shell";
import { CodeBlock } from "../common";
import type { PublicProductsRoute } from "./routes";

const { Paragraph, Text, Title } = Typography;

const PRODUCT_OVERVIEW_CSS = `
.cocalc-products-overview-hero {
  background:
    radial-gradient(circle at 88% 12%, ${alpha(PUBLIC_COLORS.brand, 0.12)}, transparent 34%),
    linear-gradient(135deg, ${PUBLIC_COLORS.surface} 0%, ${PUBLIC_COLORS.brandTint} 100%);
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.panelStrong};
  overflow: hidden;
  padding: clamp(24px, 4vw, 48px);
}

.cocalc-products-overview-title.ant-typography {
  font-size: clamp(30px, 3.6vw, 44px);
  letter-spacing: -0.035em;
  line-height: 1.1;
  margin: 0;
  max-width: 24ch;
}

.cocalc-products-paths-panel {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.media}px;
  box-shadow: ${PUBLIC_ELEVATION.panelStrong};
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
}

.cocalc-products-path-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.cocalc-products-path-option {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  color: inherit;
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto;
  padding: 13px 14px;
  text-decoration: none;
}

.cocalc-products-path-option:hover {
  border-color: ${PUBLIC_COLORS.linkHover};
  color: inherit;
}

.cocalc-products-compare-table {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-collapse: separate;
  border-radius: ${PUBLIC_RADIUS.panel}px;
  border-spacing: 0;
  overflow: hidden;
  width: 100%;
}

.cocalc-products-compare-caption {
  border: 0;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}

.cocalc-products-compare-table th,
.cocalc-products-compare-table td {
  padding: 14px 18px;
  text-align: left;
  vertical-align: top;
}

.cocalc-products-compare-table thead th {
  background: ${alpha(PUBLIC_COLORS.brandTint, 0.5)};
  border-bottom: 1px solid ${PUBLIC_COLORS.border};
  color: ${PUBLIC_COLORS.heading};
}

.cocalc-products-compare-row + .cocalc-products-compare-row th,
.cocalc-products-compare-row + .cocalc-products-compare-row td {
  border-top: 1px solid ${PUBLIC_COLORS.border};
}

.cocalc-products-compare-table tbody th {
  color: ${PUBLIC_COLORS.heading};
  width: 26%;
}

.cocalc-products-compare-table td {
  width: 37%;
}

.cocalc-products-workflow-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.cocalc-products-workflow-card {
  background: ${PUBLIC_COLORS.surface};
  border: 1px solid ${PUBLIC_COLORS.border};
  border-radius: ${PUBLIC_RADIUS.panel}px;
  box-shadow: ${PUBLIC_ELEVATION.card};
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 200px;
  padding: 20px;
}

@media (max-width: 900px) {
  .cocalc-products-workflow-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 620px) {
  .cocalc-products-overview-hero {
    padding: 22px 18px;
  }

  .cocalc-products-overview-title.ant-typography {
    font-size: clamp(26px, 7.5vw, 34px);
    max-width: none;
  }

  .cocalc-products-overview-hero .ant-btn {
    width: 100%;
  }

  .cocalc-products-compare-table,
  .cocalc-products-compare-table thead,
  .cocalc-products-compare-table tbody,
  .cocalc-products-compare-table tr,
  .cocalc-products-compare-table th,
  .cocalc-products-compare-table td {
    display: block;
    width: 100%;
  }

  .cocalc-products-compare-table thead {
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  .cocalc-products-compare-table tbody tr {
    padding: 14px 16px;
  }

  .cocalc-products-compare-row + .cocalc-products-compare-row {
    border-top: 1px solid ${PUBLIC_COLORS.border};
  }

  .cocalc-products-compare-table tbody th,
  .cocalc-products-compare-table tbody td {
    border-top: 0 !important;
    padding: 0;
    width: 100%;
  }

  .cocalc-products-compare-table tbody td {
    margin-top: 8px;
  }

  .cocalc-products-compare-table tbody td::before {
    color: ${PUBLIC_COLORS.heading};
    content: attr(data-label);
    display: block;
    font-size: ${PUBLIC_TYPE.caption}px;
    font-weight: 600;
    margin-bottom: 2px;
  }
}
`;

// A product page link: a path relative to the site's base path, a fragment on
// the same page, or an absolute URL.
function productHref(href: string): string {
  return href.startsWith("#") || /^https?:\/\//.test(href)
    ? href
    : appPath(href);
}

interface ProductDetailPoint {
  body: ReactNode;
  icon: IconName;
  title: string;
}

function titleForRoute(route: PublicProductsRoute): string {
  switch (route.view) {
    case "products-cocalc-launchpad":
      return "CoCalc Launchpad";
    case "products-cocalc-plus":
      return "CoCalc Plus";
    case "products-cocalc-rocket":
      return "CoCalc Rocket";
    case "products-cocalc-star":
      return "CoCalc Star";
    case "products":
    default:
      return PUBLIC_WHERE_TO_RUN_TITLE;
  }
}

// The workflow cards' icons, by the page each card links to.
const WORKFLOW_ICONS: Record<string, IconName> = {
  "features/ai": "robot",
  "features/compare": "exchange",
  "features/research-compute": "server",
};

// A path on the Where to run CoCalc page, with its link resolved.
function overviewHref(href: string): string {
  return /^https?:\/\//.test(href) ? href : publicPath(href);
}

// The table's narrow-screen layout is the React page's own, so only its
// caption describes it.
const COMPARISON_NARROW_SCREEN_NOTE =
  "On narrow screens, each row is shown as labelled stacked fields with the same column meaning.";

function WhereToRunComparison({
  comparison,
}: {
  comparison: PublicWhereToRunComparison;
}) {
  return (
    <PublicSection>
      <Title id="cocalc-products-compare-title" level={2} style={{ margin: 0 }}>
        {comparison.title}
      </Title>
      <table
        aria-describedby="cocalc-products-compare-caption"
        aria-labelledby="cocalc-products-compare-title"
        className="cocalc-products-compare-table"
      >
        <caption
          className="cocalc-products-compare-caption"
          id="cocalc-products-compare-caption"
        >
          {comparison.caption} {COMPARISON_NARROW_SCREEN_NOTE}
        </caption>
        <thead>
          <tr>
            <td />
            <th scope="col">CoCalc.ai</th>
            <th scope="col">CoCalc Star</th>
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr className="cocalc-products-compare-row" key={row.label}>
              <th scope="row">{row.label}</th>
              <td data-label="CoCalc.ai">{row.cocalcAi}</td>
              <td data-label="CoCalc Star">{row.star}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Flex gap={16} wrap>
        {PUBLIC_WHERE_TO_RUN_COMPARISON_LINKS.map(({ href, label }) => (
          <LinkButton href={appPath(href)} key={href}>
            {label}
          </LinkButton>
        ))}
      </Flex>
    </PublicSection>
  );
}

function ProductsOverviewPage({ config }: { config?: PublicConfig }) {
  const privacyHref = builtinPolicyPath(config, "privacy");
  const trustHref = builtinPolicyPath(config, "trust");
  const canEvaluateResearchCompute =
    getPublicFeaturePage("research-compute", {
      cocalc_product: config?.cocalc_product,
    }) != null;
  // CoCalc.ai, then only the products the public pages show.
  const paths = getPublicWhereToRunPaths();
  const comparison = getPublicWhereToRunComparison();

  const workflowLinks = PUBLIC_WHERE_TO_RUN_WORKFLOW.cards.filter(
    ({ href }) =>
      href !== "features/research-compute" || canEvaluateResearchCompute,
  );

  return (
    <Flex vertical gap={48}>
      <style>{PRODUCT_OVERVIEW_CSS}</style>
      <section
        aria-labelledby="cocalc-products-overview-title"
        className="cocalc-products-overview-hero"
      >
        <Row align="middle" gutter={[40, 36]}>
          <Col xs={24} lg={14}>
            <Flex vertical gap={22}>
              <Title
                className="cocalc-products-overview-title"
                id="cocalc-products-overview-title"
                level={2}
              >
                {getPublicWhereToRunHeadline()}
              </Title>
              <Paragraph
                style={{
                  color: PUBLIC_COLORS.mutedText,
                  fontSize: PUBLIC_TYPE.lead,
                  lineHeight: 1.6,
                  margin: 0,
                  maxWidth: 680,
                }}
              >
                {getPublicWhereToRunIntro()}
              </Paragraph>
              <ProductActions
                actions={getPublicWhereToRunActions()}
                size="large"
              />
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <div className="cocalc-products-paths-panel">
              <Text id="cocalc-products-paths-title" strong>
                {PUBLIC_WHERE_TO_RUN_PATHS_TITLE}
              </Text>
              <ul
                aria-labelledby="cocalc-products-paths-title"
                className="cocalc-products-path-list"
              >
                {paths.map((path) => (
                  <li key={path.title}>
                    <a
                      className="cocalc-products-path-option"
                      href={overviewHref(path.href)}
                    >
                      <span>
                        <Text strong style={{ display: "block" }}>
                          {path.title}
                        </Text>
                        <Text style={{ color: PUBLIC_COLORS.mutedText }}>
                          {path.detail}
                        </Text>
                      </span>
                      <span
                        aria-hidden="true"
                        style={{
                          color: PUBLIC_COLORS.brand,
                          paddingTop: 2,
                        }}
                      >
                        <Icon name="arrow-right" />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </Col>
        </Row>
      </section>

      {comparison ? <WhereToRunComparison comparison={comparison} /> : null}

      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          {PUBLIC_WHERE_TO_RUN_WORKFLOW.title}
        </Title>
        <Paragraph
          style={{
            color: PUBLIC_COLORS.mutedText,
            fontSize: PUBLIC_TYPE.lead,
            margin: 0,
            maxWidth: 780,
          }}
        >
          {PUBLIC_WHERE_TO_RUN_WORKFLOW.body}
        </Paragraph>
        <div className="cocalc-products-workflow-grid">
          {workflowLinks.map((item) => (
            <div className="cocalc-products-workflow-card" key={item.title}>
              <span
                aria-hidden="true"
                style={{ color: PUBLIC_COLORS.brand, fontSize: 22 }}
              >
                <Icon name={WORKFLOW_ICONS[item.href] ?? "star"} />
              </span>
              <Title level={3} style={{ margin: 0 }}>
                {item.title}
              </Title>
              <Paragraph
                style={{
                  color: PUBLIC_COLORS.mutedText,
                  flex: 1,
                  margin: 0,
                }}
              >
                {item.body}
              </Paragraph>
              <LinkButton href={publicPath(item.href)}>{item.label}</LinkButton>
            </div>
          ))}
        </div>
      </PublicSection>

      <PublicSection>
        <Title level={2} style={{ margin: 0 }}>
          {PUBLIC_WHERE_TO_RUN_CONTACT.title}
        </Title>
        <Paragraph
          style={{
            color: PUBLIC_COLORS.mutedText,
            fontSize: PUBLIC_TYPE.lead,
            margin: 0,
            maxWidth: 780,
          }}
        >
          {PUBLIC_WHERE_TO_RUN_CONTACT.body}
        </Paragraph>
        <ProductActions
          actions={PUBLIC_WHERE_TO_RUN_CONTACT.links}
          size="large"
        />
        {trustHref || privacyHref ? (
          <Flex aria-label="Product trust materials" gap={14} role="group" wrap>
            {trustHref ? (
              <LinkButton href={trustHref}>
                Review trust and compliance
              </LinkButton>
            ) : null}
            {privacyHref ? (
              <LinkButton href={privacyHref}>Review privacy policy</LinkButton>
            ) : null}
          </Flex>
        ) : null}
      </PublicSection>
    </Flex>
  );
}

function ProductActions({
  actions,
  size,
}: {
  actions: readonly PublicProductLink[];
  size?: "large";
}) {
  if (actions.length === 0) return null;
  return (
    <Flex gap={12} wrap>
      {actions.map((action) => (
        <Button
          href={productHref(action.href)}
          key={`${action.label}-${action.href}`}
          size={size}
          type={action.primary ? "primary" : "default"}
        >
          {action.label}
        </Button>
      ))}
    </Flex>
  );
}

function ProductLeadSection({ copy }: { copy: PublicProductPageCopy }) {
  return (
    <PublicSection>
      <Title
        level={2}
        style={{ fontSize: PUBLIC_TYPE.title, lineHeight: 1.3, margin: 0 }}
      >
        {copy.lead.title}
      </Title>
      {copy.lead.paragraphs.map((paragraph) => (
        <Paragraph
          key={paragraph}
          style={{ fontSize: PUBLIC_TYPE.lead, margin: 0, maxWidth: "72ch" }}
        >
          {paragraph}
        </Paragraph>
      ))}
      <ProductActions actions={copy.lead.actions} />
    </PublicSection>
  );
}

// The note after the lead, as the crawler fallback prints it.
function ProductSharedProjectNote() {
  return (
    <div
      aria-label="Shared CoCalc project context"
      role="note"
      style={{
        borderLeft: `3px solid ${PUBLIC_COLORS.brandSubtle}`,
        color: PUBLIC_COLORS.mutedText,
        fontSize: PUBLIC_TYPE.body,
        lineHeight: 1.55,
        maxWidth: "76ch",
        padding: "2px 0 2px 14px",
      }}
    >
      <Text strong>{PUBLIC_PRODUCT_SHARED_NOTE.title}</Text>{" "}
      <Text style={{ color: PUBLIC_COLORS.mutedText }}>
        {PUBLIC_PRODUCT_SHARED_NOTE.body}
      </Text>
    </div>
  );
}

function ProductDetailCard({
  children,
  icon,
  id,
  role,
  title,
}: {
  children: ReactNode;
  icon: IconName;
  // A link target, such as the install card's. A link lands focus on it too.
  id?: string;
  role?: "listitem";
  title: string;
}) {
  return (
    <section
      aria-label={title}
      className="cocalc-public-products-detail-card"
      id={id}
      role={role}
      tabIndex={id ? -1 : undefined}
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        height: "100%",
        minHeight: 188,
        padding: 18,
        // Keep the card's title below the page header.
        scrollMarginTop: id ? "var(--cocalc-public-anchor-offset)" : undefined,
      }}
    >
      <Flex align="center" gap={10}>
        <span
          aria-hidden="true"
          style={{
            alignItems: "center",
            background: PUBLIC_COLORS.surfaceMuted,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: 8,
            color: PUBLIC_COLORS.brand,
            display: "flex",
            flex: "0 0 38px",
            height: 38,
            justifyContent: "center",
            width: 38,
          }}
        >
          <Icon name={icon} />
        </span>
        <Title
          level={3}
          style={{ fontSize: PUBLIC_TYPE.title, lineHeight: 1.3, margin: 0 }}
        >
          {title}
        </Title>
      </Flex>
      <div style={{ flex: 1 }}>{children}</div>
    </section>
  );
}

function ProductDetailGrid({
  items,
  label,
}: {
  items: ProductDetailPoint[];
  label: string;
}) {
  return (
    <div
      aria-label={label}
      role="list"
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
      }}
    >
      {items.map((item) => (
        <ProductDetailCard
          icon={item.icon}
          key={item.title}
          role="listitem"
          title={item.title}
        >
          <Paragraph style={{ margin: 0 }}>{item.body}</Paragraph>
        </ProductDetailCard>
      ))}
    </div>
  );
}

// The page's positioning cards, each with its icon.
function productPoints(
  copy: PublicProductPageCopy,
  icons: readonly IconName[],
): ProductDetailPoint[] {
  return copy.points.map((point, index) => ({
    ...point,
    icon: icons[index] ?? "star",
  }));
}

// A paragraph's text, code and links, as the crawler fallback renders them.
function ProductText({
  block,
}: {
  block: Parameters<typeof publicProductTextParts>[0];
}) {
  return (
    <>
      {publicProductTextParts(block).map((part, index) =>
        "code" in part ? (
          <Text code key={index}>
            {part.code}
          </Text>
        ) : "link" in part ? (
          <a href={productHref(part.link.href)} key={index}>
            {part.link.label}
          </a>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

// A card's blocks, in order. Text-only cards space their paragraphs; in cards
// with commands, each step sits next to its command.
function ProductBlocks({ blocks }: { blocks: readonly PublicProductBlock[] }) {
  const margin = blocks.some(
    (block) => typeof block !== "string" && "code" in block,
  )
    ? 0
    : "0 0 8px";
  return (
    <>
      {blocks.map((block, index) =>
        typeof block === "string" || "text" in block ? (
          <Paragraph key={index} style={{ margin }}>
            <ProductText block={block} />
          </Paragraph>
        ) : "note" in block ? (
          <Paragraph
            key={index}
            style={{ color: PUBLIC_COLORS.mutedText, margin }}
          >
            {block.note}
          </Paragraph>
        ) : (
          <CodeBlock ariaLabel={block.label} code={block.code} key={index} />
        ),
      )}
    </>
  );
}

// The page's sections, one card each, in the order of the copy: an array, so
// that PublicGrid lays out each card. The install card takes installId as its
// id, so links such as #install-cocalc-star land on it.
function productSectionCards(
  copy: PublicProductPageCopy,
  icons: Record<string, IconName>,
  installId?: string,
): ReactNode[] {
  return copy.sections.map((section) => (
    <ProductDetailCard
      icon={icons[section.key] ?? "star"}
      id={section.key === "install" ? installId : undefined}
      key={section.key}
      title={section.title}
    >
      <ProductBlocks blocks={section.blocks} />
      {section.links?.length ? (
        <ProductActions actions={section.links} />
      ) : null}
    </ProductDetailCard>
  ));
}

// The card of the page's notes, if it has any.
function productNotesCard(
  copy: PublicProductPageCopy,
  icon: IconName,
): ReactNode {
  return copy.notes.length > 0 ? (
    <ProductDetailCard icon={icon} key="notes" title={copy.notesTitle}>
      <ProductNotesList items={copy.notes} />
    </ProductDetailCard>
  ) : null;
}

function ProductNotesList({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 20 }}>
      {items.map((item, index) => (
        <li
          key={index}
          style={{ marginBottom: index === items.length - 1 ? 0 : 8 }}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function CocalcRocketPage() {
  const copy = getPublicProductPageCopy("rocket");

  return (
    <Flex vertical gap={18}>
      <ProductLeadSection copy={copy} />
      <ProductSharedProjectNote />
      <ProductDetailGrid
        items={productPoints(copy, ["rocket", "servers", "cloud"])}
        label="CoCalc Rocket positioning"
      />
      <PublicGrid columns={2}>
        {productNotesCard(copy, "rocket")}
        {productSectionCards(copy, { plan: "servers" })}
      </PublicGrid>
      <ProductActions actions={copy.links} />
    </Flex>
  );
}

function CocalcStarPage() {
  const copy = getPublicProductPageCopy("star");

  return (
    <Flex vertical gap={18}>
      <ProductLeadSection copy={copy} />
      <ProductSharedProjectNote />
      <ProductDetailGrid
        items={productPoints(copy, ["star", "servers", "cloud"])}
        label="CoCalc Star positioning"
      />
      <PublicGrid columns={2}>
        {productSectionCards(
          copy,
          {
            agents: "robot",
            install: "star",
            remove: "star",
            server: "servers",
            upgrade: "cloud",
          },
          "install-cocalc-star",
        )}
        {productNotesCard(copy, "server")}
      </PublicGrid>
      <ProductActions actions={copy.links} />
    </Flex>
  );
}

function CocalcLaunchpadPage() {
  const copy = getPublicProductPageCopy("launchpad");

  return (
    <Flex vertical gap={18}>
      <ProductLeadSection copy={copy} />
      <ProductSharedProjectNote />
      <ProductDetailGrid
        items={productPoints(copy, ["servers", "cloud", "star"])}
        label="CoCalc Launchpad positioning"
      />
      <PublicGrid columns={2}>
        {productSectionCards(
          copy,
          { install: "servers" },
          "install-cocalc-launchpad",
        )}
        {productNotesCard(copy, "cloud")}
      </PublicGrid>
      <ProductActions actions={copy.links} />
    </Flex>
  );
}

function CocalcPlusPage() {
  const copy = getPublicProductPageCopy("plus");

  return (
    <Flex vertical gap={18}>
      <ProductLeadSection copy={copy} />
      <ProductSharedProjectNote />
      <ProductDetailGrid
        items={productPoints(copy, ["laptop", "cloud", "star"])}
        label="CoCalc Plus positioning"
      />
      <PublicGrid columns={2}>
        {productSectionCards(
          copy,
          {
            agents: "robot",
            install: "laptop",
            uninstall: "trash",
            update: "cloud-download",
          },
          "install-cocalc-plus",
        )}
        {productNotesCard(copy, "cloud")}
      </PublicGrid>
      <ProductActions actions={copy.links} />
    </Flex>
  );
}

export default function PublicProductsApp({
  config,
  initialRoute,
}: {
  config?: PublicConfig;
  initialRoute: PublicProductsRoute;
}) {
  // A hidden product's page redirects to the products page, here as on the
  // server, for links followed inside the public app and for a page opened
  // through the static shell. It keeps the query string, as the server's
  // redirect does, and the fragment, which the browser keeps across that
  // redirect.
  const redirect = getHiddenPublicProductRedirect(initialRoute.view);
  const route: PublicProductsRoute =
    redirect != null ? { view: "products" } : initialRoute;
  const title = titleForRoute(route);
  const marketingConfig = getPublicMarketingConfig(config);

  useEffect(() => {
    if (redirect == null) return;
    navigatePublic(
      `${publicPath(redirect)}${window.location.search}${window.location.hash}`,
      true,
    );
  }, [redirect]);

  // A link from another page to a card on this one, such as Where to run
  // CoCalc's "Install CoCalc Star", lands on that card, and so does focus, so
  // the next Tab goes on from the card rather than from the top of the page.
  // Wait a frame: the public app scrolls to the top of each page it opens.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById(id);
      card?.scrollIntoView?.({ block: "start" });
      card?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [route.view]);

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicSectionShell
      active="products"
      config={marketingConfig}
      title={title}
    >
      {route.view === "products-cocalc-plus" ? (
        <CocalcPlusPage />
      ) : route.view === "products-cocalc-rocket" ? (
        <CocalcRocketPage />
      ) : route.view === "products-cocalc-star" ? (
        <CocalcStarPage />
      ) : route.view === "products-cocalc-launchpad" ? (
        <CocalcLaunchpadPage />
      ) : (
        <ProductsOverviewPage config={marketingConfig} />
      )}
    </PublicSectionShell>
  );
}
