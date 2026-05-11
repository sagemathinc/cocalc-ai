/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Collapse,
  DatePicker,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Popover,
  Select,
  Space,
  Spin,
  Typography,
  message,
  type FormInstance,
} from "antd";
import dayjs from "dayjs";
import type {
  AccountEntitlementOverride,
  MembershipDetails,
  NumericLimitRule,
  NumericLimitRuleMode,
} from "@cocalc/conat/hub/api/purchases";
import { ErrorDisplay } from "@cocalc/frontend/components";
import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { actions } from "./actions";
import { MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS } from "@cocalc/util/membership-entitlement-overrides";

const { Text } = Typography;
const BYTES_PER_GB = 1000 * 1000 * 1000;

type NumericSection = "project_defaults" | "ai_limits" | "usage_limits";

interface NumericOverrideField {
  id: string;
  section: NumericSection;
  key: string;
  label: string;
  unit: string;
  description: string;
  fromStored?: (value: number) => number;
  toStored?: (value: number) => number;
}

const NUMERIC_FIELDS: NumericOverrideField[] = [
  {
    id: "project_disk_quota",
    section: "project_defaults",
    key: "disk_quota",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.project_defaults.disk_quota
        .label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.project_defaults
      .disk_quota.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.project_defaults.disk_quota
        .adminDescription,
  },
  {
    id: "project_memory",
    section: "project_defaults",
    key: "memory",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.project_defaults.memory
        .label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.project_defaults.memory
      .unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.project_defaults.memory
        .adminDescription,
  },
  {
    id: "project_memory_request",
    section: "project_defaults",
    key: "memory_request",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.project_defaults
        .memory_request.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.project_defaults
      .memory_request.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.project_defaults
        .memory_request.adminDescription,
  },
  {
    id: "ai_units_5h",
    section: "ai_limits",
    key: "units_5h",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.ai_limits.units_5h.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.ai_limits.units_5h.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.ai_limits.units_5h
        .adminDescription,
  },
  {
    id: "ai_units_7d",
    section: "ai_limits",
    key: "units_7d",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.ai_limits.units_7d.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.ai_limits.units_7d.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.ai_limits.units_7d
        .adminDescription,
  },
  {
    id: "total_storage_soft",
    section: "usage_limits",
    key: "total_storage_soft_bytes",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .total_storage_soft_bytes.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .total_storage_soft_bytes.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .total_storage_soft_bytes.adminDescription,
    fromStored: (value) => value / BYTES_PER_GB,
    toStored: (value) => Math.round(value * BYTES_PER_GB),
  },
  {
    id: "total_storage_hard",
    section: "usage_limits",
    key: "total_storage_hard_bytes",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .total_storage_hard_bytes.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .total_storage_hard_bytes.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .total_storage_hard_bytes.adminDescription,
    fromStored: (value) => value / BYTES_PER_GB,
    toStored: (value) => Math.round(value * BYTES_PER_GB),
  },
  {
    id: "max_projects",
    section: "usage_limits",
    key: "max_projects",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits.max_projects
        .label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits.max_projects
      .unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits.max_projects
        .adminDescription,
  },
  {
    id: "max_snapshots_per_project",
    section: "usage_limits",
    key: "max_snapshots_per_project",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .max_snapshots_per_project.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .max_snapshots_per_project.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .max_snapshots_per_project.adminDescription,
  },
  {
    id: "max_backups_per_project",
    section: "usage_limits",
    key: "max_backups_per_project",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .max_backups_per_project.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .max_backups_per_project.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .max_backups_per_project.adminDescription,
  },
  {
    id: "egress_5h",
    section: "usage_limits",
    key: "egress_5h_bytes",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits.egress_5h_bytes
        .label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .egress_5h_bytes.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits.egress_5h_bytes
        .adminDescription,
    fromStored: (value) => value / BYTES_PER_GB,
    toStored: (value) => Math.round(value * BYTES_PER_GB),
  },
  {
    id: "egress_7d",
    section: "usage_limits",
    key: "egress_7d_bytes",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits.egress_7d_bytes
        .label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .egress_7d_bytes.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits.egress_7d_bytes
        .adminDescription,
    fromStored: (value) => value / BYTES_PER_GB,
    toStored: (value) => Math.round(value * BYTES_PER_GB),
  },
  {
    id: "credit_spend_5h",
    section: "usage_limits",
    key: "credit_spend_limit_5h_usd",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .credit_spend_limit_5h_usd.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .credit_spend_limit_5h_usd.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .credit_spend_limit_5h_usd.adminDescription,
  },
  {
    id: "credit_spend_7d",
    section: "usage_limits",
    key: "credit_spend_limit_7d_usd",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .credit_spend_limit_7d_usd.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .credit_spend_limit_7d_usd.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .credit_spend_limit_7d_usd.adminDescription,
  },
  {
    id: "prepaid_host_5h",
    section: "usage_limits",
    key: "prepaid_host_usage_limit_5h_usd",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .prepaid_host_usage_limit_5h_usd.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .prepaid_host_usage_limit_5h_usd.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .prepaid_host_usage_limit_5h_usd.adminDescription,
  },
  {
    id: "prepaid_host_7d",
    section: "usage_limits",
    key: "prepaid_host_usage_limit_7d_usd",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .prepaid_host_usage_limit_7d_usd.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .prepaid_host_usage_limit_7d_usd.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .prepaid_host_usage_limit_7d_usd.adminDescription,
  },
  {
    id: "notification_email_5h",
    section: "usage_limits",
    key: "notification_email_send_limit_5h",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .notification_email_send_limit_5h.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .notification_email_send_limit_5h.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .notification_email_send_limit_5h.adminDescription,
  },
  {
    id: "notification_email_7d",
    section: "usage_limits",
    key: "notification_email_send_limit_7d",
    label:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .notification_email_send_limit_7d.label,
    unit: MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
      .notification_email_send_limit_7d.unit,
    description:
      MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS.usage_limits
        .notification_email_send_limit_7d.adminDescription,
  },
];

