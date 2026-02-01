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
  DEFAULT_MODEL,
  LLMServicesAvailable,
  USER_SELECTABLE_LANGUAGE_MODELS,
  getDefaultLLM,
  isValidModel,
} from "./llm-utils";
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
  "Hyperstack",
  "Nebius",
  "Cloudflare",
  "Backups",
  "AI LLM",
  "Theme",
  "On-Prem",
  "I18N",
  "Security",
  "SSH",
  "Support",
] as const;

export type Tag = (typeof TAGS)[number];

export type SiteSettingsKeys =
  | "theming"
  | "site_name"
  | "site_description"
  | "account_creation_email_instructions"
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
  | "openai_enabled"
  | "agent_openai_control_agent_enabled"
  | "agent_openai_codex_enabled"
  | "google_vertexai_enabled"
  | "mistral_enabled"
  | "anthropic_enabled"
  | "ollama_enabled"
  | "custom_openai_enabled"
  | "selectable_llms"
  | "default_llm"
  | "user_defined_llm"
  | "organization_name"
  | "organization_email"
  | "organization_url"
  | "terms_of_service"
  | "terms_of_service_url"
  | "commercial"
  | "max_trial_projects"
  | "nonfree_countries"
  | "google_analytics"
  | "kucalc"
  | "i18n"
  | "dns"
  | "datastore"
  | "versions"
  | "version_min_project"
  | "version_min_browser"
  | "version_recommended_browser"
  | "iframe_comm_hosts"
  | "onprem_quota_heading"
  | "default_quotas"
  | "max_upgrades"
  | "email_enabled"
  | "verify_emails"
  | "email_signup"
  | "share_server"
  | "landing_pages"
  | "project_hosts_google-cloud_enabled"
  | "project_hosts_hyperstack_enabled"
  | "project_hosts_lambda_enabled"
  | "project_hosts_local_enabled"
  | "project_hosts_self_host_alpha_enabled"
  | "project_hosts_nebius_enabled"
  | "cloudflare_mode"
  | "project_hosts_dns"
  | "samesite_remember_me"
  | "user_tracking";


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
  readonly cocalc_only?: boolean; // only for use on cocalc.com (or subdomains)
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
export const only_for_password_reset_smtp = (conf): boolean =>
  to_bool(conf.email_enabled) && conf.password_reset_override === "smtp";
export const only_onprem = (conf): boolean =>
  conf.kucalc === KUCALC_ON_PREMISES;
export const only_cocalc_com = (conf): boolean =>
  conf.kucalc === KUCALC_COCALC_COM;
export const not_cocalc_com = (conf): boolean => !only_cocalc_com(conf);
export const show_theming_vars = (conf): boolean =>
  to_bool(fallback(conf, "theming"));
export const only_commercial = (conf): boolean =>
  to_bool(fallback(conf, "commercial"));
export const to_bool = (val): boolean =>
  val === "true" || val === "yes" || (typeof val === "boolean" && val);
export const to_trimmed_str = (val?: string): string => (val ?? "").trim();
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

export function to_list_of_llms(val?: string, fallbackAll = true): string[] {
  if (!val?.trim())
    return fallbackAll ? [...USER_SELECTABLE_LANGUAGE_MODELS] : [];
  return val
    .split(",")
    .map((s) => s.trim())
    .filter((v) => USER_SELECTABLE_LANGUAGE_MODELS.includes(v as any));
}
export const is_list_of_llms = (val: string) =>
  val
    .split(",")
    .map((s) => s.trim())
    .every((s) => USER_SELECTABLE_LANGUAGE_MODELS.includes(s as any));

