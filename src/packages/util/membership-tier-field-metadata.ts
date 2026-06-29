/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type MembershipTierFieldCard =
  | "product"
  | "runtime"
  | "usage-budgets"
  | "collaboration"
  | "codex-acp"
  | "dedicated-hosts"
  | "financial-risk"
  | "advanced";

export type MembershipTierFieldStatus =
  | "primary"
  | "advanced"
  | "compatibility-only"
  | "deprecated";

export type MembershipTierFieldRisk =
  | "storefront"
  | "hard-cost"
  | "capacity"
  | "abuse"
  | "collaboration"
  | "dedicated-host"
  | "internal";

export type MembershipTierFieldInputType =
  | "boolean"
  | "currency"
  | "integer"
  | "json"
  | "number"
  | "string-list"
  | "text"
  | "textarea";

export type MembershipTierFieldValueType =
  | "boolean"
  | "json"
  | "number"
  | "string"
  | "string-list";

export type MembershipTierFieldPath =
  | readonly [string]
  | readonly [string, string];

export interface MembershipTierFieldMetadata {
  id: string;
  path: MembershipTierFieldPath;
  card: MembershipTierFieldCard;
  label: string;
  help: string;
  input: MembershipTierFieldInputType;
  valueType: MembershipTierFieldValueType;
  status: MembershipTierFieldStatus;
  risks: readonly MembershipTierFieldRisk[];
  unit?: string;
  displayUnit?: string;
  displayFactor?: number;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
  public?: boolean;
}

type FieldDefinition = Omit<MembershipTierFieldMetadata, "status"> & {
  status?: MembershipTierFieldStatus;
};

function field(definition: FieldDefinition): MembershipTierFieldMetadata {
  return {
    status: "primary",
    ...definition,
  };
}

const GB = 1_000_000_000;

