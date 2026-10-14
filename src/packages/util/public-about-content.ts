/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PUBLIC_ABOUT_HEADLINE =
  "Building the future of collaborative computation.";

export const PUBLIC_ABOUT_INTRO =
  "Since 2013, CoCalc has given researchers, educators, technical teams, and AI agents a persistent place to work together using the open-source tools they trust.";

export const PUBLIC_ABOUT_MISSION =
  "Make serious computational work easy to share, reproduce, and advance, by people and AI.";

export const PUBLIC_ABOUT_REASON =
  "Important technical work should not depend on one laptop, one installation, or context trapped in a chat window. The environment itself should be durable, collaborative, inspectable, and ready for whoever works next.";

export const PUBLIC_ABOUT_PRINCIPLES = [
  {
    body: "Persistent Linux projects keep software, data, processes, and context available for the next person or agent.",
    icon: "server",
    title: "Durable environments",
  },
  {
    body: "People and AI work with the same files, notebooks, terminals, documents, and project history.",
    icon: "users",
    title: "Shared context",
  },
  {
    body: "Researchers use the languages and open-source software their work actually requires.",
    icon: "linux",
    title: "Open tools",
  },
] as const;

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

// Quotes, purchase orders, and invoices go to the site's support page rather
// than to one person's address. The team page and its crawler fallback both
// show this line.
export const PUBLIC_TEAM_BILLING_CONTACT = {
  label: "contact support",
  path: "support",
  text: "For quotes, purchase orders, and invoices,",
} as const;
