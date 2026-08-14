/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Site Settings Config for the servers (hubs)
// They are only visible and editable for admins and services.
// In particular, this includes the email backend config, Stripe, etc.

// You can use markdown in the descriptions below and it is rendered properly!

import { isEmpty } from "lodash";

import { EMAIL_LANE_BACKENDS } from "@cocalc/util/notification-email";
import {
  expire_time,
  isValidUUID,
  is_valid_email_address,
} from "@cocalc/util/misc";
import {
  Config,
  SiteSettings,
  displayJson,
  from_json,
  is_email_enabled,
  onlyPosFloat,
  only_booleans,
  only_cocalc_com,
  only_pos_int,
  parsableJson,
  toFloat,
  to_bool,
  to_int,
  to_trimmed_str,
} from "./site-defaults";

export const pii_retention_parse = (retention: string): number | false => {
  if (retention == "never" || retention == null) return false;
  const [num_str, mult_str] = retention.split(" ");
  const num = parseInt(num_str);
  const mult = (function () {
    const m = mult_str.toLowerCase();
    if (m.startsWith("year")) return 365;
    if (m.startsWith("month")) return 30;
    if (m.startsWith("day")) return 1;
    throw new Error(`unknown multiplyer "${m}"`);
  })();
  const secs = num * (mult * 24 * 60 * 60);
  if (isNaN(secs) || secs == null) {
    throw new Error(
      `pii_expire problem: cannot derive future time from "{retention}"`,
    );
  }
  return secs;
};

const pii_retention_display = (retention: string) => {
  const secs = pii_retention_parse(retention);
  if (secs === false) {
    return "will never expire";
  } else {
    return `Future date ${expire_time(secs).toLocaleString()}`;
  }
};

const vertexai_enabled = (conf: SiteSettings) =>
  to_bool(conf.google_vertexai_enabled);
const mistral_enabled = (conf: SiteSettings) => to_bool(conf.mistral_enabled);
const anthropic_enabled = (conf: SiteSettings) =>
  to_bool(conf.anthropic_enabled);
const ollama_enabled = (conf: SiteSettings) => to_bool(conf.ollama_enabled);
const custom_openai_enabled = (conf: SiteSettings) =>
  to_bool(conf.custom_openai_enabled);

const cloudflare_mode = (conf: SiteSettings): string =>
  `${conf.cloudflare_mode ?? "none"}`.trim().toLowerCase();

function emailBackendSelected(
  conf: Record<string, any>,
  backend: string,
): boolean {
  if (!is_email_enabled(conf)) return false;
  return (
    conf.email_backend === backend ||
    conf.notification_email_critical_backend === backend ||
    conf.notification_email_transactional_backend === backend ||
    conf.notification_email_notification_backend === backend ||
    conf.notification_email_marketing_backend === backend
  );
}

const only_for_email_smtp = (conf: Record<string, any>): boolean =>
  emailBackendSelected(conf, "smtp");

const only_for_email_sendgrid = (conf: Record<string, any>): boolean =>
  emailBackendSelected(conf, "sendgrid");
const cloudflare_self_mode = (conf: SiteSettings): boolean =>
  cloudflare_mode(conf) === "self";

const project_hosts_nebius_enabled = (conf: SiteSettings) =>
  to_bool(conf["project_hosts_nebius_enabled"]);
const project_hosts_google_cloud_enabled = (conf: SiteSettings) =>
  to_bool(conf["project_hosts_google-cloud_enabled"]);
const project_hosts_hyperstack_enabled = (conf: SiteSettings) =>
  to_bool(conf["project_hosts_hyperstack_enabled"]);
const project_hosts_lambda_enabled = (conf: SiteSettings) =>
  to_bool(conf["project_hosts_lambda_enabled"]);
export const project_hosts_local_enabled = (conf: SiteSettings) =>
  to_bool(conf["project_hosts_local_enabled"]);
const metrics_enabled = (conf: SiteSettings) =>
  to_bool(
    (conf as SiteSettings & { prometheus_metrics?: string })[
      "prometheus_metrics"
    ],
  );
const google_sso_enabled = (conf: SiteSettings) =>
  to_bool(
    (conf as SiteSettings & { google_sso_enabled?: string })[
      "google_sso_enabled"
    ],
  );

function optionalPositiveInteger(value: string): boolean {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed === "" || (/^[0-9]+$/.test(trimmed) && Number(trimmed) > 0);
}

function optionalPercent(value: string): boolean {
  const trimmed = `${value ?? ""}`.trim();
  const n = Number(trimmed);
  return (
    trimmed === "" ||
    (/^[0-9]+$/.test(trimmed) && Number.isFinite(n) && n >= 1 && n <= 100)
  );
}

// Ollama and Custom OpenAI have the same schema
function custom_ai_model_valid(value: string): boolean {
  if (isEmpty(value) || !parsableJson(value)) {
    return false;
  }
  const obj = from_json(value);
  if (typeof obj !== "object") {
    return false;
  }
  for (const key in obj) {
    const val = obj[key] as any;
    if (typeof val !== "object") {
      return false;
    }
    if (typeof val.baseUrl !== "string") {
      return false;
    }
    if (val.model && typeof val.model !== "string") {
      return false;
    }
    const c = val.cocalc;
    if (c != null) {
      if (typeof c !== "object") {
        return false;
      }
      if (c.display && typeof c.display !== "string") {
        return false;
      }
      if (c.desc && typeof c.desc !== "string") {
        return false;
      }
      if (c.enabled && typeof c.enabled !== "boolean") {
        return false;
      }
    }
  }
  return true;
}

// Ollama and Custom OpenAI have the same schema
function custom_ai_model_display(value: string): string {
  const structure =
    "Must be {[key : string] : {model: string, baseUrl: string, cocalc?: {display?: string, desc?: string, icon?: string, ...}, ...}";
  if (isEmpty(value)) {
    return `Empty. ${structure}`;
  }
  if (!parsableJson(value)) {
    return `JSON not parseable. ${structure}`;
  }
  const obj = from_json(value);
  if (typeof obj !== "object") {
    return "JSON must be an object";
  }
  const ret: string[] = [];
  for (const key in obj) {
    const val = obj[key] as any;
    if (typeof val !== "object") {
      return `Config object in ${key} must be an object`;
    }
    if (typeof val.baseUrl !== "string") {
      return `Config ${key} baseUrl field must be a string`;
    }
    if (val.model && typeof val.model !== "string") {
      return `Config ${key} model field must be a string`;
    }
    const c = val.cocalc;
    if (c != null) {
      if (typeof c !== "object") {
        return `Config ${key} cocalc field must be an object: {display?: string, desc?: string, enabled?: boolean, ...}`;
      }
      if (c.display && typeof c.display !== "string") {
        return `Config ${key} cocalc.display field must be a string`;
      }
      if (c.desc && typeof c.desc !== "string") {
        return `Config ${key} cocalc.desc field must be a (markdown) string`;
      }
      if (c.enabled && typeof c.enabled !== "boolean") {
        return `Config ${key} cocalc.enabled field must be a boolean`;
      }
    }
    ret.push(
      `Olama ${key} at ${val.baseUrl} named ${c?.display ?? val.model ?? key}`,
    );
  }
  return `[${ret.join(", ")}]`;
}

