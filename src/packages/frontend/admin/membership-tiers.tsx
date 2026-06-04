/*
 *  This file is part of CoCalc: Copyright © 2024 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Admin UI for membership tiers.
*/

import {
  Alert,
  Button,
  Checkbox,
  Col,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Popover,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Typography,
} from "antd";
import dayjs from "dayjs";
import jsonic from "jsonic";
import { sortBy, pick } from "lodash";
import { useIntl } from "react-intl";

import { React } from "@cocalc/frontend/app-framework";
import {
  Icon,
  ErrorDisplay,
  Saving,
  TimeAgo,
} from "@cocalc/frontend/components";
import { JsonObjectEditor } from "@cocalc/frontend/components/json-object-editor";
import { labels } from "@cocalc/frontend/i18n";
import { query } from "@cocalc/frontend/frame-editors/generic/client";
import { currency } from "@cocalc/util/misc";
import {
  applyMembershipTierTemplateFallbacks,
  TIER_TEMPLATES,
} from "@cocalc/util/membership-tier-templates";
import {
  analyzeMembershipTierPricingRisk,
  DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS,
  MEMBERSHIP_TIER_PRICING_DAYS_PER_MONTH,
  MEMBERSHIP_TIER_PRICING_DAYS_PER_WEEK,
  MEMBERSHIP_TIER_PRICING_HOURS_PER_MONTH,
  normalizeMembershipTierPricingAssumptions,
  type MembershipTierPricingAssumptions,
  type MembershipTierPricingInput,
  type MembershipTierRiskSeverity,
} from "@cocalc/util/membership-tier-pricing-risk";
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text } = Typography;
const { Panel: CollapsePanel } = Collapse;
const BYTES_PER_GB = 1000 * 1000 * 1000;
const SECONDS_PER_CPU_HOUR = 3600;
const MEMBERSHIP_TIER_EXPORT_TYPE = "cocalc.membership_tiers";
const MEMBERSHIP_TIER_EXPORT_VERSION = 1;
const TEMPLATE_KEYS = [
  "free",
  "basic",
  "student",
  "standard",
  "instructor",
  "researcher",
  "pro",
] as const;

type TemplateKey = (typeof TEMPLATE_KEYS)[number];

type ExpectedUsageEstimateKey =
  | "aiUnits7d"
  | "egress7dGb"
  | "projectStorageHardCapGb"
  | "blobStorageGb"
  | "rootfsStorageGb"
  | "spotCpuHoursMonthly"
  | "spotRamGbHoursMonthly"
  | "standardCpuHoursMonthly"
  | "standardRamGbHoursMonthly";

type ExpectedUsageEstimate = Partial<Record<ExpectedUsageEstimateKey, number>>;

const EXPECTED_USAGE_ESTIMATE_KEYS: readonly ExpectedUsageEstimateKey[] = [
  "aiUnits7d",
  "egress7dGb",
  "projectStorageHardCapGb",
  "blobStorageGb",
  "rootfsStorageGb",
  "spotCpuHoursMonthly",
  "spotRamGbHoursMonthly",
  "standardCpuHoursMonthly",
  "standardRamGbHoursMonthly",
];

interface MembershipTierPricingModel {
  assumptions?: Partial<MembershipTierPricingAssumptions>;
  expected_usage?: ExpectedUsageEstimate;
}

interface NormalizedMembershipTierPricingModel {
  assumptions: MembershipTierPricingAssumptions;
  expected_usage: ExpectedUsageEstimate;
}

interface MembershipTierImportCandidate {
  key: string;
  sourceId: string;
  sourceLabel?: string;
  targetId: string;
  targetLabel?: string;
  match: "label" | "id" | "new";
  payload: Tier;
  disabledReason?: string;
}

interface Tier {
  key?: string;
  id: string;
  label?: string;
  store_visible?: boolean;
  store_description?: string;
  store_highlights?: readonly string[];
  course_store_visible?: boolean;
  priority?: number;
  price_monthly?: number;
  price_yearly?: number;
  trial_days?: number;
  course_price?: number;
  course_duration_days?: number;
  course_grace_days?: number;
  project_defaults?: any;
  ai_limits?: any;
  features?: any;
  usage_limits?: any;
  pricing_model?: MembershipTierPricingModel;
  disabled?: boolean;
  notes?: string;
  history?: any[];
  subscription_count?: number;
  subscribed_account_count?: number;
  admin_assigned_count?: number;
  site_license_count?: number;
  created?: dayjs.Dayjs;
  updated?: dayjs.Dayjs;
}

function parseJsonField(
  value: string | unknown | undefined,
  label: string,
): any | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  try {
    if (typeof value !== "string") {
      return value;
    }
    const parsed = jsonic(value);
    if (parsed != null && typeof parsed !== "object") {
      throw Error(`Expected a JSON object`);
    }
    return parsed;
  } catch (err) {
    throw Error(`Invalid JSON for ${label}: ${err}`);
  }
}

function normalizedOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizedOptionalPrice(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
}

function yearlyPriceMonthlyDisplay(value: unknown): string {
  const yearly = normalizedOptionalPrice(value);
  return yearly == null
    ? "Effective monthly price appears here."
    : `${currency(yearly / 12)} / month billed annually`;
}

function normalizedOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parseStoreHighlightsText(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const highlights = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return highlights;
}

function storeHighlightsToText(value: unknown): string {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .join("\n")
    : "";
}

function bytesToGigabytes(value: unknown): number | undefined {
  const bytes = normalizedOptionalNumber(value);
  return bytes == null ? undefined : bytes / BYTES_PER_GB;
}

function gigabytesToBytes(value: unknown): number | undefined {
  const gigabytes = normalizedOptionalNumber(value);
  return gigabytes == null ? undefined : Math.round(gigabytes * BYTES_PER_GB);
}

function secondsToCpuHours(value: unknown): number | undefined {
  const seconds = normalizedOptionalNumber(value);
  return seconds == null ? undefined : seconds / SECONDS_PER_CPU_HOUR;
}

function cpuHoursToSeconds(value: unknown): number | undefined {
  const cpuHours = normalizedOptionalNumber(value);
  return cpuHours == null
    ? undefined
    : Math.round(cpuHours * SECONDS_PER_CPU_HOUR);
}

function normalizedRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeExpectedUsageEstimate(value: unknown): ExpectedUsageEstimate {
  const record = normalizedRecord(value);
  const estimate: ExpectedUsageEstimate = {};
  for (const key of EXPECTED_USAGE_ESTIMATE_KEYS) {
    const numberValue = normalizedOptionalNumber(record[key]);
    if (numberValue != null) {
      estimate[key] = Math.max(0, numberValue);
    }
  }
  return estimate;
}

function normalizePricingModel(
  value: unknown,
): NormalizedMembershipTierPricingModel {
  const record = normalizedRecord(value);
  return {
    assumptions: normalizeMembershipTierPricingAssumptions(
      normalizedRecord(record.assumptions),
    ),
    expected_usage: normalizeExpectedUsageEstimate(record.expected_usage),
  };
}

function formattedNumber(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "∞";
}

function formattedPercent(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "∞";
}

function riskSeverityType(severity: MembershipTierRiskSeverity) {
  switch (severity) {
    case "danger":
      return "error";
    case "warning":
      return "warning";
    case "notice":
      return "info";
    case "ok":
      return "success";
  }
}

function setOrDeleteUsageLimit(
  usage_limits: Record<string, unknown>,
  key: string,
  value: unknown,
) {
  setOrDeleteNumber(usage_limits, key, value);
}

function setOrDeleteNumber(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
) {
  if (typeof value === "number" && Number.isFinite(value)) {
    obj[key] = value;
  } else {
    delete obj[key];
  }
}

function setOrDeleteBoolean(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
) {
  if (typeof value === "boolean") {
    obj[key] = value;
  } else {
    delete obj[key];
  }
}

function tierToFormValues(tier: Partial<Tier>) {
  return {
    ...tier,
    pricing_model: normalizePricingModel(tier.pricing_model),
    store_highlights_text: storeHighlightsToText(tier.store_highlights),
    project_defaults: tier.project_defaults ?? {},
    ai_limits: tier.ai_limits ?? {},
    features: tier.features ?? {},
    usage_limits: tier.usage_limits ?? {},
    project_default_memory_mb: normalizedOptionalNumber(
      tier.project_defaults?.memory,
    ),
    project_default_memory_request_mb: normalizedOptionalNumber(
      tier.project_defaults?.memory_request,
    ),
    project_default_disk_quota_mb: normalizedOptionalNumber(
      tier.project_defaults?.disk_quota,
    ),
    feature_create_hosts:
      typeof tier.features?.create_hosts === "boolean"
        ? tier.features.create_hosts
        : false,
    feature_project_host_tier: normalizedOptionalNumber(
      tier.features?.project_host_tier,
    ),
    ai_limit_units_5h: normalizedOptionalNumber(tier.ai_limits?.units_5h),
    ai_limit_units_7d: normalizedOptionalNumber(tier.ai_limits?.units_7d),
    usage_limit_shared_compute_priority: normalizedOptionalNumber(
      tier.usage_limits?.shared_compute_priority,
    ),
    usage_limit_total_storage_soft_gb: bytesToGigabytes(
      tier.usage_limits?.total_storage_soft_bytes,
    ),
    usage_limit_total_storage_hard_gb: bytesToGigabytes(
      tier.usage_limits?.total_storage_hard_bytes,
    ),
    usage_limit_max_projects: normalizedOptionalNumber(
      tier.usage_limits?.max_projects,
    ),
    usage_limit_max_sponsored_running_projects: normalizedOptionalNumber(
      tier.usage_limits?.max_sponsored_running_projects,
    ),
    usage_limit_max_snapshots_per_project: normalizedOptionalNumber(
      tier.usage_limits?.max_snapshots_per_project,
    ),
    usage_limit_max_backups_per_project: normalizedOptionalNumber(
      tier.usage_limits?.max_backups_per_project,
    ),
    usage_limit_egress_5h_gb: bytesToGigabytes(
      tier.usage_limits?.egress_5h_bytes,
    ),
    usage_limit_egress_7d_gb: bytesToGigabytes(
      tier.usage_limits?.egress_7d_bytes,
    ),
    usage_limit_cpu_5h_hours: secondsToCpuHours(
      tier.usage_limits?.cpu_5h_seconds,
    ),
    usage_limit_cpu_7d_hours: secondsToCpuHours(
      tier.usage_limits?.cpu_7d_seconds,
    ),
    usage_limit_credit_spend_limit_5h_usd: normalizedOptionalNumber(
      tier.usage_limits?.credit_spend_limit_5h_usd,
    ),
    usage_limit_credit_spend_limit_7d_usd: normalizedOptionalNumber(
      tier.usage_limits?.credit_spend_limit_7d_usd,
    ),
    usage_limit_prepaid_host_usage_limit_5h_usd: normalizedOptionalNumber(
      tier.usage_limits?.prepaid_host_usage_limit_5h_usd,
    ),
    usage_limit_prepaid_host_usage_limit_7d_usd: normalizedOptionalNumber(
      tier.usage_limits?.prepaid_host_usage_limit_7d_usd,
    ),
    usage_limit_acp_max_queued_per_account: normalizedOptionalNumber(
      tier.usage_limits?.acp_max_queued_per_account,
    ),
    usage_limit_acp_max_queued_per_thread: normalizedOptionalNumber(
      tier.usage_limits?.acp_max_queued_per_thread,
    ),
    usage_limit_acp_max_created_5h_per_account: normalizedOptionalNumber(
      tier.usage_limits?.acp_max_created_5h_per_account,
    ),
    usage_limit_acp_max_created_7d_per_account: normalizedOptionalNumber(
      tier.usage_limits?.acp_max_created_7d_per_account,
    ),
    usage_limit_acp_max_running_per_account: normalizedOptionalNumber(
      tier.usage_limits?.acp_max_running_per_account,
    ),
    usage_limit_acp_max_running_per_project: normalizedOptionalNumber(
      tier.usage_limits?.acp_max_running_per_project,
    ),
    usage_limit_acp_max_active_automations_per_project:
      normalizedOptionalNumber(
        tier.usage_limits?.acp_max_active_automations_per_project,
      ),
    active: !tier.disabled,
  };
}

