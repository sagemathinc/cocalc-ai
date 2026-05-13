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
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
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

const providerKinds: ProviderKind[] = ["saml", "google_oidc", "oidc"];
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

const SAML_CONFIG_FIELDS = new Set([
  "entryPoint",
  "idpCert",
  "idpIssuer",
  "issuer",
  "audience",
  "identifierFormat",
  "allowed_domains",
  "exclusive_domains",
  "account_creation",
  "update_on_login",
  "do_not_hide",
  "wantAssertionsSigned",
  "wantAuthnResponseSigned",
  "icon",
  "description",
]);

function omitKnownSamlConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!SAML_CONFIG_FIELDS.has(key)) {
      extra[key] = value;
    }
  }
  return extra;
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(normalizeList);
  }
  return `${value ?? ""}`
    .split(",")
    .map((x) => x.trim().toLowerCase().replace(/^@+/, ""))
    .filter(Boolean);
}

function listToText(value: unknown): string {
  return normalizeList(value).join(", ");
}

function normalizeCertificate(value: unknown): string | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) return undefined;
  if (/-----BEGIN CERTIFICATE-----/.test(text)) {
    return text;
  }
  const body = text.replace(/\s+/g, "");
  if (!body) return undefined;
  const lines = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;
}

function parseSamlMetadata(xml: unknown): {
  idpIssuer?: string;
  entryPoint?: string;
  idpCert?: string;
} {
  const text = `${xml ?? ""}`.trim();
  if (!text) return {};
  const idpIssuer = text
    .match(/\bentityID\s*=\s*["']([^"']+)["']/i)?.[1]
    ?.trim();
  const ssoServices = [
    ...text.matchAll(/<[^>]*SingleSignOnService[^>]*>/gi),
  ].map((match) => match[0]);
  const preferredService =
    ssoServices.find((service) => /HTTP-Redirect/i.test(service)) ??
    ssoServices.find((service) => /HTTP-POST/i.test(service)) ??
    ssoServices[0];
  const entryPoint = preferredService
    ?.match(/\bLocation\s*=\s*["']([^"']+)["']/i)?.[1]
    ?.trim();
  const certBody = text
    .match(
      /<[^>]*X509Certificate[^>]*>([\s\S]*?)<\/[^>]*X509Certificate>/i,
    )?.[1]
    ?.trim();
  return {
    idpIssuer,
    entryPoint,
    idpCert: normalizeCertificate(certBody),
  };
}

function authUrl(providerID: unknown, suffix: string): string {
  const provider = normalizeSlug(`${providerID ?? ""}`);
  if (!provider) return "";
  const base = appBasePath.length > 1 ? appBasePath : "";
  const path = `${base}/auth/${provider}${suffix}`;
  return typeof window === "undefined"
    ? path
    : `${window.location.origin}${path}`;
}

function buildSamlConfig(raw: any): Record<string, unknown> {
  const metadata = parseSamlMetadata(raw.metadata_xml);
  const entryPoint = `${raw.entryPoint ?? metadata.entryPoint ?? ""}`.trim();
  const idpCert = normalizeCertificate(raw.idpCert ?? metadata.idpCert);
  const advancedConfig = parseConfig(raw.advanced_config);
  if (
    advancedConfig.privateKey != null ||
    advancedConfig.decryptionPvk != null
  ) {
    throw new Error(
      "SAML provider config must not contain privateKey or decryptionPvk.",
    );
  }
  if (!entryPoint) {
    throw new Error("SAML SSO URL is required.");
  }
  if (!idpCert) {
    throw new Error("SAML IdP certificate is required.");
  }

  const config: Record<string, unknown> = {
    ...advancedConfig,
    entryPoint,
    idpCert,
    idpIssuer:
      `${raw.idpIssuer ?? metadata.idpIssuer ?? ""}`.trim() || undefined,
    issuer: `${raw.issuer ?? ""}`.trim() || undefined,
    audience: `${raw.audience ?? ""}`.trim() || undefined,
    identifierFormat: `${raw.identifierFormat ?? ""}`.trim() || undefined,
    allowed_domains: normalizeList(raw.allowed_domains),
    exclusive_domains: normalizeList(raw.exclusive_domains),
    account_creation: raw.account_creation ?? "registration_token_required",
    update_on_login: raw.update_on_login === true,
    do_not_hide: raw.do_not_hide === true,
    wantAssertionsSigned: raw.wantAssertionsSigned !== false,
    wantAuthnResponseSigned: raw.wantAuthnResponseSigned === true,
    icon: `${raw.icon ?? ""}`.trim() || undefined,
    description: `${raw.description ?? ""}`.trim() || undefined,
  };
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (
      value == null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      delete config[key];
    }
  }
  return config;
}

