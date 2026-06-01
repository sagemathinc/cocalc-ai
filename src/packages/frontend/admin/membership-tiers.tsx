/*
 *  This file is part of CoCalc: Copyright © 2024 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Admin UI for membership tiers.
*/

import {
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
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
import { COLORS } from "@cocalc/util/theme";

const { Paragraph, Text } = Typography;
const { Panel: CollapsePanel } = Collapse;
const BYTES_PER_GB = 1000 * 1000 * 1000;
const SECONDS_PER_CPU_HOUR = 3600;

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
    const val_orig: Tier = { ...values };
    if (editing != null) set_editing(null);

    try {
      set_saving(true);
      const project_defaults = (parseJsonField(
        values.project_defaults,
        "project_defaults",
      ) ?? {}) as Record<string, unknown>;
      const ai_limits = (parseJsonField(values.ai_limits, "ai_limits") ??
        {}) as Record<string, unknown>;
      const features = (parseJsonField(values.features, "features") ??
        {}) as Record<string, unknown>;
      const usage_limits = (parseJsonField(
        values.usage_limits,
        "usage_limits",
      ) ?? {}) as Record<string, unknown>;
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

      const payload = pick(
        {
          ...values,
          project_defaults,
          ai_limits,
          features,
          usage_limits,
          store_description: normalizedOptionalString(values.store_description),
          store_highlights: parseStoreHighlightsText(
            values.store_highlights_text,
          ),
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
          "disabled",
          "notes",
        ],
      );

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

  function edit_new_tier() {
    set_editing({
      id: "",
      label: "",
      store_visible: false,
      store_description: "",
      store_highlights: [],
      course_store_visible: false,
      priority: 0,
      trial_days: 0,
      disabled: false,
      notes: "",
      project_defaults: {},
      ai_limits: {},
      features: {
        create_hosts: false,
        project_host_tier: 0,
      },
      usage_limits: {},
    });
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
    edit_new_tier,
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
    edit_new_tier,
    save,
    load,
  } = useMembershipTiers();
  const [jsonErrors, setJsonErrors] = React.useState<Record<string, string>>(
    {},
  );

  function render_edit() {
    const onFinish = (values) => save(values);
    const editingExisting = editing?.id != null && data[editing.id] != null;
    const applyTemplate = (key: keyof typeof TIER_TEMPLATES) => {
      const template = TIER_TEMPLATES[key];
      form.setFieldsValue(tierToFormValues({ ...template, disabled: false }));
    };
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
      defaultCollapsed = false,
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

    return (
      <>
        <Card
          style={{
            ...cardStyle,
            background:
              "linear-gradient(135deg, rgba(238,246,255,0.9), rgba(255,255,255,0.95))",
          }}
          styles={{ body: { padding: "14px 18px" } }}
        >
          <Space direction="vertical" style={{ width: "100%" }}>
            <Space wrap>
              <Text strong>Start from template</Text>
              <Text type="secondary">
                Templates fill all modeled values; edit the cards below before
                saving.
              </Text>
            </Space>
            <Space wrap>
              {(
                [
                  "free",
                  "basic",
                  "student",
                  "standard",
                  "member",
                  "instructor",
                  "researcher",
                  "pro",
                ] as const
              ).map((key) => (
                <Button
                  key={key}
                  size="small"
                  onClick={() => applyTemplate(key)}
                >
                  {TIER_TEMPLATES[key].label}
                </Button>
              ))}
            </Space>
          </Space>
        </Card>
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
              "Public identity, pricing, store visibility, and internal lifecycle state.",
            summary: cardSummary((get) =>
              summaryPieces(
                `monthly ${currency(Number(get("price_monthly") ?? 0))}`,
                `yearly ${currency(Number(get("price_yearly") ?? 0))}`,
                get("store_visible") ? "public store" : "hidden from store",
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
                      label="Store visibility"
                      valuePropName="checked"
                    >
                      <Checkbox>Show in public pricing/store</Checkbox>
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
                      label="Store description"
                      extra="Short public sentence shown on pricing/store cards."
                    >
                      <Input.TextArea rows={3} />
                    </Form.Item>
                  </Col>
                  <Col {...wideFieldCol}>
                    <Form.Item
                      name="store_highlights_text"
                      label="Store highlights"
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
                          label="Account storage soft cap"
                          extra={fieldHelp(
                            "GB soft cap across owned projects before storage-increasing actions are restricted.",
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
                          label="Account storage hard cap"
                          extra={fieldHelp(
                            "GB hard cap across owned projects; should be at or above the soft cap.",
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
                  form.resetFields();
                  edit_new_tier();
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
          onClick={() => edit_new_tier()}
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
          Tip: Tier IDs should be stable slugs (e.g., <Text code>member</Text>).
          Set <Text code>Visible</Text> for the normal store and{" "}
          <Text code>Course visible</Text> for course student memberships.
        </Paragraph>
      </div>
    );
  }

  return (
    <div>
      {render_error()}
      {render_control()}
      {render_info()}
    </div>
  );
}