function buildMembershipTierPayload(values): Tier {
  const project_defaults = (parseJsonField(
    values.project_defaults,
    "project_defaults",
  ) ?? {}) as Record<string, unknown>;
  const ai_limits = (parseJsonField(values.ai_limits, "ai_limits") ??
    {}) as Record<string, unknown>;
  const features = (parseJsonField(values.features, "features") ??
    {}) as Record<string, unknown>;
  const usage_limits = (parseJsonField(values.usage_limits, "usage_limits") ??
    {}) as Record<string, unknown>;
  setOrDeleteNumber(
    project_defaults,
    "memory",
    values.project_default_memory_mb,
  );
  setOrDeleteNumber(
    project_defaults,
    "memory_request",
    values.project_default_memory_request_mb,
  );
  setOrDeleteNumber(
    project_defaults,
    "disk_quota",
    values.project_default_disk_quota_mb,
  );
  setOrDeleteBoolean(features, "create_hosts", values.feature_create_hosts);
  setOrDeleteNumber(
    features,
    "project_host_tier",
    values.feature_project_host_tier,
  );
  setOrDeleteNumber(ai_limits, "units_5h", values.ai_limit_units_5h);
  setOrDeleteNumber(ai_limits, "units_7d", values.ai_limit_units_7d);
  setOrDeleteUsageLimit(
    usage_limits,
    "shared_compute_priority",
    values.usage_limit_shared_compute_priority,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "total_storage_soft_bytes",
    gigabytesToBytes(values.usage_limit_total_storage_soft_gb),
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "total_storage_hard_bytes",
    gigabytesToBytes(values.usage_limit_total_storage_hard_gb),
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "max_projects",
    values.usage_limit_max_projects,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "max_sponsored_running_projects",
    values.usage_limit_max_sponsored_running_projects,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "max_snapshots_per_project",
    values.usage_limit_max_snapshots_per_project,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "max_backups_per_project",
    values.usage_limit_max_backups_per_project,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "egress_5h_bytes",
    gigabytesToBytes(values.usage_limit_egress_5h_gb),
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "egress_7d_bytes",
    gigabytesToBytes(values.usage_limit_egress_7d_gb),
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "cpu_5h_seconds",
    cpuHoursToSeconds(values.usage_limit_cpu_5h_hours),
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "cpu_7d_seconds",
    cpuHoursToSeconds(values.usage_limit_cpu_7d_hours),
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "credit_spend_limit_5h_usd",
    values.usage_limit_credit_spend_limit_5h_usd,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "credit_spend_limit_7d_usd",
    values.usage_limit_credit_spend_limit_7d_usd,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "prepaid_host_usage_limit_5h_usd",
    values.usage_limit_prepaid_host_usage_limit_5h_usd,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "prepaid_host_usage_limit_7d_usd",
    values.usage_limit_prepaid_host_usage_limit_7d_usd,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "acp_max_queued_per_account",
    values.usage_limit_acp_max_queued_per_account,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "acp_max_queued_per_thread",
    values.usage_limit_acp_max_queued_per_thread,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "acp_max_created_5h_per_account",
    values.usage_limit_acp_max_created_5h_per_account,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "acp_max_created_7d_per_account",
    values.usage_limit_acp_max_created_7d_per_account,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "acp_max_running_per_account",
    values.usage_limit_acp_max_running_per_account,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "acp_max_running_per_project",
    values.usage_limit_acp_max_running_per_project,
  );
  setOrDeleteUsageLimit(
    usage_limits,
    "acp_max_active_automations_per_project",
    values.usage_limit_acp_max_active_automations_per_project,
  );

  return pick(
    {
      ...values,
      project_defaults,
      ai_limits,
      features,
      usage_limits,
      pricing_model: normalizePricingModel(values.pricing_model),
      store_description: normalizedOptionalString(values.store_description),
      store_highlights: parseStoreHighlightsText(values.store_highlights_text),
      disabled: !values.active,
    },
    [
      "id",
      "label",
      "store_visible",
      "store_description",
      "store_highlights",
      "course_store_visible",
      "priority",
      "price_monthly",
      "price_yearly",
      "trial_days",
      "course_price",
      "course_duration_days",
      "course_grace_days",
      "project_defaults",
      "ai_limits",
      "features",
      "usage_limits",
      "pricing_model",
      "disabled",
      "notes",
    ],
  ) as Tier;
}

function membershipTierExportPayload(tiers: Tier[]) {
  return {
    type: MEMBERSHIP_TIER_EXPORT_TYPE,
    version: MEMBERSHIP_TIER_EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    membership_tiers: sortBy(
      tiers.map((tier) => buildMembershipTierPayload(tierToFormValues(tier))),
      "id",
    ),
  };
}

function parseMembershipTierImportJson(value: unknown): Tier[] {
  const record = normalizedRecord(value);
  const rawTiers = Array.isArray(value)
    ? value
    : Array.isArray(record.membership_tiers)
      ? record.membership_tiers
      : Array.isArray(record.tiers)
        ? record.tiers
        : undefined;
  if (rawTiers == null) {
    throw Error(
      "Expected a JSON object with membership_tiers, or a plain array of tiers.",
    );
  }
  return rawTiers.map((tier, index) => {
    if (tier == null || typeof tier !== "object" || Array.isArray(tier)) {
      throw Error(`Tier ${index + 1} is not an object.`);
    }
    const payload = buildMembershipTierPayload(tierToFormValues(tier as Tier));
    if (!payload.id?.trim()) {
      throw Error(`Tier ${index + 1} is missing an id.`);
    }
    return payload;
  });
}

function useMembershipTiers() {
  const [data, set_data] = React.useState<{ [key: string]: Tier }>({});
  const [editing, set_editing] = React.useState<Tier | null>(null);
  const [saving, set_saving] = React.useState<boolean>(false);
  const [deleting, set_deleting] = React.useState<boolean>(false);
  const [loading, set_loading] = React.useState<boolean>(false);
  const [last_saved, set_last_saved] = React.useState<Tier | null>(null);
  const [error, set_error] = React.useState<string>("");
  const [sel_rows, set_sel_rows] = React.useState<any>([]);

  const [form] = Form.useForm();

  async function load() {
    let result: any;
    set_loading(true);
    try {
      result = await query({
        query: {
          membership_tiers: {
            id: "*",
            label: null,
            store_visible: null,
            store_description: null,
            store_highlights: null,
            course_store_visible: null,
            priority: null,
            price_monthly: null,
            price_yearly: null,
            trial_days: null,
            course_price: null,
            course_duration_days: null,
            course_grace_days: null,
            project_defaults: null,
            ai_limits: null,
            features: null,
            usage_limits: null,
            disabled: null,
            notes: null,
            history: null,
            subscription_count: null,
            subscribed_account_count: null,
            admin_assigned_count: null,
            site_license_count: null,
            created: null,
            updated: null,
          },
        },
      });
      const next = {};
      for (const row of result.query.membership_tiers ?? []) {
        const tier = applyMembershipTierTemplateFallbacks({
          ...row,
        });
        if (tier.created) tier.created = dayjs(tier.created);
        if (tier.updated) tier.updated = dayjs(tier.updated);
        next[tier.id] = tier;
      }
      set_error("");
      set_data(next);
    } catch (err) {
      set_error(err.message ?? String(err));
    } finally {
      set_loading(false);
    }
  }

  React.useEffect(() => {
    set_sel_rows([]);
    load();
  }, []);

  React.useEffect(() => {
    if (editing != null) {
      form.setFieldsValue(tierToFormValues(editing));
    }
    if (last_saved != null) {
      set_last_saved(null);
    }
  }, [editing]);

  async function save(values): Promise<void> {
    const formValues = form.getFieldsValue(true);
    const mergedValues = {
      ...(editing != null ? tierToFormValues(editing) : {}),
      ...formValues,
      ...values,
      id: values.id ?? formValues.id ?? editing?.id,
    };
    const val_orig: Tier = { ...mergedValues };
    if (editing != null) set_editing(null);

    try {
      set_saving(true);
      const payload = buildMembershipTierPayload(mergedValues);
      await query({
        query: {
          membership_tiers: payload,
        },
      });
      set_last_saved(val_orig);
      await load();
    } catch (err) {
      set_error(err.message ?? String(err));
      set_editing(val_orig);
    } finally {
      set_saving(false);
    }
  }

  async function create_tier_from_template({
    id,
    label,
    template,
  }: {
    id: string;
    label: string;
    template: TemplateKey;
  }): Promise<void> {
    const trimmedId = id.trim();
    const trimmedLabel = label.trim();
    if (data[trimmedId] != null) {
      throw Error(`membership tier "${trimmedId}" already exists`);
    }
    const tier = applyMembershipTierTemplateFallbacks({
      ...TIER_TEMPLATES[template],
      id: trimmedId,
      label: trimmedLabel,
      store_visible: false,
      course_store_visible: false,
      disabled: false,
    });
    const values = tierToFormValues(tier);
    const payload = buildMembershipTierPayload(values);
    set_saving(true);
    try {
      await query({
        query: {
          membership_tiers: payload,
        },
      });
      await load();
      set_editing(applyMembershipTierTemplateFallbacks(payload));
    } catch (err) {
      set_error(err.message ?? String(err));
      throw err;
    } finally {
      set_saving(false);
    }
  }

  async function import_tiers(payloads: Tier[]): Promise<void> {
    set_saving(true);
    try {
      for (const payload of payloads) {
        await query({
          query: {
            membership_tiers: payload,
          },
        });
      }
      await load();
      set_error("");
    } catch (err) {
      set_error(err.message ?? String(err));
      throw err;
    } finally {
      set_saving(false);
    }
  }

  async function delete_tier(id: string | undefined, single = false) {
    if (!id) return;
    if (single) set_deleting(true);
    try {
      if ((data[id]?.subscription_count ?? 0) > 0) {
        throw Error("cannot delete a tier with active subscriptions");
      }
      if ((data[id]?.site_license_count ?? 0) > 0) {
        throw Error("cannot delete a tier used by active site licenses");
      }
      await query({
        query: {
          membership_tiers: { id },
        },
        options: [{ delete: true }],
      });
      if (single) load();
    } catch (err) {
      if (single) {
        set_error(err.message ?? String(err));
      } else {
        throw err;
      }
    } finally {
      if (single) set_deleting(false);
    }
  }

  async function delete_tiers(): Promise<void> {
    set_deleting(true);
    try {
      const blocked = sel_rows.filter(
        (id) => (data[id]?.subscription_count ?? 0) > 0,
      );
      if (blocked.length > 0) {
        throw Error(
          `Cannot delete tiers with active subscriptions: ${blocked.join(", ")}`,
        );
      }
      const siteLicenseBlocked = sel_rows.filter(
        (id) => (data[id]?.site_license_count ?? 0) > 0,
      );
      if (siteLicenseBlocked.length > 0) {
        throw Error(
          `Cannot delete tiers used by active site licenses: ${siteLicenseBlocked.join(
            ", ",
          )}`,
        );
      }
      await Promise.all(sel_rows.map(async (id) => await delete_tier(id)));
      set_sel_rows([]);
      load();
    } catch (err) {
      set_error(err.message ?? String(err));
    } finally {
      set_deleting(false);
    }
  }

  return {
    data,
    form,
    editing,
    saving,
    deleting,
    delete_tier,
    delete_tiers,
    loading,
    last_saved,
    error,
    set_error,
    sel_rows,
    set_sel_rows,
    set_editing,
    create_tier_from_template,
    import_tiers,
    save,
    load,
  };
}

