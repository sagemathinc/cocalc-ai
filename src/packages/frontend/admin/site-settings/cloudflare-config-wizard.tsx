/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Radio,
  Space,
  Typography,
} from "antd";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  R2CredentialsTestResult,
  VisitorLocationHeaderTestResult,
} from "@cocalc/conat/hub/api/system";
import cloudflareApiTokenImg from "./assets/cloudflare-api-token.png";
import cloudflareManagedTransformImg from "./assets/cloudflare-managed-transform-location-headers.png";
import SecretSettingInput from "./secret-setting-input";

const DEFAULT_CLOUDFLARE_PREFIX = "cocalc";

const { Item } = Descriptions;
const { Item: FormItem } = Form;
const { Link, Paragraph, Text, Title } = Typography;

interface WizardProps {
  open: boolean;
  onClose: () => void;
  data: Record<string, string>;
  isSet: Record<string, boolean>;
  onApply: (values: Record<string, string>) => Promise<void> | void;
}

function trimOrEmpty(val: string | undefined): string {
  return (val ?? "").trim();
}

function normalizedDomain(val: string | undefined): string {
  return trimOrEmpty(val).toLowerCase().replace(/\.+$/, "");
}

function normalizedDraftValue(val: string | undefined): string {
  return trimOrEmpty(val);
}

function savedCloudflareMode(data: Record<string, string>): string {
  const rawMode = trimOrEmpty(data.cloudflare_mode).toLowerCase();
  if (rawMode === "self" || rawMode === "none") return rawMode;
  if (rawMode === "managed") return "self";
  return trimOrEmpty(data.project_hosts_cloudflare_tunnel_enabled) !== "no"
    ? "self"
    : "none";
}

function hasPendingCloudflareRuntimeDraft(args: {
  data: Record<string, string>;
  mode: string;
  externalDomain: string;
  accountId: string;
  apiToken: string;
  tunnelPrefix: string;
  hostSuffix: string;
}): boolean {
  const savedMode = savedCloudflareMode(args.data);
  if (savedMode !== trimOrEmpty(args.mode).toLowerCase()) return true;
  if (
    normalizedDomain(args.data.dns) !== normalizedDomain(args.externalDomain)
  ) {
    return true;
  }
  if (
    normalizedDraftValue(
      args.data.project_hosts_cloudflare_tunnel_account_id,
    ) !== normalizedDraftValue(args.accountId)
  ) {
    return true;
  }
  if (normalizedDraftValue(args.apiToken)) {
    return true;
  }
  const savedPrefix =
    normalizedDraftValue(args.data.project_hosts_cloudflare_tunnel_prefix) ||
    DEFAULT_CLOUDFLARE_PREFIX;
  const draftPrefix =
    normalizedDraftValue(args.tunnelPrefix) || DEFAULT_CLOUDFLARE_PREFIX;
  if (savedPrefix !== draftPrefix) return true;
  if (
    normalizedDraftValue(
      args.data.project_hosts_cloudflare_tunnel_host_suffix,
    ) !== normalizedDraftValue(args.hostSuffix)
  ) {
    return true;
  }
  return false;
}

