/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { type ReactNode, useEffect } from "react";
import { Button } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  getPublicMarketingConfig,
  getPublicMarketingSiteName,
  type PublicConfig,
} from "@cocalc/frontend/public/config";
import { PublicPage } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_COLORS,
  PUBLIC_DISPLAY_FONT_FAMILY,
} from "@cocalc/frontend/public/theme";
import {
  getPublicHomeContent,
  PUBLIC_HOME_OUTCOMES_INTRO,
  PUBLIC_HOME_EVALUATION_INTRO,
  PUBLIC_HOME_CONTACT,
  PUBLIC_HOME_TRUST_LABEL,
  PUBLIC_HOME_SECTION_TITLES as TITLES,
  type PublicHomeItem,
  type PublicHomeLink,
} from "@cocalc/util/public-home-content";
import { publicHomeTitle } from "@cocalc/util/public-site-metadata";
import { joinUrlPath } from "@cocalc/util/url-path";

// Home-specific layout. Keep these selectors local to the page; the native
// shell supplies theme colors, navigation and document landmarks.
const HOME_CSS = `
.cocalc-home { color:${PUBLIC_COLORS.text}; font-size:16px; line-height:1.65; }
.cocalc-home h1,.cocalc-home h2,.cocalc-home h3 { font-family:${PUBLIC_DISPLAY_FONT_FAMILY}; color:${PUBLIC_COLORS.heading}; text-wrap:balance; }
.cocalc-home h1 { font-size:clamp(38px,4.6vw,62px); font-weight:650; letter-spacing:-.035em; line-height:1.08; max-width:19ch; margin:0; }
.cocalc-home h2 { font-size:clamp(28px,3vw,38px); font-weight:600; letter-spacing:-.025em; line-height:1.2; max-width:27ch; margin:0; }
.cocalc-home h3 { font-size:20px; line-height:1.3; font-weight:600; margin:0 0 12px; }
.cocalc-home p { margin:0; }
.cocalc-home a { overflow-wrap:anywhere; }
.cocalc-home a:focus-visible,.cocalc-home summary:focus-visible { outline:3px solid ${PUBLIC_COLORS.link}; outline-offset:4px; border-radius:4px; }
.cocalc-home section { scroll-margin-top:calc(var(--cocalc-public-anchor-offset,64px) + 16px); }
.cocalc-home-hero { display:grid; gap:32px; padding-top:clamp(32px,6vw,72px); align-items:center; }
.cocalc-home-lead { font-size:19px; line-height:1.65; margin-top:22px !important; max-width:58ch; }
.cocalc-home-actions { display:flex; flex-wrap:wrap; gap:12px; margin-top:28px; }
.cocalc-home-actions .ant-btn { height:auto; min-height:40px; padding:9px 16px; white-space:normal; text-align:center; }
.cocalc-home-figure { margin:0; min-width:0; }
.cocalc-home-figure img { display:block; width:100%; height:auto; border:1px solid ${PUBLIC_COLORS.border}; border-radius:10px; }
.cocalc-home-section { margin-top:clamp(56px,7vw,88px); }
.cocalc-home-section-intro { margin-bottom:30px; }
.cocalc-home-section-intro p { margin-top:16px; max-width:68ch; }
.cocalc-home-process { max-width:940px; }
.cocalc-home-process-row { display:grid; grid-template-columns:1fr 1.7fr; gap:32px; border-top:1px solid ${PUBLIC_COLORS.border}; padding:22px 0; }
.cocalc-home-process-row h3 { margin:0; }
.cocalc-home-benefits { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr)); gap:32px; }
.cocalc-home-benefit { border-top:1px solid ${PUBLIC_COLORS.border}; padding-top:22px; min-width:0; }
.cocalc-home-item-link { display:inline-block; margin-top:16px; font-weight:600; }
.cocalc-home-outcomes { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; }
.cocalc-home-card { padding:26px; border:1px solid ${PUBLIC_COLORS.border}; border-radius:8px; background:${PUBLIC_COLORS.surface}; min-width:0; }
.cocalc-home-outcomes .cocalc-home-card:last-child:nth-child(odd) { grid-column:1 / -1; }
.cocalc-home-directory { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:32px; }
.cocalc-home-directory ul { list-style:none; padding:0; margin:0; }
.cocalc-home-directory li { margin:10px 0; }
.cocalc-home-details { margin-top:30px; border-top:1px solid ${PUBLIC_COLORS.border}; border-bottom:1px solid ${PUBLIC_COLORS.border}; padding:18px 0; }
.cocalc-home-details summary { cursor:pointer; font-weight:600; color:${PUBLIC_COLORS.heading}; }
.cocalc-home-details p { margin-top:16px; max-width:75ch; }
.cocalc-home-details-links { display:flex; flex-wrap:wrap; gap:20px; margin-top:16px; }
.cocalc-home-final { border-top:1px solid ${PUBLIC_COLORS.border}; padding:42px 0 12px; display:grid; grid-template-columns:1fr auto; align-items:center; gap:24px; }
.cocalc-home-final .cocalc-home-actions { margin-top:0; }
.cocalc-home-final p { margin-top:16px; }
@media(min-width:960px) {
  .cocalc-home-hero:has(.cocalc-home-figure) { grid-template-columns:repeat(2,minmax(0,1fr)); gap:clamp(32px,4vw,56px); }
  .cocalc-home h1 { font-size:clamp(48px,4vw,54px); }
}
@media(max-width:900px) { .cocalc-home-final { grid-template-columns:minmax(0,1fr); } }
@media(max-width:620px) {
  .cocalc-home h1 { font-size:clamp(34px,9vw,42px); }
  .cocalc-home-lead { font-size:18px; }
  .cocalc-home-process-row,.cocalc-home-outcomes,.cocalc-home-directory { grid-template-columns:minmax(0,1fr); }
  .cocalc-home-process-row { gap:10px; }
  .cocalc-home-card { padding:22px; }
  .cocalc-home-actions { width:100%; }
  .cocalc-home-actions .ant-btn { width:100%; }
}
`;

