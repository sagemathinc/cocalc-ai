/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { CANONICAL_PUBLIC_SITE_ORIGIN } from "./public-site-policy";

// The words of the About and team pages. The React page and the crawler
// fallback in hub/servers/app/public-prerender.ts both render these strings,
// so the two stay word for word the same.

export const PUBLIC_ABOUT_HEADLINE =
  "We build the agent platform where your agents work alongside your team.";

// A run of text, and a link when it has a path. The path is a site path, such
// as "docs/ai/claude-code"; each renderer adds the site's base path.
export interface PublicAboutTextPart {
  path?: string;
  text: string;
}

const PUBLIC_ABOUT_INTRO_START =
  "You start an agent with a request, and it works in a persistent, shared CoCalc project with your files, installed software, terminals, and a web browser. Share the agent with colleagues, and they can review what it delivers and continue the work.";

// The lead under the headline. Codex is built in on every site. Claude is
// named only on cocalc.ai (isPublicCocalcAiSite in public-home-content.ts,
// whose result renderers pass in), and links to the Claude guide, which
// states its preview status.
export function getPublicAboutIntro(
  onCocalcAi: boolean,
): readonly PublicAboutTextPart[] {
  if (!onCocalcAi) {
    return [{ text: `${PUBLIC_ABOUT_INTRO_START} Codex is built in.` }];
  }
  return [
    { text: `${PUBLIC_ABOUT_INTRO_START} Codex is built in, and ` },
    { path: "docs/ai/claude-code", text: "Claude" },
    { text: " is available where the site enables it." },
  ];
}

export const PUBLIC_ABOUT_REASON =
  "Important technical work should not depend on one laptop, one installation, or context trapped in a chat window. The environment itself should be durable, collaborative, inspectable, and ready for whoever works next.";

export const PUBLIC_ABOUT_PRINCIPLES_HEADLINE =
  "Three principles behind the agent platform.";

export const PUBLIC_ABOUT_PRINCIPLES = [
  {
    body: "Each agent works in a CoCalc project with your files, installed software, and terminals. When a task needs a web browser, the agent drives one in the project while you watch, and you can take over at any moment, then hand it back. Browsing the web needs a project with internet access.",
    icon: "server",
    title: "Agents need a real place to work.",
  },
  {
    body: "Named agents stay in your Agents list. Share one with colleagues, and they join the same conversation and project to review what it delivers, guide it, and continue the work. Each person's turns use their own payment choice.",
    icon: "users",
    title: "Agents belong to the team.",
  },
  {
    body: "An agent has full access to its own project. To let it work in other projects, give it CoCalc access to the ones you choose, read-only files or full runtime, without creating an API key. That access ends when its turn does; grant it only from a project whose collaborators you trust.",
    icon: "key",
    title: "People decide what agents can reach.",
  },
] as const;

export interface PublicAboutFact {
  detail: string;
  // A site path that the fact links to.
  path?: string;
  value: string;
}

const PUBLIC_ABOUT_FACTS: readonly PublicAboutFact[] = [
  {
    detail: "Independent security audit",
    path: "policies/trust",
    value: "SOC 2",
  },
  {
    detail: "Verified privacy program",
    path: "policies/trust",
    value: "GDPR",
  },
  { detail: "Hosted and customer-operated", value: "Flexible deployment" },
];

// The trust section, after the principles. Paths are site paths.
export const PUBLIC_ABOUT_TRUST = {
  eyebrow: "Built for the long term",
  facts: PUBLIC_ABOUT_FACTS,
  headline: "A mature company behind your team and its agents.",
  intro:
    "SageMath, Inc. develops and operates CoCalc with the security, privacy, deployment flexibility, and operational discipline expected by individuals and institutions.",
  link: { label: "Trust and compliance", path: "policies/trust" },
  note: {
    body: "Review independent assurance, privacy commitments, and data processing terms.",
    title: "Security and privacy are operating requirements.",
  },
} as const;