function providerFormValues(provider: SsoProvider): Record<string, unknown> {
  const config = provider.config ?? {};
  const common = {
    ...provider,
    advanced_config: stringifyConfig(config),
  };
  if (provider.kind !== "saml") {
    return common;
  }
  return {
    ...common,
    entryPoint: config.entryPoint,
    idpCert: config.idpCert ?? config.cert,
    idpIssuer: config.idpIssuer,
    issuer: config.issuer,
    audience: config.audience === false ? "" : config.audience,
    identifierFormat: config.identifierFormat,
    allowed_domains: listToText(config.allowed_domains),
    exclusive_domains: listToText(config.exclusive_domains),
    account_creation: config.account_creation ?? "registration_token_required",
    update_on_login: config.update_on_login === true,
    do_not_hide: config.do_not_hide === true,
    wantAssertionsSigned: config.wantAssertionsSigned !== false,
    wantAuthnResponseSigned: config.wantAuthnResponseSigned === true,
    icon: config.icon,
    description: config.description,
    metadata_xml: "",
    advanced_config: stringifyConfig(omitKnownSamlConfig(config)),
  };
}

function GenericProviderFields() {
  return (
    <Form.Item
      label="Advanced provider config JSON"
      name="advanced_config"
      extra="Only use this for future/non-SAML provider kinds. Google client ID and secret are configured in Site Settings."
    >
      <Input.TextArea rows={4} style={{ maxWidth: 720 }} />
    </Form.Item>
  );
}

function SsoUrlHelp({ providerID }: { providerID: unknown }) {
  const metadataUrl = authUrl(providerID, "/metadata");
  const returnUrl = authUrl(providerID, "/return");
  if (!metadataUrl) {
    return (
      <Typography.Text type="secondary">
        Enter a provider ID to see the SP metadata and ACS URLs.
      </Typography.Text>
    );
  }
  return (
    <Space direction="vertical" size={2}>
      <Typography.Text>
        SP metadata URL:{" "}
        <Typography.Text code copyable={{ text: metadataUrl }}>
          {metadataUrl}
        </Typography.Text>
      </Typography.Text>
      <Typography.Text>
        ACS / callback URL:{" "}
        <Typography.Text code copyable={{ text: returnUrl }}>
          {returnUrl}
        </Typography.Text>
      </Typography.Text>
    </Space>
  );
}

