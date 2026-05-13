/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";

import { React } from "@cocalc/frontend/app-framework";
import { ErrorDisplay, Loading } from "@cocalc/frontend/components";
import { query } from "@cocalc/frontend/frame-editors/generic/client";
import type {
  SsoDomainPolicySetFields,
  SsoProviderSetFields,
} from "@cocalc/util/db-schema/types";

type ProviderKind = "google_oidc" | "saml" | "oidc";
type DomainMode = "password_allowed" | "sso_required" | "sso_signup_only";
type SignupMode =
  | "inherit"
  | "disabled"
  | "registration_token_required"
  | "public_allowed";

interface SsoProvider {
  provider_id: string;
  kind: ProviderKind;
  display?: string;
  enabled?: boolean;
  public?: boolean;
  config?: Record<string, unknown>;
  notes?: string;
}

interface SsoDomainPolicy {
  domain: string;
  provider_id: string;
  mode: DomainMode;
  enabled?: boolean;
  require_cocalc_2fa?: boolean;
  signup_mode?: SignupMode;
  notes?: string;
}

const providerKinds: ProviderKind[] = ["google_oidc", "saml", "oidc"];
const domainModes: DomainMode[] = [
  "sso_required",
  "sso_signup_only",
  "password_allowed",
];
const signupModes: SignupMode[] = [
  "inherit",
  "disabled",
  "registration_token_required",
  "public_allowed",
];

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "");
}

function stringifyConfig(config: unknown): string {
  return JSON.stringify(config ?? {}, null, 2);
}