export type SiteSettingsExtrasKeys =
  | "pii_retention"
  | "launch_emergency_heading"
  | "launch_read_mostly_maintenance"
  | "launch_disable_project_creation"
  | "launch_disable_free_project_starts"
  | "launch_disable_user_host_create"
  | "launch_disable_ai"
  | "launch_disable_payment_checkout"
  | "cryptomining_abuse_heading"
  | "cryptomining_abuse_enforcement_enabled"
  | "cryptomining_abuse_auto_ban_enabled"
  | "bandwidth_relay_abuse_heading"
  | "bandwidth_relay_abuse_enforcement_enabled"
  | "bandwidth_relay_abuse_auto_ban_enabled"
  | "user_search_max_results"
  | "launch_sla_heading"
  | "launch_sla_project_start_warm_p95_ms"
  | "launch_sla_project_start_overall_p95_ms"
  | "launch_sla_project_terminal_ready_p95_ms"
  | "launch_sla_project_jupyter_ready_p95_ms"
  | "launch_sla_project_exec_ready_p95_ms"
  | "launch_sla_file_open_visible_p95_ms"
  | "launch_sla_file_open_sync_ready_p95_ms"
  | "conat_heading"
  | "conat_password"
  | "conat_admission_hub_api_max_active"
  | "conat_admission_hub_api_max_active_per_account"
  | "conat_admission_service_max_parallel_active"
  | "conat_admission_max_connections"
  | "conat_admission_max_connections_per_user"
  | "conat_admission_max_connections_per_hub_user"
  | "conat_admission_inbound_events_per_socket_window"
  | "conat_admission_inbound_events_per_identity_window"
  | "conat_admission_inbound_event_window_ms"
  | "conat_admission_inbound_event_block_ms"
  | "conat_admission_app_proxy_max_active_websockets_total"
  | "conat_admission_app_proxy_max_active_websockets_per_target"
  | "conat_admission_project_exec_stream_max_active"
  | "conat_admission_near_limit_percent"
  | "conat_admission_near_limit_log_interval_ms"
  | "rootfs_scan_enabled"
  | "rootfs_scan_container_image"
  | "rootfs_scan_trivy_cache_dir"
  | "rootfs_scan_timeout_minutes"
  | "rootfs_scan_max_target_gb"
  | "rootfs_scan_max_report_mb"
  | "rootfs_scan_full_report_retention_days"
  | "rootfs_scan_scheduled_enabled"
  | "rootfs_scan_rescan_period_days"
  | "software_licenses_heading"
  | "software_license_private_key"
  | "stripe_heading"
  | "stripe_publishable_key"
  | "stripe_secret_key"
  | "stripe_webhook_secret"
  | "r2_heading"
  | "r2_account_id"
  | "r2_api_token"
  | "r2_access_key_id"
  | "r2_secret_access_key"
  | "r2_bucket_prefix"
  | "re_captcha_v3_heading"
  | "re_captcha_v3_publishable_key"
  | "re_captcha_v3_secret_key"
  | "email_section"
  | "email_backend"
  | "notification_email_critical_backend"
  | "notification_email_transactional_backend"
  | "notification_email_notification_backend"
  | "notification_email_marketing_backend"
  | "sendgrid_key"
  | "email_smtp_server"
  | "email_smtp_from"
  | "email_smtp_login"
  | "email_smtp_password"
  | "openai_section"
  | "openai_api_key"
  | "site_funded_codex_heading"
  | "site_funded_codex_enabled"
  | "site_funded_codex_model"
  | "site_funded_codex_reasoning"
  | "site_funded_codex_service_tier"
  | "site_funded_codex_global_pool_weekly_usd"
  | "site_funded_codex_free_pool_weekly_usd"
  | "site_funded_codex_paid_pool_weekly_usd"
  | "site_funded_codex_max_turn_usd"
  | "site_funded_codex_max_turn_seconds"
  | "site_funded_codex_max_input_tokens_per_request"
  | "site_funded_codex_max_output_tokens_per_request"
  | "site_funded_codex_max_requests_per_turn"
  | "site_funded_codex_global_concurrency"
  | "site_funded_codex_openai_admin_key"
  | "site_funded_codex_openai_project_id"
  | "google_vertexai_key"
  | "ollama_configuration"
  | "custom_openai_configuration"
  | "mistral_api_key"
  | "anthropic_api_key"
  | "salesloft_section"
  | "salesloft_api_key"
  | "google_sso_heading"
  | "google_sso_enabled"
  | "google_sso_client_id"
  | "google_sso_client_secret"
  | "google_sso_allowed_domains"
  | "google_sso_signup_mode"
  | "zendesk_heading"
  | "zendesk_token"
  | "zendesk_username"
  | "zendesk_uri"
  | "support_account_id"
  | "github_heading"
  | "github_project_id"
  | "github_username"
  | "github_token"
  | "github_block"
  | "prometheus_metrics"
  | "prometheus_metrics_allowlist"
  | "pay_as_you_go_section"
  | "pay_as_you_go_min_payment"
  | "compute_vm_mode"
  | "compute_vm_emergency_stop"
  | "compute_vm_admin_allowlist"
  | "compute_vm_gcp_service_account_json"
  | "compute_vm_gcp_network"
  | "compute_vm_gcp_network_tag"
  | "compute_vm_max_active_per_project"
  | "compute_vm_max_active_total"
  | "compute_vm_max_ttl_minutes"
  | "compute_vm_max_boot_disk_gb"
  | "compute_vm_max_volumes_per_account"
  | "compute_vm_max_volume_gb"
  | "compute_vm_unfunded_volume_delete_days"
  | "compute_vm_unfunded_volume_max_exposure_usd"
  | "lambda_cloud_api_key"
  | "project_hosts_lambda_prefix"
  | "nebius_region_config_json"
  | "project_hosts_nebius_prefix"
  | "hyperstack_api_key"
  | "project_hosts_hyperstack_prefix"
  | "project_hosts_ssh_public_keys"
  | "google_cloud_service_account_json"
  | "project_hosts_google_prefix"
  | "project_hosts_route_mode"
  | "project_hosts_software_base_url"
  | "project_hosts_runtime_retention_policy"
  | "project_hosts_bootstrap_channel"
  | "project_hosts_bootstrap_version"
  | "project_hosts_self_host_connector_version"
  | "project_hosts_cloudflare_tunnel_enabled"
  | "project_hosts_cloudflare_tunnel_account_id"
  | "project_hosts_cloudflare_tunnel_api_token"
  | "project_hosts_cloudflare_tunnel_prefix"
  | "project_hosts_cloudflare_tunnel_host_suffix"
  | "software_license_token"
  | "software_license_server_url"
  | "software_license_instance_id"
  | "active_user_map_enabled"
  //   | "coreweave_kubeconfig"
  //   | "amazon_web_services_access_key"
  //   | "amazon_web_services_secret_access_key"
  | "subscription_maintenance";

export type SettingsExtras = Record<SiteSettingsExtrasKeys, Config>;