export const MEMBERSHIP_TIER_FIELDS = [
  field({
    id: "id",
    path: ["id"],
    card: "product",
    label: "Tier ID",
    help: "Stable machine identifier for this tier. Changing this creates a different product entitlement.",
    input: "text",
    valueType: "string",
    risks: ["storefront", "internal"],
    public: true,
  }),
  field({
    id: "label",
    path: ["label"],
    card: "product",
    label: "Display name",
    help: "Human-readable tier name shown to admins and users.",
    input: "text",
    valueType: "string",
    risks: ["storefront"],
    public: true,
  }),
  field({
    id: "disabled",
    path: ["disabled"],
    card: "product",
    label: "Disabled",
    help: "Disable this tier so it cannot be newly assigned or purchased.",
    input: "boolean",
    valueType: "boolean",
    risks: ["storefront"],
  }),
  field({
    id: "store_visible",
    path: ["store_visible"],
    card: "product",
    label: "Visible for purchase",
    help: "Show this tier in public pricing and purchase surfaces.",
    input: "boolean",
    valueType: "boolean",
    risks: ["storefront"],
    public: true,
  }),
  field({
    id: "store_description",
    path: ["store_description"],
    card: "product",
    label: "Public description",
    help: "Short public explanation of who this tier is for.",
    input: "textarea",
    valueType: "string",
    risks: ["storefront"],
    public: true,
  }),
  field({
    id: "store_highlights",
    path: ["store_highlights"],
    card: "product",
    label: "Public highlights",
    help: "Public bullet points for pricing and membership comparison views.",
    input: "string-list",
    valueType: "string-list",
    risks: ["storefront"],
    public: true,
  }),
  field({
    id: "site_license_pool_description",
    path: ["site_license_pool_description"],
    card: "product",
    label: "Site-license pool description",
    help: "Default user-facing pool description copied into new site-license pools using this tier.",
    input: "textarea",
    valueType: "string",
    risks: ["storefront"],
    public: true,
  }),
  field({
    id: "team_visible",
    path: ["team_visible"],
    card: "product",
    label: "Team license visible",
    help: "Show this tier as a team-license seat option.",
    input: "boolean",
    valueType: "boolean",
    risks: ["storefront"],
    public: true,
  }),
  field({
    id: "priority",
    path: ["priority"],
    card: "product",
    label: "Tier priority",
    help: "Ordering and precedence value when tiers are compared.",
    input: "integer",
    valueType: "number",
    risks: ["internal"],
    integer: true,
  }),
  field({
    id: "price_monthly",
    path: ["price_monthly"],
    card: "product",
    label: "Monthly price",
    help: "Advertised recurring monthly price for this tier.",
    input: "currency",
    valueType: "number",
    risks: ["storefront"],
    unit: "USD",
    minimum: 0,
    public: true,
  }),
  field({
    id: "price_yearly",
    path: ["price_yearly"],
    card: "product",
    label: "Yearly price",
    help: "Advertised recurring yearly price for this tier.",
    input: "currency",
    valueType: "number",
    risks: ["storefront"],
    unit: "USD",
    minimum: 0,
    public: true,
  }),
  field({
    id: "trial_days",
    path: ["trial_days"],
    card: "product",
    label: "Trial days",
    help: "Trial duration before paid billing starts.",
    input: "integer",
    valueType: "number",
    risks: ["storefront", "hard-cost", "abuse"],
    unit: "days",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "course_store_visible",
    path: ["course_store_visible"],
    card: "product",
    label: "Course purchase visible",
    help: "Show this tier as a course-oriented purchase option.",
    input: "boolean",
    valueType: "boolean",
    risks: ["storefront"],
    public: true,
  }),
  field({
    id: "course_allowed_domains",
    path: ["course_allowed_domains"],
    card: "product",
    label: "Course allowed instructor domains",
    help: "Optional verified instructor email domains allowed to select this course tier. Leave empty for any instructor. Use example.edu for exact domains or *.example.edu for subdomains.",
    input: "string-list",
    valueType: "string-list",
    risks: ["storefront"],
  }),
  field({
    id: "course_price",
    path: ["course_price"],
    card: "product",
    label: "Course price",
    help: "One-time course price for this tier.",
    input: "currency",
    valueType: "number",
    risks: ["storefront"],
    unit: "USD",
    minimum: 0,
    public: true,
  }),
  field({
    id: "course_duration_days",
    path: ["course_duration_days"],
    card: "product",
    label: "Course duration",
    help: "Nominal paid course access duration.",
    input: "integer",
    valueType: "number",
    risks: ["storefront"],
    unit: "days",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "course_grace_days",
    path: ["course_grace_days"],
    card: "product",
    label: "Course grace period",
    help: "Additional course access days after nominal duration.",
    input: "integer",
    valueType: "number",
    risks: ["storefront"],
    unit: "days",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "notes",
    path: ["notes"],
    card: "product",
    label: "Admin notes",
    help: "Internal notes for admins. Not shown publicly.",
    input: "textarea",
    valueType: "string",
    risks: ["internal"],
  }),
  field({
    id: "project_defaults.memory",
    path: ["project_defaults", "memory"],
    card: "runtime",
    label: "Project RAM limit",
    help: "Maximum memory available to each project owned by this account when started or restarted.",
    input: "number",
    valueType: "number",
    risks: ["capacity"],
    unit: "MB",
    minimum: 0,
    public: true,
  }),
  field({
    id: "project_defaults.memory_request",
    path: ["project_defaults", "memory_request"],
    card: "runtime",
    label: "Project requested RAM",
    help: "Requested memory used for scheduling. Usually at or below the RAM limit.",
    input: "number",
    valueType: "number",
    risks: ["capacity"],
    unit: "MB",
    minimum: 0,
  }),
  field({
    id: "project_defaults.disk_quota",
    path: ["project_defaults", "disk_quota"],
    card: "runtime",
    label: "Per-project disk quota",
    help: "Disk quota applied to each project. This is separate from account-wide storage limits.",
    input: "number",
    valueType: "number",
    risks: ["capacity"],
    unit: "MB",
    minimum: 0,
    public: true,
  }),
  field({
    id: "features.project_host_tier",
    path: ["features", "project_host_tier"],
    card: "runtime",
    label: "Project-host tier",
    help: "Highest shared public project-host tier this membership can use. Tier N can use public hosts up to N.",
    input: "integer",
    valueType: "number",
    risks: ["capacity", "storefront"],
    unit: "tier",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.shared_compute_priority",
    path: ["usage_limits", "shared_compute_priority"],
    card: "runtime",
    label: "Shared compute priority",
    help: "Relative priority used by project-host admission, eviction, and restart decisions.",
    input: "integer",
    valueType: "number",
    risks: ["capacity", "abuse"],
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.max_sponsored_running_projects",
    path: ["usage_limits", "max_sponsored_running_projects"],
    card: "runtime",
    label: "Sponsored running projects",
    help: "Maximum simultaneously starting or running projects whose runtime this account can sponsor.",
    input: "integer",
    valueType: "number",
    risks: ["capacity", "abuse"],
    unit: "projects",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.cpu_5h_seconds",
    path: ["usage_limits", "cpu_5h_seconds"],
    card: "usage-budgets",
    label: "CPU budget, 5 hours",
    help: "Rolling 5-hour CPU budget. Stored as seconds; displayed as CPU-hours.",
    input: "number",
    valueType: "number",
    risks: ["capacity", "abuse"],
    unit: "seconds",
    displayUnit: "CPU-hours",
    displayFactor: 1 / 3600,
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.cpu_7d_seconds",
    path: ["usage_limits", "cpu_7d_seconds"],
    card: "usage-budgets",
    label: "CPU budget, 7 days",
    help: "Rolling 7-day CPU budget. Stored as seconds; displayed as CPU-hours.",
    input: "number",
    valueType: "number",
    risks: ["capacity", "abuse"],
    unit: "seconds",
    displayUnit: "CPU-hours",
    displayFactor: 1 / 3600,
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.egress_5h_bytes",
    path: ["usage_limits", "egress_5h_bytes"],
    card: "usage-budgets",
    label: "Managed egress, 5 hours",
    help: "Rolling 5-hour managed egress budget. Stored as bytes; displayed as GB.",
    input: "number",
    valueType: "number",
    risks: ["hard-cost", "abuse"],
    unit: "bytes",
    displayUnit: "GB",
    displayFactor: 1 / GB,
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.egress_7d_bytes",
    path: ["usage_limits", "egress_7d_bytes"],
    card: "usage-budgets",
    label: "Managed egress, 7 days",
    help: "Rolling 7-day managed egress budget. Stored as bytes; displayed as GB.",
    input: "number",
    valueType: "number",
    risks: ["hard-cost", "abuse"],
    unit: "bytes",
    displayUnit: "GB",
    displayFactor: 1 / GB,
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "ai_limits.units_5h",
    path: ["ai_limits", "units_5h"],
    card: "usage-budgets",
    label: "AI units, 5 hours",
    help: "Rolling 5-hour AI usage budget in normalized platform AI units.",
    input: "number",
    valueType: "number",
    risks: ["hard-cost", "abuse"],
    unit: "units",
    minimum: 0,
    public: true,
  }),
  field({
    id: "ai_limits.units_7d",
    path: ["ai_limits", "units_7d"],
    card: "usage-budgets",
    label: "AI units, 7 days",
    help: "Rolling 7-day AI usage budget in normalized platform AI units.",
    input: "number",
    valueType: "number",
    risks: ["hard-cost", "abuse"],
    unit: "units",
    minimum: 0,
    public: true,
  }),
  field({
    id: "usage_limits.blob_account_total_bytes",
    path: ["usage_limits", "blob_account_total_bytes"],
    card: "usage-budgets",
    label: "Blob storage per account",
    help: "Maximum active blob storage attributed to this account.",
    input: "number",
    valueType: "number",
    risks: ["hard-cost"],
    unit: "bytes",
    displayUnit: "GB",
    displayFactor: 1 / GB,
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.blob_account_count",
    path: ["usage_limits", "blob_account_count"],
    card: "usage-budgets",
    label: "Blob count per account",
    help: "Maximum number of active blobs attributed to this account.",
    input: "integer",
    valueType: "number",
    risks: ["hard-cost", "abuse"],
    unit: "blobs",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.blob_project_total_bytes",
    path: ["usage_limits", "blob_project_total_bytes"],
    card: "usage-budgets",
    label: "Blob storage per project",
    help: "Maximum active blob storage attributed to any one project sponsored by this account.",
    input: "number",
    valueType: "number",
    risks: ["hard-cost"],
    unit: "bytes",
    displayUnit: "GB",
    displayFactor: 1 / GB,
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.blob_project_count",
    path: ["usage_limits", "blob_project_count"],
    card: "usage-budgets",
    label: "Blob count per project",
    help: "Maximum number of active blobs attributed to any one project sponsored by this account.",
    input: "integer",
    valueType: "number",
    risks: ["hard-cost", "abuse"],
    unit: "blobs",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.public_directory_shares",
    path: ["usage_limits", "public_directory_shares"],
    card: "usage-budgets",
    label: "Published directory shares",
    help: "Maximum active public directory shares this account may create across all projects.",
    input: "integer",
    valueType: "number",
    risks: ["abuse", "capacity"],
    unit: "shares",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.rootfs_count",
    path: ["usage_limits", "rootfs_count"],
    card: "usage-budgets",
    label: "RootFS image count",
    help: "Maximum active user-created RootFS catalog entries this account may own.",
    input: "integer",
    valueType: "number",
    risks: ["hard-cost", "capacity", "abuse"],
    unit: "images",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.rootfs_total_storage_gb",
    path: ["usage_limits", "rootfs_total_storage_gb"],
    card: "usage-budgets",
    label: "RootFS total storage",
    help: "Maximum total stored RootFS data this account may own.",
    input: "number",
    valueType: "number",
    risks: ["hard-cost"],
    unit: "GB",
    minimum: 0,
    public: true,
  }),
  field({
    id: "usage_limits.rootfs_max_storage_gb",
    path: ["usage_limits", "rootfs_max_storage_gb"],
    card: "usage-budgets",
    label: "RootFS per-image storage",
    help: "Maximum stored size of any one user-created RootFS image.",
    input: "number",
    valueType: "number",
    risks: ["hard-cost"],
    unit: "GB",
    minimum: 0,
  }),
  field({
    id: "usage_limits.rootfs_oci_images",
    path: ["usage_limits", "rootfs_oci_images"],
    card: "usage-budgets",
    label: "Remote OCI RootFS images",
    help: "Allow arbitrary remote OCI images outside the managed RootFS catalog.",
    input: "boolean",
    valueType: "boolean",
    risks: ["abuse", "capacity"],
    public: true,
  }),
  field({
    id: "usage_limits.project_max_collaborators_and_pending_invites",
    path: ["usage_limits", "project_max_collaborators_and_pending_invites"],
    card: "collaboration",
    label: "Project collaborators and pending invites",
    help: "Maximum collaborators plus pending invitations per project.",
    input: "integer",
    valueType: "number",
    risks: ["collaboration", "abuse"],
    unit: "people",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.course_max_students_and_pending_invites",
    path: ["usage_limits", "course_max_students_and_pending_invites"],
    card: "collaboration",
    label: "Course students and pending invites",
    help: "Maximum students plus pending invitations per course.",
    input: "integer",
    valueType: "number",
    risks: ["collaboration", "abuse"],
    unit: "people",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.invite_email_send_enabled",
    path: ["usage_limits", "invite_email_send_enabled"],
    card: "collaboration",
    label: "Invite email sending",
    help: "Allow this tier to send project/course invitation email from CoCalc.",
    input: "boolean",
    valueType: "boolean",
    risks: ["hard-cost", "abuse", "collaboration"],
    public: true,
  }),
  field({
    id: "usage_limits.invite_email_daily_count",
    path: ["usage_limits", "invite_email_daily_count"],
    card: "collaboration",
    label: "Invite emails per day",
    help: "Daily count limit for invitation email sends.",
    input: "integer",
    valueType: "number",
    risks: ["hard-cost", "abuse", "collaboration"],
    unit: "emails",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.invite_email_hourly_count",
    path: ["usage_limits", "invite_email_hourly_count"],
    card: "collaboration",
    label: "Invite emails per hour",
    help: "Hourly count limit for invitation email sends.",
    input: "integer",
    valueType: "number",
    risks: ["hard-cost", "abuse", "collaboration"],
    unit: "emails",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.invite_email_recipients_per_batch",
    path: ["usage_limits", "invite_email_recipients_per_batch"],
    card: "collaboration",
    label: "Invite recipients per batch",
    help: "Maximum recipient count for one invite-send action.",
    input: "integer",
    valueType: "number",
    risks: ["abuse", "collaboration"],
    unit: "recipients",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.invite_email_custom_message_max_chars",
    path: ["usage_limits", "invite_email_custom_message_max_chars"],
    card: "collaboration",
    label: "Invite custom message length",
    help: "Maximum characters allowed in a user-provided invite message.",
    input: "integer",
    valueType: "number",
    risks: ["abuse", "collaboration"],
    unit: "characters",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.acp_max_queued_per_account",
    path: ["usage_limits", "acp_max_queued_per_account"],
    card: "codex-acp",
    label: "ACP queued turns per account",
    help: "Maximum queued durable Codex/ACP turns per account.",
    input: "integer",
    valueType: "number",
    risks: ["capacity", "abuse"],
    unit: "turns",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.acp_max_queued_per_thread",
    path: ["usage_limits", "acp_max_queued_per_thread"],
    card: "codex-acp",
    label: "ACP queued turns per thread",
    help: "Maximum queued durable Codex/ACP turns in one chat thread.",
    input: "integer",
    valueType: "number",
    risks: ["capacity", "abuse"],
    unit: "turns",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.acp_max_created_5h_per_account",
    path: ["usage_limits", "acp_max_created_5h_per_account"],
    card: "codex-acp",
    label: "ACP created turns, 5 hours",
    help: "Rolling 5-hour creation limit for durable Codex/ACP turns.",
    input: "integer",
    valueType: "number",
    risks: ["capacity", "abuse"],
    unit: "turns",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.acp_max_created_7d_per_account",
    path: ["usage_limits", "acp_max_created_7d_per_account"],
    card: "codex-acp",
    label: "ACP created turns, 7 days",
    help: "Rolling 7-day creation limit for durable Codex/ACP turns.",
    input: "integer",
    valueType: "number",
    risks: ["capacity", "abuse"],
    unit: "turns",
    minimum: 0,
    integer: true,
    public: true,
  }),
  field({
    id: "usage_limits.acp_max_running_per_account",
    path: ["usage_limits", "acp_max_running_per_account"],
    card: "codex-acp",
    label: "ACP running turns per account",
    help: "Maximum concurrently running durable Codex/ACP turns across projects.",
    input: "integer",
    valueType: "number",
    risks: ["capacity", "abuse"],
    unit: "turns",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.acp_max_running_per_project",
    path: ["usage_limits", "acp_max_running_per_project"],
    card: "codex-acp",
    label: "ACP running turns per project",
    help: "Maximum concurrently running durable Codex/ACP turns for one project.",
    input: "integer",
    valueType: "number",
    risks: ["capacity", "abuse"],
    unit: "turns",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "usage_limits.acp_max_active_automations_per_project",
    path: ["usage_limits", "acp_max_active_automations_per_project"],
    card: "codex-acp",
    label: "Active ACP automations per project",
    help: "Maximum enabled scheduled Codex/ACP automations for one project.",
    input: "integer",
    valueType: "number",
    risks: ["capacity", "abuse"],
    unit: "automations",
    minimum: 0,
    integer: true,
  }),
  field({
    id: "features.create_hosts",
    path: ["features", "create_hosts"],
    card: "dedicated-hosts",
    label: "Can create dedicated hosts",
    help: "Allow this tier to create/rent dedicated project hosts.",
    input: "boolean",
    valueType: "boolean",
    risks: ["dedicated-host", "hard-cost", "abuse"],
    public: true,
  }),
  field({
    id: "usage_limits.prepaid_host_usage_limit_5h_usd",
    path: ["usage_limits", "prepaid_host_usage_limit_5h_usd"],
    card: "dedicated-hosts",
    label: "Prepaid host spend, 5 hours",
    help: "Fixed account 5-hour dedicated-host spend limit when using prepaid balance.",
    input: "currency",
    valueType: "number",
    risks: ["dedicated-host", "hard-cost"],
    unit: "USD",
    minimum: 0,
  }),
  field({
    id: "usage_limits.prepaid_host_usage_limit_7d_usd",
    path: ["usage_limits", "prepaid_host_usage_limit_7d_usd"],
    card: "dedicated-hosts",
    label: "Prepaid host spend, 7 days",
    help: "Fixed account 7-day dedicated-host spend limit when using prepaid balance.",
    input: "currency",
    valueType: "number",
    risks: ["dedicated-host", "hard-cost"],
    unit: "USD",
    minimum: 0,
  }),
  field({
    id: "usage_limits.credit_spend_limit_5h_usd",
    path: ["usage_limits", "credit_spend_limit_5h_usd"],
    card: "dedicated-hosts",
    label: "Postpaid host spend, 5 hours",
    help: "Fixed account 5-hour postpaid dedicated-host spend limit.",
    input: "currency",
    valueType: "number",
    risks: ["dedicated-host", "hard-cost"],
    unit: "USD",
    minimum: 0,
  }),
  field({
    id: "usage_limits.credit_spend_limit_7d_usd",
    path: ["usage_limits", "credit_spend_limit_7d_usd"],
    card: "dedicated-hosts",
    label: "Postpaid host spend, 7 days",
    help: "Fixed account 7-day postpaid dedicated-host spend limit.",
    input: "currency",
    valueType: "number",
    risks: ["dedicated-host", "hard-cost"],
    unit: "USD",
    minimum: 0,
  }),
  field({
    id: "usage_limits.dedicated_host_egress_policy",
    path: ["usage_limits", "dedicated_host_egress_policy"],
    card: "dedicated-hosts",
    label: "Dedicated host egress policy",
    help: "Policy selector for dedicated-host egress accounting and limits.",
    input: "text",
    valueType: "string",
    risks: ["dedicated-host", "hard-cost", "abuse"],
  }),
] as const satisfies readonly MembershipTierFieldMetadata[];