function parseConfig(value: string | undefined): Record<string, unknown> {
  if (!value?.trim()) return {};
  const parsed = JSON.parse(value);
  if (parsed == null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Provider config must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function SsoAdmin() {
  const [providers, setProviders] = React.useState<SsoProvider[]>([]);
  const [policies, setPolicies] = React.useState<SsoDomainPolicy[]>([]);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [saving, setSaving] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string>("");
  const [providerForm] = Form.useForm();
  const [policyForm] = Form.useForm();

  async function load() {
    setLoading(true);
    try {
      const result = await query({
        query: {
          sso_providers: {
            provider_id: "*",
            kind: null,
            display: null,
            enabled: null,
            public: null,
            config: null,
            notes: null,
          },
          sso_domain_policies: {
            domain: "*",
            provider_id: null,
            mode: null,
            enabled: null,
            require_cocalc_2fa: null,
            signup_mode: null,
            notes: null,
          },
        },
      });
      setProviders(result.query.sso_providers ?? []);
      setPolicies(result.query.sso_domain_policies ?? []);
      setError("");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    load();
  }, []);

  async function saveProvider(raw: any) {
    setSaving(true);
    try {
      const provider_id = normalizeSlug(raw.provider_id);
      const payload: SsoProvider = {
        provider_id,
        kind: raw.kind,
        display: raw.display?.trim() || provider_id,
        enabled: raw.enabled !== false,
        public: raw.public === true,
        config: parseConfig(raw.config),
        notes: raw.notes?.trim() || undefined,
      };
      await query({
        query: {
          sso_providers: payload as Record<SsoProviderSetFields, unknown>,
        },
      });
      providerForm.resetFields();
      message.success("SSO provider saved");
      await load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveDomainPolicy(raw: any) {
    setSaving(true);
    try {
      const domain = normalizeDomain(raw.domain);
      const payload: SsoDomainPolicy = {
        domain,
        provider_id: normalizeSlug(raw.provider_id),
        mode: raw.mode,
        enabled: raw.enabled !== false,
        require_cocalc_2fa: raw.require_cocalc_2fa === true,
        signup_mode: raw.signup_mode ?? "inherit",
        notes: raw.notes?.trim() || undefined,
      };
      await query({
        query: {
          sso_domain_policies: payload as Record<
            SsoDomainPolicySetFields,
            unknown
          >,
        },
      });
      policyForm.resetFields();
      message.success("SSO domain policy saved");
      await load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function deleteRow(table: "sso_providers" | "sso_domain_policies", id) {
    setSaving(true);
    try {
      await query({
        query: { [table]: id },
        options: [{ delete: true }],
      });
      await load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  function editProvider(provider: SsoProvider) {
    providerForm.setFieldsValue({
      ...provider,
      config: stringifyConfig(provider.config),
    });
  }

  function editPolicy(policy: SsoDomainPolicy) {
    policyForm.setFieldsValue(policy);
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="SSO providers and domain policies"
        description={
          <>
            This is the first-class SSO policy layer. Google client ID/secret
            still live in Site Settings; this page defines provider metadata and
            domain rules such as requiring SSO or CoCalc-native 2FA for a
            domain.
          </>
        }
      />
      {error ? (
        <ErrorDisplay error={error} onClose={() => setError("")} />
      ) : null}
      {loading ? <Loading /> : null}

      <Typography.Title level={4}>Providers</Typography.Title>
      <Form
        layout="vertical"
        form={providerForm}
        onFinish={saveProvider}
        initialValues={{
          kind: "google_oidc",
          enabled: true,
          public: false,
          config: "{}",
        }}
      >
        <Space wrap align="start">
          <Form.Item
            label="Provider ID"
            name="provider_id"
            rules={[{ required: true }]}
          >
            <Input placeholder="google or cornell" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item label="Kind" name="kind" rules={[{ required: true }]}>
            <Select
              style={{ width: 160 }}
              options={providerKinds.map((value) => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item label="Display" name="display">
            <Input placeholder="Google" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item label="Enabled" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="Public" name="public" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="Config JSON" name="config">
            <Input.TextArea rows={3} style={{ width: 320 }} />
          </Form.Item>
          <Form.Item label="Notes" name="notes">
            <Input.TextArea rows={3} style={{ width: 280 }} />
          </Form.Item>
          <Form.Item label=" ">
            <Button type="primary" htmlType="submit" loading={saving}>
              Save provider
            </Button>
          </Form.Item>
        </Space>
      </Form>

      <Table
        size="small"
        rowKey="provider_id"
        dataSource={providers}
        pagination={false}
        columns={[
          { title: "Provider", dataIndex: "provider_id" },
          { title: "Kind", dataIndex: "kind" },
          { title: "Display", dataIndex: "display" },
          {
            title: "State",
            render: (_, row: SsoProvider) => (
              <Space>
                <Tag color={row.enabled === false ? "red" : "green"}>
                  {row.enabled === false ? "disabled" : "enabled"}
                </Tag>
                {row.public ? <Tag color="blue">public</Tag> : null}
              </Space>
            ),
          },
          { title: "Notes", dataIndex: "notes" },
          {
            title: "Actions",
            render: (_, row: SsoProvider) => (
              <Space>
                <Button size="small" onClick={() => editProvider(row)}>
                  Edit
                </Button>
                <Popconfirm
                  title={`Delete provider ${row.provider_id}?`}
                  onConfirm={() =>
                    deleteRow("sso_providers", {
                      provider_id: row.provider_id,
                    })
                  }
                >
                  <Button size="small" danger>
                    Delete
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Typography.Title level={4}>Domain Policies</Typography.Title>
      <Form
        layout="vertical"
        form={policyForm}
        onFinish={saveDomainPolicy}
        initialValues={{
          mode: "sso_required",
          enabled: true,
          require_cocalc_2fa: false,
          signup_mode: "inherit",
        }}
      >
        <Space wrap align="start">
          <Form.Item label="Domain" name="domain" rules={[{ required: true }]}>
            <Input placeholder="example.edu" style={{ width: 200 }} />
          </Form.Item>
          <Form.Item
            label="Provider ID"
            name="provider_id"
            rules={[{ required: true }]}
          >
            <Select
              showSearch
              style={{ width: 200 }}
              options={providers.map((provider) => ({
                value: provider.provider_id,
                label: provider.provider_id,
              }))}
            />
          </Form.Item>
          <Form.Item label="Mode" name="mode" rules={[{ required: true }]}>
            <Select
              style={{ width: 200 }}
              options={domainModes.map((value) => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item label="Enabled" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            label="Require CoCalc 2FA"
            name="require_cocalc_2fa"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item label="Signup Mode" name="signup_mode">
            <Select
              style={{ width: 240 }}
              options={signupModes.map((value) => ({ value, label: value }))}
            />
          </Form.Item>
          <Form.Item label="Notes" name="notes">
            <Input.TextArea rows={3} style={{ width: 300 }} />
          </Form.Item>
          <Form.Item label=" ">
            <Button type="primary" htmlType="submit" loading={saving}>
              Save policy
            </Button>
          </Form.Item>
        </Space>
      </Form>

      <Table
        size="small"
        rowKey="domain"
        dataSource={policies}
        pagination={false}
        columns={[
          { title: "Domain", dataIndex: "domain" },
          { title: "Provider", dataIndex: "provider_id" },
          { title: "Mode", dataIndex: "mode" },
          {
            title: "State",
            render: (_, row: SsoDomainPolicy) => (
              <Space>
                <Tag color={row.enabled === false ? "red" : "green"}>
                  {row.enabled === false ? "disabled" : "enabled"}
                </Tag>
                {row.require_cocalc_2fa ? (
                  <Tag color="purple">CoCalc 2FA</Tag>
                ) : null}
              </Space>
            ),
          },
          { title: "Signup", dataIndex: "signup_mode" },
          { title: "Notes", dataIndex: "notes" },
          {
            title: "Actions",
            render: (_, row: SsoDomainPolicy) => (
              <Space>
                <Button size="small" onClick={() => editPolicy(row)}>
                  Edit
                </Button>
                <Popconfirm
                  title={`Delete policy for ${row.domain}?`}
                  onConfirm={() =>
                    deleteRow("sso_domain_policies", { domain: row.domain })
                  }
                >
                  <Button size="small" danger>
                    Delete
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}
