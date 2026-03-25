/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface PublicLink {
  href: string;
  label: string;
}

export interface PublicPolicySection {
  bullets?: string[];
  links?: PublicLink[];
  paragraphs?: string[];
  title: string;
}

export interface PublicPolicyPage {
  slug: string;
  summary: string;
  title: string;
  updated?: string;
  sections: PublicPolicySection[];
}

export const POLICY_PAGES: PublicPolicyPage[] = [
  {
    slug: "accessibility",
    title: "Accessibility",
    updated: "July 3, 2019",
    summary:
      "CoCalc accessibility information, including VPAT-related material and support contacts.",
    sections: [
      {
        title: "Accessibility commitment",
        paragraphs: [
          "CoCalc is used in technical teaching and research environments where accessibility matters. We want institutions and individual users to be able to evaluate the platform clearly for their specific workflows.",
          "The historical Next.js page centered on the Voluntary Product Accessibility Template (VPAT). That material remains part of the accessibility story, but practical evaluation should also include the exact tools and workflows you expect to use.",
        ],
      },
      {
        title: "What to review",
        bullets: [
          "Keyboard navigation in the specific editors and workflows your users depend on",
          "Screen-reader compatibility for the main product surfaces you care about",
          "Institutional documentation or procurement requirements related to accessibility review",
        ],
      },
      {
        title: "Questions",
        paragraphs: [
          "If you need accessibility documentation or want to discuss whether a particular workflow is a good fit, contact the CoCalc team directly.",
        ],
        links: [
          { href: "mailto:office@sagemath.com", label: "office@sagemath.com" },
        ],
      },
    ],
  },
  {
    slug: "copyright",
    title: "Copyright policy",
    updated: "April 2, 2015",
    summary:
      "How SageMath, Inc. handles copyright complaints and DMCA notices.",
    sections: [
      {
        title: "Copyright complaints",
        paragraphs: [
          "SageMath, Inc. respects the intellectual property rights of others and expects users to do the same.",
          "In appropriate circumstances, accounts that repeatedly infringe copyrights may be disabled or terminated.",
        ],
      },
      {
        title: "What a DMCA notice should include",
        bullets: [
          "Identification of the copyrighted work claimed to be infringed",
          "Identification of the allegedly infringing material and enough information for us to locate it",
          "Your mailing address, telephone number, and email address",
          "Statements of good-faith belief and accuracy under penalty of perjury",
          "Your full legal name and physical or electronic signature",
        ],
      },
      {
        title: "Where to send notices",
        paragraphs: [
          "Deliver completed notices to SageMath, Inc.'s designated copyright contact.",
        ],
        links: [
          {
            href: "mailto:copyright@sagemath.com",
            label: "copyright@sagemath.com",
          },
          {
            href: "https://www.copyright.gov/legislation/dmca.pdf",
            label: "DMCA text",
          },
        ],
      },
    ],
  },
  {
    slug: "enterprise-terms",
    title: "Enterprise terms",
    updated: "September 15, 2021",
    summary:
      "Enterprise and institutional deployments often require additional contract terms beyond the standard public terms of service.",
    sections: [
      {
        title: "What this route is for",
        paragraphs: [
          "The historical Next.js route largely mirrored the public terms page, but in practice enterprise and institutional deployments often rely on custom agreements, procurement requirements, security reviews, and deployment-specific commitments.",
          "For the new public site, this route should communicate that enterprise terms are not a generic click-through page so much as a starting point for a real commercial agreement.",
        ],
      },
      {
        title: "Typical enterprise requirements",
        bullets: [
          "Institutional procurement and invoicing requirements",
          "Security reviews, privacy questionnaires, and vendor onboarding",
          "Deployment-specific service, hosting, and compliance expectations",
          "Custom contract language when required by the customer",
        ],
      },
      {
        title: "Contact",
        paragraphs: [
          "If you need enterprise, campus-wide, or self-hosted terms, contact the team to start that process directly.",
        ],
        links: [
          { href: "mailto:office@sagemath.com", label: "office@sagemath.com" },
          { href: "/support", label: "Support" },
        ],
      },
    ],
  },
  {
    slug: "ferpa",
    title: "FERPA compliance",
    updated: "September 1, 2020",
    summary:
      "How CoCalc addresses FERPA-related questions for educational institutions.",
    sections: [
      {
        title: "Overview",
        paragraphs: [
          "Educational institutions need reasonable measures in place to protect personally identifiable information from student education records.",
          "In practice, that means schools must understand what data is shared with service providers, who can access it, and how student information is handled when platforms like CoCalc are used in courses.",
        ],
      },
      {
        title: "Important points",
        bullets: [
          "Student directory information may be shared when permitted by the institution's FERPA process",
          "Institutions remain responsible for their own FERPA obligations and disclosure processes",
          "SageMath, Inc. will make every effort to support compliance with institutional FERPA requirements",
        ],
      },
      {
        title: "Institutional requests",
        paragraphs: [
          "If you represent an academic institution and require access to student information under FERPA, contact us directly.",
        ],
        links: [
          { href: "mailto:office@sagemath.com", label: "office@sagemath.com" },
        ],
      },
    ],
  },
  {
    slug: "privacy",
    title: "Privacy policy",
    updated: "October 3, 2025",
    summary:
      "How SageMath, Inc. collects, uses, and protects personal information.",
    sections: [
      {
        title: "Purpose and scope",
        paragraphs: [
          "This privacy policy explains how SageMath, Inc. handles personal information across the site and related services, including information users provide directly and data collected through normal service operation.",
          "It applies to our business operations, websites, applications, and other online or offline offerings, subject to applicable law.",
        ],
      },
      {
        title: "Information we collect",
        bullets: [
          "Information you provide directly, such as contact details and account registration data",
          "Communications with support, surveys, and other direct interactions",
          "Usage data, device information, and similar technical information collected as you use the service",
          "Supplemental information from trusted third-party sources when needed to verify or support service delivery",
        ],
      },
      {
        title: "How information is used",
        bullets: [
          "To provide the service and operate user accounts",
          "To communicate with users about support, updates, or account matters",
          "To improve security, reliability, and the overall product",
          "To satisfy legal, contractual, and compliance obligations",
        ],
      },
      {
        title: "International transfers and providers",
        paragraphs: [
          "The historical policy also covered the Data Privacy Framework and other mechanisms for lawful international data transfer. We continue to rely on appropriate legal mechanisms and vendor agreements where required.",
          "Third-party providers used to operate CoCalc are described separately in the third-parties statement.",
        ],
        links: [
          { href: "/policies/thirdparties", label: "Third-parties statement" },
          {
            href: "https://www.dataprivacyframework.gov/",
            label: "Data Privacy Framework",
          },
        ],
      },
      {
        title: "Questions",
        paragraphs: [
          "If you have questions about privacy, data handling, or institutional review, contact SageMath, Inc.",
        ],
        links: [
          { href: "mailto:office@sagemath.com", label: "office@sagemath.com" },
        ],
      },
    ],
  },
  {
    slug: "terms",
    title: "Terms of service",
    updated: "January 27, 2025",
    summary: "The core terms governing use of CoCalc and related services.",
    sections: [
      {
        title: "Agreement and eligibility",
        paragraphs: [
          "By using the service, you agree to the terms of service. If you use the service on behalf of an organization, you represent that you have authority to bind that organization.",
          "Users must satisfy the applicable age and legal eligibility requirements described in the terms.",
        ],
      },
      {
        title: "Accounts, workspaces, and files",
        paragraphs: [
          "CoCalc accounts provide access to collaborative workspaces and files, including notebooks, documents, terminals, and code in multiple languages.",
          "Users remain responsible for activity under their accounts and for the content they create or share through the service.",
        ],
      },
      {
        title: "Collaboration and public posting",
        bullets: [
          "Collaborators may be granted access to files and workspaces under the license terms you choose",
          "Posting work publicly grants broader rights to other users and the general public under the applicable license model",
          "Public posting should be treated carefully because some granted rights continue even if content is later unpublished",
        ],
      },
      {
        title: "API and service usage",
        paragraphs: [
          "Use of the HTTP API and other programmatic interfaces is governed by the same overall terms, with additional restrictions on abuse and unauthorized access.",
          "Commercial use, hosted resources, subscriptions, and pay-as-you-go services may also be subject to additional billing terms.",
        ],
      },
      {
        title: "Payments and changes",
        paragraphs: [
          "The detailed terms cover subscriptions, licenses, pay-as-you-go services, billing changes, refunds, and fee changes. Review those terms carefully if you use paid features.",
          "We may modify the terms or parts of the service over time, and continued use after such changes indicates agreement to the updated terms.",
        ],
      },
    ],
  },
  {
    slug: "thirdparties",
    title: "Third-parties statement",
    summary:
      "An overview of the third-party providers and services used to operate CoCalc.",
    sections: [
      {
        title: "Essential infrastructure",
        bullets: [
          "Cloudflare for DDoS protection and traffic handling",
          "Google Cloud Platform for hosted compute and storage resources",
          "reCAPTCHA and similar anti-abuse protections where needed",
        ],
      },
      {
        title: "Payments and communication",
        bullets: [
          "Stripe for payment processing",
          "Amazon Web Services, Google Workspace, and Twilio SendGrid for communication and email infrastructure",
          "Zendesk for support ticket handling",
        ],
      },
      {
        title: "Extra services and AI",
        paragraphs: [
          "Some optional features involve additional providers such as avatar services or AI model providers. These are feature-specific rather than ambient background integrations.",
          "In particular, AI interactions in CoCalc are explicit: you choose when to invoke them and what context to send.",
        ],
      },
      {
        title: "Privacy and agreements",
        paragraphs: [
          "For each provider, the historical page linked to privacy notices and data processing agreements. Those remain the right documents to consult when doing institutional review.",
        ],
        links: [
          {
            href: "https://www.cloudflare.com/privacypolicy/",
            label: "Cloudflare privacy policy",
          },
          {
            href: "https://cloud.google.com/terms/cloud-privacy-notice",
            label: "Google Cloud privacy notice",
          },
          {
            href: "https://stripe.com/us/privacy",
            label: "Stripe privacy policy",
          },
          {
            href: "https://www.zendesk.com/company/agreements-and-terms/privacy-notice/",
            label: "Zendesk privacy notice",
          },
        ],
      },
    ],
  },
  {
    slug: "trust",
    title: "Trust and compliance",
    summary: "Security, compliance, and external trust resources for CoCalc.",
    sections: [
      {
        title: "Security posture",
        paragraphs: [
          "The old Next.js page focused on GDPR verification, SOC 2, and the public trust center. That remains the right structure for this route.",
          "The trust page should help institutions and technical buyers understand where to find security and compliance information quickly.",
        ],
      },
      {
        title: "Current highlights",
        bullets: [
          "GDPR-related compliance review through the external representative process described on the historical page",
          "SOC 2 compliance and related operational controls",
          "A separate trust center for current documents and status",
        ],
      },
      {
        title: "More information",
        links: [
          { href: "https://trust.cocalc.com/", label: "Trust Center" },
          { href: "https://gdpr-info.eu/", label: "GDPR information" },
          {
            href: "https://www.vanta.com/collection/soc-2/what-is-soc-2",
            label: "What SOC 2 means",
          },
          { href: "mailto:office@sagemath.com", label: "office@sagemath.com" },
        ],
      },
    ],
  },
];

const POLICY_PAGE_MAP = new Map(POLICY_PAGES.map((page) => [page.slug, page]));

export function getPolicyPage(slug?: string): PublicPolicyPage | undefined {
  if (!slug) return;
  return POLICY_PAGE_MAP.get(slug);
}
