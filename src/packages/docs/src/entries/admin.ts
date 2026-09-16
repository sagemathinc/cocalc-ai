/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon } from "../helpers";
import {
  ADMIN_BACKUP_SHARDS_BODY,
  ADMIN_BAY_OPS_BODY,
  ADMIN_CLI_BODY,
  ADMIN_CRM_BODY,
  ADMIN_CRM_OUTREACH_BODY,
  ADMIN_CRM_OUTREACH_UI_BODY,
  ADMIN_CRM_UI_BODY,
  ADMIN_MANAGED_EGRESS_BODY,
  ADMIN_MEMBERSHIP_AND_LICENSES_BODY,
  ADMIN_NEWS_BODY,
  ADMIN_OVERVIEW_BODY,
  ADMIN_RECEIVABLES_BODY,
  ADMIN_REGISTRATION_TOKENS_BODY,
  ADMIN_ROOTFS_BODY,
  ADMIN_SIGNUP_EMERGENCY_CONTROLS_BODY,
  ADMIN_SOFTWARE_COMMAND_BODY,
  ADMIN_SITE_SETTINGS_BODY,
  ADMIN_SSO_BODY,
  ADMIN_USERS_BODY,
} from "../content";

export const ADMIN_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "teams"],
    body: ADMIN_OVERVIEW_BODY.trim(),
    category: "Admin",
    id: "admin.overview",
    image: docsIcon(
      "/public/docs/browser-automation-5dc255b9.webp",
      "Admin tools connected to operational checks and site controls",
    ),
    lastReviewed: "2026-05-26",
    noActionReason:
      "Overview page; specific admin task pages expose the executable destinations.",
    slug: "admin/overview",
    status: "ready",
    summary:
      "Understand the admin docs surface and the safety model for site operations.",
    title: "Admin operations overview",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> News manager.",
        executable: true,
        id: "admin.news.open",
        label: "Open news manager",
      },
      {
        description: "Open the Admin -> News editor for a new system notice.",
        executable: true,
        id: "admin.news.create-system",
        label: "Create system notice",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_NEWS_BODY.trim(),
    category: "Admin",
    id: "admin.news",
    image: docsIcon(
      "/public/docs/docs-browser-74a65d58.webp",
      "A site-wide message card prepared for CoCalc users",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/news",
    status: "ready",
    summary:
      "Create public news, events, and in-app system notices for a CoCalc site.",
    title: "Manage news and system notices",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Site Settings section.",
        executable: true,
        id: "admin.site-settings.open",
        label: "Open site settings",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_SITE_SETTINGS_BODY.trim(),
    category: "Admin",
    id: "admin.site-settings",
    image: docsIcon(
      "/public/docs/runtime-image-09add8c9.webp",
      "Site configuration controls with cloud and runtime settings",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/site-settings",
    status: "ready",
    summary:
      "Use the admin site settings section and configuration wizards safely.",
    title: "Configure site settings",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> User Search section.",
        executable: true,
        id: "admin.users.open",
        label: "Open user search",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_USERS_BODY.trim(),
    category: "Admin",
    id: "admin.users",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "Admin user cards with account support controls",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/users",
    status: "ready",
    summary:
      "Find accounts and use impersonation, password reset, 2FA removal, ban, project, and billing tools.",
    title: "Manage users as an admin",
    visibility: "admin",
  },
  {
    audiences: ["agents", "teams"],
    body: ADMIN_CLI_BODY.trim(),
    category: "Admin",
    id: "admin.cocalc-cli",
    image: docsIcon(
      "/public/docs/cocalc-cli-862b8d4e.webp",
      "An admin terminal inspecting bays, accounts, and project hosts",
    ),
    lastReviewed: "2026-05-26",
    noActionReason:
      "Command-line cookbook; the correct action is to run the shown cocalc-cli command in an authenticated shell.",
    slug: "admin/cocalc-cli",
    status: "ready",
    summary:
      "Use cocalc-cli for admin inspection, fresh auth, bay listing, account location, and rehome smoke tests.",
    title: "Admin cocalc-cli cookbook",
    visibility: "admin",
  },
  {
    audiences: ["agents", "teams"],
    body: ADMIN_RECEIVABLES_BODY.trim(),
    category: "Admin",
    id: "admin.accounts-receivable",
    image: docsIcon(
      "/public/docs/cocalc-cli-862b8d4e.webp",
      "A commercial receivables queue with invoicing, collection, and fulfillment state",
    ),
    lastReviewed: "2026-08-26",
    noActionReason:
      "Admin operations runbook; use the documented cocalc admin receivables commands or Admin -> Accounts Receivable.",
    searchKeywords:
      "accounts receivable commercial orders AR quotes Stripe Quotes PDF invoices Invoicing Plus customer acceptance payments manual settlement site license fulfillment procurement purchase order PO billing contacts collections reconciliation Zendesk adoption pilot",
    slug: "admin/accounts-receivable",
    status: "ready",
    summary:
      "Operate the shared commercial-order, invoicing, collection, and site-license fulfillment workflow safely.",
    title: "Operate accounts receivable",
    visibility: "admin",
  },
  {
    audiences: ["teams"],
    body: ADMIN_CRM_UI_BODY.trim(),
    category: "Admin",
    id: "admin.crm-ui",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "A customer relationship workspace with people, pipeline, follow-up, linked systems, and timeline",
    ),
    lastReviewed: "2026-08-25",
    noActionReason:
      "Admin UI guide; perform the documented workflow in Admin -> Customers.",
    searchKeywords:
      "CRM customer relationship UI Customer 360 organization institution contacts opportunity adoption pilot renewal task timeline Zendesk commercial orders site licenses",
    slug: "admin/crm-ui",
    status: "ready",
    summary:
      "Use the Customers queue and Customer 360 workspace to coordinate institutional relationships safely.",
    title: "Use the customer relationships workspace",
    visibility: "admin",
  },
  {
    audiences: ["agents", "teams"],
    body: ADMIN_CRM_OUTREACH_BODY.trim(),
    category: "Admin",
    id: "admin.crm-outreach",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "A reviewed CRM outreach queue connected to Zendesk and internal follow-up",
    ),
    lastReviewed: "2026-08-27",
    noActionReason:
      "Admin operations runbook; use cocalc admin crm outreach or Admin -> Customers -> Outreach.",
    searchKeywords:
      "CRM outreach proactive Zendesk institutional prospects adoption pilot follow-up viewed no reply MyReadReceipt suppression opt out bounce complaint rate limit throttle template batch",
    slug: "admin/crm-outreach",
    status: "ready",
    summary:
      "Initiate reviewed institutional conversations with shared visibility, safe throttling, and durable follow-up.",
    title: "Operate CRM outreach",
    visibility: "admin",
  },
  {
    audiences: ["teams"],
    body: ADMIN_CRM_OUTREACH_UI_BODY.trim(),
    category: "Admin",
    id: "admin.crm-outreach-ui",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "A reviewed outreach workspace with deliveries, batches, templates, suppressions, and follow-up",
    ),
    lastReviewed: "2026-08-26",
    noActionReason:
      "Admin UI guide; perform the documented workflow in Admin -> Customers -> Outreach.",
    searchKeywords:
      "CRM outreach UI proactive Zendesk compose review approve queue delivery batch template suppression opt out follow-up viewed no reply institutional prospect adoption pilot",
    slug: "admin/crm-outreach-ui",
    status: "ready",
    summary:
      "Use the Outreach workspace to compose, review, suppress, and follow up on proactive institutional conversations safely.",
    title: "Use the CRM outreach workspace",
    visibility: "admin",
  },
  {
    audiences: ["agents", "teams"],
    body: ADMIN_CRM_BODY.trim(),
    category: "Admin",
    id: "admin.crm",
    image: docsIcon(
      "/public/docs/collaborators-8ce1955f.webp",
      "A customer relationship overview joining contacts, opportunities, tasks, and commercial systems",
    ),
    lastReviewed: "2026-08-27",
    noActionReason:
      "Admin operations runbook; use cocalc admin crm or Admin -> Customers.",
    searchKeywords:
      "CRM customer relationship organization institution domain contacts opportunity adoption pilot renewal expansion task timeline Zendesk Stripe commercial orders site licenses customer 360",
    slug: "admin/crm",
    status: "ready",
    summary:
      "Operate CoCalc's seed-global customer identity, opportunity, follow-up, linking, and Customer 360 workflow safely.",
    title: "Operate customer relationships",
    visibility: "admin",
  },
  {
    audiences: ["agents", "teams"],
    body: ADMIN_SOFTWARE_COMMAND_BODY.trim(),
    category: "Admin",
    id: "admin.cocalc-software",
    image: docsIcon(
      "/public/docs/cocalc-cli-862b8d4e.webp",
      "A terminal managing CoCalc software artifacts and deployments",
    ),
    lastReviewed: "2026-09-11",
    noActionReason:
      "Command-line runbook; run the shown cocalc software commands in an authenticated source checkout.",
    searchKeywords:
      "software deploy rollout canary readiness health build push history rollback smoke artifacts release channels R2 bay project-host cli launchpad plus star",
    slug: "admin/cocalc-software",
    status: "ready",
    summary:
      "Understand deployment effects, canary campaigns, and readiness evidence while managing CoCalc software releases.",
    title: "Manage software releases with cocalc software",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Bay Operations section.",
        executable: true,
        id: "admin.bay-ops.open",
        label: "Open bay operations",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_BAY_OPS_BODY.trim(),
    category: "Admin",
    id: "admin.bay-ops",
    image: docsIcon(
      "/public/docs/browser-automation-5dc255b9.webp",
      "Bay operation status with ownership and rehome checks",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/bay-ops",
    status: "ready",
    summary:
      "Inspect bay health, ownership counts, rehome operations, backup health, and load projections.",
    title: "Inspect bay operations",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Images section.",
        executable: true,
        id: "admin.rootfs.open",
        label: "Open images",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_ROOTFS_BODY.trim(),
    category: "Admin",
    id: "admin.rootfs",
    image: docsIcon(
      "/public/docs/runtime-image-09add8c9.webp",
      "Runtime image catalog entries cached across project hosts",
    ),
    lastReviewed: "2026-05-26",
    searchKeywords:
      "rootfs admin project images runtime images managed image catalog host scans visibility blocking deletion retention",
    slug: "admin/rootfs",
    status: "ready",
    summary:
      "Manage project image catalog entries, host scans, visibility, blocking, deletion, and retention.",
    title: "Administer project images",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Backup Shards section.",
        executable: true,
        id: "admin.project-backup-shards.open",
        label: "Open backup shards",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_BACKUP_SHARDS_BODY.trim(),
    category: "Admin",
    id: "admin.project-backup-shards",
    image: docsIcon(
      "/public/docs/project-files-6c4ff552.webp",
      "Backup shard storage routes connected to project folders",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/project-backup-shards",
    status: "ready",
    summary:
      "Inspect project backup shard configuration and connect shard health to bay operations.",
    title: "Review backup shards",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Registration Tokens section.",
        executable: true,
        id: "admin.registration-tokens.open",
        label: "Open registration tokens",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_REGISTRATION_TOKENS_BODY.trim(),
    category: "Admin",
    id: "admin.registration-tokens",
    image: docsIcon(
      "/public/docs/project-secrets-ea9872ae.webp",
      "A registration token card granting controlled site access",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/registration-tokens",
    status: "ready",
    summary:
      "Create and review targeted signup tokens for cohorts, classrooms, pilots, and restricted sites.",
    title: "Manage registration tokens",
    visibility: "admin",
  },
  {
    audiences: ["agents", "teams"],
    body: ADMIN_SIGNUP_EMERGENCY_CONTROLS_BODY.trim(),
    category: "Admin",
    id: "admin.signup-emergency-controls",
    image: docsIcon(
      "/public/docs/project-secrets-ea9872ae.webp",
      "Emergency signup controls with registration token and site setting safeguards",
    ),
    lastReviewed: "2026-06-10",
    noActionReason:
      "Runbook page; use the linked Admin -> Registration Tokens and Admin -> Site Settings pages for executable navigation.",
    slug: "admin/signup-emergency-controls",
    status: "ready",
    summary:
      "Close, restrict, verify, and reopen signup paths during a launch incident.",
    title: "Signup emergency controls",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Membership Tiers section.",
        executable: true,
        id: "admin.membership-tiers.open",
        label: "Open membership tiers",
      },
      {
        description: "Open the Admin -> Software Licenses section.",
        executable: true,
        id: "admin.software-licenses.open",
        label: "Open software licenses",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_MEMBERSHIP_AND_LICENSES_BODY.trim(),
    category: "Admin",
    id: "admin.membership-licenses",
    image: docsIcon(
      "/public/docs/project-hosts-684faa4c.webp",
      "Membership and license controls for account capabilities",
    ),
    lastReviewed: "2026-05-26",
    slug: "admin/membership-licenses",
    status: "ready",
    summary:
      "Understand membership tiers, software licenses, dedicated-host limits, and commercial access policies.",
    title: "Manage membership and licenses",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> Network Egress section.",
        executable: true,
        id: "admin.managed-egress.open",
        label: "Open network egress",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_MANAGED_EGRESS_BODY.trim(),
    category: "Admin",
    id: "admin.managed-egress",
    image: docsIcon(
      "/public/docs/connectivity-eaca154f.webp",
      "Network egress activity grouped by accounts, projects, and categories",
    ),
    lastReviewed: "2026-05-27",
    slug: "admin/managed-egress",
    status: "ready",
    summary:
      "Use the admin Network Egress overview to investigate recent account, project, and category network usage.",
    title: "Monitor network egress",
    visibility: "admin",
  },
  {
    actions: [
      {
        description: "Open the Admin -> SSO Providers & Domains section.",
        executable: true,
        id: "admin.sso.open",
        label: "Open SSO settings",
      },
    ],
    audiences: ["agents", "teams"],
    body: ADMIN_SSO_BODY.trim(),
    category: "Admin",
    id: "admin.sso",
    image: docsIcon(
      "/public/docs/http-api-5067e8ed.webp",
      "An identity provider connection with domain policy controls",
    ),
    lastReviewed: "2026-05-27",
    slug: "admin/sso",
    status: "ready",
    summary:
      "Configure SSO providers and domain policies without locking users out.",
    title: "Configure SSO providers and domains",
    visibility: "admin",
  },
];