const PROJECT_FIELD_IDS = new Set([
  "project_disk_quota",
  "project_memory",
  "project_memory_request",
  "max_projects",
  "max_snapshots_per_project",
  "max_backups_per_project",
]);

const STORAGE_EGRESS_FIELD_IDS = new Set([
  "total_storage_soft",
  "total_storage_hard",
  "egress_5h",
  "egress_7d",
]);

const AI_FIELD_IDS = new Set(["ai_units_5h", "ai_units_7d"]);
const NOTIFICATION_EMAIL_FIELD_IDS = new Set([
  "notification_email_5h",
  "notification_email_7d",
]);

const SPEND_FIELD_IDS = new Set([
  "credit_spend_5h",
  "credit_spend_7d",
  "prepaid_host_5h",
  "prepaid_host_7d",
]);

const MODE_OPTIONS = [
  { value: "", label: "No override" },
  { value: "minimum", label: "Minimum" },
  { value: "maximum", label: "Maximum" },
  { value: "set", label: "Set" },
];

function getNumericRule(
  override: AccountEntitlementOverride | undefined,
  field: NumericOverrideField,
): NumericLimitRule | undefined {
  const section = override?.[field.section] as
    | Record<string, NumericLimitRule | undefined>
    | undefined;
  return section?.[field.key];
}

function applyRuleToFields(
  fields: Record<string, unknown>,
  field: NumericOverrideField,
  rule?: NumericLimitRule,
) {
  fields[`${field.id}_mode`] = rule?.mode ?? "";
  fields[`${field.id}_value`] =
    rule?.value == null
      ? undefined
      : (field.fromStored ?? ((v) => v))(rule.value);
}

function setNestedRule(
  target: Record<string, any>,
  field: NumericOverrideField,
  rule?: NumericLimitRule,
) {
  if (!rule) return;
  target[field.section] ??= {};
  target[field.section][field.key] = rule;
}