export const PUBLIC_ABOUT_AUDIENCES = [
  {
    body: "Individual researchers and collaborative groups running experiments, papers, and long-lived computational projects.",
    icon: "experiment",
    title: "Research",
  },
  {
    body: "Courses, workshops, departments, and instructors who need consistent environments and collaborative support.",
    icon: "graduation-cap",
    title: "Education",
  },
  {
    body: "Engineering, data, and R&D groups that combine code, documents, compute, and AI-assisted work.",
    icon: "users",
    title: "Technical teams",
  },
  {
    body: "Universities, laboratories, companies, and public-sector organizations with deployment and governance requirements.",
    icon: "bank",
    title: "Institutions",
  },
] as const;

// The company's history, after the audiences.
export const PUBLIC_ABOUT_HISTORY = {
  eyebrow: "Our path",
  headline: "Built from computational mathematics, for work far beyond it.",
  timeline: [
    {
      body: "SageMathCloud launches, bringing open technical software into a collaborative browser workspace.",
      year: "2013",
    },
    {
      body: "William leaves his full professorship to focus on SageMath, Inc. and CoCalc full-time.",
      year: "2019",
    },
    {
      body: "CoCalc is rebuilt with agents at its core: they work in the same persistent, shared projects as the people who direct them.",
      year: "Today",
    },
  ],
} as const;

export interface PublicTeamMemberSummary {
  cardText: string;
  imageAlt: string;
  imageSrc: string;
  metadataDescription: string;
  name: string;
  slug: string;
  title: string;
}

export const PUBLIC_TEAM_MEMBERS = [
  {
    cardText:
      "William Stein is the founder of CoCalc and SageMath, Inc. A Berkeley-trained mathematician with over 15 years in teaching and research, his work in number theory and computational science led him from academia to building open tools for technical computing.",
    imageAlt: "William Stein with his dog, Bella.",
    imageSrc: "/public/about/william-stein.png",
    metadataDescription:
      "Meet William Stein, founder and CEO of SageMath, Inc. and the creator of CoCalc and SageMath.",
    name: "William Stein",
    slug: "william-stein",
    title: "Founder and CEO",
  },
  {
    cardText:
      "Blaec leads sales and partnerships at SageMath, Inc. He holds an M.S. in Mathematics from Oregon State University, where his work applied numerical analysis and partial differential equations to model physical phenomena — technical grounding he brings to how he helps teams evaluate and adopt CoCalc.",
    imageAlt: "A portrait of Blaec Bejarano.",
    imageSrc: "/public/about/blaec-bejarano.png",
    metadataDescription:
      "Meet Blaec Bejarano, Chief Sales Officer at SageMath, Inc., leading CoCalc sales, partnerships, and technical adoption.",
    name: "Blaec Bejarano",
    slug: "blaec-bejarano",
    title: "CSO",
  },
] as const satisfies readonly PublicTeamMemberSummary[];

export function getPublicTeamMember(
  slug?: string,
): PublicTeamMemberSummary | undefined {
  return PUBLIC_TEAM_MEMBERS.find((member) => member.slug === slug);
}

// Team profiles that are no longer published. Their URLs redirect
// permanently to the team page (getPublicPermanentRedirectPath in
// public-site-metadata.ts), on the server and in the client router, so
// existing links keep working.
export const UNPUBLISHED_TEAM_PROFILE_SLUGS: readonly string[] = [
  "andrey-novoseltsev",
  "harald-schilly",
];

export function isUnpublishedTeamProfile(slug?: string): boolean {
  return slug != null && UNPUBLISHED_TEAM_PROFILE_SLUGS.includes(slug);
}

// Quotes, purchase orders, and invoices go to SageMath, Inc.'s support page
// rather than to one person's address. The team page and its crawler fallback
// both show this line. On cocalc.ai (isPublicCocalcAiSite) it links the site's
// own support page, `path`. Every other site's support page belongs to the
// site's operator, so there it links cocalc.ai's, `url`.
export const PUBLIC_TEAM_BILLING_CONTACT = {
  label: "contact support",
  path: "support",
  text: "For quotes, purchase orders, and invoices,",
  url: `${CANONICAL_PUBLIC_SITE_ORIGIN}/support`,
} as const;