export function MembershipTiers() {
  const intl = useIntl();
  const projectLabel = intl.formatMessage(labels.project);
  const workspaceDefaultsLabel = intl.formatMessage(
    {
      id: "admin.membership-tiers.project-defaults",
      defaultMessage: "{projectLabel} Defaults",
    },
    { projectLabel },
  );
  const {
    data,
    form,
    editing,
    saving,
    deleting,
    delete_tier,
    delete_tiers,
    loading,
    last_saved,
    error,
    set_error,
    sel_rows,
    set_sel_rows,
    set_editing,
    create_tier_from_template,
    import_tiers,
    save,
    load,
  } = useMembershipTiers();
  const [createTierForm] = Form.useForm();
  const [createTierOpen, setCreateTierOpen] = React.useState(false);
  const importFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [importModalOpen, setImportModalOpen] = React.useState(false);
  const [importCandidates, setImportCandidates] = React.useState<
    MembershipTierImportCandidate[]
  >([]);
  const [importSelectedKeys, setImportSelectedKeys] = React.useState<
    React.Key[]
  >([]);
  const [importError, setImportError] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [jsonErrors, setJsonErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [pricingAssumptions, setPricingAssumptions] =
    React.useState<MembershipTierPricingAssumptions>(
      () => DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS,
    );
  const [expectedUsageEstimate, setExpectedUsageEstimate] =
    React.useState<ExpectedUsageEstimate>({});

  React.useEffect(() => {
    const pricingModel = normalizePricingModel(editing?.pricing_model);
    setPricingAssumptions(pricingModel.assumptions);
    setExpectedUsageEstimate(pricingModel.expected_usage);
    form.setFieldsValue({ pricing_model: pricingModel });
  }, [editing, form]);

  function updatePricingModelFormValue(
    assumptions: MembershipTierPricingAssumptions,
    expected_usage: ExpectedUsageEstimate,
  ) {
    form.setFieldsValue({
      pricing_model: {
        assumptions,
        expected_usage,
      },
    });
  }

  function updatePricingAssumption(
    key: keyof MembershipTierPricingAssumptions,
    value: number | null,
  ) {
    setPricingAssumptions((prev) => {
      const next = normalizeMembershipTierPricingAssumptions({
        ...prev,
        [key]: typeof value === "number" && Number.isFinite(value) ? value : 0,
      });
      updatePricingModelFormValue(next, expectedUsageEstimate);
      return next;
    });
  }

  function resetPricingAssumptions() {
    setPricingAssumptions(DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS);
    updatePricingModelFormValue(
      DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS,
      expectedUsageEstimate,
    );
  }

  function updateExpectedUsageEstimate(
    key: ExpectedUsageEstimateKey,
    value: number | null,
  ) {
    setExpectedUsageEstimate((prev) => {
      const estimate = { ...prev };
      if (typeof value === "number" && Number.isFinite(value)) {
        estimate[key] = Math.max(0, value);
      } else {
        delete estimate[key];
      }
      updatePricingModelFormValue(pricingAssumptions, estimate);
      return estimate;
    });
  }

  function resetExpectedUsageEstimate() {
    setExpectedUsageEstimate({});
    updatePricingModelFormValue(pricingAssumptions, {});
  }

  function render_edit() {
    const onFinish = (values) => save(values);
    const editingExisting = editing?.id != null && data[editing.id] != null;
    const updateJsonError = (field: string, err?: string) => {
      setJsonErrors((prev) => {
        const next = { ...prev };
        if (err) {
          next[field] = err;
        } else {
          delete next[field];
        }
        return next;
      });
    };
    const hasJsonErrors = Object.keys(jsonErrors).length > 0;
    const fieldCol = { xs: 24, md: 12, xl: 8 };
    const wideFieldCol = { xs: 24, lg: 12 };
    const cardStyle = {
      marginBottom: "16px",
      borderRadius: "14px",
      boxShadow: "0 8px 24px rgba(15, 23, 42, 0.08)",
      border: `1px solid ${COLORS.GRAY_LL}`,
    };
    const cardBodyStyle: React.CSSProperties = {
      background:
        "linear-gradient(135deg, rgba(255,255,255,0.98), rgba(248,250,252,0.86))",
      borderRadius: "0 0 14px 14px",
    };
    const collapseStyle: React.CSSProperties = {
      ...cardStyle,
      overflow: "hidden",
      background:
        "linear-gradient(135deg, rgba(255,255,255,0.98), rgba(248,250,252,0.9))",
    };
    const sectionIntroStyle = {
      color: COLORS.GRAY,
      marginTop: "-4px",
      marginBottom: "16px",
    };
    const compactInputStyle = { width: "100%" };
    const valueText = (value: unknown, suffix = "") => {
      if (value == null || value === "") return null;
      return `${value}${suffix}`;
    };
    const summaryPieces = (...pieces: Array<string | null | undefined>) =>
      pieces.filter(Boolean).join(" · ");
    const cardSummary = (
      render: (getFieldValue: (name: string) => unknown) => string,
    ) => (
      <Form.Item noStyle shouldUpdate>
        {({ getFieldValue }) => (
          <Text type="secondary" style={{ fontSize: "13px" }}>
            {render(getFieldValue)}
          </Text>
        )}
      </Form.Item>
    );
    const editorCard = ({
      title,
      subtitle,
      summary,
      defaultCollapsed = true,
      children,
    }: {
      title: string;
      subtitle: string;
      summary: React.ReactNode;
      defaultCollapsed?: boolean;
      children: React.ReactNode;
    }) => (
      <Collapse
        defaultActiveKey={defaultCollapsed ? [] : [title]}
        style={collapseStyle}
      >
        <CollapsePanel
          key={title}
          header={
            <div style={{ width: "100%" }}>
              <Space wrap style={{ width: "100%" }}>
                <Text strong>{title}</Text>
                {summary}
              </Space>
              <div
                style={{
                  color: COLORS.GRAY,
                  fontSize: "12px",
                  fontWeight: 400,
                  marginTop: "2px",
                  whiteSpace: "normal",
                }}
              >
                {subtitle}
              </div>
            </div>
          }
        >
          <div style={cardBodyStyle}>{children}</div>
        </CollapsePanel>
      </Collapse>
    );
    const fieldGroup = ({
      title,
      children,
      note,
    }: {
      title: string;
      children: React.ReactNode;
      note?: string;
    }) => (
      <div
        style={{
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: "10px",
          padding: "14px",
          background: "rgba(255,255,255,0.7)",
          marginBottom: "14px",
        }}
      >
        <div style={{ marginBottom: note ? "4px" : "12px" }}>
          <Text strong>{title}</Text>
        </div>
        {note && (
          <div style={{ color: COLORS.GRAY, marginBottom: "12px" }}>{note}</div>
        )}
        {children}
      </div>
    );
    const fieldHelp = (text: string) => (
      <span style={{ color: COLORS.GRAY }}>{text}</span>
    );
    const pricingInputFromForm = (
      getFieldValue: (name: string) => unknown,
    ): MembershipTierPricingInput => {
      const usageLimits = normalizedRecord(getFieldValue("usage_limits"));
      const projectDefaults = normalizedRecord(
        getFieldValue("project_defaults"),
      );
      return {
        priceMonthlyUsd: normalizedOptionalPrice(
          getFieldValue("price_monthly"),
        ),
        priceYearlyUsd: normalizedOptionalPrice(getFieldValue("price_yearly")),
        aiUnits7d:
          normalizedOptionalNumber(getFieldValue("ai_limit_units_7d")) ??
          normalizedOptionalNumber(
            normalizedRecord(getFieldValue("ai_limits")).units_7d,
          ),
        egress7dGb:
          normalizedOptionalNumber(getFieldValue("usage_limit_egress_7d_gb")) ??
          bytesToGigabytes(usageLimits.egress_7d_bytes),
        projectStorageHardCapGb:
          normalizedOptionalNumber(
            getFieldValue("usage_limit_total_storage_hard_gb"),
          ) ?? bytesToGigabytes(usageLimits.total_storage_hard_bytes),
        blobStorageGb:
          bytesToGigabytes(usageLimits.blob_account_total_bytes) ??
          normalizedOptionalNumber(usageLimits.blob_account_total_gb),
        rootfsStorageGb:
          normalizedOptionalNumber(usageLimits.rootfs_total_storage_gb) ??
          bytesToGigabytes(usageLimits.rootfs_total_storage_bytes),
        creditSpendLimit7dUsd:
          normalizedOptionalNumber(
            getFieldValue("usage_limit_credit_spend_limit_7d_usd"),
          ) ?? normalizedOptionalNumber(usageLimits.credit_spend_limit_7d_usd),
        prepaidHostUsageLimit7dUsd:
          normalizedOptionalNumber(
            getFieldValue("usage_limit_prepaid_host_usage_limit_7d_usd"),
          ) ??
          normalizedOptionalNumber(usageLimits.prepaid_host_usage_limit_7d_usd),
        cpu7dHours:
          normalizedOptionalNumber(getFieldValue("usage_limit_cpu_7d_hours")) ??
          secondsToCpuHours(usageLimits.cpu_7d_seconds),
        projectMemoryMb:
          normalizedOptionalNumber(
            getFieldValue("project_default_memory_mb"),
          ) ?? normalizedOptionalNumber(projectDefaults.memory),
        maxSponsoredRunningProjects:
          normalizedOptionalNumber(
            getFieldValue("usage_limit_max_sponsored_running_projects"),
          ) ??
          normalizedOptionalNumber(usageLimits.max_sponsored_running_projects),
      };
    };
    const expectedPricingInput = (
      maxInput: MembershipTierPricingInput,
      estimate: ExpectedUsageEstimate,
    ): MembershipTierPricingInput => {
      const bounded = (key: ExpectedUsageEstimateKey): number | undefined => {
        const value = normalizedOptionalNumber(estimate[key]);
        if (value == null) return undefined;
        const max = normalizedOptionalNumber(maxInput[key]);
        return max == null ? value : Math.min(value, max);
      };
      return {
        priceMonthlyUsd: maxInput.priceMonthlyUsd,
        priceYearlyUsd: maxInput.priceYearlyUsd,
        aiUnits7d: bounded("aiUnits7d"),
        egress7dGb: bounded("egress7dGb"),
        projectStorageHardCapGb: bounded("projectStorageHardCapGb"),
        blobStorageGb: bounded("blobStorageGb"),
        rootfsStorageGb: bounded("rootfsStorageGb"),
        spotCpuHoursMonthly: normalizedOptionalNumber(
          estimate.spotCpuHoursMonthly,
        ),
        spotRamGbHoursMonthly: normalizedOptionalNumber(
          estimate.spotRamGbHoursMonthly,
        ),
        standardCpuHoursMonthly: normalizedOptionalNumber(
          estimate.standardCpuHoursMonthly,
        ),
        standardRamGbHoursMonthly: normalizedOptionalNumber(
          estimate.standardRamGbHoursMonthly,
        ),
      };
    };
    const monthlyFromWeeklyLabel = (value: unknown, suffix = "") => {
      const numberValue = normalizedOptionalNumber(value);
      if (numberValue == null) return "Not configured";
      const monthlyValue =
        numberValue *
        (MEMBERSHIP_TIER_PRICING_DAYS_PER_MONTH /
          MEMBERSHIP_TIER_PRICING_DAYS_PER_WEEK);
      return `${formattedNumber(monthlyValue, monthlyValue >= 100 ? 0 : 1)}${suffix ? ` ${suffix}` : ""}`;
    };
    const monthlyStorageLabel = (value: unknown, suffix = "GB") => {
      const numberValue = normalizedOptionalNumber(value);
      if (numberValue == null) return "Not configured";
      return `${formattedNumber(numberValue, numberValue >= 100 ? 0 : 1)} ${suffix}`;
    };
    const monthlyUsageLabel = (value: unknown, suffix: string, digits = 1) => {
      const numberValue = normalizedOptionalNumber(value);
      if (numberValue == null) return "Not estimated";
      return `${formattedNumber(numberValue, digits)} ${suffix}`;
    };
    const maxLabel = (value: unknown, suffix = "") => {
      const numberValue = normalizedOptionalNumber(value);
      return numberValue == null
        ? "No configured maximum."
        : `Max ${formattedNumber(numberValue, 2)}${suffix ? ` ${suffix}` : ""}`;
    };
    const riskMetric = (
      label: string,
      value: React.ReactNode,
      note?: string,
    ) => (
      <div
        style={{
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: "10px",
          padding: "12px",
          background: "rgba(255,255,255,0.74)",
          minHeight: "76px",
        }}
      >
        <div style={{ color: COLORS.GRAY, fontSize: "12px" }}>{label}</div>
        <div style={{ fontSize: "18px", fontWeight: 600 }}>{value}</div>
        {note && (
          <div style={{ color: COLORS.GRAY, fontSize: "12px" }}>{note}</div>
        )}
      </div>
    );
    const costTableCellStyle: React.CSSProperties = {
      borderTop: `1px solid ${COLORS.GRAY_LLL}`,
      padding: "10px 12px",
      verticalAlign: "top",
    };
    const costTableNumberCellStyle: React.CSSProperties = {
      ...costTableCellStyle,
      textAlign: "right",
      fontVariantNumeric: "tabular-nums",
      whiteSpace: "nowrap",
    };
    const costTableHeaderStyle: React.CSSProperties = {
      padding: "9px 12px",
      color: COLORS.GRAY,
      fontSize: "12px",
      fontWeight: 600,
      textAlign: "left",
      borderBottom: `1px solid ${COLORS.GRAY_LL}`,
      background: COLORS.GRAY_LLL,
    };
    const expectedUsageInput = (
      key: ExpectedUsageEstimateKey,
      label: string,
      maxValue: unknown,
      opts: {
        step?: number;
        addonAfter?: string;
        extra?: string;
        unbounded?: boolean;
      } = {},
    ) => {
      const max = opts.unbounded
        ? undefined
        : normalizedOptionalNumber(maxValue);
      const rawValue = expectedUsageEstimate[key];
      const value =
        max != null && rawValue != null ? Math.min(rawValue, max) : rawValue;
      return (
        <Form.Item
          label={label}
          extra={fieldHelp(opts.extra ?? maxLabel(max, opts.addonAfter ?? ""))}
        >
          <InputNumber
            min={0}
            max={max}
            step={opts.step ?? 0.1}
            addonAfter={
              opts.addonAfter ? (
                <span style={{ whiteSpace: "nowrap" }}>{opts.addonAfter}</span>
              ) : undefined
            }
            style={compactInputStyle}
            value={value}
            onChange={(value) =>
              updateExpectedUsageEstimate(
                key,
                typeof value === "number" ? value : null,
              )
            }
          />
        </Form.Item>
      );
    };
    const assumptionInput = (
      key: keyof MembershipTierPricingAssumptions,
      label: string,
      opts: {
        step?: number;
        addonAfter?: string;
        multiplier?: number;
        extra?: string;
      } = {},
    ) => (
      <Form.Item
        label={label}
        extra={opts.extra ? fieldHelp(opts.extra) : null}
      >
        <InputNumber
          min={0}
          step={opts.step ?? 0.01}
          addonAfter={
            opts.addonAfter ? (
              <span style={{ whiteSpace: "nowrap" }}>{opts.addonAfter}</span>
            ) : undefined
          }
          style={compactInputStyle}
          value={pricingAssumptions[key] * (opts.multiplier ?? 1)}
          onChange={(value) =>
            updatePricingAssumption(
              key,
              typeof value === "number" ? value / (opts.multiplier ?? 1) : null,
            )
          }
        />
      </Form.Item>
    );

    return (
      <>
        <Form
          layout="vertical"
          style={{ margin: "20px 0" }}
          size={"middle"}
          form={form}
          name="edit-membership-tier"
          onFinish={onFinish}
        >
          {editorCard({
            title: "Product",
            subtitle:
              "Public identity, pricing, purchase visibility, and internal lifecycle state.",
            summary: cardSummary((get) =>
              summaryPieces(
                `monthly ${currency(Number(get("price_monthly") ?? 0))}`,
                `yearly ${currency(Number(get("price_yearly") ?? 0))}`,
                get("store_visible") ? "public purchase" : "hidden",
                get("active") ? "active" : "disabled",
              ),
            ),
            children: (
              <>
                <Paragraph style={sectionIntroStyle}>
                  This card defines what users see and how the tier behaves as a
                  purchasable product.
                </Paragraph>
                <Row gutter={16}>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="id"
                      label="Tier ID"
                      rules={[{ required: true }]}
                    >
                      <Input disabled={editingExisting} />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="label"
                      label="Display name"
                      rules={[{ required: true }]}
                    >
                      <Input />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item name="priority" label="Priority">
                      <InputNumber
                        step={1}
                        precision={0}
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item name="price_monthly" label="Monthly price">
                      <InputNumber
                        min={0}
                        step={1}
                        prefix="$"
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item label="Yearly price">
                      <Space direction="vertical" style={{ width: "100%" }}>
                        <Form.Item name="price_yearly" noStyle>
                          <InputNumber
                            min={0}
                            step={1}
                            prefix="$"
                            style={compactInputStyle}
                          />
                        </Form.Item>
                        <Form.Item
                          noStyle
                          shouldUpdate={(prev, next) =>
                            prev.price_yearly !== next.price_yearly
                          }
                        >
                          {({ getFieldValue }) => (
                            <Text type="secondary">
                              {yearlyPriceMonthlyDisplay(
                                getFieldValue("price_yearly"),
                              )}
                            </Text>
                          )}
                        </Form.Item>
                      </Space>
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item name="trial_days" label="Trial days">
                      <InputNumber
                        min={0}
                        step={1}
                        precision={0}
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="store_visible"
                      label="Purchase visibility"
                      valuePropName="checked"
                    >
                      <Checkbox>
                        Show in public pricing and purchase UI
                      </Checkbox>
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="course_store_visible"
                      label="Course purchase"
                      valuePropName="checked"
                    >
                      <Checkbox>
                        Available for course student memberships
                      </Checkbox>
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="active"
                      label="Active"
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item name="course_price" label="Course price">
                      <InputNumber
                        min={0}
                        step={1}
                        prefix="$"
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="course_duration_days"
                      label="Course duration days"
                    >
                      <InputNumber
                        min={1}
                        step={1}
                        precision={0}
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="course_grace_days"
                      label="Course grace days"
                    >
                      <InputNumber
                        min={0}
                        step={1}
                        precision={0}
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...wideFieldCol}>
                    <Form.Item
                      name="store_description"
                      label="Public description"
                      extra="Short public sentence shown on pricing and purchase cards."
                    >
                      <Input.TextArea rows={3} />
                    </Form.Item>
                  </Col>
                  <Col {...wideFieldCol}>
                    <Form.Item
                      name="store_highlights_text"
                      label="Public highlights"
                      extra="One public bullet point per line."
                    >
                      <Input.TextArea rows={3} />
                    </Form.Item>
                  </Col>
                  <Col xs={24}>
                    <Form.Item name="notes" label="Admin notes">
                      <Input.TextArea rows={2} />
                    </Form.Item>
                  </Col>
                </Row>
              </>
            ),
          })}

          {editorCard({
            title: "Runtime",
            subtitle:
              "The shared-compute promise: memory, disk, host tier, priority, and running project slots.",
            summary: cardSummary((get) =>
              summaryPieces(
                valueText(get("project_default_memory_mb"), " MB RAM"),
                valueText(get("project_default_disk_quota_mb"), " MB disk"),
                `host tier ${get("feature_project_host_tier") ?? "unset"}`,
                `priority ${get("usage_limit_shared_compute_priority") ?? "unset"}`,
                valueText(
                  get("usage_limit_max_sponsored_running_projects"),
                  " running projects",
                ),
              ),
            ),
            children: (
              <>
                <Paragraph style={sectionIntroStyle}>
                  CPU is not sold as cores. Use host tier, relative priority,
                  sponsored running projects, and CPU-hour budgets to shape the
                  runtime experience.
                </Paragraph>
                <Row gutter={16}>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="project_default_memory_mb"
                      label="Project RAM limit (MB)"
                      extra={fieldHelp(
                        "Maximum RAM each project gets when started or restarted.",
                      )}
                    >
                      <InputNumber
                        min={0}
                        step={250}
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="project_default_memory_request_mb"
                      label="Project requested RAM (MB)"
                      extra={fieldHelp(
                        "Scheduler request; keep at or below the RAM limit.",
                      )}
                    >
                      <InputNumber
                        min={0}
                        step={250}
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="project_default_disk_quota_mb"
                      label={`${workspaceDefaultsLabel} disk quota (MB)`}
                      extra={fieldHelp(
                        "Per-project disk quota. This is separate from account-wide storage caps.",
                      )}
                    >
                      <InputNumber
                        min={0}
                        step={1000}
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="feature_project_host_tier"
                      label="Project-host tier"
                      extra={fieldHelp(
                        "Tier N can use shared public project hosts up to tier N.",
                      )}
                    >
                      <InputNumber
                        min={0}
                        step={1}
                        precision={0}
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="usage_limit_shared_compute_priority"
                      label="Shared compute priority"
                      extra={fieldHelp(
                        "Relative priority for host admission, eviction, and restart decisions.",
                      )}
                    >
                      <InputNumber
                        min={0}
                        step={1}
                        precision={0}
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="usage_limit_max_sponsored_running_projects"
                      label="Sponsored running projects"
                      extra={fieldHelp(
                        "Maximum simultaneously starting or running projects sponsored by this account.",
                      )}
                    >
                      <InputNumber
                        min={0}
                        step={1}
                        precision={0}
                        style={compactInputStyle}
                      />
                    </Form.Item>
                  </Col>
                </Row>
              </>
            ),
          })}

          {editorCard({
            title: "Usage Budgets",
            subtitle:
              "Hard-cost and abuse budgets for CPU-hours, egress, AI, storage, projects, snapshots, and backups.",
            summary: cardSummary((get) =>
              summaryPieces(
                `CPU ${get("usage_limit_cpu_5h_hours") ?? "unset"}/${get("usage_limit_cpu_7d_hours") ?? "unset"} h`,
                `egress ${get("usage_limit_egress_5h_gb") ?? "unset"}/${get("usage_limit_egress_7d_gb") ?? "unset"} GB`,
                `AI ${get("ai_limit_units_5h") ?? "unset"}/${get("ai_limit_units_7d") ?? "unset"} units`,
                `projects ${get("usage_limit_max_projects") ?? "unset"}`,
              ),
            ),
            children: (
              <>
                <Paragraph style={sectionIntroStyle}>
                  Egress and AI can create direct cost. CPU-hours primarily
                  drive capacity planning, abuse signals, and project-start
                  admission.
                </Paragraph>
                {fieldGroup({
                  title: "Compute",
                  note: "Rolling CPU-hour budgets are capacity and abuse controls. They do not reserve fixed CPU cores.",
                  children: (
                    <Row gutter={16}>
                      <Col {...wideFieldCol}>
                        <Form.Item
                          name="usage_limit_cpu_5h_hours"
                          label="CPU budget, rolling 5 hours"
                          extra={fieldHelp(
                            "CPU-hours allowed in the last 5 hours before new project starts are blocked.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={0.1}
                            addonAfter="CPU-hours"
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                      <Col {...wideFieldCol}>
                        <Form.Item
                          name="usage_limit_cpu_7d_hours"
                          label="CPU budget, rolling 7 days"
                          extra={fieldHelp(
                            "Longer-term CPU-hours budget used for gentle product limits and abuse visibility.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={1}
                            addonAfter="CPU-hours"
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                  ),
                })}
                {fieldGroup({
                  title: "Network Egress",
                  note: "Managed egress is a direct hard-cost and abuse signal. Values are stored as bytes and edited here as GB.",
                  children: (
                    <Row gutter={16}>
                      <Col {...wideFieldCol}>
                        <Form.Item
                          name="usage_limit_egress_5h_gb"
                          label="Egress budget, rolling 5 hours"
                          extra={fieldHelp(
                            "Short-window GB budget for burst control and attack detection.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={0.1}
                            addonAfter="GB"
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                      <Col {...wideFieldCol}>
                        <Form.Item
                          name="usage_limit_egress_7d_gb"
                          label="Egress budget, rolling 7 days"
                          extra={fieldHelp(
                            "Long-window GB budget for normal product allowance and cost containment.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={0.1}
                            addonAfter="GB"
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                  ),
                })}
                {fieldGroup({
                  title: "AI",
                  note: "Included AI units are a hard-cost budget. Free tier defaults should stay at 0 unless intentionally changed.",
                  children: (
                    <Row gutter={16}>
                      <Col {...wideFieldCol}>
                        <Form.Item
                          name="ai_limit_units_5h"
                          label="AI units, rolling 5 hours"
                          extra={fieldHelp(
                            "Short-window normalized AI allowance.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={1}
                            addonAfter="units"
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                      <Col {...wideFieldCol}>
                        <Form.Item
                          name="ai_limit_units_7d"
                          label="AI units, rolling 7 days"
                          extra={fieldHelp(
                            "Weekly normalized AI allowance used to bound included AI spend.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={1}
                            addonAfter="units"
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                  ),
                })}
                {fieldGroup({
                  title: "Storage And Project Count",
                  note: "These limits control owned projects and account-wide storage pressure.",
                  children: (
                    <Row gutter={16}>
                      <Col {...fieldCol}>
                        <Form.Item
                          name="usage_limit_total_storage_soft_gb"
                          label="Project file storage soft cap"
                          extra={fieldHelp(
                            "GB soft cap across projects owned by this account before storage-increasing actions are restricted.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={0.1}
                            addonAfter="GB"
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                      <Col {...fieldCol}>
                        <Form.Item
                          name="usage_limit_total_storage_hard_gb"
                          label="Project file storage hard cap"
                          extra={fieldHelp(
                            "GB hard cap across projects owned by this account; should be at or above the soft cap.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={0.1}
                            addonAfter="GB"
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                      <Col {...fieldCol}>
                        <Form.Item
                          name="usage_limit_max_projects"
                          label="Owned projects"
                          extra={fieldHelp(
                            "Maximum projects this account may own. Collaboration on other projects does not count.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={1}
                            precision={0}
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                  ),
                })}
                {fieldGroup({
                  title: "Retention",
                  note: "Per-project snapshot and backup retention limits.",
                  children: (
                    <Row gutter={16}>
                      <Col {...wideFieldCol}>
                        <Form.Item
                          name="usage_limit_max_snapshots_per_project"
                          label="Snapshots per project"
                          extra={fieldHelp(
                            "Maximum retained snapshots for each project owned by this account.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={1}
                            precision={0}
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                      <Col {...wideFieldCol}>
                        <Form.Item
                          name="usage_limit_max_backups_per_project"
                          label="Backups per project"
                          extra={fieldHelp(
                            "Maximum retained backups for each project owned by this account.",
                          )}
                        >
                          <InputNumber
                            min={0}
                            step={1}
                            precision={0}
                            style={compactInputStyle}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                  ),
                })}
              </>
            ),
          })}

          {editorCard({
            title: "Codex / ACP",
            subtitle:
              "Durable agent queue, creation, running, and automation limits.",
            summary: cardSummary((get) =>
              summaryPieces(
                `created ${get("usage_limit_acp_max_created_5h_per_account") ?? "unset"}/${get("usage_limit_acp_max_created_7d_per_account") ?? "unset"}`,
                `running/account ${get("usage_limit_acp_max_running_per_account") ?? "unset"}`,
                `running/project ${get("usage_limit_acp_max_running_per_project") ?? "unset"}`,
              ),
            ),
            children: (
              <Row gutter={16}>
                <Col {...fieldCol}>
                  <Form.Item
                    name="usage_limit_acp_max_queued_per_account"
                    label="Queued ACP turns / account"
                  >
                    <InputNumber min={0} step={1} precision={0} />
                  </Form.Item>
                </Col>
                <Col {...fieldCol}>
                  <Form.Item
                    name="usage_limit_acp_max_queued_per_thread"
                    label="Queued ACP turns / thread"
                  >
                    <InputNumber min={0} step={1} precision={0} />
                  </Form.Item>
                </Col>
                <Col {...fieldCol}>
                  <Form.Item
                    name="usage_limit_acp_max_created_5h_per_account"
                    label="Created ACP turns / account / 5h"
                  >
                    <InputNumber min={0} step={1} precision={0} />
                  </Form.Item>
                </Col>
                <Col {...fieldCol}>
                  <Form.Item
                    name="usage_limit_acp_max_created_7d_per_account"
                    label="Created ACP turns / account / 7d"
                  >
                    <InputNumber min={0} step={1} precision={0} />
                  </Form.Item>
                </Col>
                <Col {...fieldCol}>
                  <Form.Item
                    name="usage_limit_acp_max_running_per_account"
                    label="Running ACP turns / account"
                  >
                    <InputNumber min={0} step={1} precision={0} />
                  </Form.Item>
                </Col>
                <Col {...fieldCol}>
                  <Form.Item
                    name="usage_limit_acp_max_running_per_project"
                    label="Running ACP turns / project"
                  >
                    <InputNumber min={0} step={1} precision={0} />
                  </Form.Item>
                </Col>
                <Col {...fieldCol}>
                  <Form.Item
                    name="usage_limit_acp_max_active_automations_per_project"
                    label="Active ACP automations / project"
                  >
                    <InputNumber min={0} step={1} precision={0} />
                  </Form.Item>
                </Col>
              </Row>
            ),
          })}

          {editorCard({
            title: "Dedicated Hosts",
            subtitle:
              "Dedicated-host entitlement and spending guardrails for prepaid and credit usage.",
            summary: cardSummary((get) =>
              summaryPieces(
                get("feature_create_hosts")
                  ? "host creation enabled"
                  : "host creation disabled",
                `credit ${get("usage_limit_credit_spend_limit_5h_usd") ?? "unset"}/${get("usage_limit_credit_spend_limit_7d_usd") ?? "unset"} USD`,
                `prepaid ${get("usage_limit_prepaid_host_usage_limit_5h_usd") ?? "unset"}/${get("usage_limit_prepaid_host_usage_limit_7d_usd") ?? "unset"} USD`,
              ),
            ),
            children: (
              <>
                <Paragraph style={sectionIntroStyle}>
                  These fields control whether a tier can create dedicated
                  project hosts and how much spend can happen in rolling
                  windows.
                </Paragraph>
                <Row gutter={16}>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="feature_create_hosts"
                      label="Dedicated host creation"
                      valuePropName="checked"
                    >
                      <Checkbox>
                        Can create/rent dedicated project hosts
                      </Checkbox>
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="usage_limit_credit_spend_limit_5h_usd"
                      label="Credit spend 5h ($)"
                    >
                      <InputNumber min={0} step={1} style={compactInputStyle} />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="usage_limit_credit_spend_limit_7d_usd"
                      label="Credit spend 7d ($)"
                    >
                      <InputNumber min={0} step={1} style={compactInputStyle} />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="usage_limit_prepaid_host_usage_limit_5h_usd"
                      label="Prepaid spend 5h ($)"
                    >
                      <InputNumber min={0} step={1} style={compactInputStyle} />
                    </Form.Item>
                  </Col>
                  <Col {...fieldCol}>
                    <Form.Item
                      name="usage_limit_prepaid_host_usage_limit_7d_usd"
                      label="Prepaid spend 7d ($)"
                    >
                      <InputNumber min={0} step={1} style={compactInputStyle} />
                    </Form.Item>
                  </Col>
                </Row>
              </>
            ),
          })}

          {editorCard({
            title: "Financial Risk",
            subtitle:
              "Advisory hard-cost and capacity model for deciding whether this tier fits its price point.",
            summary: (
              <Form.Item noStyle shouldUpdate>
                {({ getFieldValue }) => {
                  const analysis = analyzeMembershipTierPricingRisk(
                    pricingInputFromForm(getFieldValue),
                    pricingAssumptions,
                  );
                  return (
                    <Text type="secondary" style={{ fontSize: "13px" }}>
                      {summaryPieces(
                        `hard cost ${currency(analysis.hardCosts.totalMonthlyUsd)} / mo`,
                        `budget ${currency(analysis.targetHardCostBudgetUsd)} / mo`,
                        `${formattedNumber(analysis.capacity.averageCpuEntitlement, 2)} avg CPU`,
                      )}
                    </Text>
                  );
                }}
              </Form.Item>
            ),
            children: (
              <Form.Item noStyle shouldUpdate>
                {({ getFieldValue }) => {
                  const maxPricingInput = pricingInputFromForm(getFieldValue);
                  const analysis = analyzeMembershipTierPricingRisk(
                    maxPricingInput,
                    pricingAssumptions,
                  );
                  const expectedInput = expectedPricingInput(
                    maxPricingInput,
                    expectedUsageEstimate,
                  );
                  const expectedAnalysis = analyzeMembershipTierPricingRisk(
                    expectedInput,
                    pricingAssumptions,
                  );
                  const monthlyScale =
                    MEMBERSHIP_TIER_PRICING_DAYS_PER_MONTH /
                    MEMBERSHIP_TIER_PRICING_DAYS_PER_WEEK;
                  const usageScalePopover = (
                    <Popover
                      content={
                        <div style={{ maxWidth: "260px" }}>
                          Weekly limits are scaled by{" "}
                          {MEMBERSHIP_TIER_PRICING_DAYS_PER_MONTH} /{" "}
                          {MEMBERSHIP_TIER_PRICING_DAYS_PER_WEEK} ={" "}
                          {formattedNumber(monthlyScale, 2)} to estimate an
                          average month.
                        </div>
                      }
                    >
                      <Button size="small" type="text" style={{ padding: 0 }}>
                        ?
                      </Button>
                    </Popover>
                  );
                  const costRows = [
                    {
                      key: "ai",
                      name: "AI allowance",
                      hardLimit: monthlyFromWeeklyLabel(
                        maxPricingInput.aiUnits7d,
                        "units",
                      ),
                      maxCost: analysis.hardCosts.aiMonthlyUsd,
                      expectedLimit: monthlyFromWeeklyLabel(
                        expectedInput.aiUnits7d,
                        "units",
                      ),
                      expectedCost: expectedAnalysis.hardCosts.aiMonthlyUsd,
                      scaled: true,
                    },
                    {
                      key: "egress",
                      name: "Network egress allowance",
                      hardLimit: monthlyFromWeeklyLabel(
                        maxPricingInput.egress7dGb,
                        "GB",
                      ),
                      maxCost: analysis.hardCosts.egressMonthlyUsd,
                      expectedLimit: monthlyFromWeeklyLabel(
                        expectedInput.egress7dGb,
                        "GB",
                      ),
                      expectedCost: expectedAnalysis.hardCosts.egressMonthlyUsd,
                      scaled: true,
                    },
                    {
                      key: "project-storage",
                      name: "Project file storage hard cap",
                      hardLimit: monthlyStorageLabel(
                        maxPricingInput.projectStorageHardCapGb,
                      ),
                      maxCost: analysis.hardCosts.projectStorageMonthlyUsd,
                      expectedLimit: monthlyStorageLabel(
                        expectedInput.projectStorageHardCapGb,
                      ),
                      expectedCost:
                        expectedAnalysis.hardCosts.projectStorageMonthlyUsd,
                    },
                    {
                      key: "blob-storage",
                      name: "R2/blob storage",
                      hardLimit: monthlyStorageLabel(
                        maxPricingInput.blobStorageGb,
                      ),
                      maxCost: analysis.hardCosts.blobStorageMonthlyUsd,
                      expectedLimit: monthlyStorageLabel(
                        expectedInput.blobStorageGb,
                      ),
                      expectedCost:
                        expectedAnalysis.hardCosts.blobStorageMonthlyUsd,
                    },
                    {
                      key: "rootfs-storage",
                      name: "Rootfs storage",
                      hardLimit: monthlyStorageLabel(
                        maxPricingInput.rootfsStorageGb,
                      ),
                      maxCost: analysis.hardCosts.rootfsStorageMonthlyUsd,
                      expectedLimit: monthlyStorageLabel(
                        expectedInput.rootfsStorageGb,
                      ),
                      expectedCost:
                        expectedAnalysis.hardCosts.rootfsStorageMonthlyUsd,
                    },
                    {
                      key: "spot-cpu",
                      name: "Spot CPU QoS estimate",
                      hardLimit: "No hard limit",
                      maxCost: 0,
                      expectedLimit: monthlyUsageLabel(
                        expectedInput.spotCpuHoursMonthly,
                        "CPU-h",
                      ),
                      expectedCost:
                        expectedAnalysis.hardCosts.spotCpuMonthlyUsd,
                    },
                    {
                      key: "spot-ram",
                      name: "Spot RAM QoS estimate",
                      hardLimit: "No hard limit",
                      maxCost: 0,
                      expectedLimit: monthlyUsageLabel(
                        expectedInput.spotRamGbHoursMonthly,
                        "GB-h",
                      ),
                      expectedCost:
                        expectedAnalysis.hardCosts.spotRamMonthlyUsd,
                    },
                    {
                      key: "standard-cpu",
                      name: "Standard CPU QoS estimate",
                      hardLimit: "No hard limit",
                      maxCost: 0,
                      expectedLimit: monthlyUsageLabel(
                        expectedInput.standardCpuHoursMonthly,
                        "CPU-h",
                      ),
                      expectedCost:
                        expectedAnalysis.hardCosts.standardCpuMonthlyUsd,
                    },
                    {
                      key: "standard-ram",
                      name: "Standard RAM QoS estimate",
                      hardLimit: "No hard limit",
                      maxCost: 0,
                      expectedLimit: monthlyUsageLabel(
                        expectedInput.standardRamGbHoursMonthly,
                        "GB-h",
                      ),
                      expectedCost:
                        expectedAnalysis.hardCosts.standardRamMonthlyUsd,
                    },
                  ];
                  const customerMonthlyUsd =
                    analysis.monthlyRevenueUsd > 0
                      ? analysis.monthlyRevenueUsd
                      : analysis.annualizedMonthlyRevenueUsd;
                  const expectedCostMonthlyUsd =
                    expectedAnalysis.hardCosts.totalMonthlyUsd;
                  const expectedProfitLossUsd =
                    customerMonthlyUsd - expectedCostMonthlyUsd;
                  const exposureUsd = Math.max(
                    0,
                    analysis.hardCosts.totalMonthlyUsd - customerMonthlyUsd,
                  );
                  const ratioWidth = (value: number) =>
                    `${Math.min(100, Math.max(0, Math.round(value * 100)))}%`;
                  const relativeToRevenue = (value: number) =>
                    customerMonthlyUsd > 0
                      ? Math.abs(value) / customerMonthlyUsd
                      : 0;
                  const economicsBar = ({
                    label,
                    value,
                    color,
                  }: {
                    label: string;
                    value: number;
                    color: string;
                  }) => (
                    <div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: "12px",
                          fontSize: "12px",
                          color: COLORS.GRAY,
                        }}
                      >
                        <span>{label}</span>
                        <span>
                          {customerMonthlyUsd > 0
                            ? `${formattedPercent(
                                Math.abs(value) / customerMonthlyUsd,
                              )} of revenue`
                            : "no revenue"}
                        </span>
                      </div>
                      <div
                        style={{
                          height: "8px",
                          borderRadius: "999px",
                          background: COLORS.GRAY_LL,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: ratioWidth(relativeToRevenue(value)),
                            background: color,
                          }}
                        />
                      </div>
                    </div>
                  );
                  const costAccountingTable = (
                    <div
                      style={{
                        overflowX: "auto",
                        border: `1px solid ${COLORS.GRAY_LL}`,
                        borderRadius: "10px",
                        background: "rgba(255,255,255,0.82)",
                      }}
                    >
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          minWidth: "860px",
                        }}
                      >
                        <thead>
                          <tr>
                            <th style={costTableHeaderStyle}>Name</th>
                            <th
                              style={{
                                ...costTableHeaderStyle,
                                textAlign: "right",
                              }}
                            >
                              Hard limit / month {usageScalePopover}
                            </th>
                            <th
                              style={{
                                ...costTableHeaderStyle,
                                textAlign: "right",
                              }}
                            >
                              Max cost
                            </th>
                            <th
                              style={{
                                ...costTableHeaderStyle,
                                textAlign: "right",
                              }}
                            >
                              Expected / month {usageScalePopover}
                            </th>
                            <th
                              style={{
                                ...costTableHeaderStyle,
                                textAlign: "right",
                              }}
                            >
                              Expected cost
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {costRows.map((row) => (
                            <tr key={row.key}>
                              <td style={costTableCellStyle}>
                                <Text>{row.name}</Text>
                                {row.scaled && (
                                  <div
                                    style={{
                                      color: COLORS.GRAY,
                                      fontSize: "12px",
                                    }}
                                  >
                                    7-day allowance ×{" "}
                                    {formattedNumber(monthlyScale, 2)}
                                  </div>
                                )}
                              </td>
                              <td style={costTableNumberCellStyle}>
                                {row.hardLimit}
                              </td>
                              <td style={costTableNumberCellStyle}>
                                {currency(row.maxCost)}
                              </td>
                              <td style={costTableNumberCellStyle}>
                                {row.expectedLimit}
                              </td>
                              <td style={costTableNumberCellStyle}>
                                {currency(row.expectedCost)}
                              </td>
                            </tr>
                          ))}
                          <tr>
                            <td
                              style={{
                                ...costTableCellStyle,
                                borderTop: `2px solid ${COLORS.GRAY_LL}`,
                                fontWeight: 700,
                              }}
                            >
                              Total modeled cost
                            </td>
                            <td
                              style={{
                                ...costTableNumberCellStyle,
                                borderTop: `2px solid ${COLORS.GRAY_LL}`,
                              }}
                            />
                            <td
                              style={{
                                ...costTableNumberCellStyle,
                                borderTop: `2px solid ${COLORS.GRAY_LL}`,
                                fontWeight: 700,
                              }}
                            >
                              {currency(analysis.hardCosts.totalMonthlyUsd)}
                            </td>
                            <td
                              style={{
                                ...costTableNumberCellStyle,
                                borderTop: `2px solid ${COLORS.GRAY_LL}`,
                              }}
                            />
                            <td
                              style={{
                                ...costTableNumberCellStyle,
                                borderTop: `2px solid ${COLORS.GRAY_LL}`,
                                fontWeight: 700,
                              }}
                            >
                              {currency(
                                expectedAnalysis.hardCosts.totalMonthlyUsd,
                              )}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  );
                  const unitEconomicsSummary = (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(320px, 520px) 1fr",
                        gap: "16px",
                        margin: "14px 0 18px",
                      }}
                    >
                      <div
                        style={{
                          border: `1px solid ${COLORS.GRAY_LL}`,
                          borderRadius: "10px",
                          overflow: "hidden",
                          background: "rgba(255,255,255,0.82)",
                        }}
                      >
                        <table
                          style={{
                            width: "100%",
                            borderCollapse: "collapse",
                          }}
                        >
                          <tbody>
                            {[
                              {
                                label: "Customer pays / month",
                                value: customerMonthlyUsd,
                                color: undefined,
                              },
                              {
                                label: "Expected cost / month",
                                value: expectedCostMonthlyUsd,
                                color: undefined,
                              },
                              {
                                label: "Expected profit/loss",
                                value: expectedProfitLossUsd,
                                color:
                                  expectedProfitLossUsd >= 0
                                    ? COLORS.BS_GREEN_D
                                    : COLORS.FG_RED,
                              },
                              {
                                label:
                                  "Exposure: maximum possible loss / month",
                                value: exposureUsd,
                                color:
                                  exposureUsd > 0 ? COLORS.FG_RED : COLORS.GRAY,
                              },
                            ].map((row) => (
                              <tr key={row.label}>
                                <td style={costTableCellStyle}>{row.label}</td>
                                <td
                                  style={{
                                    ...costTableNumberCellStyle,
                                    color: row.color,
                                    fontWeight: row.color ? 700 : 400,
                                  }}
                                >
                                  {currency(row.value)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <Space direction="vertical" style={{ width: "100%" }}>
                        {economicsBar({
                          label:
                            expectedProfitLossUsd >= 0
                              ? "Expected profit"
                              : "Expected loss",
                          value: expectedProfitLossUsd,
                          color:
                            expectedProfitLossUsd >= 0
                              ? COLORS.BS_GREEN
                              : COLORS.FG_RED,
                        })}
                        {economicsBar({
                          label: "Worst-case exposure",
                          value: exposureUsd,
                          color:
                            exposureUsd > 0 ? COLORS.FG_RED : COLORS.GRAY_L,
                        })}
                      </Space>
                    </div>
                  );
                  return (
                    <>
                      <Paragraph style={sectionIntroStyle}>
                        This card does not block saving. It turns tier limits
                        into a rough monthly hard-cost exposure and shared-pool
                        pressure estimate so admins can reason about price
                        points.
                      </Paragraph>
                      {fieldGroup({
                        title: "Monthly Cost Accounting",
                        note: "Enter realistic expected usage for this tier. Expected values are advisory, saved with the tier when you click Save, and bounded by configured tier maxima where a maximum exists. CPU/RAM rows model quality-of-service capacity, not a hard user-visible limit.",
                        children: (
                          <>
                            {costAccountingTable}
                            {unitEconomicsSummary}
                            <Row gutter={16}>
                              <Col {...fieldCol}>
                                {expectedUsageInput(
                                  "aiUnits7d",
                                  "Expected AI units / 7d",
                                  maxPricingInput.aiUnits7d,
                                  {
                                    step: 1,
                                    addonAfter: "units",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {expectedUsageInput(
                                  "egress7dGb",
                                  "Expected egress / 7d",
                                  maxPricingInput.egress7dGb,
                                  {
                                    step: 0.1,
                                    addonAfter: "GB",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {expectedUsageInput(
                                  "projectStorageHardCapGb",
                                  "Expected project file storage",
                                  maxPricingInput.projectStorageHardCapGb,
                                  {
                                    step: 0.1,
                                    addonAfter: "GB",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {expectedUsageInput(
                                  "blobStorageGb",
                                  "Expected R2/blob storage",
                                  maxPricingInput.blobStorageGb,
                                  {
                                    step: 0.1,
                                    addonAfter: "GB",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {expectedUsageInput(
                                  "rootfsStorageGb",
                                  "Expected rootfs storage",
                                  maxPricingInput.rootfsStorageGb,
                                  {
                                    step: 0.1,
                                    addonAfter: "GB",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {expectedUsageInput(
                                  "spotCpuHoursMonthly",
                                  "Expected spot CPU / month",
                                  undefined,
                                  {
                                    step: 1,
                                    addonAfter: "CPU-h",
                                    unbounded: true,
                                    extra:
                                      "QoS capacity assumption. Example: 50 CPU-hours/month on spot hosts.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {expectedUsageInput(
                                  "spotRamGbHoursMonthly",
                                  "Expected spot RAM / month",
                                  undefined,
                                  {
                                    step: 1,
                                    addonAfter: "GB-h",
                                    unbounded: true,
                                    extra:
                                      "RAM GB-hours/month on spot hosts. Example: 100 GB-hours/month.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {expectedUsageInput(
                                  "standardCpuHoursMonthly",
                                  "Expected standard CPU / month",
                                  undefined,
                                  {
                                    step: 1,
                                    addonAfter: "CPU-h",
                                    unbounded: true,
                                    extra:
                                      "QoS capacity expected on standard, non-spot hosts.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {expectedUsageInput(
                                  "standardRamGbHoursMonthly",
                                  "Expected standard RAM / month",
                                  undefined,
                                  {
                                    step: 1,
                                    addonAfter: "GB-h",
                                    unbounded: true,
                                    extra:
                                      "RAM GB-hours/month expected on standard, non-spot hosts.",
                                  },
                                )}
                              </Col>
                            </Row>
                            <Button
                              style={{ marginTop: "12px" }}
                              onClick={resetExpectedUsageEstimate}
                            >
                              Clear expected usage estimates
                            </Button>
                          </>
                        ),
                      })}
                      {fieldGroup({
                        title: "Risk Snapshot",
                        note: "Hard-cost exposure assumes the configured limits are fully used. CPU/RAM QoS cost only appears in the expected column above because it is a capacity planning assumption, not a hard project-start cap.",
                        children: (
                          <>
                            <Row gutter={[16, 16]}>
                              <Col xs={24} md={12} xl={6}>
                                {riskMetric(
                                  "Modeled hard cost",
                                  currency(analysis.hardCosts.totalMonthlyUsd),
                                )}
                              </Col>
                              <Col xs={24} md={12} xl={6}>
                                {riskMetric(
                                  "Target hard-cost budget",
                                  currency(analysis.targetHardCostBudgetUsd),
                                  `price × ${formattedPercent(
                                    Math.max(
                                      0,
                                      1 -
                                        pricingAssumptions.targetGrossMargin -
                                        pricingAssumptions.overheadReserve,
                                    ),
                                  )}`,
                                )}
                              </Col>
                              <Col xs={24} md={12} xl={6}>
                                {riskMetric(
                                  "Budget remaining",
                                  currency(
                                    analysis.margin.hardCostBudgetRemainingUsd,
                                  ),
                                )}
                              </Col>
                              <Col xs={24} md={12} xl={6}>
                                {riskMetric(
                                  "Budget used",
                                  formattedPercent(
                                    analysis.margin.hardCostRatio,
                                  ),
                                )}
                              </Col>
                              <Col xs={24} md={12} xl={6}>
                                {riskMetric(
                                  "Average CPUs if fully used",
                                  `${formattedNumber(
                                    analysis.capacity.averageCpuEntitlement,
                                    2,
                                  )} CPUs`,
                                  `monthly CPU-hours ÷ ${formattedNumber(
                                    MEMBERSHIP_TIER_PRICING_HOURS_PER_MONTH,
                                    0,
                                  )}`,
                                )}
                              </Col>
                              <Col xs={24} md={12} xl={6}>
                                {riskMetric(
                                  "Monthly CPU allowance",
                                  `${formattedNumber(
                                    analysis.capacity.cpuHoursMonthlyBudget,
                                    0,
                                  )} h`,
                                  `7-day CPU budget × ${formattedNumber(
                                    monthlyScale,
                                    2,
                                  )}`,
                                )}
                              </Col>
                              <Col xs={24} md={12} xl={6}>
                                {riskMetric(
                                  "Modeled active project RAM",
                                  `${formattedNumber(
                                    analysis.capacity.activeProjectRamGb,
                                    1,
                                  )} GB`,
                                  `${formattedNumber(
                                    analysis.capacity.modeledActiveProjects,
                                    1,
                                  )} active project(s) × project RAM`,
                                )}
                              </Col>
                              <Col xs={24} md={12} xl={6}>
                                {riskMetric(
                                  "RAM capacity target",
                                  `${formattedNumber(
                                    analysis.capacity.sharedHostRamUserShare,
                                    1,
                                  )} GB RAM`,
                                  "host RAM × RAM oversubscription",
                                )}
                              </Col>
                            </Row>
                            <Space
                              direction="vertical"
                              style={{ width: "100%", marginTop: "16px" }}
                            >
                              {analysis.messages.map((message, index) => (
                                <Alert
                                  key={index}
                                  showIcon
                                  type={riskSeverityType(message.severity)}
                                  message={message.message}
                                />
                              ))}
                            </Space>
                          </>
                        ),
                      })}
                      {fieldGroup({
                        title: "Assumptions",
                        note: "Saved in this browser. Use the main Site Settings page later if these should become shared global defaults for all admins.",
                        children: (
                          <>
                            <Row gutter={16}>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "targetGrossMargin",
                                  "Target gross margin",
                                  {
                                    multiplier: 100,
                                    step: 1,
                                    addonAfter: "%",
                                    extra:
                                      "Revenue fraction that must remain after modeled direct costs and overhead.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "overheadReserve",
                                  "Overhead reserve",
                                  {
                                    multiplier: 100,
                                    step: 1,
                                    addonAfter: "%",
                                    extra:
                                      "Revenue fraction reserved for support, payment fees, and operations. Target hard-cost budget = price × (100% - margin - overhead).",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "aiUnitCostUsd",
                                  "AI unit cost",
                                  {
                                    step: 0.001,
                                    addonAfter: "$/unit",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "egressCostPerGb",
                                  "Egress cost",
                                  {
                                    step: 0.001,
                                    addonAfter: "$/GB",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "projectStorageCostPerGbMonth",
                                  "Project file storage cost",
                                  {
                                    step: 0.001,
                                    addonAfter: "$/GB-mo",
                                    extra:
                                      "Cost basis for the project file storage hard cap across owned projects.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "blobStorageCostPerGbMonth",
                                  "R2/blob storage cost",
                                  {
                                    step: 0.001,
                                    addonAfter: "$/GB-mo",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "rootfsStorageCostPerGbMonth",
                                  "Rootfs storage cost",
                                  {
                                    step: 0.001,
                                    addonAfter: "$/GB-mo",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "spotCpuCostPerMonth",
                                  "Spot CPU cost",
                                  {
                                    step: 0.1,
                                    addonAfter: "$/CPU-mo",
                                    extra:
                                      "Provider cost for one spot vCPU-month before utilization adjustment.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "spotRamGbCostPerMonth",
                                  "Spot RAM cost",
                                  {
                                    step: 0.1,
                                    addonAfter: "$/GB-mo",
                                    extra:
                                      "Provider cost for one spot RAM GB-month before utilization adjustment.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "standardCpuCostPerMonth",
                                  "Standard CPU cost",
                                  {
                                    step: 0.1,
                                    addonAfter: "$/CPU-mo",
                                    extra:
                                      "Provider cost for one standard vCPU-month before utilization adjustment.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "standardRamGbCostPerMonth",
                                  "Standard RAM cost",
                                  {
                                    step: 0.1,
                                    addonAfter: "$/GB-mo",
                                    extra:
                                      "Provider cost for one standard RAM GB-month before utilization adjustment.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "averageCpuUtilization",
                                  "Average VM CPU utilization",
                                  {
                                    multiplier: 100,
                                    step: 1,
                                    addonAfter: "%",
                                    extra:
                                      "Effective unit CPU price divides provider CPU cost by this utilization.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "averageRamUtilization",
                                  "Average VM RAM utilization",
                                  {
                                    multiplier: 100,
                                    step: 1,
                                    addonAfter: "%",
                                    extra:
                                      "Effective unit RAM price divides provider RAM cost by this utilization.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "sharedHostUsableRamGb",
                                  "Shared host usable RAM",
                                  {
                                    step: 1,
                                    addonAfter: "GB",
                                    extra:
                                      "Capacity reference for RAM pressure; not counted as direct hard-cost exposure.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "sharedHostUsableVcpu",
                                  "Shared host usable CPU",
                                  {
                                    step: 1,
                                    addonAfter: "vCPU",
                                    extra:
                                      "Capacity reference for CPU pressure; not counted as direct hard-cost exposure.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "targetRamOversubscription",
                                  "RAM oversubscription",
                                  {
                                    step: 0.1,
                                    addonAfter: "x",
                                    extra:
                                      "How many users' active project RAM can reasonably share one host.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "targetCpuOversubscription",
                                  "CPU oversubscription",
                                  {
                                    step: 0.5,
                                    addonAfter: "x",
                                    extra:
                                      "How many average-CPU promises can reasonably share one host.",
                                  },
                                )}
                              </Col>
                              <Col {...fieldCol}>
                                {assumptionInput(
                                  "activeProjectConcurrency",
                                  "Assumed active projects",
                                  {
                                    step: 0.1,
                                    addonAfter: "projects",
                                    extra:
                                      "Used for modeled active project RAM; capped by the tier's sponsored running-project limit when that limit is set.",
                                  },
                                )}
                              </Col>
                            </Row>
                            <Button onClick={resetPricingAssumptions}>
                              Reset pricing assumptions
                            </Button>
                          </>
                        ),
                      })}
                    </>
                  );
                }}
              </Form.Item>
            ),
          })}

          {editorCard({
            title: "Advanced JSON",
            subtitle:
              "Escape hatch for fields that are not modeled yet. Prefer the cards above for ordinary tier decisions.",
            summary: hasJsonErrors ? (
              <Text type="danger" style={{ fontSize: "13px" }}>
                JSON errors
              </Text>
            ) : (
              <Text type="secondary" style={{ fontSize: "13px" }}>
                raw entitlements and compatibility fields
              </Text>
            ),
            defaultCollapsed: true,
            children: (
              <>
                <Paragraph style={sectionIntroStyle}>
                  The typed controls above merge into these objects on save.
                  Keep compatibility-only fields here only during migrations.
                </Paragraph>
                <Row gutter={16}>
                  <Col {...wideFieldCol}>
                    <Form.Item name="features" label="Features JSON">
                      <JsonObjectEditor
                        emptyHint="No feature flags yet."
                        onErrorChange={(err) =>
                          updateJsonError("features", err)
                        }
                      />
                    </Form.Item>
                  </Col>
                  <Col {...wideFieldCol}>
                    <Form.Item
                      name="project_defaults"
                      label="Project defaults JSON"
                    >
                      <JsonObjectEditor
                        emptyHint="No default quotas set."
                        onErrorChange={(err) =>
                          updateJsonError("project_defaults", err)
                        }
                      />
                    </Form.Item>
                  </Col>
                  <Col {...wideFieldCol}>
                    <Form.Item name="ai_limits" label="AI limits JSON">
                      <JsonObjectEditor
                        emptyHint="No AI limits defined."
                        onErrorChange={(err) =>
                          updateJsonError("ai_limits", err)
                        }
                      />
                    </Form.Item>
                  </Col>
                  <Col {...wideFieldCol}>
                    <Form.Item name="usage_limits" label="Usage limits JSON">
                      <JsonObjectEditor
                        emptyHint="No shared-host usage limits configured."
                        onErrorChange={(err) =>
                          updateJsonError("usage_limits", err)
                        }
                      />
                    </Form.Item>
                  </Col>
                </Row>
              </>
            ),
          })}

          <Form.Item>
            <Space.Compact>
              <Button type="primary" htmlType="submit" disabled={hasJsonErrors}>
                Save
              </Button>
              <Button
                htmlType="button"
                onClick={() => {
                  if (editing != null) {
                    form.setFieldsValue(tierToFormValues(editing));
                  } else {
                    form.resetFields();
                  }
                }}
              >
                Reset
              </Button>
              <Button htmlType="button" onClick={() => set_editing(null)}>
                Cancel
              </Button>
            </Space.Compact>
            {hasJsonErrors && (
              <div style={{ marginTop: "8px" }}>
                <Text type="danger">
                  Fix errors in JSON fields before saving.
                </Text>
              </div>
            )}
          </Form.Item>
        </Form>
      </>
    );
  }

  async function createTierFromModal(): Promise<void> {
    try {
      const values = await createTierForm.validateFields();
      await create_tier_from_template({
        id: values.id,
        label: values.label,
        template: values.template,
      });
      setCreateTierOpen(false);
      createTierForm.resetFields();
    } catch (err) {
      if (err?.errorFields != null) return;
      const message = err?.message ?? String(err);
      set_error(message);
      if (message.includes("already exists")) {
        createTierForm.setFields([{ name: "id", errors: [message] }]);
      }
    }
  }

  function openCreateTierModal() {
    setCreateTierOpen(true);
    createTierForm.setFieldsValue({
      template: "standard",
      id: "",
      label: "",
    });
  }

  function exportMembershipTiers() {
    const payload = membershipTierExportPayload(Object.values(data));
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cocalc-membership-tiers-${dayjs().format(
      "YYYY-MM-DD-HHmmss",
    )}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function buildImportCandidates(
    tiers: Tier[],
  ): MembershipTierImportCandidate[] {
    const byLabel = new Map<string, Tier>();
    const duplicateLabels = new Set<string>();
    for (const tier of Object.values(data)) {
      const label = tier.label?.trim();
      if (!label) continue;
      if (byLabel.has(label)) {
        duplicateLabels.add(label);
      } else {
        byLabel.set(label, tier);
      }
    }
    for (const label of duplicateLabels) {
      byLabel.delete(label);
    }

    const candidates = tiers.map((tier, index) => {
      const sourceLabel = tier.label?.trim();
      const labelMatch = sourceLabel ? byLabel.get(sourceLabel) : undefined;
      const idMatch = data[tier.id];
      const target = labelMatch ?? idMatch;
      const match =
        labelMatch != null ? "label" : idMatch != null ? "id" : "new";
      const targetId = target?.id ?? tier.id;
      const payload = buildMembershipTierPayload(
        tierToFormValues({
          ...tier,
          id: targetId,
          label: sourceLabel || tier.id,
        }),
      );
      return {
        key: `${index}:${tier.id}`,
        sourceId: tier.id,
        sourceLabel: tier.label,
        targetId,
        targetLabel: target?.label,
        match,
        payload,
      } satisfies MembershipTierImportCandidate;
    });

    const targetCounts = candidates.reduce<Record<string, number>>(
      (counts, candidate) => {
        counts[candidate.targetId] = (counts[candidate.targetId] ?? 0) + 1;
        return counts;
      },
      {},
    );
    return candidates.map((candidate) => ({
      ...candidate,
      disabledReason:
        targetCounts[candidate.targetId] > 1
          ? `Another imported tier also maps to "${candidate.targetId}".`
          : undefined,
    }));
  }

  async function handleImportFileSelected(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file == null) return;
    try {
      const parsed = JSON.parse(await file.text());
      const tiers = parseMembershipTierImportJson(parsed);
      const candidates = buildImportCandidates(tiers);
      setImportCandidates(candidates);
      setImportSelectedKeys(
        candidates
          .filter((candidate) => candidate.disabledReason == null)
          .map((candidate) => candidate.key),
      );
      setImportError("");
      setImportModalOpen(true);
    } catch (err) {
      setImportError(err.message ?? String(err));
      setImportCandidates([]);
      setImportSelectedKeys([]);
      setImportModalOpen(true);
    }
  }

  async function importSelectedMembershipTiers() {
    const selected = importCandidates.filter((candidate) =>
      importSelectedKeys.includes(candidate.key),
    );
    if (selected.length === 0) {
      setImportError("Select at least one tier to import.");
      return;
    }
    setImporting(true);
    try {
      await import_tiers(selected.map((candidate) => candidate.payload));
      setImportModalOpen(false);
      setImportCandidates([]);
      setImportSelectedKeys([]);
      setImportError("");
    } catch (err) {
      setImportError(err.message ?? String(err));
    } finally {
      setImporting(false);
    }
  }

  function render_create_tier_modal() {
    return (
      <Modal
        title="Create Membership Tier"
        open={createTierOpen}
        okText="Create tier"
        confirmLoading={saving}
        onOk={() => createTierFromModal()}
        onCancel={() => {
          setCreateTierOpen(false);
          createTierForm.resetFields();
        }}
        destroyOnHidden
      >
        <Paragraph type="secondary">
          Choose a starting template once, then create the tier. Template
          presets are not shown in the editor for existing tiers.
        </Paragraph>
        <Form
          layout="vertical"
          form={createTierForm}
          initialValues={{ template: "standard" }}
        >
          <Form.Item
            name="template"
            label="Starting template"
            rules={[{ required: true }]}
          >
            <Select
              options={TEMPLATE_KEYS.map((key) => ({
                value: key,
                label: TIER_TEMPLATES[key].label,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="id"
            label="Tier ID"
            extra="Stable machine identifier, e.g. standard or pro."
            rules={[
              { required: true, message: "Enter a tier ID." },
              {
                pattern: /^[a-z0-9][a-z0-9_-]*$/,
                message:
                  "Use lowercase letters, numbers, underscores, or hyphens.",
              },
              {
                validator: async (_, value) => {
                  const id =
                    typeof value === "string" ? value.trim() : String(value);
                  if (!id || data[id] == null) return;
                  throw Error(`membership tier "${id}" already exists`);
                },
              },
            ]}
          >
            <Input autoFocus />
          </Form.Item>
          <Form.Item
            name="label"
            label="Display name"
            rules={[{ required: true, message: "Enter a display name." }]}
          >
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    );
  }

  function render_import_tiers_modal() {
    return (
      <Modal
        title="Import Membership Tiers"
        open={importModalOpen}
        okText={`Import ${importSelectedKeys.length} tier(s)`}
        okButtonProps={{
          disabled:
            importCandidates.length === 0 || importSelectedKeys.length === 0,
        }}
        confirmLoading={importing || saving}
        onOk={() => importSelectedMembershipTiers()}
        onCancel={() => {
          setImportModalOpen(false);
          setImportError("");
        }}
        width={900}
      >
        <Paragraph type="secondary">
          Review the tiers in this JSON file before importing. Exact display
          label matches overwrite the existing tier with that label; otherwise
          exact tier ID matches overwrite by ID; otherwise a new tier is
          created.
        </Paragraph>
        {importError && (
          <Alert
            style={{ marginBottom: "12px" }}
            type="error"
            showIcon
            message={importError}
          />
        )}
        <Table<MembershipTierImportCandidate>
          size="small"
          rowKey="key"
          dataSource={importCandidates}
          pagination={false}
          rowSelection={{
            selectedRowKeys: importSelectedKeys,
            onChange: setImportSelectedKeys,
            getCheckboxProps: (candidate) => ({
              disabled: candidate.disabledReason != null,
            }),
          }}
        >
          <Table.Column<MembershipTierImportCandidate>
            title="Import ID"
            dataIndex="sourceId"
          />
          <Table.Column<MembershipTierImportCandidate>
            title="Name"
            dataIndex="sourceLabel"
            render={(label, candidate) => label || candidate.sourceId}
          />
          <Table.Column<MembershipTierImportCandidate>
            title="Import action"
            render={(_, candidate) => {
              if (candidate.disabledReason) {
                return <Text type="danger">{candidate.disabledReason}</Text>;
              }
              if (candidate.match === "label") {
                return (
                  <Text>
                    Overwrite tier <Text code>{candidate.targetId}</Text> by
                    matching label.
                  </Text>
                );
              }
              if (candidate.match === "id") {
                return (
                  <Text>
                    Overwrite tier <Text code>{candidate.targetId}</Text> by
                    matching ID.
                  </Text>
                );
              }
              return (
                <Text>
                  Create new tier <Text code>{candidate.targetId}</Text>.
                </Text>
              );
            }}
          />
        </Table>
      </Modal>
    );
  }

  function render_buttons() {
    const any_selected = sel_rows.length > 0;
    const selected_has_usage = sel_rows.some(
      (id) =>
        (data[id]?.subscription_count ?? 0) > 0 ||
        (data[id]?.site_license_count ?? 0) > 0,
    );
    return (
      <Space.Compact style={{ margin: "10px 0" }}>
        <Button
          type={!any_selected ? "primary" : "default"}
          disabled={any_selected}
          onClick={() => openCreateTierModal()}
        >
          <Icon name="plus" /> Add
        </Button>
        <Button
          type={any_selected ? "primary" : "default"}
          onClick={delete_tiers}
          disabled={!any_selected || selected_has_usage}
          loading={deleting}
        >
          <Icon name="trash" />
          {any_selected ? `Delete ${sel_rows.length} tier(s)` : "Delete"}
        </Button>
        <Button onClick={() => load()}>
          <Icon name="refresh" /> Refresh
        </Button>
        <Button onClick={exportMembershipTiers}>
          <Icon name="download" /> Export JSON
        </Button>
        <Button onClick={() => importFileInputRef.current?.click()}>
          <Icon name="upload" /> Import JSON
        </Button>
        <input
          ref={importFileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={handleImportFileSelected}
        />
      </Space.Compact>
    );
  }

  function render_view() {
    const table_data = sortBy(
      Object.values(data).map((v) => {
        v.key = v.id;
        return v;
      }),
      "id",
    );
    const rowSelection = {
      selectedRowKeys: sel_rows,
      onChange: set_sel_rows,
    };
    return (
      <>
        {render_buttons()}
        <Table<Tier>
          size={"small"}
          dataSource={table_data}
          loading={loading}
          rowSelection={rowSelection}
          pagination={{
            position: ["bottomRight"],
            defaultPageSize: 10,
            showSizeChanger: true,
          }}
          rowClassName={(row) =>
            row.id === last_saved?.id ? "cocalc-highlight-saved-token" : ""
          }
        >
          <Table.Column<Tier>
            title="Tier ID"
            dataIndex="id"
            defaultSortOrder={"ascend"}
            sorter={(a, b) => a.id.localeCompare(b.id)}
          />
          <Table.Column<Tier> title="Label" dataIndex="label" />
          <Table.Column<Tier>
            title="Visible"
            dataIndex="store_visible"
            render={(val) => (val ? "Yes" : "")}
          />
          <Table.Column<Tier>
            title="Course"
            dataIndex="course_store_visible"
            render={(val) => (val ? "Yes" : "")}
          />
          <Table.Column<Tier> title="Priority" dataIndex="priority" />
          <Table.Column<Tier>
            title="Monthly"
            dataIndex="price_monthly"
            render={(val) => (val != null ? currency(Number(val)) : "")}
          />
          <Table.Column<Tier>
            title="Yearly"
            dataIndex="price_yearly"
            render={(val) => (val != null ? currency(Number(val)) : "")}
          />
          <Table.Column<Tier>
            title="Trial days"
            dataIndex="trial_days"
            render={(val) => (val != null && val > 0 ? val : "")}
          />
          <Table.Column<Tier>
            title="Course price"
            dataIndex="course_price"
            render={(val) => (val != null ? val : "")}
          />
          <Table.Column<Tier>
            title="Course days"
            dataIndex="course_duration_days"
            render={(val) => (val != null ? val : "")}
          />
          <Table.Column<Tier>
            title="Grace days"
            dataIndex="course_grace_days"
            render={(val) => (val != null ? val : "")}
          />
          <Table.Column<Tier>
            title="Subscriptions"
            dataIndex="subscription_count"
            render={(val) => val ?? 0}
          />
          <Table.Column<Tier>
            title="Subscribed accounts"
            dataIndex="subscribed_account_count"
            render={(val) => val ?? 0}
          />
          <Table.Column<Tier>
            title="Admin assigned"
            dataIndex="admin_assigned_count"
            render={(val) => val ?? 0}
          />
          <Table.Column<Tier>
            title="Site licenses"
            dataIndex="site_license_count"
            render={(val) => val ?? 0}
          />
          <Table.Column<Tier>
            title="Active"
            dataIndex="disabled"
            render={(_text, tier) => {
              const click = () => save({ ...tier, active: !!tier.disabled });
              return (
                <Checkbox checked={!tier.disabled} onChange={click}></Checkbox>
              );
            }}
          />
          <Table.Column<Tier>
            title="Updated"
            dataIndex="updated"
            render={(v) => (v != null ? <TimeAgo date={v} /> : "")}
          />
          <Table.Column<Tier>
            title="History"
            dataIndex="history"
            render={(val) => (Array.isArray(val) ? val.length : 0)}
          />
          <Table.Column<Tier>
            title="Edit"
            dataIndex="edit"
            render={(_text, tier) => (
              <Icon name="pencil" onClick={() => set_editing(tier)} />
            )}
          />
          <Table.Column<Tier>
            title="Delete"
            dataIndex="delete"
            render={(_text, tier) => {
              const inUse =
                (tier.subscription_count ?? 0) > 0 ||
                (tier.site_license_count ?? 0) > 0;
              if (inUse) {
                return (
                  <Text type="secondary" title="Tier in use">
                    In use
                  </Text>
                );
              }
              return (
                <Popconfirm
                  title="Sure to delete?"
                  onConfirm={() => delete_tier(tier.key, true)}
                >
                  <Icon name="trash" />
                </Popconfirm>
              );
            }}
          />
        </Table>
      </>
    );
  }

  function render_control() {
    if (editing != null) {
      return render_edit();
    }
    return render_view();
  }

  function render_error() {
    if (error) {
      return <ErrorDisplay error={error} onClose={() => set_error("")} />;
    }
    return null;
  }

  function render_info() {
    return (
      <div style={{ color: COLORS.GRAY, fontStyle: "italic" }}>
        {saving && (
          <>
            <Saving />
            <br />
          </>
        )}
        <Paragraph style={{ marginBottom: 0 }}>
          Tip: Use stable tier IDs, e.g. <Text code>standard</Text>. Set{" "}
          <Text code>Visible</Text> for public purchase UI and{" "}
          <Text code>Course visible</Text> for course student memberships.
        </Paragraph>
      </div>
    );
  }

  return (
    <div>
      {render_error()}
      {render_control()}
      {render_create_tier_modal()}
      {render_import_tiers_modal()}
      {render_info()}
    </div>
  );
}