export const to_default_llm: ToValFunc<ToVal> = (val: string, conf) => {
  if (isValidModel(val)) return val;

  if (conf == null) {
    return DEFAULT_MODEL;
  }

  // FYI, conf are the raw values
  const selectable_llms = to_list_of_llms(conf.selectable_llms);
  const filter: LLMServicesAvailable = {
    openai: to_bool(conf.openai_enabled),
    google: to_bool(conf.google_vertexai_enabled),
    ollama: to_bool(conf.ollama_enabled),
    mistralai: to_bool(conf.mistral_enabled),
    anthropic: to_bool(conf.anthropic_enabled),
    custom_openai: to_bool(conf.custom_openai_enabled),
    user: conf.kucalc !== KUCALC_COCALC_COM,
  } as const;
  const ollama = from_json((conf as any)?.ollama);
  const custom_openai = from_json((conf as any)?.custom_openai);

  return getDefaultLLM(selectable_llms, filter, ollama, custom_openai);
};

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
export const valid_dns_name_or_empty = (val) =>
  !val || valid_dns_name(val);

export const split_iframe_comm_hosts: ToValFunc<string[]> = (hosts) =>
  (hosts ?? "").match(/[a-z0-9.-]+/g) || [];

const split_strings: ToValFunc<string[]> = (str) =>
  (str ?? "").match(/[a-zA-Z0-9]+/g) || [];

function num_dns_hosts(val): string {
  return `Found ${split_iframe_comm_hosts(val).length} hosts.`;
}

const commercial_to_val: ToValFunc<boolean> = (
  val?,
  conf?: { [key in SiteSettingsKeys]: string },
) => {
  // special case: only if we're in cocalc.com production mode, the commercial setting can be true at all
  const kucalc =
    conf != null ? fallback(conf, "kucalc") : site_settings_conf.kucalc.default;
  if (kucalc === KUCALC_COCALC_COM) {
    return to_bool(val);
  }
  return false;
};