export const MEMBERSHIP_TIER_FIELD_BY_ID = Object.freeze(
  Object.fromEntries(MEMBERSHIP_TIER_FIELDS.map((field) => [field.id, field])),
) as Readonly<Record<string, MembershipTierFieldMetadata>>;

export const MEMBERSHIP_TIER_FIELD_CARDS: readonly MembershipTierFieldCard[] = [
  "product",
  "runtime",
  "usage-budgets",
  "collaboration",
  "codex-acp",
  "dedicated-hosts",
  "financial-risk",
  "advanced",
];

export function getMembershipTierField(
  id: string,
): MembershipTierFieldMetadata | undefined {
  return MEMBERSHIP_TIER_FIELD_BY_ID[id];
}

export function membershipTierFieldsForCard(
  card: MembershipTierFieldCard,
  opts: { includeAdvanced?: boolean } = {},
): MembershipTierFieldMetadata[] {
  return MEMBERSHIP_TIER_FIELDS.filter(
    (field) =>
      field.card === card &&
      (opts.includeAdvanced ||
        field.status === "primary" ||
        field.status === "advanced"),
  );
}

export function membershipTierFieldsByStatus(
  status: MembershipTierFieldStatus,
): MembershipTierFieldMetadata[] {
  return MEMBERSHIP_TIER_FIELDS.filter((field) => field.status === status);
}

