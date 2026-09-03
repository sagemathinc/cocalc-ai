/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Default settings to customize a given site, typically a private install of CoCalc.

import jsonic from "jsonic";
import { isEqual } from "lodash";
import { LOCALE } from "@cocalc/util/consts/locale";
import { is_valid_email_address } from "@cocalc/util/misc";
import {
  parseDomainRules,
  SIGNUP_EMAIL_DOMAIN_POLICY_MODES,
} from "../accounts/signup-email-domain-policy";
import { EMAIL_AUTHENTICATION_MODES } from "../auth/email-auth";
export const ALWAYS_ALLOWED_TIMETRAVEL = 10;

export type ConfigValid = Readonly<string[]> | ((val: string) => boolean);

export type RowType = "header" | "setting";

// for filtering, exact matches
export const TAGS = [
  "Commercialization",
  "OpenAI",
  "Jupyter",
  "Email",
  "Logo",
  "Version",
  "Conat",
  "Stripe",
  "captcha",
  "Zendesk",
  "Licensing",
  "GitHub",
  "Pay as you Go",
  "Cloud",
  "Project Hosts",
  "Workspace",
  "RootFS",
  "OCI",
  "GPU",
  "Hyperstack",
  "Nebius",
  "Cloudflare",
  "Backups",
  "AI",
  "Theme",
  "On-Prem",
  "I18N",
  "Security",
  "SSH",
  "SLA",
  "Support",
  "SSO",
  "Cookie Banner",
  "Migration",
] as const;

export type Tag = (typeof TAGS)[number];

export type SiteSettingsKeys =
  | "theming"
  | "site_name"
  | "site_description"
  | "status_page_url"
  | "account_creation_email_instructions"
  | "sign_in_email_instructions"
  | "help_email"
  | "logo_square"
  | "logo_rectangular"
  | "splash_image"
  | "index_info_html"
  | "index_tagline"
  | "imprint"
  | "policies"
  | "support"
  | "support_video_call"
  | "cookie_banner_enabled"
  | "cookie_banner_text"
  | "openai_enabled"
  | "agent_openai_codex_enabled"
  | "codex_notification_toast_enabled"
  | "codex_notification_browser_enabled"
  | "google_vertexai_enabled"
  | "mistral_enabled"
  | "anthropic_enabled"
  | "ollama_enabled"
  | "custom_openai_enabled"
  | "organization_name"
  | "organization_email"
  | "organization_url"
  | "email_authentication_mode"
  | "policy_pages"
  | "terms_of_service"
  | "terms_of_service_url"
  | "commercial"
  | "google_analytics"
  | "ux_latency_telemetry_enabled"
  | "ux_latency_success_sample_rate"
  | "kucalc"
  | "i18n"
  | "dns"
  | "public_viewer_dns"
  | "datastore"
  | "versions"
  | "version_min_browser"
  | "version_recommended_browser"
  | "iframe_comm_hosts"
  | "onprem_quota_heading"
  | "default_quotas"
  | "max_upgrades"
  | "email_enabled"
  | "verify_emails"
  | "email_signup"
  | "signup_email_domain_policy_mode"
  | "signup_email_domain_allow_list"
  | "signup_email_domain_deny_list"
  | "signup_email_domain_public_message"
  | "signup_email_domain_show_allowed_domains"
  | "public_signup_without_registration_token"
  | "legacy_migration_enabled"
  | "legacy_migration_page_message"
  | "commercial_receivables_visible"
  | "commercial_receivables_mutations_enabled"
  | "commercial_receivables_stripe_drafts_enabled"
  | "commercial_receivables_stripe_send_enabled"
  | "commercial_receivables_stripe_quotes_enabled"
  | "commercial_receivables_stripe_quote_finalize_enabled"
  | "commercial_receivables_stripe_quote_accept_enabled"
  | "commercial_receivables_manual_settlement_enabled"
  | "commercial_receivables_reconciliation_enabled"
  | "commercial_receivables_fulfillment_enabled"
  | "crm_visible"
  | "crm_mutations_enabled"
  | "crm_pipeline_mutations_enabled"
  | "crm_zendesk_linking_enabled"
  | "crm_commercial_integration_enabled"
  | "crm_metric_projections_enabled"
  | "crm_exports_enabled"
  | "crm_backfill_enabled"
  | "crm_outreach_enabled"
  | "crm_outreach_mutations_enabled"
  | "crm_outreach_delivery_enabled"
  | "crm_outreach_webhook_enabled"
  | "crm_outreach_max_recipients_per_batch"
  | "crm_outreach_send_per_minute"
  | "crm_outreach_send_per_hour"
  | "crm_outreach_send_per_day"
  | "crm_outreach_send_per_domain_per_day"
  | "crm_outreach_contact_cooldown_days"
  | "crm_outreach_default_followup_days"
  | "crm_outreach_default_max_followups"
  | "crm_outreach_default_final_review_days"
  | "crm_outreach_worker_concurrency"
  | "crm_outreach_worker_batch_size"
  | "crm_outreach_retry_max_attempts"
  | "crm_outreach_retry_base_seconds"
  | "crm_outreach_zendesk_submitter_id"
  | "crm_outreach_zendesk_group_id"
  | "crm_outreach_zendesk_form_id"
  | "crm_outreach_zendesk_support_address"
  | "crm_outreach_company_postal_address"
  | "crm_outreach_footer_markdown"
  | "crm_outreach_zendesk_webhook_secret"
  | "crm_outreach_read_receipts_enabled"
  | "crm_outreach_read_receipts_mode"
  | "crm_outreach_read_receipts_ticket_field_ids"
  | "crm_outreach_read_receipts_integration_id"
  | "project_hosts_google-cloud_enabled"
  | "project_hosts_hyperstack_enabled"
  | "project_hosts_lambda_enabled"
  | "project_hosts_local_enabled"
  | "project_hosts_self_host_alpha_enabled"
  | "project_hosts_nebius_enabled"
  | "project_hosts_funding_mode"
  | "project_hosts_gcp_surcharge_percent"
  | "project_hosts_nebius_surcharge_percent"
  | "cloudflare_mode"
  | "project_hosts_app_private_hostnames_enabled"
  | "project_hosts_app_private_hostname_domain"
  | "project_hosts_app_private_hostname_bay_limit"
  | "automatic_project_archiving_enabled"
  | "automatic_project_archiving_report_only"
  | "free_project_archive_after_days"
  | "banned_project_archive_after_days"
  | "automatic_project_archiving_batch_limit"
  | "automatic_project_archiving_global_per_hour"
  | "automatic_project_archiving_per_host_concurrency"
  | "automatic_project_archiving_canary_bays"
  | "automatic_project_archiving_canary_hosts"
  | "launcher_default_quick_create"
  | "project_rootfs_default_image"
  | "project_rootfs_default_image_gpu"
  | "project_rootfs_prepull_images"
  | "samesite_remember_me"
  | "browser_raw_exec_policy";

type Mapping = { [key: string]: string | number | boolean };

type ToVal = boolean | string | number | string[] | Mapping;
type ToValFunc<T> = (
  val?: string,
  config?: { [key in SiteSettingsKeys]?: string },
) => T;

export type RequiredWhen = {
  key: string;
  equals?: string | string[];
  present?: boolean;
};