function parseRule(values: Record<string, any>, field: NumericOverrideField) {
  const mode = values[`${field.id}_mode`] as NumericLimitRuleMode | "";
  const raw = values[`${field.id}_value`];
  const hasValue = raw != null && raw !== "";
  if (!mode) return undefined;
  if (!hasValue) {
    throw Error(`${field.label} needs a value.`);
  }
  const displayValue = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(displayValue) || displayValue < 0) {
    throw Error(`${field.label} needs a nonnegative number.`);
  }
  return {
    mode,
    value: (field.toStored ?? ((value) => value))(displayValue),
  };
}

function validateNumericRule(
  values: Record<string, any>,
  field: NumericOverrideField,
) {
  const mode = values[`${field.id}_mode`] as NumericLimitRuleMode | "";
  const raw = values[`${field.id}_value`];
  const hasValue = raw != null && raw !== "";
  if (!mode && hasValue) {
    throw Error(`${field.label} has a value but no override mode.`);
  }
}

function getCurrentEntitlementValue(
  details: MembershipDetails | null | undefined,
  field: NumericOverrideField,
): unknown {
  const selected = details?.selected;
  if (!selected) return undefined;
  if (field.section === "usage_limits") {
    return (
      selected.effective_limits?.[
        field.key as keyof NonNullable<typeof selected.effective_limits>
      ] ??
      selected.entitlements.usage_limits?.[
        field.key as keyof NonNullable<
          typeof selected.entitlements.usage_limits
        >
      ]
    );
  }
  if (field.section === "project_defaults") {
    return selected.entitlements.project_defaults?.[field.key];
  }
  if (field.section === "ai_limits") {
    return selected.entitlements.ai_limits?.[field.key];
  }
  return undefined;
}

function formatCurrentValue(
  value: unknown,
  field?: Pick<NumericOverrideField, "fromStored" | "unit">,
): string {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const display = field?.fromStored ? field.fromStored(value) : value;
    const formatted = Number.isInteger(display)
      ? `${display}`
      : display.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return field?.unit ? `${formatted} ${field.unit}` : formatted;
  }
  return "Not configured";
}