function inferCloudflareZone(domain: string | undefined): string {
  const normalized = normalizedDomain(domain);
  if (!normalized) return "";
  const labels = normalized.split(".").filter(Boolean);
  if (labels.length <= 2) return normalized;
  const secondLevelPublicSuffixes = new Set([
    "ac",
    "co",
    "com",
    "edu",
    "gov",
    "net",
    "org",
  ]);
  const penultimate = labels[labels.length - 2];
  const last = labels[labels.length - 1];
  if (
    last.length === 2 &&
    penultimate.length <= 3 &&
    secondLevelPublicSuffixes.has(penultimate) &&
    labels.length >= 3
  ) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

function CodeValue({ value }: { value: ReactNode }) {
  return (
    <Text code>{value == null || value === "" ? "(missing)" : value}</Text>
  );
}

function codeItem(label: string, value: ReactNode) {
  return (
    <Item label={label}>
      <CodeValue value={value} />
    </Item>
  );
}

function WizardStep({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Space vertical style={{ width: "100%" }}>
      <Title level={5}>{title}</Title>
      {children}
    </Space>
  );
}

export default function CloudflareConfigWizard({
  open,
  onClose,
  data,
  isSet,
  onApply,
}: WizardProps) {
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [externalDomain, setExternalDomain] = useState("");
  const [hostSuffix, setHostSuffix] = useState("");
  const [tunnelPrefix, setTunnelPrefix] = useState(DEFAULT_CLOUDFLARE_PREFIX);
  const [mode, setMode] = useState("none");
  const [r2ApiToken, setR2ApiToken] = useState("");
  const [r2AccessKey, setR2AccessKey] = useState("");
  const [r2SecretKey, setR2SecretKey] = useState("");
  const [r2BucketPrefix, setR2BucketPrefix] = useState(
    DEFAULT_CLOUDFLARE_PREFIX,
  );
  const [r2Testing, setR2Testing] = useState(false);
  const [r2TestError, setR2TestError] = useState("");
  const [r2TestResult, setR2TestResult] =
    useState<R2CredentialsTestResult | null>(null);
  const [locationHeadersTesting, setLocationHeadersTesting] = useState(false);
  const [locationHeadersTestError, setLocationHeadersTestError] = useState("");
  const [locationHeadersResult, setLocationHeadersResult] =
    useState<VisitorLocationHeaderTestResult | null>(null);
  const [notice, setNotice] = useState("");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open) {
      setAccountId("");
      setApiToken("");
      setExternalDomain("");
      setHostSuffix("");
      setTunnelPrefix(DEFAULT_CLOUDFLARE_PREFIX);
      setMode("none");
      setR2ApiToken("");
      setR2AccessKey("");
      setR2SecretKey("");
      setR2BucketPrefix(DEFAULT_CLOUDFLARE_PREFIX);
      setR2Testing(false);
      setR2TestError("");
      setR2TestResult(null);
      setLocationHeadersTesting(false);
      setLocationHeadersTestError("");
      setLocationHeadersResult(null);
      setNotice("");
      setApplying(false);
      return;
    }
    setAccountId(trimOrEmpty(data.project_hosts_cloudflare_tunnel_account_id));
    setApiToken(trimOrEmpty(data.project_hosts_cloudflare_tunnel_api_token));
    setExternalDomain(trimOrEmpty(data.dns));
    setHostSuffix(
      trimOrEmpty(data.project_hosts_cloudflare_tunnel_host_suffix),
    );
    setTunnelPrefix(
      trimOrEmpty(data.project_hosts_cloudflare_tunnel_prefix) ||
        DEFAULT_CLOUDFLARE_PREFIX,
    );
    setMode(savedCloudflareMode(data));
    setR2ApiToken(trimOrEmpty(data.r2_api_token));
    setR2AccessKey(trimOrEmpty(data.r2_access_key_id));
    setR2SecretKey(trimOrEmpty(data.r2_secret_access_key));
    setR2BucketPrefix(
      trimOrEmpty(data.r2_bucket_prefix) || DEFAULT_CLOUDFLARE_PREFIX,
    );
    setR2Testing(false);
    setR2TestError("");
    setR2TestResult(null);
    setLocationHeadersTesting(false);
    setLocationHeadersTestError("");
    setLocationHeadersResult(null);
    setApplying(false);
  }, [open, data]);

  const showSelfConfig = mode === "self";
  const r2TokenUrl = accountId
    ? `https://dash.cloudflare.com/${accountId}/r2/api-tokens/create?type=user`
    : "https://dash.cloudflare.com/<account_id>/r2/api-tokens/create?type=user";
  const accountIdTrimmed = accountId.trim();
  const invalidAccountId =
    accountIdTrimmed.length > 0 && !/^[a-f0-9]{32}$/.test(accountIdTrimmed);
  const zoneGuess = inferCloudflareZone(externalDomain);
  const managedTransformsUrl =
    accountIdTrimmed && zoneGuess
      ? `https://dash.cloudflare.com/${accountIdTrimmed}/${zoneGuess}/rules/settings/managed-transforms`
      : "https://dash.cloudflare.com/<account_id>/<zone>/rules/settings/managed-transforms";
  const hasPendingRuntimeDraft = hasPendingCloudflareRuntimeDraft({
    data,
    mode,
    externalDomain,
    accountId,
    apiToken,
    tunnelPrefix,
    hostSuffix,
  });
  const hasUnsavedDraft =
    hasPendingRuntimeDraft ||
    (mode === "self" &&
      (!!normalizedDraftValue(r2ApiToken) ||
        normalizedDraftValue(data.r2_access_key_id) !==
          normalizedDraftValue(r2AccessKey) ||
        !!normalizedDraftValue(r2SecretKey) ||
        (normalizedDraftValue(data.r2_bucket_prefix) ||
          DEFAULT_CLOUDFLARE_PREFIX) !== normalizedDraftValue(r2BucketPrefix)));
  const buttonDisabledReason = hasUnsavedDraft
    ? undefined
    : "No unapplied changes.";

  function missingLabel(): string | null {
    if (mode !== "self") return null;
    if (!externalDomain) return "External Domain Name";
    if (!accountId) return "Cloudflare Account ID";
    if (invalidAccountId) return "Valid Cloudflare Account ID";
    if (!apiToken && !isSet?.project_hosts_cloudflare_tunnel_api_token)
      return "Cloudflare API Token";
    if (!r2ApiToken && !isSet?.r2_api_token) return "Cloudflare R2 API Token";
    if (!r2AccessKey) return "R2 Access Key ID";
    if (!r2SecretKey && !isSet?.r2_secret_access_key)
      return "R2 Secret Access Key";
    if (!r2BucketPrefix) return "R2 bucket prefix";
    return null;
  }

  const missing = missingLabel();
  const applyDisabled = !hasUnsavedDraft || (mode === "self" && !!missing);

  async function applySettings() {
    setApplying(true);
    const updates: Record<string, string> = {};
    try {
      updates.cloudflare_mode = mode;
      updates.project_hosts_cloudflare_tunnel_enabled =
        mode === "self" ? "yes" : "no";
      if (mode === "self") {
        if (accountId)
          updates.project_hosts_cloudflare_tunnel_account_id = accountId;
        if (apiToken)
          updates.project_hosts_cloudflare_tunnel_api_token = apiToken;
        if (tunnelPrefix)
          updates.project_hosts_cloudflare_tunnel_prefix = tunnelPrefix;
        if (hostSuffix)
          updates.project_hosts_cloudflare_tunnel_host_suffix = hostSuffix;
        if (externalDomain) {
          updates.dns = externalDomain;
        }
        if (accountId) updates.r2_account_id = accountId;
        if (r2ApiToken) updates.r2_api_token = r2ApiToken;
        if (r2AccessKey) updates.r2_access_key_id = r2AccessKey;
        if (r2SecretKey) updates.r2_secret_access_key = r2SecretKey;
        if (r2BucketPrefix) updates.r2_bucket_prefix = r2BucketPrefix;
      } else {
        updates.project_hosts_cloudflare_tunnel_api_token = "";
      }
      await onApply(updates);
      setNotice("Settings applied and saved. You can now run diagnostics.");
    } finally {
      setApplying(false);
    }
  }

  function requestClose() {
    if (!hasUnsavedDraft) {
      onClose();
      return;
    }
    Modal.confirm({
      title: "Discard unsaved Cloudflare settings?",
      content:
        "Closing this wizard will discard unsaved values, including tokens that cannot be shown again after you leave the page.",
      okText: "Discard changes",
      cancelText: "Keep editing",
      okButtonProps: { danger: true },
      onOk: onClose,
    });
  }

  async function testSavedR2Credentials() {
    setR2Testing(true);
    setR2TestError("");
    setR2TestResult(null);
    try {
      const result =
        await webapp_client.conat_client.hub.system.testR2Credentials({});
      setR2TestResult(result);
    } catch (err) {
      setR2TestError(`${err}`);
    } finally {
      setR2Testing(false);
    }
  }

  async function testVisitorLocationHeaders() {
    setLocationHeadersTesting(true);
    setLocationHeadersTestError("");
    setLocationHeadersResult(null);
    try {
      const result =
        await webapp_client.conat_client.hub.system.testCloudflareVisitorLocationHeaders(
          {},
        );
      setLocationHeadersResult(result);
    } catch (err) {
      setLocationHeadersTestError(`${err}`);
    } finally {
      setLocationHeadersTesting(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={requestClose}
      footer={[
        <Button key="close" onClick={requestClose} disabled={applying}>
          Close
        </Button>,
        <Button
          key="apply"
          type="primary"
          icon={<Icon name="save" />}
          onClick={applySettings}
          disabled={applyDisabled}
          loading={applying}
          title={buttonDisabledReason}
        >
          Apply Settings
        </Button>,
      ]}
      title="Cloudflare Configuration Wizard"
      width={920}
    >
      <Form layout="vertical" component={false}>
        <Space vertical style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            title="Configure Cloudflare Tunnel + R2 in one pass."
            description="This wizard fills in the Cloudflare settings for Launchpad. Advanced users can edit fields manually."
          />
          <WizardStep title="Step 1 - Choose Cloudflare mode">
            <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
              <Space vertical>
                <Radio value="none">No Cloudflare (self-hosted only)</Radio>
                <Radio value="self">Use my own Cloudflare account</Radio>
              </Space>
            </Radio.Group>
          </WizardStep>
          {showSelfConfig && (
            <>
              <WizardStep title="Step 2 - External domain">
                <FormItem
                  label="External domain"
                  extra="This domain must be under a DNS zone managed by Cloudflare in your account. It is used by the hub and project hosts."
                >
                  <Input
                    placeholder="cocalc.example.edu"
                    value={externalDomain}
                    onChange={(e) => setExternalDomain(e.target.value)}
                  />
                </FormItem>
              </WizardStep>
              <WizardStep title="Step 3 - Cloudflare account ID">
                <Paragraph type="secondary">
                  Open{" "}
                  <Link
                    href="https://dash.cloudflare.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Cloudflare
                  </Link>{" "}
                  and use the left sidebar Quick search to find "account id".
                  Click the result to copy it.
                </Paragraph>
                {invalidAccountId ? (
                  <Alert
                    type="warning"
                    showIcon
                    title="Account IDs are 32 lowercase hex characters."
                  />
                ) : null}
                <FormItem
                  label="Cloudflare Account ID"
                  extra="Paste the Account ID here."
                >
                  <Input
                    placeholder="Cloudflare Account ID"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                  />
                </FormItem>
              </WizardStep>
              <WizardStep title="Step 4 - Cloudflare API token">
                <Paragraph type="secondary">
                  Create a token at{" "}
                  <Link
                    href="https://dash.cloudflare.com/profile/api-tokens"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Cloudflare API Tokens
                  </Link>
                  , then match this configuration, except with your Cloudflare
                  zone instead of cocalc.ai.
                </Paragraph>
                <img
                  src={cloudflareApiTokenImg}
                  alt="Cloudflare API token configuration"
                  style={{ width: "100%", maxWidth: 760 }}
                />
                <FormItem label="Cloudflare API Token">
                  <SecretSettingInput
                    placeholder="Cloudflare API Token"
                    value={apiToken}
                    isSet={isSet?.project_hosts_cloudflare_tunnel_api_token}
                    onChange={setApiToken}
                  />
                </FormItem>
              </WizardStep>
              <WizardStep title="Step 5 - Enable Visitor Location Headers">
                <Paragraph type="secondary">
                  Enable this managed transform in Cloudflare so CoCalc can pick
                  good default regions for users and sort host regions by
                  distance.
                </Paragraph>
                <Paragraph>
                  Open{" "}
                  <Link
                    href={managedTransformsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {managedTransformsUrl}
                  </Link>
                  .
                </Paragraph>
                <Paragraph>
                  Enable: <Text strong>Add visitor location headers</Text>.
                </Paragraph>
                <Paragraph type="secondary">
                  If the link above does not work, search in Cloudflare for
                  Managed Transforms and select your domain.
                </Paragraph>
                <img
                  src={cloudflareManagedTransformImg}
                  alt='Cloudflare managed transform "Add visitor location headers"'
                  style={{ width: "100%", maxWidth: 900 }}
                />
              </WizardStep>
              <WizardStep title="Step 6 - R2 backups">
                <Paragraph type="secondary">
                  R2 is required for Launchpad backups. You must create a
                  separate R2 API token with full Admin Read &amp; Write access.
                </Paragraph>
                <Paragraph>
                  R2 token link uses your Account ID:{" "}
                  <Link href={r2TokenUrl} target="_blank" rel="noreferrer">
                    {r2TokenUrl}
                  </Link>
                </Paragraph>
                <Paragraph type="secondary">
                  Required R2 token permission:{" "}
                  <Text strong>Admin Read &amp; Write</Text>. Allows the ability
                  to create, list, and delete buckets, edit bucket
                  configuration, read, write, and list objects, and read and
                  write access to data catalog tables and associated metadata.
                </Paragraph>
                <FormItem
                  label="Cloudflare R2 API Token"
                  extra="Token with Admin Read & Write permissions."
                >
                  <SecretSettingInput
                    placeholder="Cloudflare R2 API Token"
                    value={r2ApiToken}
                    isSet={isSet?.r2_api_token}
                    onChange={setR2ApiToken}
                  />
                </FormItem>
                <FormItem
                  label="R2 Access Key ID"
                  extra="From the R2 API token you created."
                >
                  <Input
                    placeholder="R2 Access Key ID"
                    value={r2AccessKey}
                    onChange={(e) => setR2AccessKey(e.target.value)}
                  />
                </FormItem>
                <FormItem
                  label="R2 Secret Access Key"
                  extra="From the R2 API token you created."
                >
                  <SecretSettingInput
                    placeholder="R2 Secret Access Key"
                    value={r2SecretKey}
                    isSet={isSet?.r2_secret_access_key}
                    onChange={setR2SecretKey}
                  />
                </FormItem>
                <FormItem
                  label="R2 bucket prefix"
                  extra="Prefix for regional backup bucket names, such as cocalc-wnam. The default is fine for one CoCalc site; use a different prefix for each site in this Cloudflare account."
                >
                  <Input
                    placeholder={DEFAULT_CLOUDFLARE_PREFIX}
                    value={r2BucketPrefix}
                    onChange={(e) => setR2BucketPrefix(e.target.value)}
                  />
                </FormItem>
              </WizardStep>
              <WizardStep title="Step 7 - Tunnel settings">
                <Paragraph type="secondary">
                  These control how CoCalc names Cloudflare tunnel resources for
                  project hosts.
                </Paragraph>
                <FormItem
                  label="Tunnel name prefix"
                  extra="Prefix for tunnel names (e.g., cocalc-...)."
                >
                  <Input
                    placeholder="Tunnel name prefix (e.g., cocalc)"
                    value={tunnelPrefix}
                    onChange={(e) => setTunnelPrefix(e.target.value)}
                  />
                </FormItem>
                <FormItem
                  label="Project-host hostname suffix"
                  extra='Leave blank for the default "-<External Domain Name>".'
                >
                  <Input
                    placeholder="Project-host hostname suffix (optional, e.g., -hosts.cocalc.ai)"
                    value={hostSuffix}
                    onChange={(e) => setHostSuffix(e.target.value)}
                  />
                </FormItem>
              </WizardStep>
              <WizardStep title="Step 8 - Post-save diagnostics">
                <Alert
                  type={hasUnsavedDraft ? "warning" : "info"}
                  showIcon
                  title={
                    hasUnsavedDraft
                      ? "Apply settings before testing."
                      : "Diagnostics use saved settings."
                  }
                  description={
                    hasUnsavedDraft
                      ? "These diagnostics use saved settings and ignore unsaved fields."
                      : "R2 checks the saved backup credentials. Public domain headers checks the saved external domain through Cloudflare."
                  }
                />
                <Space vertical style={{ width: "100%" }}>
                  <Space vertical style={{ width: "100%" }}>
                    <Button
                      onClick={testSavedR2Credentials}
                      loading={r2Testing}
                      disabled={hasUnsavedDraft}
                    >
                      Test Saved R2 Credentials
                    </Button>
                    {r2TestError ? (
                      <Alert
                        type="error"
                        showIcon
                        title="R2 test failed"
                        description={r2TestError}
                      />
                    ) : null}
                    {r2TestResult ? (
                      <Alert
                        type={r2TestResult.ok ? "success" : "error"}
                        showIcon
                        title={
                          r2TestResult.ok
                            ? "R2 credentials look good"
                            : "R2 credential test found problems"
                        }
                        description={
                          <Descriptions size="small" column={1}>
                            {codeItem("Account", r2TestResult.account_id)}
                            {codeItem("Endpoint", r2TestResult.endpoint)}
                            <Item label="Cloudflare API token">
                              {r2TestResult.api_token.ok
                                ? `OK (visible buckets: ${r2TestResult.api_token.bucket_count ?? 0})`
                                : `Failed (${r2TestResult.api_token.error ?? "unknown error"})`}
                            </Item>
                            <Item label="R2 S3 keys">
                              {r2TestResult.s3.ok
                                ? `OK (visible buckets: ${r2TestResult.s3.bucket_count ?? 0})`
                                : `Failed (${r2TestResult.s3.error ?? "unknown error"})`}
                            </Item>
                            {r2TestResult.bucket_prefix
                              ? codeItem(
                                  "Bucket prefix",
                                  r2TestResult.bucket_prefix,
                                )
                              : null}
                            {r2TestResult.bucket_prefix ? (
                              <Item label="Matching buckets">
                                {r2TestResult.matched_buckets.length > 0
                                  ? r2TestResult.matched_buckets.join(", ")
                                  : "(none yet)"}
                              </Item>
                            ) : null}
                            {r2TestResult.notes?.length ? (
                              <Item label="Notes">
                                {r2TestResult.notes.join(" ")}
                              </Item>
                            ) : null}
                          </Descriptions>
                        }
                      />
                    ) : null}
                  </Space>
                  <Space vertical style={{ width: "100%" }}>
                    <Button
                      onClick={testVisitorLocationHeaders}
                      loading={locationHeadersTesting}
                      disabled={hasUnsavedDraft}
                    >
                      Test Public Domain Location Headers
                    </Button>
                    {hasPendingRuntimeDraft ? (
                      <Alert
                        type="warning"
                        showIcon
                        title="Save and apply Cloudflare tunnel settings before testing visitor headers."
                      />
                    ) : null}
                    {locationHeadersTestError ? (
                      <Alert
                        type="error"
                        showIcon
                        title="Visitor location header test failed"
                        description={locationHeadersTestError}
                      />
                    ) : null}
                    {locationHeadersResult ? (
                      <Alert
                        type={locationHeadersResult.ok ? "success" : "warning"}
                        showIcon
                        title={
                          locationHeadersResult.ok
                            ? "Public domain location headers are present"
                            : "Location headers are incomplete"
                        }
                        description={
                          <Descriptions size="small" column={1}>
                            {codeItem("Tested URL", locationHeadersResult.url)}
                            {codeItem(
                              "Country",
                              locationHeadersResult.details.country,
                            )}
                            {codeItem(
                              "Region",
                              locationHeadersResult.details.region,
                            )}
                            {codeItem(
                              "Region code",
                              locationHeadersResult.details.regionCode,
                            )}
                            {codeItem(
                              "City",
                              locationHeadersResult.details.city,
                            )}
                            {codeItem(
                              "Continent",
                              locationHeadersResult.details.continent,
                            )}
                            {codeItem(
                              "Timezone",
                              locationHeadersResult.details.timezone,
                            )}
                            {codeItem(
                              "Latitude",
                              locationHeadersResult.details.latitude,
                            )}
                            {codeItem(
                              "Longitude",
                              locationHeadersResult.details.longitude,
                            )}
                            {locationHeadersResult.missing.length > 0 ? (
                              codeItem(
                                "Missing required fields",
                                locationHeadersResult.missing.join(", "),
                              )
                            ) : (
                              <Item label="Required fields">
                                All required location fields are present.
                              </Item>
                            )}
                          </Descriptions>
                        }
                      />
                    ) : null}
                  </Space>
                </Space>
              </WizardStep>
            </>
          )}
          {applyDisabled && missing ? (
            <Alert
              type="warning"
              showIcon
              title={`Fill in required field: ${missing}`}
            />
          ) : null}
          {notice ? <Alert type="success" showIcon title={notice} /> : null}
        </Space>
      </Form>
    </Modal>
  );
}