function SamlProviderFields() {
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="SAML provider setup"
        description={
          <>
            Configure the IdP with the metadata/ACS URLs below. Paste IdP
            metadata XML to auto-fill the IdP entity ID, SSO URL, and
            certificate, or enter those fields manually. Private keys are not
            accepted in this table.
          </>
        }
      />
      <Form.Item shouldUpdate noStyle>
        {({ getFieldValue }) => (
          <SsoUrlHelp providerID={getFieldValue("provider_id")} />
        )}
      </Form.Item>
      <Space wrap align="start">
        <Form.Item
          label="IdP metadata XML"
          name="metadata_xml"
          extra="Optional. Used only to fill fields on save; the raw XML is not stored."
        >
          <Input.TextArea rows={6} style={{ width: 520 }} />
        </Form.Item>
        <Form.Item
          label="SAML SSO URL"
          name="entryPoint"
          extra="IdP SingleSignOnService Location."
        >
          <Input
            placeholder="https://idp.example.edu/sso"
            style={{ width: 420 }}
          />
        </Form.Item>
        <Form.Item
          label="IdP certificate"
          name="idpCert"
          extra="Paste the IdP signing certificate. PEM or bare base64 is accepted."
        >
          <Input.TextArea rows={6} style={{ width: 520 }} />
        </Form.Item>
        <Form.Item
          label="IdP entity ID"
          name="idpIssuer"
          extra="Optional but recommended if present in IdP metadata."
        >
          <Input
            placeholder="https://idp.example.edu/metadata"
            style={{ width: 420 }}
          />
        </Form.Item>
        <Form.Item
          label="SP entity ID override"
          name="issuer"
          extra="Optional. Defaults to the CoCalc metadata URL above."
        >
          <Input style={{ width: 420 }} />
        </Form.Item>
        <Form.Item
          label="Audience override"
          name="audience"
          extra="Optional. Defaults to the SP entity ID."
        >
          <Input style={{ width: 420 }} />
        </Form.Item>
        <Form.Item
          label="NameID format"
          name="identifierFormat"
          extra="Optional. Defaults to persistent NameID."
        >
          <Input style={{ width: 420 }} />
        </Form.Item>
        <Form.Item
          label="Allowed email domains"
          name="allowed_domains"
          extra="Comma-separated domains this IdP may authenticate."
        >
          <Input
            placeholder="example.edu, department.example.edu"
            style={{ width: 360 }}
          />
        </Form.Item>
        <Form.Item
          label="Required SSO domains"
          name="exclusive_domains"
          extra="Usually prefer Domain Policies below; this is provider-local fallback metadata."
        >
          <Input placeholder="example.edu" style={{ width: 360 }} />
        </Form.Item>
        <Form.Item label="Account creation" name="account_creation">
          <Select
            style={{ width: 260 }}
            options={signupModes
              .filter((value) => value !== "inherit")
              .map((value) => ({ value, label: value }))}
          />
        </Form.Item>
        <Form.Item label="Icon URL" name="icon">
          <Input style={{ width: 360 }} />
        </Form.Item>
        <Form.Item label="Description" name="description">
          <Input.TextArea rows={3} style={{ width: 420 }} />
        </Form.Item>
        <Form.Item
          label="Update profile on login"
          name="update_on_login"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label="Show when non-public"
          name="do_not_hide"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label="Require signed assertions"
          name="wantAssertionsSigned"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label="Require signed response"
          name="wantAuthnResponseSigned"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
      </Space>
      <Form.Item
        label="Advanced SAML config JSON"
        name="advanced_config"
        extra="Optional node-saml options not covered above. Do not put private keys or decrypted secrets here."
      >
        <Input.TextArea rows={4} style={{ maxWidth: 720 }} />
      </Form.Item>
    </Space>
  );
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
      if (!provider_id) {
        throw new Error("Provider ID is required.");
      }
      const payload: SsoProvider = {
        provider_id,
        kind: raw.kind,
        display: raw.display?.trim() || provider_id,
        enabled: raw.enabled !== false,
        public: raw.public === true,
        config:
          raw.kind === "saml"
            ? buildSamlConfig(raw)
            : parseConfig(raw.advanced_config),
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
    providerForm.setFieldsValue(providerFormValues(provider));
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
          kind: "saml",
          enabled: true,
          public: false,
          account_creation: "registration_token_required",
          update_on_login: false,
          do_not_hide: false,
          wantAssertionsSigned: true,
          wantAuthnResponseSigned: false,
          advanced_config: "{}",
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
          <Form.Item label="Notes" name="notes">
            <Input.TextArea rows={3} style={{ width: 280 }} />
          </Form.Item>
          <Form.Item label=" ">
            <Button type="primary" htmlType="submit" loading={saving}>
              Save provider
            </Button>
          </Form.Item>
        </Space>
        <Form.Item shouldUpdate noStyle>
          {({ getFieldValue }) =>
            getFieldValue("kind") === "saml" ? (
              <SamlProviderFields />
            ) : (
              <GenericProviderFields />
            )
          }
        </Form.Item>
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