export interface Config {
  readonly name: string;
  readonly desc: string;
  // there must be a default value, even if it is just ''
  readonly default: string;
  // list of allowed strings or a validator function
  readonly valid?: ConfigValid;
  // optional display labels for valid values
  readonly valid_labels?: Readonly<Record<string, string>>;
  readonly password?: boolean;
  readonly show?: (conf: any) => boolean;
  // this optional function derives the actual value of this setting from current value or from a global (unprocessed) setting.
  readonly to_val?: ToValFunc<ToVal>;
  // this optional function derives the visual representation for the admin (fallback: to_val)
  readonly to_display?: (val: string | string[]) => string;
  readonly hint?: (val: string) => string; // markdown
  readonly type?: RowType;
  readonly clearable?: boolean; // default false
  readonly multiline?: number;
  readonly cocalc_only?: boolean; // only for use on hosted CoCalc (or subdomains)
  readonly help?: string; // markdown formatted help text
  readonly tags?: Readonly<Tag[]>; // tags for filtering
  readonly managed_by_wizard?: boolean; // shown as wizard-managed in admin UI
  readonly wizard?: {
    name: string;
    label: string;
  };
  // optional metadata for organizing admin settings UI
  readonly group?: string;
  readonly subgroup?: string;
  readonly order?: number;
  readonly advanced?: boolean;
  readonly hidden?: boolean;
  readonly depends_on?: Readonly<string[]>;
  readonly required_when?: Readonly<RequiredWhen[]>;
  readonly wizard_id?: string;
  readonly action_label?: string;
  readonly launchpad_only?: boolean;
  readonly rocket_only?: boolean;
}

export type SiteSettings = Record<SiteSettingsKeys, Config>;

const fallback = (
  conf: { [key in SiteSettingsKeys]: string },
  name: SiteSettingsKeys,
): string => conf[name] ?? site_settings_conf[name].default;

// little helper fuctions, used in the site settings & site settings extras
export const is_email_enabled = (conf): boolean =>
  to_bool(conf.email_enabled) && conf.email_backend !== "none";
export const only_for_smtp = (conf): boolean =>
  is_email_enabled(conf) && conf.email_backend === "smtp";
export const only_for_sendgrid = (conf): boolean =>
  is_email_enabled(conf) && conf.email_backend === "sendgrid";
export const only_onprem = (conf): boolean =>
  conf.kucalc === PLATFORM_MODE_ON_PREMISES;
export const only_cocalc_com = (conf): boolean =>
  conf.kucalc === PLATFORM_MODE_CLOUD;
export const not_cocalc_com = (conf): boolean => !only_cocalc_com(conf);
export const show_theming_vars = (conf): boolean =>
  to_bool(fallback(conf, "theming"));
export const only_commercial = (conf): boolean =>
  to_bool(fallback(conf, "commercial"));
export const to_bool = (val): boolean =>
  val === "true" || val === "yes" || (typeof val === "boolean" && val);
export const to_trimmed_str = (val?: string): string => (val ?? "").trim();
const is_optional_http_url = (val: string): boolean => {
  const trimmed = to_trimmed_str(val);
  if (!trimmed) return true;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};
export const only_booleans = ["yes", "no"]; // we also understand true and false
export const to_int = (val): number => parseInt(val);
export const only_ints = (val) =>
  ((v) => !isNaN(v) && Number.isFinite(v) && Number.isInteger(val))(
    to_int(val),
  );
export const only_nonneg_int = (val) =>
  ((v) => only_ints(v) && v >= 0)(to_int(val));
export const only_pos_int = (val) =>
  ((v) => only_ints(v) && v > 0)(to_int(val));

const validDomainList = (val: string): boolean =>
  !val.trim() || parseDomainRules(val).length > 0;

export const toFloat = (val): number => parseFloat(val);
export const onlyFloats = (val) =>
  ((v) => !isNaN(v) && Number.isFinite(v))(toFloat(val));
export const onlyNonnegFloat = (val) =>
  ((v) => onlyFloats(v) && v >= 0)(toFloat(val));
export const onlyPosFloat = (val) =>
  ((v) => onlyFloats(v) && v > 0)(toFloat(val));

export function to_list_of_locale(val?: string, fallbackAll = true): string[] {
  if (!val?.trim()) {
    return fallbackAll ? [...LOCALE] : [];
  }
  const list = val
    .split(",")
    .map((s) => s.trim())
    .filter((v) => LOCALE.includes(v as any));
  return list;
}

export const from_json = (conf): Mapping => {
  try {
    if (conf !== null) {
      return jsonic(conf) ?? {};
    }
  } catch (_) {}
  return {};
};

export const parsableJson = (conf): boolean => {
  try {
    jsonic(conf ?? "{}");
    return true;
  } catch (_) {
    return false;
  }
};

export const displayJson = (conf) =>
  JSON.stringify(from_json(conf), undefined, 2);

// TODO a cheap'n'dirty validation is good enough
export const valid_dns_name = (val) => val.match(/^[a-zA-Z0-9.-]+$/g);
export const valid_dns_name_or_empty = (val) => !val || valid_dns_name(val);

export const split_iframe_comm_hosts: ToValFunc<string[]> = (hosts) =>
  (hosts ?? "").match(/[a-z0-9.-]+/g) || [];

const split_csv_tokens: ToValFunc<string[]> = (str) =>
  (str ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));

function num_dns_hosts(val): string {
  return `Found ${split_iframe_comm_hosts(val).length} hosts.`;
}

const PROJECT_HOSTS_FUNDING_MODES = [
  "auto",
  "account-prepaid",
  "account-postpaid",
  "site-funded",
] as const;
export type ProjectHostsFundingMode =
  | "account-prepaid"
  | "account-postpaid"
  | "site-funded";

const project_hosts_funding_mode_to_val: ToValFunc<ProjectHostsFundingMode> = (
  val?,
  conf?: { [key in SiteSettingsKeys]: string },
) => {
  const mode = to_trimmed_str(val).toLowerCase();
  if (
    mode === "account-prepaid" ||
    mode === "account-postpaid" ||
    mode === "site-funded"
  ) {
    return mode;
  }
  return to_bool(
    conf != null
      ? fallback(conf, "commercial")
      : site_settings_conf.commercial.default,
  )
    ? "account-postpaid"
    : "site-funded";
};

export const DATASTORE_TITLE = "Cloud Storage & Remote Filesystems";
export const PLATFORM_MODE_SINGLE_NODE = "no";
export const PLATFORM_MODE_CLOUD = "yes";
export const PLATFORM_MODE_ON_PREMISES = "onprem";
export const PLATFORM_MODE_VALID_VALS = [
  PLATFORM_MODE_CLOUD,
  PLATFORM_MODE_ON_PREMISES,
  PLATFORM_MODE_SINGLE_NODE,
] as const;
export type PlatformMode = (typeof PLATFORM_MODE_VALID_VALS)[number];

// Deprecated compatibility aliases for the persisted site setting key and old
// callers. New code should use PLATFORM_MODE_* and PlatformMode.
export const KUCALC_DISABLED = PLATFORM_MODE_SINGLE_NODE;
export const KUCALC_COCALC_COM = PLATFORM_MODE_CLOUD;
export const KUCALC_ON_PREMISES = PLATFORM_MODE_ON_PREMISES;
export type KucalcValues = PlatformMode;

const DEFAULT_QUOTAS_HELP = `
### Default quotas

Define the default quotas for a project pod, and overcommitment factors if there are additional upgrades.

| Name | Example | Unit | Description |
| :--------- | :--------- | :----- | :----- |
| idle_timeout | 3600 | seconds | after how many seconds of inactivity a project is stopped |
| internet | true  | boolean  | if false, project pod is annotated in a way to disable network access |
| mem  | 1000 | MB | shared memory limit |
| cpu | 1  | Cores | shared CPU limit |
| mem_oc | 5 | 1:N | Memory overcommitment factor, used to calculate the memory request unless explicilty given |
| cpu_oc | 10 | 1:N | CPU overcommitment factor, used to calculate the cpu request unless explicilty given |
`;