export function membershipTierFieldPath(
  fieldOrId: MembershipTierFieldMetadata | string,
): string[] {
  const field =
    typeof fieldOrId === "string"
      ? getMembershipTierField(fieldOrId)
      : fieldOrId;
  if (field == null) {
    throw new Error(`unknown membership tier field: ${fieldOrId}`);
  }
  return [...field.path];
}

export function membershipTierStoredToDisplayValue(
  fieldOrId: MembershipTierFieldMetadata | string,
  value: unknown,
): unknown {
  const field =
    typeof fieldOrId === "string"
      ? getMembershipTierField(fieldOrId)
      : fieldOrId;
  if (field == null) {
    throw new Error(`unknown membership tier field: ${fieldOrId}`);
  }
  if (field.valueType !== "number" || field.displayFactor == null) {
    return value;
  }
  const numberValue = toFiniteNumber(value);
  return numberValue == null ? undefined : numberValue * field.displayFactor;
}

export function membershipTierDisplayToStoredValue(
  fieldOrId: MembershipTierFieldMetadata | string,
  value: unknown,
): unknown {
  const field =
    typeof fieldOrId === "string"
      ? getMembershipTierField(fieldOrId)
      : fieldOrId;
  if (field == null) {
    throw new Error(`unknown membership tier field: ${fieldOrId}`);
  }
  if (field.valueType !== "number") {
    return value;
  }
  const numberValue = toFiniteNumber(value);
  if (numberValue == null) {
    return undefined;
  }
  const stored =
    field.displayFactor != null
      ? numberValue / field.displayFactor
      : numberValue;
  return field.integer ? Math.round(stored) : stored;
}

export function membershipTierFieldDisplayUnit(
  fieldOrId: MembershipTierFieldMetadata | string,
): string | undefined {
  const field =
    typeof fieldOrId === "string"
      ? getMembershipTierField(fieldOrId)
      : fieldOrId;
  if (field == null) {
    throw new Error(`unknown membership tier field: ${fieldOrId}`);
  }
  return field.displayUnit ?? field.unit;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
}