// not public, but admins can edit them
export const EXTRAS: SettingsExtras = {
  launch_emergency_heading: {
    name: "Launch Emergency Controls",
    desc: "Temporary operator kill switches for public-launch incidents. These settings are read dynamically by backend request paths and are intended for fast mitigation, not long-term policy.",
    default: "",
    type: "header",
    tags: ["Security"],
    group: "System / Advanced",
    subgroup: "Launch Emergency Controls",
  },
  launch_read_mostly_maintenance: {
    name: "Read-Mostly Maintenance Mode",
    desc: "Broad emergency brake for launch incidents. Blocks non-admin project creation, non-admin project starts, non-admin dedicated-host creation, payment checkout, and AI/Codex while preserving existing read paths and admin diagnosis paths.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Security"],
    group: "System / Advanced",
    subgroup: "Launch Emergency Controls",
  },
  launch_disable_project_creation: {
    name: "Disable New Project Creation",
    desc: "Blocks non-admin users from creating new projects. Existing projects can still be opened, started, stopped, and edited.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Security"],
    group: "System / Advanced",
    subgroup: "Launch Emergency Controls",
  },
  launch_disable_free_project_starts: {
    name: "Disable Free Project Starts",
    desc: "Blocks starts for projects sponsored by free memberships. Paid and admin-sponsored project starts still work, and admins can start projects for diagnosis.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Security", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Launch Emergency Controls",
  },
  launch_disable_user_host_create: {
    name: "Disable User Dedicated Host Creation",
    desc: "Blocks non-admin users from creating new dedicated hosts, including cloud hosts and user-added hosts. Existing hosts are not stopped or deleted.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Security", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Launch Emergency Controls",
  },
  launch_disable_ai: {
    name: "Disable AI and Codex",
    desc: "Blocks site-managed AI/Codex usage while preserving unrelated project functionality. Use this for abuse or runaway AI-cost incidents.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Security", "AI", "OpenAI"],
    group: "System / Advanced",
    subgroup: "Launch Emergency Controls",
  },
  launch_disable_payment_checkout: {
    name: "Disable Payment Checkout",
    desc: "Blocks users from creating new Stripe checkout, payment, and setup sessions. Existing billing records and read-only billing pages still work.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Security", "Commercialization"],
    group: "System / Advanced",
    subgroup: "Launch Emergency Controls",
  },
  cryptomining_abuse_heading: {
    name: "Compute Abuse Detection",
    desc: "Operator controls for high-confidence cryptomining and prohibited QEMU execution detection on project hosts. These settings are off by default for self-hosted sites.",
    default: "",
    type: "header",
    tags: ["Security", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Abuse Detection",
  },
  cryptomining_abuse_enforcement_enabled: {
    name: "Enable Compute Abuse Enforcement",
    desc: "When enabled, the hub acts on high-confidence cryptomining or prohibited QEMU execution evidence from project hosts by stopping the affected project. Active account entitlement overrides can exempt reviewed legitimate workloads. Leave disabled for self-hosted sites that intentionally permit these workloads.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Security", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Abuse Detection",
  },
  cryptomining_abuse_auto_ban_enabled: {
    name: "Enable Automatic Compute Abuse Bans",
    desc: "When enabled together with compute abuse enforcement, sole-owner projects belonging to new free accounts with high-confidence cryptomining evidence, and sole-owner projects belonging to free accounts executing QEMU system emulators, are automatically banned using the normal account ban path. Shared projects, paid accounts, and exempt accounts are not automatically banned.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Security", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Abuse Detection",
  },
  bandwidth_relay_abuse_heading: {
    name: "Bandwidth Relay Abuse Detection",
    desc: "Operator controls for detecting high-volume tunnel and explicitly named uploader/streamer-bot workloads on project hosts. Runtime evidence excludes full command lines and credentials. These settings are off by default for self-hosted sites.",
    default: "",
    type: "header",
    tags: ["Security", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Abuse Detection",
  },
  bandwidth_relay_abuse_enforcement_enabled: {
    name: "Enable Bandwidth Relay Enforcement",
    desc: "When enabled, the hub stops projects after a project host reports both live tunneling and an explicitly named uploader/streamer-bot process and the attributed account has at least 1 GiB of raw-network egress in five hours or 3 GiB in seven days. Active account entitlement overrides can exempt reviewed legitimate workloads.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Security", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Abuse Detection",
  },
  bandwidth_relay_abuse_auto_ban_enabled: {
    name: "Enable Automatic Bandwidth Relay Bans",
    desc: "When enabled together with bandwidth relay enforcement, a new free account is automatically banned only when it is the sole user and owner of the affected project and an explicit uploader/streamer-bot process is present. Paid accounts, older free accounts, shared projects, project sponsors, and exempt accounts are not automatically banned.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Security", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Abuse Detection",
  },
  user_search_max_results: {
    name: "User Search Maximum Results",
    desc: "Maximum number of accounts returned by a non-admin user search. The hard safety limit is 50.",
    default: "50",
    valid: only_pos_int,
    to_val: to_int,
    tags: ["Security"],
    group: "System / Advanced",
    subgroup: "User Search",
  },
  launch_sla_heading: {
    name: "Launch SLA Thresholds",
    desc: "Operator thresholds for browser-observed launch readiness latency. UX latency alerts and Launch Health compare recent P95 values to these thresholds.",
    default: "",
    type: "header",
    tags: ["SLA", "Support"],
    group: "System / Advanced",
    subgroup: "Launch SLA Thresholds",
  },
  launch_sla_project_start_warm_p95_ms: {
    name: "Warm Project Start P95 SLA",
    desc: "Maximum acceptable P95 milliseconds from project start request to lifecycle running for the warm provisioned path. If empty, the default is 10000.",
    default: "10000",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["SLA", "Support", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Launch SLA Thresholds",
  },
  launch_sla_project_start_overall_p95_ms: {
    name: "Overall Project Start P95 SLA",
    desc: "Maximum acceptable P95 milliseconds from project start request to lifecycle running across all start paths, including restore/dearchive outliers. If empty, the default is 5000.",
    default: "5000",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["SLA", "Support", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Launch SLA Thresholds",
  },
  launch_sla_project_terminal_ready_p95_ms: {
    name: "Terminal Ready P95 SLA",
    desc: "Maximum acceptable P95 milliseconds from terminal connect/open action to terminal ready for input. If empty, the default is 5000.",
    default: "5000",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["SLA", "Support", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Launch SLA Thresholds",
  },
  launch_sla_project_jupyter_ready_p95_ms: {
    name: "Jupyter Ready P95 SLA",
    desc: "Maximum acceptable P95 milliseconds from Run Cell to the Jupyter run request being accepted. If empty, the default is 10000.",
    default: "10000",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["SLA", "Support", "Jupyter"],
    group: "System / Advanced",
    subgroup: "Launch SLA Thresholds",
  },
  launch_sla_project_exec_ready_p95_ms: {
    name: "Project Exec Ready P95 SLA",
    desc: "Maximum acceptable P95 milliseconds from an exec/compile action to project exec request acceptance. If empty, the default is 500.",
    default: "500",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["SLA", "Support", "Project Hosts"],
    group: "System / Advanced",
    subgroup: "Launch SLA Thresholds",
  },
  launch_sla_file_open_visible_p95_ms: {
    name: "File Content Paint P95 SLA",
    desc: "Maximum acceptable P95 milliseconds from foreground file-open intent through the loaded editor React commit and following animation frame. If empty, the default is 10000.",
    default: "10000",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["SLA", "Support"],
    group: "System / Advanced",
    subgroup: "Launch SLA Thresholds",
  },
  launch_sla_file_open_sync_ready_p95_ms: {
    name: "File Sync Ready P95 SLA",
    desc: "Maximum acceptable P95 milliseconds from foreground file-open intent until SyncDoc initialization reports ready. If empty, the default is 5000.",
    default: "5000",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["SLA", "Support"],
    group: "System / Advanced",
    subgroup: "Launch SLA Thresholds",
  },
  conat_heading: {
    name: "Conat Configuration",
    desc: "Conat is a [NATS](https://nats.io/)-like [socketio](https://socket.io/) websocket server and persistence layer that CoCalc uses extensively for communication.",
    default: "",
    type: "header",
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat",
  },
  conat_password: {
    name: "Conat Password",
    desc: "Password for conat *hub* admin account. If not given, then the contents of the file `$SECRETS/conat_password` (or `$COCALC_ROOT/data/secrets/conat_password`) is used, if it exists.",
    default: "",
    password: true,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat",
  },
  conat_admission_hub_api_max_active: {
    name: "Hub API Active Request Limit",
    desc: "Maximum simultaneously running hub Conat API requests. Blank uses `COCALC_HUB_CONAT_API_MAX_ACTIVE` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_hub_api_max_active_per_account: {
    name: "Hub API Active Requests Per Account",
    desc: "Maximum simultaneously running hub Conat API requests for one account on each hub process. Blank uses `COCALC_HUB_CONAT_API_MAX_ACTIVE_PER_ACCOUNT` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_service_max_parallel_active: {
    name: "Service Parallel Handler Limit",
    desc: "Default maximum simultaneously running handlers for parallel Conat services and typed fast-RPC services. Blank uses `COCALC_CONAT_SERVICE_MAX_PARALLEL_ACTIVE` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_max_connections: {
    name: "Conat Total Connection Limit",
    desc: "Maximum total Conat websocket connections per Conat server process. Blank uses `COCALC_CONAT_MAX_CONNECTIONS` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_max_connections_per_user: {
    name: "Conat Connections Per User",
    desc: "Maximum Conat websocket connections per ordinary user identity. Blank uses `COCALC_CONAT_MAX_CONNECTIONS_PER_USER` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_max_connections_per_hub_user: {
    name: "Conat Connections Per Hub User",
    desc: "Maximum Conat websocket connections for trusted hub/system identities. Blank uses `COCALC_CONAT_MAX_CONNECTIONS_PER_HUB_USER` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_inbound_events_per_socket_window: {
    name: "Conat Events Per Socket Window",
    desc: "Maximum inbound Conat socket events per connection in the configured event window. Blank uses `COCALC_CONAT_MAX_INBOUND_EVENTS_PER_SOCKET_WINDOW` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_inbound_events_per_identity_window: {
    name: "Conat Events Per Identity Window",
    desc: "Maximum inbound Conat socket events per authenticated identity in the configured event window. Blank uses `COCALC_CONAT_MAX_INBOUND_EVENTS_PER_IDENTITY_WINDOW` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_inbound_event_window_ms: {
    name: "Conat Event Window Milliseconds",
    desc: "Sliding window length for Conat inbound event rate limits. Blank uses `COCALC_CONAT_INBOUND_EVENT_WINDOW_MS` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_inbound_event_block_ms: {
    name: "Conat Event Block Milliseconds",
    desc: "How long to reject Conat socket events after an inbound event rate limit is exceeded. Blank uses `COCALC_CONAT_INBOUND_EVENT_BLOCK_MS` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_app_proxy_max_active_websockets_total: {
    name: "App Proxy Websocket Total Limit",
    desc: "Maximum active app-proxy websockets per project process. Blank uses `COCALC_APP_PROXY_MAX_ACTIVE_WEBSOCKETS_TOTAL` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_app_proxy_max_active_websockets_per_target: {
    name: "App Proxy Websockets Per Target",
    desc: "Maximum active app-proxy websockets per target app/port. Blank uses `COCALC_APP_PROXY_MAX_ACTIVE_WEBSOCKETS_PER_TARGET` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_project_exec_stream_max_active: {
    name: "Project Exec Stream Limit",
    desc: "Maximum active project exec-stream requests per project process. Blank uses `COCALC_PROJECT_EXEC_STREAM_MAX_ACTIVE` or the built-in default.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_near_limit_percent: {
    name: "Admission Near-Limit Alert Percent",
    desc: "Percent of an admission limit at which near-limit telemetry is recorded. Blank uses 80.",
    default: "",
    valid: optionalPercent,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  conat_admission_near_limit_log_interval_ms: {
    name: "Admission Near-Limit Log Interval",
    desc: "Minimum milliseconds between repeated near-limit telemetry records for the same surface/identity/key. Blank uses 60000.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["Conat"],
    group: "System / Advanced",
    subgroup: "Conat Admission",
  },
  rootfs_scan_enabled: {
    name: "RootFS Scan: Enabled",
    desc: "Enable RootFS vulnerability scanning UI, scheduled scans, and manual scan RPCs for this site. Disabled by default because it requires Trivy image/cache storage and project-host scan capacity.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["RootFS", "Security", "Project Hosts"],
    group: "Compute / Project Hosts",
    subgroup: "RootFS Scanning",
  },
  active_user_map_enabled: {
    name: "Active Users Map: Enabled",
    desc: "Collect one short-lived approximate Cloudflare location per active account, enable the admin active-users world map, and retain consent-gated country aggregates for 24 months. No IP address or account-linked location history is stored. Disabled by default.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["Cloudflare", "Security"],
    group: "System / Advanced",
    subgroup: "Admin Operations",
  },
  rootfs_scan_container_image: {
    name: "RootFS Scan: Trivy Container Image",
    desc: "Pinned Trivy scanner container image used by project hosts for official RootFS vulnerability scans. Blank uses docker.io/aquasec/trivy:latest; production should use an internal image reference pinned by digest.",
    default: "",
    valid: () => true,
    to_val: to_trimmed_str,
    tags: ["RootFS", "Security", "Project Hosts"],
    group: "Compute / Project Hosts",
    subgroup: "RootFS Scanning",
  },
  rootfs_scan_trivy_cache_dir: {
    name: "RootFS Scan: Trivy Cache Directory",
    desc: "Absolute project-host path for the Trivy vulnerability database/cache. Project hosts seed this cache before scans; scan jobs mount it read-only and run with network disabled. Blank uses /mnt/cocalc/data/trivy-cache.",
    default: "",
    valid: () => true,
    to_val: to_trimmed_str,
    tags: ["RootFS", "Security", "Project Hosts"],
    group: "Compute / Project Hosts",
    subgroup: "RootFS Scanning",
  },
  rootfs_scan_timeout_minutes: {
    name: "RootFS Scan: Timeout Minutes",
    desc: "Maximum runtime for one official RootFS vulnerability scan. Blank uses 30 minutes.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["RootFS", "Security", "Project Hosts"],
    group: "Compute / Project Hosts",
    subgroup: "RootFS Scanning",
  },
  rootfs_scan_max_target_gb: {
    name: "RootFS Scan: Max Target GB",
    desc: "Maximum RootFS release size that may be scanned. Blank disables this guard and relies on per-scan overrides.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["RootFS", "Security", "Project Hosts"],
    group: "Compute / Project Hosts",
    subgroup: "RootFS Scanning",
  },
  rootfs_scan_max_report_mb: {
    name: "RootFS Scan: Max Report MB",
    desc: "Maximum raw Trivy JSON report size retained for admin/SOC-2 evidence. Blank uses 64 MB.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["RootFS", "Security", "Project Hosts"],
    group: "Compute / Project Hosts",
    subgroup: "RootFS Scanning",
  },
  rootfs_scan_full_report_retention_days: {
    name: "RootFS Scan: Full Report Retention Days",
    desc: "How long to retain full Trivy JSON reports for admin/SOC-2 evidence. Blank uses 730 days.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["RootFS", "Security", "Project Hosts"],
    group: "Compute / Project Hosts",
    subgroup: "RootFS Scanning",
  },
  rootfs_scan_scheduled_enabled: {
    name: "RootFS Scan: Scheduled Official Scans",
    desc: "Run scheduled vulnerability scans for official non-hidden RootFS images when RootFS scanning is enabled. Blank or yes enables weekly scanning; no disables the scheduler.",
    default: "yes",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["RootFS", "Security", "Project Hosts"],
    group: "Compute / Project Hosts",
    subgroup: "RootFS Scanning",
  },
  rootfs_scan_rescan_period_days: {
    name: "RootFS Scan: Rescan Period Days",
    desc: "How often official non-hidden RootFS images should be rescanned. Blank uses 7 days.",
    default: "",
    valid: optionalPositiveInteger,
    to_val: to_trimmed_str,
    tags: ["RootFS", "Security", "Project Hosts"],
    group: "Compute / Project Hosts",
    subgroup: "RootFS Scanning",
  },
  software_licenses_heading: {
    name: "Software Licensing",
    desc: "Keys used to sign software licenses for Launchpad/Rocket.",
    default: "",
    type: "header",
    tags: ["Licensing"],
    group: "Payments & Billing",
    subgroup: "Licensing",
  },
  software_license_private_key: {
    name: "Software Licensing: Private Signing Key (PEM)",
    desc: "Ed25519 private key used to sign software license tokens. Keep this secret.  Generate using\n```sh\nopenssl genpkey -algorithm ED25519 -out software_license_private_key.pem && cat software_license_private_key.pem\n```",
    default: "",
    password: true,
    multiline: 6,
    to_val: to_trimmed_str,
    tags: ["Licensing", "Security"],
    valid: () => true,
    group: "Payments & Billing",
    subgroup: "Licensing",
  },
  software_license_token: {
    name: "Software Licensing: License Token",
    desc: "Launchpad/Rocket activation token. This is typically set by the activation flow.",
    default: "",
    password: true,
    multiline: 4,
    to_val: to_trimmed_str,
    tags: ["Licensing"],
    valid: () => true,
    group: "Payments & Billing",
    subgroup: "Licensing",
  },
  software_license_server_url: {
    name: "Software Licensing: Server URL",
    desc: "Licensing server base URL used for activation and refresh.",
    default: "https://cocalc.ai",
    to_val: to_trimmed_str,
    tags: ["Licensing"],
    valid: () => true,
    group: "Payments & Billing",
    subgroup: "Licensing",
  },
  software_license_instance_id: {
    name: "Software Licensing: Instance Id",
    desc: "Unique instance identifier used during license activation (auto-generated).",
    default: "",
    to_val: to_trimmed_str,
    tags: ["Licensing"],
    valid: () => true,
    group: "Payments & Billing",
    subgroup: "Licensing",
  },
  openai_section: {
    name: "OpenAI / Codex Configuration",
    desc: "",
    default: "",
    type: "header",
    tags: ["AI", "OpenAI"],
    group: "AI & Agents",
    subgroup: "OpenAI",
  },
  openai_api_key: {
    name: "OpenAI API Key",
    desc: "Optional site OpenAI API key from https://platform.openai.com/account/api-keys. Leave this blank if users will rely on their own subscriptions or API keys.",
    default: "",
    password: true,
    tags: ["AI", "OpenAI"],
    group: "AI & Agents",
    subgroup: "OpenAI",
  },
  site_funded_codex_heading: {
    name: "Site-Funded Codex",
    desc: "Hard financial and policy controls for Codex turns paid for by the site's OpenAI API key.",
    default: "",
    type: "header",
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 10,
  },
  site_funded_codex_enabled: {
    name: "Enable Site-Funded Codex",
    desc: "Allow eligible accounts to use the site OpenAI key through the bounded funded proxy. Disabling this leaves personal ChatGPT and API-key access unchanged.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 20,
  },
  site_funded_codex_model: {
    name: "Funded Codex Model",
    desc: "Exact model permitted for site-funded turns. Models without a verified funded price fail closed.",
    default: "gpt-5.6-luna",
    valid: (value) => value === "gpt-5.6-luna",
    to_val: to_trimmed_str,
    tags: ["AI", "OpenAI", "Commercialization"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 30,
  },
  site_funded_codex_reasoning: {
    name: "Funded Codex Reasoning",
    desc: "Reasoning level forced at the backend and provider proxy for site-funded turns. Medium is the default; low remains available as a lower-cost operator override.",
    default: "medium",
    valid: (value) => value === "low" || value === "medium",
    to_val: to_trimmed_str,
    tags: ["AI", "OpenAI", "Commercialization"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 40,
  },
  site_funded_codex_service_tier: {
    name: "Funded Codex Speed",
    desc: "Provider service tier forced for site-funded turns.",
    default: "standard",
    valid: (value) => value === "standard",
    to_val: to_trimmed_str,
    tags: ["AI", "OpenAI", "Commercialization"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 50,
  },
  site_funded_codex_global_pool_weekly_usd: {
    name: "Combined Weekly Budget (USD)",
    desc: "Hard weekly ceiling across all free and paid site-funded Codex usage. The free and paid limits below are sub-pool ceilings and cannot exceed this combined budget in aggregate.",
    default: "100",
    valid: onlyPosFloat,
    to_val: toFloat,
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 60,
  },
  site_funded_codex_free_pool_weekly_usd: {
    name: "Free Sub-Pool Weekly Limit (USD)",
    desc: "Weekly ceiling reserved for free-account usage, still bounded by the combined weekly budget.",
    default: "100",
    valid: onlyPosFloat,
    to_val: toFloat,
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 70,
  },
  site_funded_codex_paid_pool_weekly_usd: {
    name: "Paid Sub-Pool Weekly Limit (USD)",
    desc: "Weekly ceiling for paid-member usage, still bounded by the combined weekly budget.",
    default: "100",
    valid: onlyPosFloat,
    to_val: toFloat,
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 80,
  },
  site_funded_codex_max_turn_usd: {
    name: "Emergency Maximum Funded Turn Cost (USD)",
    desc: "Generous emergency ceiling for one turn, not a normal UX limit. The ledger reserves this exposure before admission and releases unused funds when the turn finishes.",
    default: "0.25",
    valid: onlyPosFloat,
    to_val: toFloat,
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 200,
  },
  site_funded_codex_max_turn_seconds: {
    name: "Emergency Maximum Turn Duration (seconds)",
    desc: "Generous emergency guard against abandoned or runaway turns. Normal turns should finish well below it.",
    default: "3600",
    valid: only_pos_int,
    to_val: to_int,
    tags: ["AI", "OpenAI", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    advanced: true,
    order: 210,
  },
  site_funded_codex_max_input_tokens_per_request: {
    name: "Funded Codex Context Window (tokens)",
    desc: "Context window advertised directly to Codex. Codex automatically compacts thread history at 75% of this value, so long-running threads remain usable instead of being rejected by the funding proxy.",
    default: "128000",
    valid: only_pos_int,
    to_val: to_int,
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    advanced: true,
    order: 220,
  },
  site_funded_codex_max_output_tokens_per_request: {
    name: "Emergency Maximum Output Tokens per Request",
    desc: "Generous provider-output guard. It should not truncate ordinary Codex work.",
    default: "32000",
    valid: only_pos_int,
    to_val: to_int,
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    advanced: true,
    order: 230,
  },
  site_funded_codex_max_requests_per_turn: {
    name: "Emergency Maximum Provider Requests per Turn",
    desc: "Generous runaway-loop guard. It should not stop normal multi-step Codex work.",
    default: "256",
    valid: only_pos_int,
    to_val: to_int,
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    advanced: true,
    order: 240,
  },
  site_funded_codex_global_concurrency: {
    name: "Global Funded Turn Concurrency",
    desc: "Maximum active site-funded turns across the global pool, independent of its dollar limit.",
    default: "50",
    valid: only_pos_int,
    to_val: to_int,
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 90,
  },
  site_funded_codex_openai_admin_key: {
    name: "OpenAI Organization Admin Key",
    desc: "Optional organization-level OpenAI admin key used only to compare CoCalc's funded-usage ledger with OpenAI's Costs API. It is not used to run Codex turns and is distinct from the OpenAI API key above.",
    default: "",
    password: true,
    tags: ["AI", "OpenAI", "Commercialization", "Security"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 110,
  },
  site_funded_codex_openai_project_id: {
    name: "OpenAI Platform Project ID (proj_...)",
    desc: "Optional OpenAI Platform project that owns the API key used for included Codex turns. Use a dedicated project and API key, and configure that project with an enforced hard spend limit rather than only a notification threshold. Set this ID together with the organization admin key to compare OpenAI's reported project costs with CoCalc's ledger.",
    default: "",
    to_val: to_trimmed_str,
    tags: ["AI", "OpenAI", "Commercialization"],
    group: "AI & Agents",
    subgroup: "Site-Funded Codex",
    order: 100,
  },
  google_vertexai_key: {
    name: "Google Generative AI API Key",
    desc: "Create an [API Key](https://aistudio.google.com/app/apikey) in [Google's AI Studio](https://aistudio.google.com/) and paste it here.",
    default: "",
    password: true,
    show: vertexai_enabled,
    tags: ["AI"],
    required_when: [{ key: "google_vertexai_enabled", equals: "yes" }],
    group: "AI",
    subgroup: "Google AI",
  },
  mistral_api_key: {
    name: "Mistral AI API Key",
    desc: "Create an API Key in the [Mistral AI Console](https://console.mistral.ai/api-keys/) and paste it here.",
    default: "",
    password: true,
    show: mistral_enabled,
    tags: ["AI"],
    required_when: [{ key: "mistral_enabled", equals: "yes" }],
    group: "AI",
    subgroup: "Mistral",
  },
  anthropic_api_key: {
    name: "Anthropic API Key",
    desc: "Create an API Key in the [Anthropic Console](https://console.anthropic.com/) and paste it here.",
    default: "",
    password: true,
    show: anthropic_enabled,
    tags: ["AI"],
    required_when: [{ key: "anthropic_enabled", equals: "yes" }],
    group: "AI",
    subgroup: "Anthropic",
  },
  ollama_configuration: {
    name: "Ollama Configuration",
    desc: 'Configure Ollama endpoints. e.g. Ollama has "gemma" installed and is available at localhost:11434: `{"gemma" : {"baseUrl": "http://localhost:11434/" , cocalc: {display: "Gemma", desc: "Google\'s Gemma Model", icon: "https://.../...png"}}`',
    default: "{}",
    multiline: 5,
    show: ollama_enabled,
    to_val: from_json,
    valid: custom_ai_model_valid,
    to_display: custom_ai_model_display,
    tags: ["AI"],
    group: "AI",
    subgroup: "Ollama",
  },
  // This is very similar to the ollama config, but there are small differences in the details.
  custom_openai_configuration: {
    name: "Custom OpenAI Endpoints",
    desc: 'Configure OpenAI-compatible endpoints. e.g. `{"myllm" : {"baseUrl": "http://1.2.3.4:5678/" , apiKey: "key...", cocalc: {display: "My AI Model", desc: "My custom AI model", icon: "https://.../...png"}}, "gpt-4o-high": {baseUrl: "https://api.openai.com/v1", temperature: 1.5, "apiKey": "sk-...", "model": "gpt-4o", cocalc: {display: "High GPT-4 Omni", desc: "GPT 4 Omni High Temp"}}}`',
    default: "{}",
    multiline: 5,
    show: custom_openai_enabled,
    to_val: from_json,
    valid: custom_ai_model_valid,
    to_display: custom_ai_model_display,
    tags: ["AI"],
    group: "AI",
    subgroup: "Custom OpenAI",
  },
  salesloft_section: {
    name: "Salesloft Configuration",
    desc: "",
    default: "",
    show: only_cocalc_com,
    type: "header",
  },
  salesloft_api_key: {
    name: "Salesloft API key (needed for Salesloft integration)",
    desc: "Your API key, which is needed to connect for some functionality related to [the Salesloft API](https://developers.salesloft.com/docs/api).",
    default: "",
    password: true,
    show: only_cocalc_com,
  },
  pii_retention: {
    name: "PII Retention",
    desc: "How long to keep personally identifiable information, after which the server automatically deletes certain database entries that contain PII.",
    default: "12 month",
    // values must be understood by packages/hub/utils.ts pii_expire
    valid: [
      "30 days",
      "3 month",
      "6 month",
      "12 month",
      "1 year",
      "2 years",
      "5 years",
      "10 years",
    ],
    to_val: pii_retention_parse,
    to_display: pii_retention_display,
  },
  stripe_heading: {
    // this is consmetic, otherwise it looks weird.
    name: "Stripe Keys",
    desc: "",
    default: "",
    type: "header",
    tags: ["Stripe"],
    group: "Payments & Billing",
    subgroup: "Stripe",
  },
  stripe_publishable_key: {
    name: "Stripe Publishable",
    desc: "Stripe calls this key 'publishable'",
    default: "",
    password: false,
    tags: ["Stripe"],
    group: "Payments & Billing",
    subgroup: "Stripe",
  },
  stripe_secret_key: {
    name: "Stripe Secret",
    desc: "Stripe calls this key 'secret'",
    default: "",
    password: true,
    tags: ["Stripe"],
    group: "Payments & Billing",
    subgroup: "Stripe",
  },
  stripe_webhook_secret: {
    name: "Stripe Webhook Secret",
    desc: "The Stripe webhook secret, which verifies Stripe webhook event signatures, and should look like 'whsec_fibl8xlfp...'. Enable Stripe webhooks at https://dashboard.stripe.com/webhooks with a URL like `https://my-cocalc-server/webhooks/stripe`. CoCalc handles payment_intent.succeeded, payment_intent.canceled, checkout.session.completed, invoice.paid, invoice.payment_succeeded, customer.subscription.created, customer.subscription.updated, and customer.subscription.deleted.",
    default: "",
    password: true,
    tags: ["Stripe"],
    group: "Payments & Billing",
    subgroup: "Stripe",
  },
  r2_heading: {
    name: "Cloudflare R2 Backups",
    desc: "Credentials used to configure rustic backups in Cloudflare R2.",
    default: "",
    type: "header",
    tags: ["Backups", "Cloudflare"],
    group: "Backups & Storage",
    subgroup: "Cloudflare R2",
    order: 10,
    show: cloudflare_self_mode,
  },
  r2_account_id: {
    name: "Cloudflare R2 Account ID",
    desc: "Cloudflare account ID used to build the R2 endpoint URL.",
    default: "",
    tags: ["Backups", "Cloudflare"],
    group: "Backups & Storage",
    subgroup: "Cloudflare R2",
    order: 20,
    required_when: [{ key: "cloudflare_mode", equals: "self" }],
    show: cloudflare_self_mode,
    hidden: true,
  },
  r2_api_token: {
    name: "Cloudflare R2 API Token",
    desc: 'Cloudflare API token with "R2:Edit" permissions used to create region buckets automatically.',
    default: "",
    password: true,
    tags: ["Backups", "Cloudflare"],
    group: "Backups & Storage",
    subgroup: "Cloudflare R2",
    order: 30,
    required_when: [{ key: "cloudflare_mode", equals: "self" }],
    show: cloudflare_self_mode,
    hidden: true,
  },
  r2_access_key_id: {
    name: "Cloudflare R2 Access Key ID",
    desc: "Access key for the R2 S3-compatible API.",
    default: "",
    tags: ["Backups", "Cloudflare"],
    group: "Backups & Storage",
    subgroup: "Cloudflare R2",
    order: 40,
    required_when: [{ key: "cloudflare_mode", equals: "self" }],
    show: cloudflare_self_mode,
    hidden: true,
  },
  r2_secret_access_key: {
    name: "Cloudflare R2 Secret Access Key",
    desc: "Secret key for the R2 S3-compatible API.",
    default: "",
    password: true,
    tags: ["Backups", "Cloudflare"],
    group: "Backups & Storage",
    subgroup: "Cloudflare R2",
    order: 50,
    required_when: [{ key: "cloudflare_mode", equals: "self" }],
    show: cloudflare_self_mode,
    hidden: true,
  },
  r2_bucket_prefix: {
    name: "Cloudflare R2 Bucket Prefix",
    desc: "Prefix for per-region backup buckets (e.g., cocalc).",
    default: "",
    tags: ["Backups", "Cloudflare"],
    group: "Backups & Storage",
    subgroup: "Cloudflare R2",
    order: 60,
    show: cloudflare_self_mode,
    hidden: true,
  },
  re_captcha_v3_heading: {
    // this is cosmetic, otherwise it looks weird.
    name: "reCaptcha v3 Keys",
    desc: "You get these from https://www.google.com/recaptcha/intro/v3.html .  They make it so it is more difficult for robots to create accounts on your server.  Users never have to explicitly solve a captcha.",
    default: "",
    type: "header",
    tags: ["captcha"],
    group: "Access & Identity",
    subgroup: "Signup Security",
  },
  re_captcha_v3_publishable_key: {
    name: "reCaptcha v3 Site Key",
    desc: "",
    default: "",
    password: false,
    tags: ["captcha"],
    group: "Access & Identity",
    subgroup: "Signup Security",
  },
  re_captcha_v3_secret_key: {
    name: "reCaptcha v3 Secret Key",
    desc: "",
    default: "",
    password: true,
    tags: ["captcha"],
    group: "Access & Identity",
    subgroup: "Signup Security",
  },
  google_sso_heading: {
    name: "Google Single Sign-On",
    desc: "Configure the built-in Google OpenID Connect sign-in provider. Create an OAuth client in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials) with redirect URI `https://YOUR-DOMAIN/auth/google/return`, then paste its client ID and client secret here.",
    default: "",
    type: "header",
    tags: ["SSO", "Security"],
    group: "Access & Identity",
    subgroup: "Single Sign-On",
  },
  google_sso_enabled: {
    name: "Enable Google SSO",
    desc: "Enable the built-in Google sign-in provider.",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    tags: ["SSO", "Security"],
    group: "Access & Identity",
    subgroup: "Single Sign-On",
  },
  google_sso_client_id: {
    name: "Google SSO Client ID",
    desc: "OAuth client ID from the Google Cloud Console. It usually ends with `.apps.googleusercontent.com`.",
    default: "",
    show: google_sso_enabled,
    required_when: [{ key: "google_sso_enabled", equals: "yes" }],
    to_val: to_trimmed_str,
    tags: ["SSO", "Security"],
    group: "Access & Identity",
    subgroup: "Single Sign-On",
  },
  google_sso_client_secret: {
    name: "Google SSO Client Secret",
    desc: "OAuth client secret from the Google Cloud Console. This is encrypted at rest and never sent back to the browser after saving.",
    default: "",
    password: true,
    show: google_sso_enabled,
    required_when: [{ key: "google_sso_enabled", equals: "yes" }],
    to_val: to_trimmed_str,
    tags: ["SSO", "Security"],
    group: "Access & Identity",
    subgroup: "Single Sign-On",
  },
  google_sso_allowed_domains: {
    name: "Google SSO Allowed Domains",
    desc: "Optional comma-separated email domains, e.g. `example.com, school.edu`. If set, Google SSO is only accepted for verified email addresses in these domains, and password sign-in for those domains is routed to Google SSO.",
    default: "",
    show: google_sso_enabled,
    to_val: to_trimmed_str,
    tags: ["SSO", "Security"],
    group: "Access & Identity",
    subgroup: "Single Sign-On",
  },
  google_sso_signup_mode: {
    name: "Google SSO Account Creation",
    desc: "Deprecated. Google SSO account creation now follows the normal site registration-token policy.",
    default: "registration_token_required",
    show: () => false,
    valid: ["disabled", "registration_token_required", "public_allowed"],
    tags: ["SSO", "Security"],
    group: "Access & Identity",
    subgroup: "Single Sign-On",
  },
  zendesk_heading: {
    name: "Zendesk API Configuration",
    desc: "",
    default: "",
    type: "header",
    tags: ["Zendesk", "Support"],
    group: "Support / Integrations",
    subgroup: "Zendesk",
  },
  zendesk_token: {
    name: "Zendesk Token",
    desc: "This is the API Token in Zendesk; see their Admin --> API page.",
    default: "",
    password: true,
    show: () => true,
    tags: ["Zendesk", "Support"],
    group: "Support / Integrations",
    subgroup: "Zendesk",
  },
  zendesk_username: {
    name: "Zendesk Username",
    desc: "This is the username for Zendesk.  E.g., for `cocalc.ai` it is `support-agent@cocalc.ai`",
    default: "",
    show: () => true,
    tags: ["Zendesk", "Support"],
    group: "Support / Integrations",
    subgroup: "Zendesk",
  },
  zendesk_uri: {
    name: "Zendesk Subdomain",
    desc: "This is the Subdomain of your Zendesk server.  E.g., for `cocalc.ai` it is `sagemathcloud`",
    default: "",
    show: () => true,
    tags: ["Zendesk", "Support"],
    group: "Support / Integrations",
    subgroup: "Zendesk",
  },
  support_account_id: {
    name: "Support CoCalc Account ID",
    desc: "The account_id of a special account that will be used for systemwide support messages in CoCalc.  E.g., when users receive an internal message about billing, this is the account the message will come from.",
    default: "",
    valid: isValidUUID,
    tags: ["Support"],
    group: "Support / Integrations",
    subgroup: "Support Messaging",
  },
  github_heading: {
    name: "GitHub API Configuration",
    desc: "CoCalc can mirror content from  GitHub at `https://yoursite.com/github/[url to github]`. This is just like what https://nbviewer.org does.",
    default: "",
    type: "header",
    tags: ["GitHub"],
    group: "Support / Integrations",
    subgroup: "GitHub",
  },
  github_project_id: {
    name: "GitHub Project ID",
    desc: "If this is set to a `project_id` (a UUID v4 of a project on your server), then the share server will proxy GitHub URL's.  For example, when a user visits https://yoursite.com/github/sagemathinc/cocalc they see a rendered version.  They can star the repo from cocalc, edit it in cocalc, etc.  This extends your CoCalc server to provide similar functionality to what nbviewer.org provides.  Optionally set a GitHub username and personal access token below to massively increase GitHub's API rate limits.",
    default: "",
    valid: isValidUUID,
    tags: ["GitHub"],
    group: "Support / Integrations",
    subgroup: "GitHub",
  },
  github_username: {
    name: "GitHub Username",
    desc: "This is a username for a GitHub Account.",
    default: "",
    show: () => true,
    tags: ["GitHub"],
    group: "Support / Integrations",
    subgroup: "GitHub",
  },
  github_token: {
    name: "GitHub Token",
    desc: "This is a Personal Access token for the above GitHub account.  You can get one at https://github.com/settings/tokens -- you do not have to enable any scopes -- it used only to increase rate limits from 60/hour to 5000/hour.",
    default: "",
    password: true,
    show: () => true,
    tags: ["GitHub"],
    group: "Support / Integrations",
    subgroup: "GitHub",
  },
  github_block: {
    name: "GitHub Abuse Block",
    desc: "In case of **abuse**, you can block proxying of any GitHub URL that contains any string in this comma separated list.",
    default: "",
    show: () => true,
    tags: ["GitHub"],
    group: "Support / Integrations",
    subgroup: "GitHub",
  },
  email_section: {
    name: "Email Configuration",
    desc: "",
    default: "",
    type: "header",
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "Overview",
  },
  email_backend: {
    name: "Email backend type",
    desc: "The type of backend for sending emails ('none' means there is none).",
    default: "",
    valid: ["none", "sendgrid", "smtp"],
    show: () => true,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "Backend",
    required_when: [{ key: "email_enabled", equals: "yes" }],
  },
  notification_email_critical_backend: {
    name: "Critical email lane backend",
    desc: "Backend for critical mail such as account recovery, security alerts, failed payment, and host enforcement. Use 'default' to inherit the main Email backend type.",
    default: "default",
    valid: EMAIL_LANE_BACKENDS,
    show: is_email_enabled,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "Lanes",
  },
  notification_email_transactional_backend: {
    name: "Transactional email lane backend",
    desc: "Backend for receipts, support replies, and account/admin notices. Use 'default' to inherit the main Email backend type.",
    default: "default",
    valid: EMAIL_LANE_BACKENDS,
    show: is_email_enabled,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "Lanes",
  },
  notification_email_notification_backend: {
    name: "Notification email lane backend",
    desc: "Backend for user-triggered notification email such as mentions, invites, AI completion notices, and digests. Use 'default' to inherit the main Email backend type.",
    default: "default",
    valid: EMAIL_LANE_BACKENDS,
    show: is_email_enabled,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "Lanes",
  },
  notification_email_marketing_backend: {
    name: "Marketing email lane backend",
    desc: "Backend for optional product announcements and similar marketing mail. Use 'default' to inherit the main Email backend type.",
    default: "default",
    valid: EMAIL_LANE_BACKENDS,
    show: is_email_enabled,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "Lanes",
  },
  sendgrid_key: {
    name: "Sendgrid API key (for email)",
    desc: "You need a Sendgrid account and then enter a valid API key here",
    password: true,
    default: "",
    show: only_for_email_sendgrid,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "SendGrid",
    required_when: [{ key: "email_backend", equals: "sendgrid" }],
  },
  email_smtp_server: {
    name: "SMTP server",
    desc: "Hostname for the SMTP backend.",
    default: "",
    show: only_for_email_smtp,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "SMTP",
    required_when: [{ key: "email_backend", equals: "smtp" }],
  },
  email_smtp_from: {
    name: "SMTP FROM",
    desc: "FROM and REPLYTO email address for the SMTP backend.",
    default: "",
    valid: is_valid_email_address,
    show: only_for_email_smtp,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "SMTP",
    required_when: [{ key: "email_backend", equals: "smtp" }],
  },
  email_smtp_login: {
    name: "SMTP username",
    desc: "Username for PLAIN SMTP auth.",
    default: "",
    show: only_for_email_smtp,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "SMTP",
    required_when: [{ key: "email_backend", equals: "smtp" }],
  },
  email_smtp_password: {
    name: "SMTP password",
    desc: "Password for PLAIN SMTP auth.",
    default: "",
    show: only_for_email_smtp,
    password: true,
    tags: ["Email"],
    group: "Messaging & Email",
    subgroup: "SMTP",
    required_when: [{ key: "email_backend", equals: "smtp" }],
  },
  prometheus_metrics: {
    name: "Prometheus Metrics",
    desc: "Make [Prometheus metrics](https://prometheus.io/) available at `/metrics`. (Wait one minute after changing this setting for it to take effect.)",
    default: "no",
    valid: only_booleans,
    to_val: to_bool,
    group: "System / Advanced",
    subgroup: "Metrics",
  },
  prometheus_metrics_allowlist: {
    name: "Prometheus Metrics Allowlist",
    desc: "Comma-separated IP/CIDR list allowed to access `/metrics`, e.g., `127.0.0.1/32, ::1/128, 10.0.0.0/8`. Leave empty to **deny all access**.",
    default: "",
    to_val: to_trimmed_str,
    show: metrics_enabled,
    group: "System / Advanced",
    subgroup: "Metrics",
  },
  pay_as_you_go_section: {
    name: "Billing",
    desc: "",
    default: "",
    type: "header",
    tags: ["Pay as you Go"],
    group: "Payments & Billing",
    subgroup: "Pay as you Go",
  },
  pay_as_you_go_min_payment: {
    name: "Minimum Payment",
    desc: "The minimum transaction size, in dollars, for account credit and other automated billing collection flows.",
    default: "2.50",
    to_val: toFloat,
    valid: onlyPosFloat,
    tags: ["Pay as you Go"],
    group: "Payments & Billing",
    subgroup: "Pay as you Go",
  },
  compute_vm_mode: {
    name: "Managed Compute VMs: Mode",
    desc: "Controls the account-owned VM control plane. `disabled` and `reconcile_only` reject create/start while preserving stop, delete, and hard-TTL cleanup. `admin_canary` permits only allowlisted administrators. `enabled` admits memberships authorized for prepaid or postpaid dedicated-host spending.",
    default: "auto",
    to_val: to_trimmed_str,
    valid: (value) =>
      [
        "auto",
        "disabled",
        "reconcile_only",
        "admin_canary",
        "enabled",
      ].includes(`${value ?? ""}`.trim().toLowerCase()),
    tags: ["Cloud", "Security"],
    group: "Compute / Managed VMs",
    subgroup: "Admission",
  },
  compute_vm_emergency_stop: {
    name: "Managed Compute VMs: Emergency Stop",
    desc: "Immediately reject VM create/start and durably request every active managed VM to stop. Deletion and hard-TTL cleanup remain enabled.",
    default: "no",
    to_val: to_bool,
    valid: only_booleans,
    tags: ["Cloud", "Security"],
    group: "Compute / Managed VMs",
    subgroup: "Admission",
  },
  compute_vm_admin_allowlist: {
    name: "Managed Compute VMs: Administrator Allowlist",
    desc: "Comma- or whitespace-separated account UUIDs permitted while mode is `admin_canary`. Staging `auto` mode permits administrators for development; production `auto` mode is disabled.",
    default: "",
    to_val: to_trimmed_str,
    multiline: 3,
    valid: () => true,
    tags: ["Cloud", "Security"],
    group: "Compute / Managed VMs",
    subgroup: "Admission",
  },
  compute_vm_gcp_service_account_json: {
    name: "Managed Compute VMs: GCP Service Account JSON",
    desc: "Dedicated credentials for the isolated hostile-guest compute project. Production VM operations fail closed when this is absent and never fall back to project-host credentials.",
    default: "",
    multiline: 5,
    password: true,
    wizard: {
      name: "compute-vm-gcp-service-account-json",
      label: "Setup isolated GCP project...",
    },
    to_val: to_trimmed_str,
    valid: (value) => {
      const text = `${value ?? ""}`.trim();
      if (!text) return true;
      try {
        const parsed = JSON.parse(text);
        return !!parsed?.project_id && !!parsed?.client_email;
      } catch {
        return false;
      }
    },
    tags: ["Cloud", "Security"],
    group: "Compute / Managed VMs",
    subgroup: "GCP Isolation",
    order: 1,
  },
  compute_vm_gcp_network: {
    name: "Managed Compute VMs: GCP Network",
    desc: "Full global VPC network URI in the dedicated compute project. CoCalc discovers the flow-log-enabled regional subnets on this custom network and selects the subnet matching each VM region.",
    default: "",
    to_val: to_trimmed_str,
    valid: (value) =>
      !`${value ?? ""}`.trim() ||
      /^projects\/[^/]+\/global\/networks\/[^/]+$/.test(`${value}`.trim()),
    tags: ["Cloud", "Security"],
    group: "Compute / Managed VMs",
    subgroup: "GCP Isolation",
  },
  compute_vm_gcp_network_tag: {
    name: "Managed Compute VMs: GCP Network Tag",
    desc: "Network tag whose dedicated firewall policy permits SSH and denies east-west access.",
    default: "cocalc-compute-vm",
    to_val: to_trimmed_str,
    valid: (value) =>
      /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/.test(`${value ?? ""}`),
    tags: ["Cloud", "Security"],
    group: "Compute / Managed VMs",
    subgroup: "GCP Isolation",
  },
  compute_vm_max_active_per_project: {
    name: "Managed Compute VMs: Maximum Active Per Project",
    desc: "Maximum undeleted VM leases associated with one project.",
    default: "10",
    to_val: to_int,
    valid: only_pos_int,
    tags: ["Cloud"],
    group: "Compute / Managed VMs",
    subgroup: "Limits",
  },
  compute_vm_max_active_total: {
    name: "Managed Compute VMs: Maximum Active Site-wide",
    desc: "Emergency site-wide ceiling for undeleted VM leases across this bay.",
    default: "1000",
    to_val: to_int,
    valid: only_pos_int,
    tags: ["Cloud"],
    group: "Compute / Managed VMs",
    subgroup: "Limits",
  },
  compute_vm_max_ttl_minutes: {
    name: "Managed Compute VMs: Maximum TTL Minutes",
    desc: "Hard upper bound for a VM lease. The guest cannot extend this deadline.",
    default: "1440",
    to_val: to_int,
    valid: only_pos_int,
    tags: ["Cloud"],
    group: "Compute / Managed VMs",
    subgroup: "Limits",
  },
  compute_vm_max_boot_disk_gb: {
    name: "Managed Compute VMs: Maximum Boot Disk GB",
    desc: "Largest persistent root disk allowed for a VM lease.",
    default: "10000",
    to_val: to_int,
    valid: only_pos_int,
    tags: ["Cloud"],
    group: "Compute / Managed VMs",
    subgroup: "Limits",
  },
  compute_vm_max_volumes_per_account: {
    name: "Managed Compute VMs: Maximum Volumes Per Account",
    desc: "Maximum undeleted persistent home volumes owned by one account.",
    default: "10",
    to_val: to_int,
    valid: only_pos_int,
    tags: ["Cloud"],
    group: "Compute / Managed VMs",
    subgroup: "Limits",
  },
  compute_vm_unfunded_volume_delete_days: {
    name: "Managed Compute VMs: Unfunded Volume Deletion Days",
    desc: "Delete detached persistent home volumes that remain unfunded for this many days. Admin alerts begin immediately.",
    default: "30",
    to_val: toFloat,
    valid: onlyPosFloat,
    tags: ["Cloud", "Pay as you Go", "Security"],
    group: "Compute / Managed VMs",
    subgroup: "Limits",
  },
  compute_vm_unfunded_volume_max_exposure_usd: {
    name: "Managed Compute VMs: Unfunded Volume Maximum Exposure USD",
    desc: "Delete a detached unfunded persistent home volume early when its estimated retained-storage exposure reaches this amount.",
    default: "100",
    to_val: toFloat,
    valid: onlyPosFloat,
    tags: ["Cloud", "Pay as you Go", "Security"],
    group: "Compute / Managed VMs",
    subgroup: "Limits",
  },
  compute_vm_max_volume_gb: {
    name: "Managed Compute VMs: Maximum Volume GB",
    desc: "Largest persistent home volume allowed. Volumes are retained and billed independently from VMs.",
    default: "10000",
    to_val: to_int,
    valid: only_pos_int,
    tags: ["Cloud"],
    group: "Compute / Managed VMs",
    subgroup: "Limits",
  },
  subscription_maintenance: {
    name: "Subscription Maintenance Parameters",
    desc: 'Example -- { "renewal_mode": "disabled", "request": 6, "renewal_warning_minutes": 10, "renewal_critical_minutes": 1440, "renewal_concurrency": 1 }. Renewal mode is disabled, schedule-only, or active. Send reminders before renewal, control renewal worker concurrency, and aggregate admin alerts when processing is delayed.',
    default:
      '{"renewal_mode":"disabled","request":6,"renewal_warning_minutes":10,"renewal_critical_minutes":1440,"renewal_concurrency":1}',
    to_val: from_json,
    to_display: displayJson,
    valid: parsableJson,
    tags: ["Pay as you Go"],
    group: "Payments & Billing",
    subgroup: "Pay as you Go",
  },
  project_hosts_hyperstack_prefix: {
    name: "Project Hosts: Hyperstack - Resource Prefix",
    desc: "Prepend this string to all Hyperstack resources that are created, e.g., VM names, disks, etc. Experimental: Hyperstack support has not been actively tested recently.",
    default: "cocalc",
    to_val: to_trimmed_str,
    show: project_hosts_hyperstack_enabled,
    tags: ["Project Hosts", "Cloud", "Hyperstack"],
    group: "Compute / Project Hosts",
    subgroup: "Hyperstack",
    hidden: true,
  },
  hyperstack_api_key: {
    name: "Project Hosts: Hyperstack - API Key",
    desc: "Your [Hyperstack API Key](https://console.hyperstack.cloud/api-keys). Experimental: Hyperstack support has not been actively tested recently and may be broken.",
    default: "",
    password: true,
    show: project_hosts_hyperstack_enabled,
    tags: ["Project Hosts", "Cloud", "Hyperstack"],
    group: "Compute / Project Hosts",
    subgroup: "Hyperstack",
    required_when: [{ key: "project_hosts_hyperstack_enabled", equals: "yes" }],
    hidden: true,
  },
  project_hosts_ssh_public_keys: {
    name: "Project Hosts: SSH Public Keys",
    desc: "Optional SSH public keys to add to project hosts (one per line). These are installed for the ubuntu user so site admins can SSH if needed.",
    default: "",
    to_val: to_trimmed_str,
    multiline: 4,
    tags: ["Project Hosts", "Cloud", "SSH"],
    valid: () => true,
    group: "Compute / Project Hosts",
    subgroup: "Access",
  },

  lambda_cloud_api_key: {
    name: "Project Hosts: Lambda Cloud API Key",
    desc: "Your [Lambda Cloud](https://lambdalabs.com/service/gpu-cloud) API Key from https://cloud.lambda.ai/api-keys/cloud-api. Experimental: Lambda Cloud support has not been actively tested recently and may be broken.",
    default: "",
    password: true,
    show: project_hosts_lambda_enabled,
    tags: ["Project Hosts", "Cloud"],
    group: "Compute / Project Hosts",
    subgroup: "Lambda Cloud",
    required_when: [{ key: "project_hosts_lambda_enabled", equals: "yes" }],
    hidden: true,
  },
  project_hosts_lambda_prefix: {
    name: "Project Hosts: Lambda Cloud - Resource Prefix",
    desc: "Prepend this string to all Lambda Cloud resources that are created, e.g., instance names. Experimental: Lambda Cloud support has not been actively tested recently.",
    default: "cocalc-host",
    to_val: to_trimmed_str,
    show: project_hosts_lambda_enabled,
    tags: ["Project Hosts", "Cloud"],
    valid: () => true,
    group: "Compute / Project Hosts",
    subgroup: "Lambda Cloud",
    hidden: true,
  },
  nebius_region_config_json: {
    name: "Project Hosts: Nebius - Region Config (JSON)",
    desc: "Generated by the **Wizard**. Contains per-region Nebius credentials, project, and subnet ids.",
    default: "",
    to_val: to_trimmed_str,
    multiline: 6,
    password: true,
    wizard: { name: "nebius-cli", label: "Wizard..." },
    managed_by_wizard: true,
    show: project_hosts_nebius_enabled,
    tags: ["Project Hosts", "Cloud", "Nebius"],
    valid: (x) => !!x,
    group: "Compute / Project Hosts",
    subgroup: "Nebius",
    required_when: [{ key: "project_hosts_nebius_enabled", equals: "yes" }],
  },
  project_hosts_nebius_prefix: {
    name: "Project Hosts: Nebius - Resource Prefix",
    desc: "Prepend this string to all Nebius resources that are created, e.g., instance names. Keep this short. If the prefix is 'cocalc', then a project host with id 17 will be called 'cocalc-17'.",
    default: "cocalc-host",
    to_val: to_trimmed_str,
    show: project_hosts_nebius_enabled,
    tags: ["Project Hosts", "Cloud", "Nebius"],
    valid: () => true,
    group: "Compute / Project Hosts",
    subgroup: "Nebius",
  },
  google_cloud_service_account_json: {
    name: "Project Hosts: Google Cloud - Service Account Json",
    desc: 'Use the **Wizard**, or paste the Service Account key JSON for a Google Cloud Service Account with the IAM Role: **Editor** (for compute servers). This supports managing compute servers on Google Cloud, and you must enable the Compute Engine API.\n\nExample format:\n```js\n{"type": "service_account",...,"universe_domain": "googleapis.com"}\n```',
    default: "",
    multiline: 5,
    password: true,
    wizard: { name: "gcp-service-account-json", label: "Wizard..." },
    show: project_hosts_google_cloud_enabled,
    tags: ["Project Hosts", "Cloud"],
    group: "Compute / Project Hosts",
    subgroup: "Google Cloud",
    required_when: [
      { key: "project_hosts_google-cloud_enabled", equals: "yes" },
    ],
  },
  project_hosts_google_prefix: {
    name: "Project Hosts: Google Cloud - Resource Prefix",
    desc: "Prepend this string to all Google Cloud resources that are created, e.g., VM names, disks, etc. Keep this short. If the prefix is 'cocalc', then a project host with id 17 will be called 'cocalc-17'. You should change this if you manage multiple CoCalc installations in the same Google Cloud project.",
    default: "cocalc-host",
    to_val: to_trimmed_str,
    show: project_hosts_google_cloud_enabled,
    tags: ["Project Hosts", "Cloud"],
    valid: () => true,
    group: "Compute / Project Hosts",
    subgroup: "Google Cloud",
  },
  project_hosts_route_mode: {
    name: "Project Hosts: Hub Route Mode",
    desc: "Controls how hubs connect to managed project hosts. `auto` uses private GCP routing when available and public routing for other providers. `internal` explicitly selects private GCP routing. `public` routes through each host's public Cloudflare/DNS URL, which is required when the hub and project hosts are in separate cloud projects or VPCs.",
    default: "auto",
    to_val: to_trimmed_str,
    valid: ["auto", "internal", "public"],
    valid_labels: {
      auto: "Automatic (private GCP routing)",
      internal: "Internal/private network",
      public: "Public host URL",
    },
    tags: ["Project Hosts", "Cloud"],
    group: "Compute / Project Hosts",
    subgroup: "Networking",
  },
  project_hosts_software_base_url: {
    name: "Project Hosts: Software Base URL",
    desc: "Base URL for project-host software artifacts. This must contain manifests like `project-host/latest-linux.json`, `container-runtime/latest-linux-amd64.json`, `project/latest-linux.json`, and `tools/latest-linux-amd64.json` (e.g., https://software.cocalc.ai/software). Optional version indexes use the corresponding `versions-latest-*.json` names.",
    default: "https://software.cocalc.ai/software",
    to_val: to_trimmed_str,
    tags: ["Project Hosts", "Cloud"],
    valid: () => true,
    group: "Compute / Project Hosts",
    subgroup: "Bootstrap",
  },
  project_hosts_runtime_retention_policy: {
    name: "Project Hosts: Runtime Retention Policy",
    desc: 'Controls how many installed project-host runtime artifacts are retained locally for rollback and recovery. Example: `{"project-host":{"keep_count":10},"container-runtime":{"keep_count":3},"project-bundle":{"keep_count":3},"tools":{"keep_count":3}}`. Optional `max_bytes` per artifact can retain extra recent versions while under budget.',
    default:
      '{"project-host":{"keep_count":10},"container-runtime":{"keep_count":3},"project-bundle":{"keep_count":3},"tools":{"keep_count":3}}',
    multiline: 6,
    to_val: from_json,
    valid: parsableJson,
    to_display: displayJson,
    wizard: { name: "runtime-retention-policy", label: "Wizard..." },
    managed_by_wizard: true,
    tags: ["Project Hosts", "Cloud"],
    group: "Compute / Project Hosts",
    subgroup: "Runtime Software",
  },
  project_hosts_bootstrap_channel: {
    name: "Project Hosts: Bootstrap Channel",
    desc: "Default bootstrap channel for new hosts (e.g., latest or test). Leave blank to use latest.",
    default: "latest",
    to_val: to_trimmed_str,
    tags: ["Project Hosts"],
    valid: () => true,
    group: "Compute / Project Hosts",
    subgroup: "Bootstrap",
  },
  project_hosts_bootstrap_version: {
    name: "Project Hosts: Bootstrap Version Pin",
    desc: "Optional explicit bootstrap version to use for new hosts (overrides channel). Leave blank to use the channel.",
    default: "",
    to_val: to_trimmed_str,
    tags: ["Project Hosts"],
    valid: () => true,
    group: "Compute / Project Hosts",
    subgroup: "Bootstrap",
  },
  project_hosts_self_host_connector_version: {
    name: "Project Hosts: Self-Host Connector Version",
    desc: "Optional version pin for the self-host connector (leave blank to use latest). Experimental/Insecure: self-host is hidden by default and should not be enabled on normal multi-user servers yet.",
    default: "",
    to_val: to_trimmed_str,
    tags: ["Project Hosts", "On-Prem"],
    valid: () => true,
    group: "Compute / Project Hosts",
    subgroup: "On-Prem",
    hidden: true,
  },
  project_hosts_cloudflare_tunnel_enabled: {
    name: "Project Hosts: Cloudflare Tunnel - Enable",
    desc: "Enable Cloudflare Tunnel for project hosts. This lets project-hosts be reachable via Cloudflare without inbound firewall rules.",
    default: "no",
    to_val: to_bool,
    valid: only_booleans,
    wizard: { name: "cloudflare-config", label: "Wizard..." },
    tags: ["Project Hosts", "Cloud", "Cloudflare"],
    group: "Cloudflare",
    subgroup: "Cloudflare Tunnel",
    order: 10,
    hidden: true,
  },
  project_hosts_cloudflare_tunnel_account_id: {
    name: "Project Hosts: Cloudflare Tunnel - Account ID",
    desc: "Cloudflare account ID that owns the tunnel.",
    default: "",
    to_val: to_trimmed_str,
    tags: ["Project Hosts", "Cloud", "Cloudflare"],
    valid: () => true,
    group: "Cloudflare",
    subgroup: "Cloudflare Tunnel",
    order: 20,
    required_when: [{ key: "cloudflare_mode", equals: "self" }],
    show: cloudflare_self_mode,
    hidden: true,
  },
  project_hosts_cloudflare_tunnel_api_token: {
    name: "Project Hosts: Cloudflare Tunnel - API Token",
    desc: "Cloudflare API token with permissions for Cloudflare Tunnel and DNS (Account:Cloudflare Tunnel:Edit, Zone:DNS:Edit).",
    default: "",
    password: true,
    to_val: to_trimmed_str,
    tags: ["Project Hosts", "Cloud", "Cloudflare"],
    group: "Cloudflare",
    subgroup: "Cloudflare Tunnel",
    order: 30,
    required_when: [{ key: "cloudflare_mode", equals: "self" }],
    show: cloudflare_self_mode,
    hidden: true,
  },
  project_hosts_cloudflare_tunnel_prefix: {
    name: "Project Hosts: Cloudflare Tunnel - Name Prefix",
    desc: "Optional prefix for Cloudflare Tunnel names (hub and project-host tunnels). Useful to distinguish tunnels between multiple installations.",
    default: "cocalc",
    to_val: to_trimmed_str,
    tags: ["Project Hosts", "Cloud", "Cloudflare"],
    valid: () => true,
    group: "Cloudflare",
    subgroup: "Cloudflare Tunnel",
    order: 40,
    show: cloudflare_self_mode,
    hidden: true,
  },
  project_hosts_cloudflare_tunnel_host_suffix: {
    name: "Project Hosts: Cloudflare Tunnel - Hostname Suffix",
    desc: "Optional suffix for project-host tunnel hostnames. Defaults to `-` + External Domain Name if blank. Bare suffixes are placed under the inferred Cloudflare base domain, e.g. with External Domain `staging.cocalc.ai`, `cocalc-staging` becomes `-cocalc-staging.cocalc.ai`. Use a fully qualified suffix such as `-hosts.cocalc.ai` or `.dev.cocalc.ai` when you need exact control. Note: nested subdomains require a certificate that covers that wildcard, e.g. Cloudflare Advanced Certificate Manager.",
    default: "",
    to_val: to_trimmed_str,
    tags: ["Project Hosts", "Cloud", "Cloudflare"],
    valid: () => true,
    group: "Cloudflare",
    subgroup: "Cloudflare Tunnel",
    order: 50,
    show: cloudflare_self_mode,
    hidden: true,
  },
} as const;