function formatOverrideRule(
  rule: NumericLimitRule,
  field: Pick<NumericOverrideField, "fromStored" | "unit">,
): string {
  const display = field.fromStored ? field.fromStored(rule.value) : rule.value;
  const formatted = Number.isInteger(display)
    ? `${display}`
    : display.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${rule.mode} ${formatted} ${field.unit}`;
}

function describeOverride(override?: AccountEntitlementOverride): string[] {
  if (!override) return [];
  const effects: string[] = [];
  for (const field of NUMERIC_FIELDS) {
    const rule = getNumericRule(override, field);
    if (rule) {
      effects.push(`${field.label}: ${formatOverrideRule(rule, field)}`);
    }
  }
  if (override.features?.create_hosts != null) {
    effects.push(
      `Dedicated host creation: ${
        override.features.create_hosts ? "allow" : "block"
      }`,
    );
  }
  if (override.dedicated_hosts?.funding_mode) {
    effects.push(
      `Account host billing mode: ${override.dedicated_hosts.funding_mode.value}`,
    );
  }
  return effects;
}

function errorMessage(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    Array.isArray((err as { errorFields?: unknown[] }).errorFields)
  ) {
    const messages = (
      err as { errorFields: Array<{ errors?: string[] }> }
    ).errorFields
      .flatMap((field) => field.errors ?? [])
      .filter(Boolean);
    if (messages.length > 0) return messages.join(" ");
  }
  return err instanceof Error ? err.message : `${err}`;
}

function resetFormFields(
  form: FormInstance,
  override?: AccountEntitlementOverride,
) {
  const values: Record<string, unknown> = {
    enabled: override?.enabled ?? true,
    expires_at: override?.expires_at ? dayjs(override.expires_at) : null,
    reason: override?.reason ?? "",
    create_hosts:
      override?.features?.create_hosts == null
        ? "inherit"
        : override.features.create_hosts
          ? "true"
          : "false",
  };
  for (const field of NUMERIC_FIELDS) {
    applyRuleToFields(values, field, getNumericRule(override, field));
  }
  form.setFieldsValue(values);
}

export function buildOverride(values: Record<string, any>) {
  const override: Record<string, any> = {
    enabled: values.enabled !== false,
    expires_at: values.expires_at ? values.expires_at.toDate() : null,
  };
  for (const field of NUMERIC_FIELDS) {
    validateNumericRule(values, field);
    setNestedRule(override, field, parseRule(values, field));
  }
  if (values.create_hosts === "true" || values.create_hosts === "false") {
    override.features ??= {};
    override.features.create_hosts = values.create_hosts === "true";
  }
  return override;
}

function hasConfiguredEntitlementChange(
  override: AccountEntitlementOverride | Record<string, any>,
): boolean {
  return describeOverride(override as AccountEntitlementOverride).length > 0;
}

function OverrideHelp() {
  return (
    <Popover
      title="How override modes combine with memberships"
      content={
        <div style={{ maxWidth: 420 }}>
          <p>
            Use <b>maximum</b> to cap a limit. Example: if support sets max
            projects to maximum 50, a later purchased membership with 100
            projects still resolves to 50.
          </p>
          <p>
            Use <b>minimum</b> to grant a floor. Example: if support sets max
            projects to minimum 50, a 20-project tier resolves to 50, but a
            later 100-project tier still resolves to 100.
          </p>
          <p>
            Use <b>set</b> only when support wants an exact forced value.
          </p>
        </div>
      }
    >
      <Button type="link" size="small">
        ?
      </Button>
    </Popover>
  );
}

const GRID_COLUMNS =
  "minmax(180px, 0.8fr) minmax(170px, 0.7fr) minmax(340px, 1.5fr)";

function OverrideGridHeader() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: GRID_COLUMNS,
        gap: 12,
        alignItems: "center",
      }}
    >
      <Text strong>Setting</Text>
      <Text strong>Current effective entitlement</Text>
      <Text strong>Override</Text>
    </div>
  );
}

function NumericRuleEditor({
  details,
  field,
  form,
}: {
  details: MembershipDetails | null | undefined;
  field: NumericOverrideField;
  form: FormInstance;
}) {
  const modeName = `${field.id}_mode`;
  const valueName = `${field.id}_value`;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: GRID_COLUMNS,
        gap: 12,
        alignItems: "center",
      }}
    >
      <Space size={4}>
        <Text>{`${field.label} (${field.unit})`}</Text>
        <Popover
          content={<div style={{ maxWidth: 420 }}>{field.description}</div>}
        >
          <Button type="link" size="small">
            ?
          </Button>
        </Popover>
      </Space>
      <Text type="secondary">
        {formatCurrentValue(getCurrentEntitlementValue(details, field), field)}
      </Text>
      <Form.Item shouldUpdate noStyle>
        {({ getFieldValue }) => {
          const mode = getFieldValue(modeName);
          return (
            <Space.Compact style={{ width: "100%" }}>
              <Form.Item name={modeName} noStyle>
                <Select
                  style={{ width: 150 }}
                  options={MODE_OPTIONS}
                  onChange={(value) => {
                    if (!value) {
                      form.setFieldValue(valueName, undefined);
                    }
                  }}
                />
              </Form.Item>
              {mode ? (
                <Form.Item name={valueName} noStyle>
                  <InputNumber
                    style={{ width: "100%" }}
                    min={0}
                    placeholder={field.unit}
                  />
                </Form.Item>
              ) : null}
            </Space.Compact>
          );
        }}
      </Form.Item>
    </div>
  );
}

function SelectOverrideEditor({
  current,
  description,
  label,
  name,
  options,
}: {
  current: unknown;
  description: string;
  label: string;
  name: string;
  options: { value: string; label: string }[];
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: GRID_COLUMNS,
        gap: 12,
        alignItems: "center",
      }}
    >
      <Space size={4}>
        <Text>{label}</Text>
        <Popover content={<div style={{ maxWidth: 420 }}>{description}</div>}>
          <Button type="link" size="small">
            ?
          </Button>
        </Popover>
      </Space>
      <Text type="secondary">{formatCurrentValue(current)}</Text>
      <Form.Item name={name} noStyle>
        <Select options={options} />
      </Form.Item>
    </div>
  );
}

function NumericFieldGroup({
  details,
  fields,
  form,
}: {
  details: MembershipDetails | null | undefined;
  fields: NumericOverrideField[];
  form: FormInstance;
}) {
  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      <OverrideGridHeader />
      {fields.map((field) => (
        <NumericRuleEditor
          key={field.id}
          details={details}
          field={field}
          form={form}
        />
      ))}
    </Space>
  );
}

export function AccountEntitlementOverridePanel({
  account_id,
  details,
  onChanged,
}: {
  account_id: string;
  details?: MembershipDetails | null;
  onChanged?: () => Promise<void> | void;
}) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [override, setOverride] = useState<
    AccountEntitlementOverride | undefined
  >();
  const [error, setError] = useState<string>("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const nextOverride =
        await actions.get_account_entitlement_override(account_id);
      setOverride(nextOverride);
      resetFormFields(form, nextOverride);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const values = form.getFieldsValue();
      const reason = `${values.reason ?? ""}`.trim();
      if (!reason) {
        throw Error("Reason is required.");
      }
      const builtOverride = buildOverride(values);
      if (!hasConfiguredEntitlementChange(builtOverride)) {
        throw Error(
          "Configure at least one entitlement override before saving. Use Clear active override to remove an existing override.",
        );
      }
      const nextOverride = await actions.set_account_entitlement_override({
        account_id,
        override: builtOverride,
        reason,
      });
      setOverride(nextOverride);
      resetFormFields(form, undefined);
      message.success("Account entitlement override updated.");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("cocalc:membership-changed"));
      }
      await onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setClearing(true);
    setError("");
    try {
      const reason = `${form.getFieldValue("reason") ?? ""}`.trim();
      if (!reason) {
        throw Error("Reason is required to clear an override.");
      }
      await actions.clear_account_entitlement_override({
        account_id,
        reason,
      });
      setOverride(undefined);
      resetFormFields(form, undefined);
      message.success("Account entitlement override cleared.");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("cocalc:membership-changed"));
      }
      await onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setClearing(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [account_id]);

  return (
    <div>
      <Space align="center">
        <Text strong>Account entitlement overrides</Text>
        <OverrideHelp />
      </Space>
      <div>
        <Text type="secondary">
          Each account can have one override set. All configured changes share
          the same status, reason, and expiration.
        </Text>
      </div>
      <div style={{ marginTop: "8px" }}>
        {loading ? (
          <Spin />
        ) : (
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            {error && (
              <ErrorDisplay error={error} onClose={() => setError("")} />
            )}
            {override ? (
              <Alert
                type={override.enabled ? "info" : "warning"}
                showIcon
                title={
                  override.enabled
                    ? "An admin override is active for this account."
                    : "An admin override exists but is disabled."
                }
                description={
                  <Descriptions size="small" column={1}>
                    <Descriptions.Item label="Effects">
                      {describeOverride(override).length > 0 ? (
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {describeOverride(override).map((effect) => (
                            <li key={effect}>{effect}</li>
                          ))}
                        </ul>
                      ) : (
                        "No entitlement changes configured."
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item label="Updated">
                      <TimeAgo date={override.updated_at} />
                    </Descriptions.Item>
                    {override.expires_at ? (
                      <Descriptions.Item label="Expires">
                        <TimeAgo date={override.expires_at} />
                      </Descriptions.Item>
                    ) : null}
                  </Descriptions>
                }
              />
            ) : (
              <Text type="secondary">No account-specific override.</Text>
            )}
            <Form
              form={form}
              layout="vertical"
              initialValues={{
                enabled: true,
                create_hosts: "inherit",
              }}
            >
              <Form.Item label="Override status" name="enabled">
                <Select
                  options={[
                    { value: true, label: "Enabled" },
                    { value: false, label: "Disabled" },
                  ]}
                />
              </Form.Item>
              <Form.Item label="Expires" name="expires_at">
                <DatePicker style={{ width: "100%" }} placeholder="Never" />
              </Form.Item>
              <Form.Item
                label="Reason"
                name="reason"
                rules={[{ required: true, message: "Reason is required." }]}
              >
                <Input.TextArea
                  rows={2}
                  placeholder="Support ticket, customer request, abuse mitigation, or operational reason"
                />
              </Form.Item>

              <Divider style={{ margin: "12px 0" }} />
              <Collapse size="small" defaultActiveKey={["projects"]}>
                <Collapse.Panel header="Projects" key="projects">
                  <NumericFieldGroup
                    details={details}
                    form={form}
                    fields={NUMERIC_FIELDS.filter((field) =>
                      PROJECT_FIELD_IDS.has(field.id),
                    )}
                  />
                </Collapse.Panel>
                <Collapse.Panel header="Storage and egress" key="egress">
                  <Space
                    direction="vertical"
                    size="small"
                    style={{ width: "100%" }}
                  >
                    <OverrideGridHeader />
                    {NUMERIC_FIELDS.filter((field) =>
                      STORAGE_EGRESS_FIELD_IDS.has(field.id),
                    ).map((field) => (
                      <NumericRuleEditor
                        key={field.id}
                        details={details}
                        field={field}
                        form={form}
                      />
                    ))}
                  </Space>
                </Collapse.Panel>
                <Collapse.Panel header="AI" key="ai">
                  <NumericFieldGroup
                    details={details}
                    form={form}
                    fields={NUMERIC_FIELDS.filter((field) =>
                      AI_FIELD_IDS.has(field.id),
                    )}
                  />
                </Collapse.Panel>
                <Collapse.Panel header="Notification email" key="email">
                  <NumericFieldGroup
                    details={details}
                    form={form}
                    fields={NUMERIC_FIELDS.filter((field) =>
                      NOTIFICATION_EMAIL_FIELD_IDS.has(field.id),
                    )}
                  />
                </Collapse.Panel>
                <Collapse.Panel header="Dedicated hosts" key="hosts">
                  <Space
                    direction="vertical"
                    size="small"
                    style={{ width: "100%" }}
                  >
                    <OverrideGridHeader />
                    <SelectOverrideEditor
                      label="Dedicated host creation"
                      description="Allows or blocks creating billable dedicated hosts for this account. Starting or creating hosts still also requires billing admission checks."
                      current={
                        details?.selected.entitlements.features?.create_hosts
                      }
                      name="create_hosts"
                      options={[
                        { value: "inherit", label: "No override" },
                        { value: "true", label: "Allow" },
                        { value: "false", label: "Block" },
                      ]}
                    />
                    {NUMERIC_FIELDS.filter((field) =>
                      SPEND_FIELD_IDS.has(field.id),
                    ).map((field) => (
                      <NumericRuleEditor
                        key={field.id}
                        details={details}
                        field={field}
                        form={form}
                      />
                    ))}
                  </Space>
                </Collapse.Panel>
              </Collapse>
            </Form>
            <Space>
              <Button type="primary" onClick={save} loading={saving}>
                Save override
              </Button>
              <Button
                onClick={() => {
                  resetFormFields(form, undefined);
                  setError("");
                }}
              >
                Reset form
              </Button>
              <Button onClick={clear} loading={clearing} danger>
                Clear active override
              </Button>
            </Space>
          </Space>
        )}
      </div>
    </div>
  );
}
