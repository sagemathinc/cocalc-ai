/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";
import type {
  PlatformMode,
  ProjectHostsFundingMode,
} from "@cocalc/util/db-schema/site-defaults";
import type { SignupEmailDomainPublicPolicy } from "@cocalc/util/accounts/signup-email-domain-policy";
import type { Strategy } from "@cocalc/util/types/sso";

Table({
  name: "passport_settings",
  rules: {
    primary_key: "strategy",
  },
  fields: {
    strategy: {
      type: "string",
      desc: "a unique lower-case alphanumeric space-free identifier",
    },
    conf: {
      type: "map",
      desc: "legacy Passport strategy configuration; not used by the current SSO runtime",
    },
    info: {
      type: "map",
      desc: "legacy public information for this strategy; not used by the current SSO runtime",
    },
  },
});

Table({
  name: "passport_store",
  rules: {
    primary_key: "key",
  },
  fields: {
    key: {
      type: "string",
      desc: "an arbitrary key",
    },
    value: {
      type: "string",
      desc: "an arbitrary value as a string",
    },
    expire: {
      type: "timestamp",
      desc: "when this key expires",
    },
  },
});

Table({
  name: "server_settings",
  rules: {
    primary_key: "name",
    anonymous: false,
    user_query: {
      // NOTE: can *set* but cannot get!
      set: {
        admin: true,
        fields: {
          name: null,
          value: null,
        },
      },
    },
  },
  fields: {
    name: {
      type: "string",
    },
    value: {
      type: "string",
    },
    readonly: {
      type: "boolean",
      desc: "If true, the user interface should not allow to edit that value – it is controlled externally or via an environment variable.",
    },
  },
});

export interface Customize {
  siteName?: string;
  siteDescription?: string;
  organizationName?: string;
  organizationEmail?: string;
  organizationURL?: string;
  policy_pages?: string;
  termsOfServiceURL?: string;
  helpEmail?: string;
  contactEmail?: string;
  isCommercial?: boolean;
  stripe_enabled?: boolean;
  kucalc?: PlatformMode;
  platform_mode?: PlatformMode;
  logoSquareURL?: string;
  logoRectangularURL?: string;
  splashImage?: string;
  indexInfo?: string;
  indexTagline?: string;
  imprint?: string;
  policies?: string;
  shareServer?: boolean;
  legacy_migration_enabled?: boolean;
  collaborators_enabled?: boolean;
  people_scan_enabled?: boolean;
  commercial_receivables_visible?: boolean;
  commercial_receivables_mutations_enabled?: boolean;
  commercial_receivables_stripe_drafts_enabled?: boolean;
  commercial_receivables_stripe_send_enabled?: boolean;
  commercial_receivables_stripe_quotes_enabled?: boolean;
  commercial_receivables_stripe_quote_finalize_enabled?: boolean;
  commercial_receivables_stripe_quote_accept_enabled?: boolean;
  commercial_receivables_manual_settlement_enabled?: boolean;
  commercial_receivables_reconciliation_enabled?: boolean;
  commercial_receivables_fulfillment_enabled?: boolean;
  crm_visible?: boolean;
  crm_mutations_enabled?: boolean;
  crm_pipeline_mutations_enabled?: boolean;
  crm_zendesk_linking_enabled?: boolean;
  crm_commercial_integration_enabled?: boolean;
  crm_metric_projections_enabled?: boolean;
  crm_exports_enabled?: boolean;
  crm_backfill_enabled?: boolean;
  crm_outreach_enabled?: boolean;
  crm_outreach_mutations_enabled?: boolean;
  crm_outreach_delivery_enabled?: boolean;
  crm_outreach_webhook_enabled?: boolean;
  crm_outreach_max_recipients_per_batch?: number;
  crm_outreach_send_per_minute?: number;
  crm_outreach_send_per_hour?: number;
  crm_outreach_send_per_day?: number;
  crm_outreach_send_per_domain_per_day?: number;
  crm_outreach_contact_cooldown_days?: number;
  crm_outreach_default_followup_days?: number;
  crm_outreach_default_max_followups?: number;
  crm_outreach_default_final_review_days?: number;
  crm_outreach_worker_concurrency?: number;
  crm_outreach_worker_batch_size?: number;
  crm_outreach_retry_max_attempts?: number;
  crm_outreach_retry_base_seconds?: number;
  crm_outreach_zendesk_submitter_id?: string;
  crm_outreach_zendesk_group_id?: string;
  crm_outreach_zendesk_form_id?: string;
  crm_outreach_zendesk_support_address?: string;
  crm_outreach_company_postal_address?: string;
  crm_outreach_footer_markdown?: string;
  crm_outreach_zendesk_webhook_secret?: string;
  crm_outreach_read_receipts_enabled?: boolean;
  crm_outreach_read_receipts_mode?: string;
  crm_outreach_read_receipts_ticket_field_ids?: string;
  crm_outreach_read_receipts_integration_id?: string;
  legacy_migration_page_message?: string;
  dns?: string;
  siteURL?: string;
  googleAnalytics?: string;
  emailSignup?: boolean;
  accountCreationInstructions?: string;
  signInInstructions?: string;
  signupEmailDomainPolicy?: SignupEmailDomainPublicPolicy;
  zendesk?: boolean; // true if zendesk support is configured.
  stripePublishableKey?: string;
  imprint_html?: string;
  policies_html?: string;
  reCaptchaKey?: string;
  verifyEmailAddresses?: boolean;
  cookieBannerEnabled?: boolean;
  cookieBannerText?: string;
  strategies?: Strategy[];
  openaiEnabled?: boolean;
  googleVertexaiEnabled?: boolean;
  mistralEnabled?: boolean;
  anthropicEnabled?: boolean;
  ollamaEnabled?: boolean;
  githubProjectId?: string;
  support?: string;
  supportVideoCall?: string;
  project_hosts_nebius_enabled?: boolean;
  "project_hosts_google-cloud_enabled"?: boolean;
  project_hosts_gcp_surcharge_percent?: number;
  project_hosts_nebius_surcharge_percent?: number;
  project_hosts_hyperstack_enabled?: boolean;
  project_hosts_lambda_enabled?: boolean;
  project_hosts_local_enabled?: boolean;
  project_hosts_self_host_alpha_enabled?: boolean;
  project_hosts_funding_mode?: ProjectHostsFundingMode;
  project_hosts_cloudflare_tunnel_enabled?: boolean;
  cloudflare_mode?: string;
  launchpad_cloudflare_tunnel_status?: {
    enabled: boolean;
    running: boolean;
    hostname?: string;
    error?: string | null;
  };
  version?: {
    min_browser?: number;
    recommended_browser?: number;
  };
}