export const DATASTORE_TITLE = "Cloud Storage & Remote Filesystems";
export const KUCALC_DISABLED = "no";
export const KUCALC_COCALC_COM = "yes";
export const KUCALC_ON_PREMISES = "onprem";
const KUCALC_VALID_VALS = [
  KUCALC_COCALC_COM,
  KUCALC_ON_PREMISES,
  KUCALC_DISABLED,
] as const;
export type KucalcValues = (typeof KUCALC_VALID_VALS)[number];

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
    required_when: [
      { key: "cloudflare_mode", equals: ["self", "managed"] },
    ],
  },
  cloudflare_mode: {
    name: "Cloudflare Integration Mode",
    desc: "Choose how Cloudflare is used for this hub. Use **none** for fully self-hosted setups, **self** to use your own Cloudflare account, or **managed** to use CoCalc-managed Cloudflare.",
    default: "none",
    valid: ["none", "self", "managed"],
    valid_labels: {
      none: "Do not use Cloudflare at all",
      self: "Use your own Cloudflare account (pay for DNS and bucket storage)",
      managed: "CoCalc managed (included with your membership)",
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
  help_email: {
    name: help_email_name,
    desc: "Email address that user is directed to use for support requests",
    default: "",
    valid: is_valid_email_address,
    clearable: true,
    show: show_theming_vars,
    tags: ["Theme", "Email", "Support"],
    group: "Branding & UI",
    subgroup: "Contact",
  },
  terms_of_service_url: {
    name: "Terms of Service URL",
    desc: "URL to the page describing ToS, Policies, etc. (leave empty to not require)",
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
    desc: "Policies information on optional dedicated page – HTML/Markdown.",
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
  version_min_project: {
    name: "Required project version",
    desc: "Minimal version required by projects (if older, will terminate).",
    default: "0",
    valid: only_nonneg_int,
    show: () => true,
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
    name: "KuCalc UI",
    desc: `Configure which UI elements to show in order to match the Kubernetes backend. '${KUCALC_COCALC_COM}' for cocalc.com production site, '${KUCALC_ON_PREMISES}' for on-premises Kubernetes, or '${KUCALC_DISABLED}' for Docker`,
    default: KUCALC_DISABLED,
    valid: KUCALC_VALID_VALS,
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
  commercial: {
    name: "Commercial",
    desc: "Whether or not to include user interface elements related to for-pay upgrades and other features.  Set to 'yes' to include these elements. **IMPORTANT:** *You must restart your server after changing this setting for it to take effect.*",
    default: "no",
    valid: only_booleans,
    to_val: commercial_to_val,
    show: only_cocalc_com,
    tags: ["Commercialization"],
    group: "Payments & Billing",
    subgroup: "Commercialization",
  },
  max_trial_projects: {
    name: "Maximum Trial Projects",
    desc: "Limit where we start blocking trial projects from running in nonfree countries. (0 means disabled)",
    default: "0",
    to_val: to_int,
    valid: only_nonneg_int,
    show: only_cocalc_com,
    tags: ["Commercialization"],
    group: "Payments & Billing",
    subgroup: "Commercialization",
  },
  nonfree_countries: {
    name: "Nonfree Countries",
    desc: "ISO 3166-1 Alpha 2 country codes where extra usage restrictions apply",
    default: "",
    to_val: split_strings,
    show: only_cocalc_com,
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
    desc: "If 'true', email verification tokens are sent out + account settings UI shows it – email sending must be enabled",
    default: "no",
    show: is_email_enabled,
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "General",
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
  share_server: {
    name: "Allow public file sharing",
    desc: "Users are allowed to publicly share files on the public share server (`https://yourserver/share`).  If this is disabled, then the share server will not run and users will not be allowed to share files from their projects.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    group: "Access & Identity",
    subgroup: "Sharing",
  },
  landing_pages: {
    name: "Landing pages",
    desc: "Host landing pages about the functionality of CoCalc.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    show: only_cocalc_com,
    cocalc_only: true,
    group: "Branding & UI",
    subgroup: "Landing",
  },
  openai_enabled: {
    name: "OpenAI ChatGPT UI",
    desc: "Controls visibility of UI elements related to OpenAI ChatGPT integration.  You must **also set your OpenAI API key** below for this functionality to work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["OpenAI", "AI LLM"],
    group: "AI & LLM",
    subgroup: "Providers",
  },
  agent_openai_control_agent_enabled: {
    name: "OpenAI Control Agent UI",
    desc: "Controls visibility of UI elements related to the OpenAI control-plane agent.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["OpenAI", "AI LLM"],
    group: "AI & LLM",
    subgroup: "Providers",
  },
  agent_openai_codex_enabled: {
    name: "OpenAI Codex Agent UI",
    desc: "Controls visibility of UI elements related to the OpenAI Codex coding agent. You must have the Codex CLI installed and configured for this to work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["OpenAI", "AI LLM"],
    group: "AI & LLM",
    subgroup: "Providers",
  },
  google_vertexai_enabled: {
    name: "Google Generative AI UI",
    desc: "Controls visibility of UI elements related to Google's **Gemini Generative AI** integration.  You must **also set your Gemini Generative AI API key** below for this functionality to work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI LLM"],
    group: "AI & LLM",
    subgroup: "Providers",
  },
  mistral_enabled: {
    name: "Mistral AI UI",
    desc: "Controls visibility of UI elements related to Mistral AI integration.  You must **also set your Mistral API key** below for this functionality to work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI LLM"],
    group: "AI & LLM",
    subgroup: "Providers",
  },
  anthropic_enabled: {
    name: "Anthropic AI UI",
    desc: "Controls visibility of UI elements related to Anthropic AI integration.  You must **also set your Anthropic API key** below for this functionality to work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI LLM"],
    group: "AI & LLM",
    subgroup: "Providers",
  },
  ollama_enabled: {
    name: "Ollama LLM UI",
    desc: "Controls visibility of UI elements related to Ollama integration.  To make this actually work, configure the list of API/model endpoints in the Ollama configuration.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI LLM"],
    group: "AI & LLM",
    subgroup: "Providers",
  },
  custom_openai_enabled: {
    name: "Custom OpenAI LLM UI",
    desc: "Controls visibility of UI elements related to Custom OpenAI integration.  To make this actually work, configure the list of API/model endpoints in the Custom OpenAI configuration.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI LLM"],
    group: "AI & LLM",
    subgroup: "Providers",
  },
  selectable_llms: {
    name: "User Selectable LLMs",
    desc: "If this is empty, all available LLMs by enabled services will be selectable by your users. If you select one or more, only those LLMs will be shown. This does not affect the availibiltiy of Ollama models.",
    default: "",
    valid: is_list_of_llms,
    to_val: (v) => to_list_of_llms(v), // note: we store this as a comma separated list of model strings
    to_display: (val: string | string[]) => {
      const list = Array.isArray(val) ? val : to_list_of_llms(val);
      return isEqual(list, USER_SELECTABLE_LANGUAGE_MODELS)
        ? "All LLMs of enabled services will be selectable"
        : list.join(", ");
    },
    tags: ["AI LLM"],
    group: "AI & LLM",
    subgroup: "User Experience",
  },
  default_llm: {
    name: "Default LLM",
    desc: "If user has never selected an LLM, this one will be the fallback choice. If it is not available or not in the list of selectable LLMs, a heuristic will pick a fallback.",
    default: "",
    to_val: to_default_llm,
    valid: USER_SELECTABLE_LANGUAGE_MODELS, // ATTN: This is not true. It's actually the list selectable_llms (which has this list as a constant) + all ollama + custom_llm. This is a special case in the Admin UI.
    tags: ["AI LLM"],
    group: "AI & LLM",
    subgroup: "User Experience",
  },
  user_defined_llm: {
    name: "User Defined LLM",
    desc: "If enabled, users are allowed to configure and run their own LLMs (their API keys, etc.)",
    default: "no",
    to_val: to_bool,
    valid: only_booleans,
    tags: ["AI LLM"],
    group: "AI & LLM",
    subgroup: "User Experience",
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
    name: "Enable Project Hosts - Hyperstack",
    desc: "Whether or not to include Hyperstack cloud project hosts. You must also configure credentials below.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "Cloud", "Hyperstack"],
    group: "Compute / Project Hosts",
    subgroup: "Enable Providers",
  },
  project_hosts_lambda_enabled: {
    name: "Enable Project Hosts - Lambda Cloud",
    desc: "Whether or not to include Lambda Cloud project hosts. You must also configure credentials below.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "Cloud"],
    group: "Compute / Project Hosts",
    subgroup: "Enable Providers",
  },
  project_hosts_local_enabled: {
    name: "Enable Project Hosts - Local (manual setup)",
    desc: "Whether or not to include the local/manual project-host option (for development use).",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "On-Prem"],
    group: "Compute / Project Hosts",
    subgroup: "Enable Providers",
  },
  project_hosts_self_host_alpha_enabled: {
    name: "Enable Project Hosts - Self-Host (alpha options)",
    desc: "Enable alpha self-host options (e.g., Multipass VM and manual setup).",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Project Hosts", "On-Prem"],
    group: "Compute / Project Hosts",
    subgroup: "Enable Providers",
  },
  project_hosts_dns: {
    name: "Project Hosts: Domain name",
    desc: "Base domain name for project hosts, e.g. 'cocalc.io'. This is used with the Cloudflare token to create stable host subdomains like host-123.cocalc.io.",
    default: "",
    valid: valid_dns_name_or_empty,
    to_val: to_trimmed_str,
    tags: ["Project Hosts", "Cloud"],
    group: "Compute / Project Hosts",
    subgroup: "Domain",
    show: (conf) => (conf.cloudflare_mode ?? "none") === "self",
    required_when: [{ key: "cloudflare_mode", equals: "self" }],
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
  user_tracking: {
    name: "User Tracking",
    desc: "If enabled, then information about what users do in the frontend browser gets temporarily recorded in the user_tracking table of the database.",
    default: "no",
    valid: only_booleans,
    group: "System / Advanced",
    subgroup: "Analytics",
  },
} as const;