const MAX_UPGRADES_HELP = `
### Maximum Upgrades

These are limits for the total upgrade of a project pod.

| Name | Example | Unit | Description |
| :--------- | :--------- | :----- | :----- |
| memory | 16000 | MB | shared memory |
| memory_request | 8000 | MB | requested memory, must be smaller than memory |
| cores | 32 | cores | limit of cores
| cpu_shares| 2048 | 1/1024th | fraction of a core for the cpu request limit |
| mintime | 80000 | seconds | max idle timeout, unless always running is set
| always_running | 1 | | 0 or 1 | if true, project pod is started automatically |
| network | 1 | | 0 or 1  | network access |
| disk_quota | | |  not applicable |
| member_host | | | not applicable  |
| ephemeral_state | | | not applicable |
| ephemeral_disk | | | not applicable |
`;

const help_email_name = "Help email";
const organization_email_desc = `How to contact your organization (fallback: '${help_email_name}').`;

// You can use markdown in the descriptions below!

export const site_settings_conf: SiteSettings = {
  // ========= THEMING ===============
  dns: {
    name: "External Domain Name",
    desc: "DNS for your server, e.g. `cocalc.universe.edu`.  **Do NOT include the basePath or the https:// prefix.**  It optionally can start with `http://` (for non SSL) and end in a `:number` for a port.  This is used for password resets, invitation, sign up emails and also for external project hosts connecting back, since they need to know a link to the site.",
    default: "",
    to_val: to_trimmed_str,
    //valid: valid_dns_name,
    group: "Networking",
    subgroup: "Domain",
    order: 10,
    required_when: [{ key: "cloudflare_mode", equals: "self" }],
  },
  public_viewer_dns: {
    name: "Public Viewer Domain",
    desc: "Dedicated origin for the read-only public viewer bundle, e.g. `raw.cocalc.ai` or `dev-raw.cocalc.ai`. Leave empty to derive it automatically from the External Domain Name. This may optionally start with `http://` for local development and may include a `:port`.",
    default: "",
    to_val: to_trimmed_str,
    tags: ["Cloudflare", "Security"],
    group: "Networking",
    subgroup: "Domain",
    order: 11,
  },
  cloudflare_mode: {
    name: "Cloudflare Integration Mode",
    desc: "Choose how Cloudflare is used for this hub. Use **none** for fully self-hosted setups, or **self** to use your own Cloudflare account.",
    default: "none",
    valid: ["none", "self"],
    valid_labels: {
      none: "Do not use Cloudflare at all",
      self: "Use your own Cloudflare account (pay for DNS and bucket storage)",
    },
    to_val: to_trimmed_str,
    wizard: { name: "cloudflare-config", label: "Wizard..." },
    tags: ["Cloudflare", "Cloud"],
    group: "Cloudflare",
    subgroup: "Mode",
    order: 5,
  },
  theming: {
    name: "Show Theming",
    desc: "If 'No', the fields below are hidden, not disabled!",
    default: "yes",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Overview",
  },
  site_name: {
    name: "Site name",
    desc: "The heading name of your CoCalc site.",
    default: "CoCalc Launchpad",
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Branding",
  },
  site_description: {
    name: "Site description",
    desc: "A tagline describing your site.",
    default: "Collaborative Calculation",
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Branding",
  },
  status_page_url: {
    name: "Status page URL",
    desc: "Public uptime/status page URL. When configured, landing-page footers show a Status link that opens in a new tab.",
    default: "",
    clearable: true,
    valid: is_optional_http_url,
    to_val: to_trimmed_str,
    show: show_theming_vars,
    tags: ["Theme", "SLA"],
    group: "Branding & UI",
    subgroup: "Contact",
  },
  help_email: {
    name: help_email_name,
    desc: "Email address that users are directed to use for support requests. When outbound email is enabled, notification email also uses this address as its sender.",
    default: "",
    valid: is_valid_email_address,
    clearable: true,
    show: show_theming_vars,
    required_when: [{ key: "email_enabled", equals: "yes" }],
    tags: ["Theme", "Email", "Support"],
    group: "Messaging & Email",
    subgroup: "Sender & Contact",
  },
  policy_pages: {
    name: "Policy pages",
    desc: "Select which public policy pages to expose. Use configured policy pages for deployment-specific legal text hosted on this site. Use SageMath, Inc. policies only for official CoCalc deployments.",
    default: "none",
    valid: ["none", "custom", "sagemathinc"],
    valid_labels: {
      none: "Disabled",
      custom: "Use configured policy pages",
      sagemathinc: "Use SageMath, Inc. / CoCalc policies",
    },
    show: show_theming_vars,
    to_val: to_trimmed_str,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Legal",
  },
  terms_of_service_url: {
    name: "Terms of Service / Policies URL",
    desc: "External URL for Terms of Service or policy information hosted outside this site. When custom policy pages are enabled, /policies will use this external URL instead of local configured policy pages; for same-site policy text, use the Policies page setting below.",
    default: "",
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Legal",
  },
  terms_of_service: {
    name: "ToS information",
    desc: "The text displayed for the terms of service link (empty falls back a boilerplate using the URL).",
    default: "You agree to the <em>Terms of Service</em>.",
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Legal",
  },
  account_creation_email_instructions: {
    name: "Account creation",
    desc: `Instructions displayed above near the box where a user creates their account, e.g., "Let's begin the adventure!"`,
    default: "",
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Signup",
  },
  sign_in_email_instructions: {
    name: "Sign in",
    desc: `Instructions displayed above near the box where a user signs in, e.g., "Use your school email address."`,
    default: "",
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Signup",
  },
  organization_name: {
    name: "Organization name",
    desc: "The name of your organization, e.g. 'Hogwarts School of Witchcraft and Wizardry'.",
    default: "",
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Contact",
  },
  organization_email: {
    name: "Contact email address",
    desc: organization_email_desc,
    default: "",
    clearable: true,
    valid: is_valid_email_address,
    show: show_theming_vars,
    tags: ["Theme", "Email"],
    group: "Branding & UI",
    subgroup: "Contact",
  },
  organization_url: {
    name: "Organization website",
    desc: "URL link to your organization",
    default: "",
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Contact",
  },
  logo_square: {
    name: "Logo (square)",
    desc: "URL of a square logo (SVG or PNG, about 200x200 px)",
    default: "",
    clearable: true,
    show: show_theming_vars,
    tags: ["Logo", "Theme"],
    group: "Branding & UI",
    subgroup: "Branding",
  },
  logo_rectangular: {
    name: "Logo (rectangular)",
    desc: "URL of a rectangular logo (about 450x75 px, SVG or PNG)",
    default: "",
    clearable: true,
    show: show_theming_vars,
    tags: ["Logo", "Theme"],
    group: "Branding & UI",
    subgroup: "Branding",
  },
  splash_image: {
    name: "Index page picture",
    desc: "URL of an image displayed on the index page (about 1200x800 px)",
    default: "",
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Landing",
  },
  index_info_html: {
    name: "Index page info",
    desc: "An HTML/Markdown string displayed on the index page. If set, replaces the Index page picture!",
    default: "",
    clearable: true,
    show: show_theming_vars,
    multiline: 5,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Landing",
  },
  index_tagline: {
    name: "Index page tagline",
    desc: "If set, this replaces the large tagline in blue on the index page. (HTML/MD)",
    default: "",
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Landing",
  },
  imprint: {
    name: "Imprint page",
    desc: "Imprint information on optional dedicated page – HTML/Markdown.",
    default: "",
    clearable: true,
    show: show_theming_vars,
    multiline: 5,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Legal",
  },
  policies: {
    name: "Policies page",
    desc: "Deployment-specific policy information hosted on this site at /policies/policies – HTML/Markdown. If your policies are hosted externally instead, set the Terms of Service / Policies URL above.",
    default: "",
    clearable: true,
    show: show_theming_vars,
    multiline: 5,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Legal",
  },
  support: {
    name: "Support page (on-prem only)",
    desc: "If set, shown instead of the generic support pages – HTML/Markdown.",
    default: "",
    clearable: true,
    show: (conf) => show_theming_vars(conf) && not_cocalc_com(conf),
    multiline: 5,
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Support",
  },
  support_video_call: {
    name: "Video Call for Support",
    desc: "Link to a form to book a video call.",
    default: "https://calendly.com/cocalc/discovery?back=1",
    clearable: true,
    show: (conf) => show_theming_vars(conf) && only_cocalc_com(conf),
    tags: ["Theme"],
    group: "Branding & UI",
    subgroup: "Support",
  },
  cookie_banner_enabled: {
    name: "Cookie banner",
    desc: "Show a GDPR-style cookie consent banner with strictly necessary cookies, optional analytics cookies, and first-party usage metrics.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Cookie Banner"],
    group: "Branding & UI",
    subgroup: "Legal",
  },
  cookie_banner_text: {
    name: "Cookie banner text",
    desc: "Markdown body shown in the cookie banner and preferences modal. Links to the privacy policy and terms of service are rendered separately and do not need to be repeated here.",
    default:
      "We use cookies that are strictly necessary for sign-in and session management. With your consent, we use optional analytics cookies and first-party usage metrics to understand how the site is used. Signed-in users can manage these preferences in Account settings; signed-out visitors can manage cookie choices from the footer.",
    clearable: true,
    multiline: 5,
    tags: ["Cookie Banner"],
    group: "Branding & UI",
    subgroup: "Legal",
  },
  // ============== END THEMING ============

  versions: {
    name: "Client Versions",
    desc: "",
    default: "",
    type: "header",
    tags: ["Version"],
    group: "System / Advanced",
    subgroup: "Versions",
  },
  version_min_browser: {
    name: "Required browser version",
    desc: "Minimal version required for browser clients (if older, forced disconnect).",
    default: "0",
    valid: only_nonneg_int,
    show: () => true,
    tags: ["Version"],
    group: "System / Advanced",
    subgroup: "Versions",
  },
  version_recommended_browser: {
    name: "Recommended version",
    desc: "Older clients receive an upgrade warning.",
    default: "0",
    valid: only_nonneg_int,
    show: () => true,
    tags: ["Version"],
    group: "System / Advanced",
    subgroup: "Versions",
  },
  kucalc: {
    name: "Project Runtime Platform",
    desc: `Compatibility setting for the project runtime platform. '${PLATFORM_MODE_CLOUD}' means managed cloud/shared project hosts, '${PLATFORM_MODE_ON_PREMISES}' means on-premises project hosts, and '${PLATFORM_MODE_SINGLE_NODE}' means single-node/self-contained deployment.`,
    default: PLATFORM_MODE_SINGLE_NODE,
    valid: PLATFORM_MODE_VALID_VALS,
    valid_labels: {
      [PLATFORM_MODE_CLOUD]: "Managed cloud/shared project hosts",
      [PLATFORM_MODE_ON_PREMISES]: "On-premises project hosts",
      [PLATFORM_MODE_SINGLE_NODE]: "Single-node/self-contained",
    },
    tags: ["On-Prem"],
    group: "System / Advanced",
    subgroup: "Platform",
  },
  i18n: {
    name: "Internationalization",
    desc: "Select, which languages the frontend should offer for users to translate to. Only 'English', no dropdown will be shown. No selection, all available translations are available (default).",
    default: "",
    valid: LOCALE,
    to_val: (v) => to_list_of_locale(v), // note: we store this as a comma separated list
    to_display: (val: string | string[]) => {
      const list = Array.isArray(val) ? val : to_list_of_locale(val);
      return isEqual(list, LOCALE)
        ? "All translations are available."
        : list.join(", ");
    },
    tags: ["I18N"],
    group: "Branding & UI",
    subgroup: "Localization",
  },
  google_analytics: {
    name: "Google Analytics",
    desc: `A Google Analytics GA4 tag for tracking usage of your site ("G-...").`,
    default: "",
    show: only_cocalc_com,
    group: "System / Advanced",
    subgroup: "Analytics",
  },
  ux_latency_telemetry_enabled: {
    name: "Browser UX Latency Telemetry",
    desc: "Record privacy-bounded browser workflow latency traces for performance engineering. Telemetry is observational and never blocks the measured action.",
    default: "yes",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["SLA", "Support"],
    group: "System / Advanced",
    subgroup: "Analytics",
  },
  ux_latency_success_sample_rate: {
    name: "Browser UX Success Sample Rate",
    desc: "Fraction from 0 through 1 of successful lightweight workflow traces to retain. Diagnostic failures and incomplete traces are always retained. Core launch SLO traces are not sampled.",
    default: "0.25",
    valid: (value) => onlyNonnegFloat(value) && toFloat(value) <= 1,
    to_val: toFloat,
    tags: ["SLA", "Support"],
    group: "System / Advanced",
    subgroup: "Analytics",
  },
  commercial: {
    name: "Commercial",
    desc: "Legacy setting. Membership and entitlement UI is always enabled; Stripe-specific UI is derived from the Stripe publishable and secret keys.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    hidden: true,
    tags: ["Commercialization"],
    group: "Payments & Billing",
    subgroup: "Commercialization",
  },
  datastore: {
    name: "Datastore",
    desc: `Show the '${DATASTORE_TITLE}' panel in the project settings`,
    default: "yes",
    valid: only_booleans,
    show: only_onprem,
    to_val: to_bool,
    group: "System / Advanced",
    subgroup: "On-Prem",
  },
  onprem_quota_heading: {
    name: "On-prem Quotas",
    desc: "",
    default: "",
    show: only_onprem,
    type: "header",
    tags: ["On-Prem"],
    group: "System / Advanced",
    subgroup: "On-Prem Quotas",
  },
  default_quotas: {
    name: "Default Quotas",
    desc: "A JSON-formatted default quota for projects. This is only for on-prem setups. The fields actual meaning is defined in hub's `quota.ts` code",
    default: "{}",
    help: DEFAULT_QUOTAS_HELP,
    show: only_onprem,
    to_val: from_json,
    to_display: displayJson,
    valid: parsableJson,
    tags: ["On-Prem"],
    group: "System / Advanced",
    subgroup: "On-Prem Quotas",
  },
  max_upgrades: {
    name: "Maximum Quota Upgrades",
    desc: "A JSON-formatted upper limit of all quotas. This is only for on-prem setups. The fields are defined in the upgrade spec.",
    default: "{}",
    help: MAX_UPGRADES_HELP,
    show: only_onprem,
    to_val: from_json,
    to_display: displayJson,
    valid: parsableJson,
    tags: ["On-Prem"],
    group: "System / Advanced",
    subgroup: "On-Prem Quotas",
  },
  iframe_comm_hosts: {
    name: "IFrame embedding",
    desc: "DNS hostnames, which are allowed to embed and communicate with this CoCalc instance. Strings starting with a dot will match subdomains. Hosts are tokens matching `[a-zA-Z0-9.-]+`. In production, this needs `co proxy update-config` & restart.",
    default: "",
    to_val: split_iframe_comm_hosts,
    to_display: num_dns_hosts,
    group: "Access & Identity",
    subgroup: "Embedding",
  },
  email_enabled: {
    name: "Email sending enabled",
    desc: "Controls visibility of UI elements and if any emails are sent. This is independent of any particular email configuration!",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "General",
  },
  verify_emails: {
    name: "Verify email addresses",
    desc: "Require users to verify their email address, show verification prompts, and send verification tokens. Email sending must also be enabled.",
    default: "no",
    show: is_email_enabled,
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "General",
  },
  email_authentication_mode: {
    name: "Email authentication mode",
    desc: "Controls the public email signup experience. Password required is the legacy flow; verify after signup keeps the user in signup until email verification; email first is reserved for the pre-account code/link flow.",
    default: "password_required",
    valid: EMAIL_AUTHENTICATION_MODES,
    valid_labels: {
      password_required: "Password required",
      verify_after_signup: "Require verification before entering CoCalc",
      email_first: "Email first, password optional",
    },
    tags: ["Email", "Security"],
    group: "Access & Identity",
    subgroup: "Signup",
  },
  email_signup: {
    name: "Allow email signup",
    desc: "Users can sign up via email & password. Could be subject to an 'account creation token'.",
    default: "yes",
    valid: only_booleans,
    to_val: to_bool,
    group: "Access & Identity",
    subgroup: "Signup",
  },
  signup_email_domain_policy_mode: {
    name: "Signup email domain policy",
    desc: "Restrict new account creation and email-address changes by email domain. Use exactly one mode: allow all domains, allow only listed domains, or deny listed domains.",
    default: "allow_all",
    valid: SIGNUP_EMAIL_DOMAIN_POLICY_MODES,
    valid_labels: {
      allow_all: "Allow all email domains",
      allow_only: "Allow only listed domains",
      deny_list: "Deny listed domains",
    },
    group: "Access & Identity",
    subgroup: "Signup",
    tags: ["Security", "Email"],
  },
  signup_email_domain_allow_list: {
    name: "Signup allowed email domains",
    desc: "Comma, whitespace, or newline separated domain list used only when Signup email domain policy is 'Allow only listed domains'. Use example.edu for exact domains or *.example.edu for subdomains.",
    default: "",
    clearable: true,
    multiline: 4,
    valid: validDomainList,
    group: "Access & Identity",
    subgroup: "Signup",
    tags: ["Security", "Email"],
  },
  signup_email_domain_deny_list: {
    name: "Signup denied email domains",
    desc: "Comma, whitespace, or newline separated domain list used only when Signup email domain policy is 'Deny listed domains'. This list is never exposed through public customize data.",
    default: "",
    clearable: true,
    multiline: 4,
    valid: validDomainList,
    group: "Access & Identity",
    subgroup: "Signup",
    tags: ["Security", "Email"],
  },
  signup_email_domain_public_message: {
    name: "Signup email domain policy public message",
    desc: "Optional message shown on the signup form and returned when a signup is blocked by this policy. Leave blank for a generic message.",
    default: "",
    clearable: true,
    multiline: 3,
    group: "Access & Identity",
    subgroup: "Signup",
    tags: ["Security", "Email"],
  },
  signup_email_domain_show_allowed_domains: {
    name: "Show allowed signup domains publicly",
    desc: "If enabled with allow-list mode, the signup form can show the allowed domain list. Deny-listed domains are never shown publicly.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    group: "Access & Identity",
    subgroup: "Signup",
    tags: ["Security", "Email"],
  },
  public_signup_without_registration_token: {
    name: "Allow public signup without registration token",
    desc: "If enabled, users can create accounts without a registration token. This is disabled by default so deleting or disabling all registration tokens does not accidentally open public signup.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    group: "Access & Identity",
    subgroup: "Signup",
  },
  legacy_migration_enabled: {
    name: "Enable legacy cocalc.com migration",
    desc: "Expose the user-facing legacy cocalc.com migration page and allow the server-side migration APIs and restore worker to run. This should only be enabled on sites that have loaded the legacy migration tables and project archive configuration.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Migration"],
    group: "Access & Identity",
    subgroup: "Migration",
  },
  legacy_migration_page_message: {
    name: "Legacy migration page message",
    desc: "Optional statement shown at the top of the user-facing legacy cocalc.com migration page. Use this for site-specific migration deadlines, support instructions, or rollout status.",
    default: "",
    to_val: to_trimmed_str,
    tags: ["Migration"],
    group: "Access & Identity",
    subgroup: "Migration",
  },
  commercial_receivables_visible: {
    name: "Show commercial receivables",
    desc: "Allow admins and authorized agents to read the shared commercial order queue and audit history. Disable mutations separately so rollback does not hide operational records.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Accounts Receivable",
  },
  crm_visible: {
    name: "Show customer relationship management",
    desc: "Allow admins and authorized agents to read the seed-global customer directory, queue, and customer timeline.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Customer Relationships",
  },
  crm_mutations_enabled: {
    name: "Enable CRM mutations",
    desc: "Allow preview-first, audited customer, contact, domain, activity, and relationship mutations.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Customer Relationships",
  },
  crm_pipeline_mutations_enabled: {
    name: "Enable CRM pipeline mutations",
    desc: "Allow preview-first opportunity and internal follow-up task mutations.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Customer Relationships",
  },
  crm_zendesk_linking_enabled: {
    name: "Enable CRM Zendesk linking",
    desc: "Allow reviewed links between customers and stable Zendesk ticket or requester identifiers.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Customer Relationships",
  },
  crm_commercial_integration_enabled: {
    name: "Enable CRM commercial integration",
    desc: "Allow reviewed Stripe, commercial-order, and site-license links and order creation from opportunities.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Customer Relationships",
  },
  crm_metric_projections_enabled: {
    name: "Enable CRM metric projections",
    desc: "Allow bounded customer spend, receivables, license, and adoption metric projections.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Customer Relationships",
  },
  crm_exports_enabled: {
    name: "Enable CRM exports",
    desc: "Allow bounded fresh-auth exports of sensitive customer records.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Customer Relationships",
  },
  crm_backfill_enabled: {
    name: "Enable CRM discovery backfill",
    desc: "Allow fresh-auth preview and reviewed application of customer candidates from existing commercial systems.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Customer Relationships",
  },
  crm_outreach_enabled: {
    name: "Show CRM outreach",
    desc: "Show reviewed proactive Zendesk outreach drafts, queues, engagement evidence, and follow-up work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_mutations_enabled: {
    name: "Enable CRM outreach mutations",
    desc: "Allow fresh-auth template, draft, approval, queue, follow-up, and suppression mutations. Provider delivery has a separate emergency switch.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_delivery_enabled: {
    name: "Enable CRM outreach delivery",
    desc: "Allow the seed worker to create proactive Zendesk tickets and reviewed follow-up comments. Disable this emergency switch to stop new provider calls without losing queued work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_webhook_enabled: {
    name: "Enable CRM outreach webhook processing",
    desc: "Accept and reconcile authenticated Zendesk outreach reply, status, and My Read Receipts events.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_max_recipients_per_batch: {
    name: "CRM outreach maximum recipients per batch",
    desc: "Hard reviewed-recipient limit for one outreach batch (1 to 500). Start at 1 for a production canary.",
    default: "25",
    valid: (value) => only_pos_int(value) && to_int(value) <= 500,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_send_per_minute: {
    name: "CRM outreach sends per minute",
    desc: "Seed-global rolling-minute limit for Zendesk provider calls (1 to 60).",
    default: "5",
    valid: (value) => only_pos_int(value) && to_int(value) <= 60,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_send_per_hour: {
    name: "CRM outreach sends per hour",
    desc: "Seed-global rolling-hour limit for Zendesk provider calls (1 to 1000).",
    default: "50",
    valid: (value) => only_pos_int(value) && to_int(value) <= 1000,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_send_per_day: {
    name: "CRM outreach sends per day",
    desc: "Seed-global rolling-24-hour limit for Zendesk provider calls (1 to 5000).",
    default: "200",
    valid: (value) => only_pos_int(value) && to_int(value) <= 5000,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_send_per_domain_per_day: {
    name: "CRM outreach sends per domain per day",
    desc: "Rolling-24-hour provider-call limit for one normalized recipient domain (1 to 500).",
    default: "20",
    valid: (value) => only_pos_int(value) && to_int(value) <= 500,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_contact_cooldown_days: {
    name: "CRM outreach contact cooldown days",
    desc: "Default minimum interval between initiated outreach to one reviewed email (1 to 730 days).",
    default: "90",
    valid: (value) => only_pos_int(value) && to_int(value) <= 730,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_default_followup_days: {
    name: "CRM outreach default follow-up days",
    desc: "Default calendar-day wait before no-response follow-up becomes due (1 to 90).",
    default: "7",
    valid: (value) => only_pos_int(value) && to_int(value) <= 90,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_default_max_followups: {
    name: "CRM outreach default maximum follow-ups",
    desc: "Default maximum human-reviewed same-thread follow-up messages (1 to 5).",
    default: "2",
    valid: (value) => only_pos_int(value) && to_int(value) <= 5,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_default_final_review_days: {
    name: "CRM outreach default final-review days",
    desc: "Wait after the final reviewed follow-up before explicit no-response review (1 to 90 days).",
    default: "14",
    valid: (value) => only_pos_int(value) && to_int(value) <= 90,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_worker_concurrency: {
    name: "CRM outreach worker concurrency",
    desc: "Maximum local effectful Zendesk calls in flight (1 to 10). Durable global rate limits still apply.",
    default: "1",
    valid: (value) => only_pos_int(value) && to_int(value) <= 10,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
    advanced: true,
  },
  crm_outreach_worker_batch_size: {
    name: "CRM outreach worker batch size",
    desc: "Maximum rows considered during one worker cycle (1 to 100).",
    default: "10",
    valid: (value) => only_pos_int(value) && to_int(value) <= 100,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
    advanced: true,
  },
  crm_outreach_retry_max_attempts: {
    name: "CRM outreach retry maximum attempts",
    desc: "Maximum provider and reconciliation attempts before operator review (1 to 20).",
    default: "8",
    valid: (value) => only_pos_int(value) && to_int(value) <= 20,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
    advanced: true,
  },
  crm_outreach_retry_base_seconds: {
    name: "CRM outreach retry base seconds",
    desc: "Base for bounded exponential provider retry delay (10 to 3600 seconds).",
    default: "60",
    valid: (value) =>
      only_pos_int(value) && to_int(value) >= 10 && to_int(value) <= 3600,
    to_val: to_int,
    tags: ["Commercialization", "Zendesk"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
    advanced: true,
  },
  crm_outreach_zendesk_submitter_id: {
    name: "CRM outreach Zendesk submitter ID",
    desc: "Zendesk agent ID used as submitter for proactive outreach tickets.",
    default: "",
    valid: (value) => !to_trimmed_str(value) || only_pos_int(value),
    to_val: to_trimmed_str,
    tags: ["Zendesk", "Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_zendesk_group_id: {
    name: "CRM outreach Zendesk group ID",
    desc: "Zendesk Partnerships/Sales group ID for proactive tickets.",
    default: "",
    valid: (value) => !to_trimmed_str(value) || only_pos_int(value),
    to_val: to_trimmed_str,
    tags: ["Zendesk", "Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_zendesk_form_id: {
    name: "CRM outreach Zendesk form ID",
    desc: "Optional Zendesk ticket form ID for proactive outreach.",
    default: "",
    valid: (value) => !to_trimmed_str(value) || only_pos_int(value),
    to_val: to_trimmed_str,
    tags: ["Zendesk", "Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_zendesk_support_address: {
    name: "CRM outreach shared support address",
    desc: "Verified Zendesk support address used as the customer-visible sender and reply path, for example partnerships@cocalc.com.",
    default: "",
    valid: (value) => !to_trimmed_str(value) || is_valid_email_address(value),
    to_val: to_trimmed_str,
    tags: ["Zendesk", "Email", "Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_company_postal_address: {
    name: "CRM outreach company postal address",
    desc: "Company postal address included in every approved outreach footer.",
    default: "",
    to_val: to_trimmed_str,
    multiline: 3,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_footer_markdown: {
    name: "CRM outreach footer",
    desc: "Reviewed Markdown footer appended to every outreach message. The server also adds the postal address and opaque opt-out link.",
    default: "Best wishes,\n\nThe CoCalc Team",
    to_val: to_trimmed_str,
    multiline: 5,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_zendesk_webhook_secret: {
    name: "CRM outreach Zendesk webhook secret",
    desc: "Secret used to validate timestamped Zendesk outreach webhook requests.",
    default: "",
    to_val: to_trimmed_str,
    password: true,
    tags: ["Zendesk", "Security", "Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_read_receipts_enabled: {
    name: "Enable CRM outreach view observations",
    desc: "Import bounded My Read Receipts observations as non-authoritative engagement evidence.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Zendesk", "Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_read_receipts_mode: {
    name: "CRM outreach read receipt mode",
    desc: "Use structured Zendesk ticket fields when available; private-comment parsing requires a pinned integration identity.",
    default: "ticket_fields",
    valid: ["ticket_fields", "private_comments"],
    to_val: to_trimmed_str,
    tags: ["Zendesk", "Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
  },
  crm_outreach_read_receipts_ticket_field_ids: {
    name: "CRM outreach read receipt ticket field IDs",
    desc: "Comma-separated numeric Zendesk ticket-field IDs used by the installed My Read Receipts configuration.",
    default: "",
    valid: (value) =>
      !to_trimmed_str(value) ||
      to_trimmed_str(value)
        .split(",")
        .every((item) => /^\d+$/.test(item.trim())),
    to_val: to_trimmed_str,
    tags: ["Zendesk", "Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
    advanced: true,
  },
  crm_outreach_read_receipts_integration_id: {
    name: "CRM outreach read receipt integration ID",
    desc: "Expected Zendesk integration or user ID when authenticated private-comment receipt parsing is enabled.",
    default: "",
    valid: (value) => !to_trimmed_str(value) || only_pos_int(value),
    to_val: to_trimmed_str,
    tags: ["Zendesk", "Commercialization"],
    group: "Billing & Commerce",
    subgroup: "CRM Outreach",
    advanced: true,
  },
  commercial_receivables_mutations_enabled: {
    name: "Enable commercial order mutations",
    desc: "Allow reviewed creation, assignment, notes, approval, updates, cancellation, and backfill of commercial orders.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Accounts Receivable",
  },
  commercial_receivables_stripe_drafts_enabled: {
    name: "Enable commercial Stripe invoice drafts",
    desc: "Allow fresh-auth admins to create draft Stripe invoices from approved commercial orders. Drafts are not sent automatically.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Stripe"],
    group: "Billing & Commerce",
    subgroup: "Accounts Receivable",
  },
  commercial_receivables_stripe_send_enabled: {
    name: "Enable commercial Stripe invoice send",
    desc: "Allow fresh-auth admins to finalize, send, and void Stripe invoices for commercial orders.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Stripe"],
    group: "Billing & Commerce",
    subgroup: "Accounts Receivable",
  },
  commercial_receivables_stripe_quotes_enabled: {
    name: "Enable commercial Stripe quote drafts",
    desc: "Allow fresh-auth admins to create Stripe quote drafts from reviewed commercial orders. Drafts are not finalized or sent automatically.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Stripe"],
    group: "Billing & Commerce",
    subgroup: "Accounts Receivable",
  },
  commercial_receivables_stripe_quote_finalize_enabled: {
    name: "Enable commercial Stripe quote finalization",
    desc: "Allow fresh-auth admins to finalize Stripe quotes and retain their Stripe-generated PDFs. Enable only after confirming Stripe Invoicing Plus for live mode.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Stripe"],
    group: "Billing & Commerce",
    subgroup: "Accounts Receivable",
  },
  commercial_receivables_stripe_quote_accept_enabled: {
    name: "Enable commercial Stripe quote acceptance",
    desc: "Allow fresh-auth admins to record reviewed customer acceptance in Stripe and adopt the generated draft invoice into Accounts Receivable. This never sends the invoice automatically.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Stripe"],
    group: "Billing & Commerce",
    subgroup: "Accounts Receivable",
  },
  commercial_receivables_manual_settlement_enabled: {
    name: "Enable commercial manual settlements",
    desc: "Allow fresh-auth admins to record externally verified checks, wires, and other manual commercial payments.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization"],
    group: "Billing & Commerce",
    subgroup: "Accounts Receivable",
  },
  commercial_receivables_reconciliation_enabled: {
    name: "Enable commercial invoice reconciliation",
    desc: "Process the durable commercial Stripe webhook inbox and periodically reconcile stale nonterminal invoices.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Stripe"],
    group: "Billing & Commerce",
    subgroup: "Accounts Receivable",
  },
  commercial_receivables_fulfillment_enabled: {
    name: "Enable commercial fulfillment",
    desc: "Allow fresh-auth admins to provision, link, or end site-license fulfillment from approved commercial orders.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Commercialization", "Licensing"],
    group: "Billing & Commerce",
    subgroup: "Accounts Receivable",
  },
  openai_enabled: {
    name: "Enable OpenAI Integration",
    desc: "Allows OpenAI-backed AI features. This does not require a site OpenAI API key; users may use their own subscriptions, and the site key is optional.",
    default: "yes",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["OpenAI", "AI"],
    group: "AI & Agents",
    subgroup: "OpenAI",
  },
  agent_openai_codex_enabled: {
    name: "Enable Codex Agent UI",
    desc: "Controls visibility of the Codex coding agent UI. This does not require a site OpenAI API key.",
    default: "yes",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["OpenAI", "AI"],
    group: "AI & Agents",
    subgroup: "OpenAI",
  },
  codex_notification_toast_enabled: {
    name: "Codex Toast Notifications",
    desc: "Allow attention and completion notifications to appear as in-app toasts. Durable inbox notifications are retained when this is disabled.",
    default: "yes",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI"],
    group: "AI & Agents",
    subgroup: "Codex",
  },
  codex_notification_browser_enabled: {
    name: "Codex Browser Notifications",
    desc: "Allow privacy-safe native browser notifications for Codex attention and completion events. Users must also enable the channel and grant browser permission.",
    default: "yes",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI"],
    group: "AI & Agents",
    subgroup: "Codex",
  },
  google_vertexai_enabled: {
    name: "Google Generative AI UI",
    desc: "Controls visibility of UI elements related to Google's **Gemini Generative AI** integration.  You must **also set your Gemini Generative AI API key** below for this functionality to work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI"],
    group: "AI",
    subgroup: "Providers",
  },
  mistral_enabled: {
    name: "Mistral AI UI",
    desc: "Controls visibility of UI elements related to Mistral AI integration.  You must **also set your Mistral API key** below for this functionality to work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI"],
    group: "AI",
    subgroup: "Providers",
  },
  anthropic_enabled: {
    name: "Anthropic AI UI",
    desc: "Controls visibility of UI elements related to Anthropic AI integration.  You must **also set your Anthropic API key** below for this functionality to work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI"],
    group: "AI",
    subgroup: "Providers",
  },
  ollama_enabled: {
    name: "Ollama UI",
    desc: "Controls visibility of UI elements related to Ollama integration.  To make this actually work, configure the list of API/model endpoints in the Ollama configuration.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI"],
    group: "AI",
    subgroup: "Providers",
  },
  custom_openai_enabled: {
    name: "Custom OpenAI UI",
    desc: "Controls visibility of UI elements related to Custom OpenAI integration.  To make this actually work, configure the list of API/model endpoints in the Custom OpenAI configuration.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI"],
    group: "AI",
    subgroup: "Providers",
  },
  project_hosts_nebius_enabled: {
    name: "Enable Project Hosts - Nebius Cloud",
    desc: "Whether or not to include Nebius cloud project hosts. You must also configure credentials below.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "Cloud", "Nebius"],
    group: "Compute / Project Hosts",
    subgroup: "Enable Providers",
  },
  automatic_project_archiving_enabled: {
    name: "Automatic Project Archiving",
    desc: "Run the owning-bay lifecycle selector. Keep report-only enabled until candidate decisions have been reviewed.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "Backups", "Workspace"],
    group: "Compute / Project Hosts",
    subgroup: "Archive Lifecycle",
  },
  automatic_project_archiving_report_only: {
    name: "Automatic Project Archiving: Report Only",
    desc: "Record eligible candidates and exclusions without changing project storage.",
    default: "yes",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "Backups", "Workspace"],
    group: "Compute / Project Hosts",
    subgroup: "Archive Lifecycle",
  },
  free_project_archive_after_days: {
    name: "Free Project Archive Inactivity (days)",
    desc: "Archive eligible free projects after this many days without project-local last_edited activity.",
    default: "30",
    valid: only_pos_int,
    to_val: to_int,
    tags: ["Project Hosts", "Backups", "Workspace"],
    group: "Compute / Project Hosts",
    subgroup: "Archive Lifecycle",
  },
  banned_project_archive_after_days: {
    name: "Banned Project Archive Grace (days)",
    desc: "Archive projects only after every collaborator has remained banned for this many days.",
    default: "7",
    valid: only_nonneg_int,
    to_val: to_int,
    tags: ["Project Hosts", "Backups", "Security"],
    group: "Compute / Project Hosts",
    subgroup: "Archive Lifecycle",
  },
  automatic_project_archiving_batch_limit: {
    name: "Automatic Project Archiving: Batch Limit",
    desc: "Maximum candidate projects evaluated during one maintenance tick.",
    default: "25",
    valid: only_pos_int,
    to_val: to_int,
    tags: ["Project Hosts", "Backups"],
    group: "Compute / Project Hosts",
    subgroup: "Archive Lifecycle",
    advanced: true,
  },
  automatic_project_archiving_global_per_hour: {
    name: "Automatic Project Archiving: Global Hourly Limit",
    desc: "Maximum mutating archive completions started by each bay per hour.",
    default: "10",
    valid: only_pos_int,
    to_val: to_int,
    tags: ["Project Hosts", "Backups"],
    group: "Compute / Project Hosts",
    subgroup: "Archive Lifecycle",
    advanced: true,
  },
  automatic_project_archiving_per_host_concurrency: {
    name: "Automatic Project Archiving: Per-host Concurrency",
    desc: "Maximum archive lifecycle jobs running concurrently against one project host.",
    default: "1",
    valid: only_pos_int,
    to_val: to_int,
    tags: ["Project Hosts", "Backups"],
    group: "Compute / Project Hosts",
    subgroup: "Archive Lifecycle",
    advanced: true,
  },
  automatic_project_archiving_canary_bays: {
    name: "Automatic Project Archiving: Canary Bays",
    desc: "Optional comma-separated owning bay IDs. Empty permits every bay.",
    default: "",
    tags: ["Project Hosts", "Backups"],
    group: "Compute / Project Hosts",
    subgroup: "Archive Lifecycle",
    advanced: true,
  },
  automatic_project_archiving_canary_hosts: {
    name: "Automatic Project Archiving: Canary Hosts",
    desc: "Optional comma-separated project-host UUIDs. Empty permits every host.",
    default: "",
    tags: ["Project Hosts", "Backups"],
    group: "Compute / Project Hosts",
    subgroup: "Archive Lifecycle",
    advanced: true,
  },
  "project_hosts_google-cloud_enabled": {
    name: "Enable Project Hosts - Google Cloud",
    desc: "Whether or not to include Google Cloud project hosts. You must also configure credentials below.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "Cloud"],
    group: "Compute / Project Hosts",
    subgroup: "Enable Providers",
  },
  project_hosts_hyperstack_enabled: {
    name: "Enable Project Hosts - Hyperstack (Experimental)",
    desc: "Whether or not to include Hyperstack cloud project hosts. Experimental: this provider has not been actively tested recently and may be broken. You must also configure credentials below.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "Cloud", "Hyperstack"],
    group: "Compute / Project Hosts",
    subgroup: "Enable Providers",
    hidden: true,
  },
  project_hosts_lambda_enabled: {
    name: "Enable Project Hosts - Lambda Cloud (Experimental)",
    desc: "Whether or not to include Lambda Cloud project hosts. Experimental: this provider has not been actively tested recently and may be broken. You must also configure credentials below.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "Cloud"],
    group: "Compute / Project Hosts",
    subgroup: "Enable Providers",
    hidden: true,
  },
  project_hosts_local_enabled: {
    name: "Enable Project Hosts - Local (manual setup)",
    desc: "Whether or not to include the local/manual project-host option. Hidden by default because this was an early development bootstrap path and may be broken.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "On-Prem"],
    group: "Compute / Project Hosts",
    subgroup: "Enable Providers",
    hidden: true,
  },
  project_hosts_self_host_alpha_enabled: {
    name: "Enable Project Hosts - Self-Hosted (Experimental/Insecure)",
    desc: "Allow admins to create self-hosted project hosts. Keep this disabled on production sites: self-host connectors are experimental and can receive cluster-level backup secrets after setup. Disabling this blocks new self-hosted hosts without preventing cleanup or management of existing ones.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "On-Prem"],
    group: "Compute / Project Hosts",
    subgroup: "Enable Providers",
  },
  project_hosts_funding_mode: {
    name: "Project Hosts: Funding Mode",
    desc: "Choose how billable cloud project hosts are funded. Use **account-prepaid** when each user must fund their own hosts with prepaid balance. Use **account-postpaid** when usage is billed later through statements and automatic billing. Use **site-funded** when the installation operator pays for cloud hosts directly, such as non-commercial alpha deployments or self-hosted Launchpad sites.",
    default: "auto",
    valid: [...PROJECT_HOSTS_FUNDING_MODES],
    valid_labels: {
      auto: "Auto",
      "account-prepaid": "Account prepaid",
      "account-postpaid": "Account postpaid",
      "site-funded": "Site funded",
    },
    to_val: project_hosts_funding_mode_to_val,
    tags: ["Project Hosts", "Cloud", "Commercialization", "On-Prem"],
    group: "Compute / Project Hosts",
    subgroup: "Billing",
  },
  project_hosts_gcp_surcharge_percent: {
    name: "Project Hosts: Google Cloud - Site Surcharge (%)",
    desc: "Percentage markup applied to Google Cloud dedicated-host prices shown in the UI and used for dedicated-host billing. This helps cover spot-price volatility, public IPv4, egress, and other operating overhead.",
    default: "0",
    valid: onlyNonnegFloat,
    to_val: toFloat,
    tags: ["Project Hosts", "Cloud", "Commercialization"],
    group: "Compute / Project Hosts",
    subgroup: "Billing",
  },
  project_hosts_nebius_surcharge_percent: {
    name: "Project Hosts: Nebius - Site Surcharge (%)",
    desc: "Percentage markup applied to Nebius dedicated-host prices shown in the UI and used for dedicated-host billing. Use this to publish customer-facing prices at or above Nebius list pricing.",
    default: "0",
    valid: onlyNonnegFloat,
    to_val: toFloat,
    tags: ["Project Hosts", "Cloud", "Nebius", "Commercialization"],
    group: "Compute / Project Hosts",
    subgroup: "Billing",
  },
  project_hosts_app_private_hostnames_enabled: {
    name: "Project Hosts: Private App Hostnames",
    desc: "Enable authenticated, server-generated dev-* hostnames for private project apps. This requires Cloudflare DNS automation, direct project-host routes, and compatible wildcard TLS on project hosts.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "Cloud", "Cloudflare"],
    group: "Compute / Project Hosts",
    subgroup: "Domain",
    show: (conf) => (conf.cloudflare_mode ?? "none") === "self",
  },
  project_hosts_app_private_hostname_domain: {
    name: "Project Hosts: Private App Hostname Domain",
    desc: "DNS domain under which one-level private app hostnames are created, e.g. cocalc.ai. Leave blank to use the public site hostname. The domain must have Cloudflare edge and project-host origin TLS coverage.",
    default: "",
    valid: valid_dns_name_or_empty,
    to_val: to_trimmed_str,
    tags: ["Project Hosts", "Cloud", "Cloudflare"],
    group: "Compute / Project Hosts",
    subgroup: "Domain",
    show: (conf) =>
      (conf.cloudflare_mode ?? "none") === "self" &&
      to_bool(conf.project_hosts_app_private_hostnames_enabled),
  },
  project_hosts_app_private_hostname_bay_limit: {
    name: "Project Hosts: Private App Hostname Per-Bay Limit",
    desc: "Safety ceiling for platform-managed private app DNS records in this bay. Keep this below the Cloudflare zone record quota. This is not a cluster-wide counter in multibay deployments and becomes unnecessary when private app routing uses a wildcard edge route.",
    default: "3000",
    valid: only_nonneg_int,
    to_val: to_int,
    tags: ["Project Hosts", "Cloud", "Cloudflare"],
    group: "Compute / Project Hosts",
    subgroup: "Domain",
    show: (conf) =>
      (conf.cloudflare_mode ?? "none") === "self" &&
      to_bool(conf.project_hosts_app_private_hostnames_enabled),
  },
  launcher_default_quick_create: {
    name: "Launcher: Quick Create",
    desc: "Comma-separated exact site-wide quick-create ids used when a user has not configured a personal launcher list (e.g. chat,ipynb,md,tex,term).",
    default: "chat,ipynb,md,tex,term",
    to_val: split_csv_tokens,
    tags: ["Workspace"],
    group: "Branding & UI",
    subgroup: "Launcher",
    wizard: { name: "launcher-defaults", label: "Wizard..." },
    managed_by_wizard: true,
  },
  project_rootfs_default_image: {
    name: "Project RootFS Default Image",
    desc: "Default OCI image used when a user does not choose an image. This image is also pulled to every host.",
    default: "buildpack-deps:26.04",
    to_val: to_trimmed_str,
    tags: ["Workspace", "RootFS", "OCI"],
    group: "Compute / Projects",
    subgroup: "Root Filesystem Images",
  },
  project_rootfs_default_image_gpu: {
    name: "Project RootFS Default Image (GPU)",
    desc: "Optional default OCI image used when a user enables GPU in project creation.",
    default: "",
    to_val: to_trimmed_str,
    tags: ["Workspace", "RootFS", "OCI", "GPU"],
    group: "Compute / Projects",
    subgroup: "Root Filesystem Images",
  },
  project_rootfs_prepull_images: {
    name: "Project RootFS Prepull Images",
    desc: "Comma-separated list of OCI images to pre-pull to all running and future hosts (in addition to the default image).",
    default: "",
    to_val: to_trimmed_str,
    tags: ["Workspace", "RootFS", "OCI"],
    group: "Compute / Projects",
    subgroup: "Root Filesystem Images",
  },
  samesite_remember_me: {
    name: "sameSite setting for remember_me authentication cookie",
    desc: "The [sameSite setting](https://expressjs.com/en/resources/middleware/cookie-session.html) for the remember_me authentication token, which can be one of 'strict' or 'lax'. The default is 'strict', which is the safest choice, as it is a useful line of defense against certain attacks. Using 'lax' might be OK for some on-prem or development setups.",
    default: "strict",
    valid: ["strict", "lax"],
    to_val: (x) => (x === "none" ? "lax" : `${x}`),
    tags: ["Security"],
    group: "Access & Identity",
    subgroup: "Security",
  },
  browser_raw_exec_policy: {
    name: "Browser raw JavaScript exec policy",
    desc: "Controls whether browser-session automation may run raw JavaScript in a live browser tab. The constrained QuickJS typed-action sandbox is used when raw JavaScript is not allowed. Raw JavaScript execution is intended mainly for development and debugging.",
    default: "disabled",
    valid: ["disabled", "admin_only", "enabled"],
    valid_labels: {
      disabled: "Disabled for all accounts",
      admin_only: "Admins only",
      enabled: "Enabled when caller requests it",
    },
    to_val: (x) => {
      const value = `${x ?? ""}`.trim().toLowerCase();
      return value === "admin_only" || value === "enabled" ? value : "disabled";
    },
    tags: ["Security"],
    group: "Access & Identity",
    subgroup: "Security",
    advanced: true,
  },
} as const;