const appPath = (path: string) => joinUrlPath(appBasePath, path);

function Action({
  link,
  primary = false,
}: {
  link: PublicHomeLink;
  primary?: boolean;
}) {
  return (
    <Button href={appPath(link.href)} type={primary ? "primary" : "default"}>
      {link.label}
    </Button>
  );
}

function Section({
  id,
  title,
  body,
  children,
}: {
  id: string;
  title: string;
  body?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="cocalc-home-section"
      aria-labelledby={`${id}-title`}
    >
      <div className="cocalc-home-section-intro">
        <h2 id={`${id}-title`}>{title}</h2>
        {body && <p>{body}</p>}
      </div>
      {children}
    </section>
  );
}

function Item({
  item,
  className,
}: {
  item: PublicHomeItem;
  className: string;
}) {
  return (
    <div className={className}>
      <h3>{item.title}</h3>
      <p>{item.body}</p>
      {item.link && (
        <a className="cocalc-home-item-link" href={appPath(item.link.href)}>
          {item.link.label}
        </a>
      )}
    </div>
  );
}

// Keep canonical sign-up usable while settings load; the hostname does not
// imply AI capabilities, product type or custom branding.
function withSiteHost(config?: PublicConfig): PublicConfig | undefined {
  if (config?.dns?.trim() || typeof window === "undefined") return config;
  return { ...config, dns: window.location.host };
}

export default function PublicHomeApp({ config }: { config?: PublicConfig }) {
  const marketingConfig = getPublicMarketingConfig(withSiteHost(config));
  const content = getPublicHomeContent({
    ...marketingConfig,
    // Home policy links follow the explicit site policy, as the initial HTML does.
    policy_pages: config?.policy_pages,
  });
  const siteName = getPublicMarketingSiteName(config);
  const title = publicHomeTitle(config);
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <PublicPage active="home" config={marketingConfig}>
      <style>{HOME_CSS}</style>
      <div className="cocalc-home">
        <section
          id="home-hero"
          className="cocalc-home-hero"
          aria-label={`${siteName} hero`}
        >
          <div>
            <h1>{content.title}</h1>
            <p className="cocalc-home-lead">{content.intro}</p>
            <div className="cocalc-home-actions">
              {content.primary && <Action link={content.primary} primary />}
              <Action link={content.secondary} />
            </div>
          </div>
          {content.image && (
            <figure className="cocalc-home-figure">
              <img
                src={appPath(content.image.src)}
                alt={content.image.alt}
                width={content.image.width}
                height={content.image.height}
                fetchPriority="high"
              />
            </figure>
          )}
        </section>
        {content.process.length > 0 && (
          <Section id="home-process" title={TITLES.process}>
            <div className="cocalc-home-process">
              {content.process.map((item) => (
                <Item
                  key={item.title}
                  item={item}
                  className="cocalc-home-process-row"
                />
              ))}
            </div>
          </Section>
        )}
        <Section id="home-platform" title={content.platformTitle}>
          <div className="cocalc-home-benefits">
            {content.benefits.map((item) => (
              <Item
                key={item.title}
                item={item}
                className="cocalc-home-benefit"
              />
            ))}
          </div>
        </Section>
        <Section
          id="home-paths"
          title={TITLES.outcomes}
          body={PUBLIC_HOME_OUTCOMES_INTRO}
        >
          <div className="cocalc-home-outcomes">
            {content.outcomes.map((item) => (
              <Item key={item.title} item={item} className="cocalc-home-card" />
            ))}
          </div>
        </Section>
        <Section
          id="home-evaluate"
          title={TITLES.evaluation}
          body={PUBLIC_HOME_EVALUATION_INTRO}
        >
          <nav
            aria-label="Capability guides and implementation documentation"
            className="cocalc-home-directory"
          >
            {content.directories.map((group) => (
              <div key={group.title}>
                <h3>{group.title}</h3>
                <ul>
                  {group.links.map((link) => (
                    <li key={link.href}>
                      <a href={appPath(link.href)}>{link.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <details className="cocalc-home-details">
            <summary>{content.agents.title}</summary>
            {content.agents.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            <div className="cocalc-home-details-links">
              {content.agents.links.map((link) => (
                <a key={link.href} href={appPath(link.href)}>
                  {link.label}
                </a>
              ))}
            </div>
          </details>
        </Section>
        {content.deployment && (
          <Section
            id="home-run"
            title={TITLES.deployment}
            body={content.deployment.body}
          >
            <a href={appPath(content.deployment.link.href)}>
              {content.deployment.link.label}
            </a>
          </Section>
        )}
        <section
          id="home-final"
          className="cocalc-home-section cocalc-home-final"
          aria-labelledby="home-final-title"
        >
          <div>
            <h2 id="home-final-title">{TITLES.final}</h2>
            {content.trustHref && (
              <p>
                <a href={appPath(content.trustHref)}>
                  {PUBLIC_HOME_TRUST_LABEL}
                </a>
              </p>
            )}
          </div>
          <div className="cocalc-home-actions">
            {content.primary && <Action link={content.primary} primary />}
            <Action link={PUBLIC_HOME_CONTACT} />
          </div>
        </section>
      </div>
    </PublicPage>
  );
}
