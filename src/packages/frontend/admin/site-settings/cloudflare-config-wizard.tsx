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
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import CloudflareBootstrap from "./cloudflare-bootstrap";
import { handleErrorMessage } from "@cocalc/conat/util";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import type {
  R2CredentialsTestResult,
  VisitorLocationHeaderTestResult,
} from "@cocalc/conat/hub/api/system";
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
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const [savedData, setSavedData] = useState<Record<string, string>>(data);
  const [savedIsSet, setSavedIsSet] = useState<Record<string, boolean>>(isSet);
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
  const [applyError, setApplyError] = useState("");
  const [applying, setApplying] = useState(false);
  const [setupPath, setSetupPath] = useState("bootstrap");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [bootstrapping, setBootstrapping] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [tunnelApplying, setTunnelApplying] = useState(false);
  const [tunnelStatus, setTunnelStatus] = useState<{
    running: boolean;
    message: string;
  }>();
  const operationBusy =
    applying || bootstrapping || provisioning || tunnelApplying;
  const [blobResult, setBlobResult] = useState<{
    ok: boolean;
    bucket?: string;
    worker?: string;
    public_url?: string;
    message?: string;
  }>();

  useEffect(() => {
    if (!open) {
      setBootstrapToken("");
      setSetupPath("bootstrap");
      setBootstrapping(false);
      setBlobResult(undefined);
      setTunnelStatus(undefined);
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
      setApplyError("");
      setApplying(false);
      return;
    }
    setAccountId(trimOrEmpty(data.project_hosts_cloudflare_tunnel_account_id));
    setSavedData(data);
    setSavedIsSet(isSet);
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
  }, [open, data, isSet]);

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
  const defaultHostSuffix = `-${normalizedDomain(externalDomain) || "<external domain name>"}`;
  const hasPendingRuntimeDraft = hasPendingCloudflareRuntimeDraft({
    data: savedData,
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
        normalizedDraftValue(savedData.r2_access_key_id) !==
          normalizedDraftValue(r2AccessKey) ||
        !!normalizedDraftValue(r2SecretKey) ||
        normalizedDraftValue(savedData.r2_bucket_prefix) !==
          normalizedDraftValue(r2BucketPrefix)));
  const buttonDisabledReason = hasUnsavedDraft
    ? undefined
    : "No unapplied changes.";

  function missingLabel(): string | null {
    if (mode !== "self") return null;
    if (!externalDomain) return "External Domain Name";
    if (!accountId) return "Cloudflare Account ID";
    if (invalidAccountId) return "Valid Cloudflare Account ID";
    if (!apiToken && !savedIsSet.project_hosts_cloudflare_tunnel_api_token)
      return "Cloudflare API Token";
    if (!r2ApiToken && !savedIsSet.r2_api_token) return "R2 API Token";
    if (!r2AccessKey) return "R2 Access Key ID";
    if (!r2SecretKey && !savedIsSet.r2_secret_access_key)
      return "R2 Secret Access Key";
    if (!r2BucketPrefix) return "R2 bucket prefix";
    return null;
  }

  const missing = missingLabel();
  const applyDisabled = !hasUnsavedDraft || (mode === "self" && !!missing);

  async function applySettings() {
    setApplying(true);
    setApplyError("");
    setNotice("");
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
      setSavedData((current) => {
        const next = { ...current, ...updates };
        next.project_hosts_cloudflare_tunnel_api_token = "";
        next.r2_api_token = "";
        next.r2_secret_access_key = "";
        return next;
      });
      setSavedIsSet((current) => ({
        ...current,
        ...(updates.project_hosts_cloudflare_tunnel_api_token != null
          ? {
              project_hosts_cloudflare_tunnel_api_token:
                updates.project_hosts_cloudflare_tunnel_api_token !== "",
            }
          : {}),
        ...(updates.r2_api_token ? { r2_api_token: true } : {}),
        ...(updates.r2_secret_access_key ? { r2_secret_access_key: true } : {}),
      }));
      setApiToken("");
      setR2ApiToken("");
      setR2SecretKey("");
      setNotice("Settings applied and saved. You can now run diagnostics.");
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setApplying(false);
    }
  }

  function requestClose() {
    if (operationBusy) return;
    setBootstrapToken("");
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

  async function provisionBlobs() {
    if (operationBusy || hasUnsavedDraft) return;
    setProvisioning(true);
    setBlobResult(undefined);
    try {
      const completed = await runFreshAuthAction(async () => {
        setBlobResult(
          handleErrorMessage(
            await webapp_client.conat_client.callHubApi({
              name: "system.reconcileCloudflareBlobs",
              args: [{ browser_id: webapp_client.browser_id }],
              timeout: 5 * 60_000,
            }),
          ),
        );
      });
      if (!completed)
        setBlobResult({
          ok: false,
          message:
            "Security verification cancelled. Retry provisioning when ready.",
        });
    } catch {
      setBlobResult({
        ok: false,
        message:
          "Provisioning did not complete. Check saved credentials and retry; the previous working configuration is kept until health checks pass.",
      });
    } finally {
      setProvisioning(false);
    }
  }

  async function applySavedTunnelSettings() {
    if (operationBusy || hasUnsavedDraft) return;
    setTunnelApplying(true);
    setTunnelStatus(undefined);
    try {
      const completed = await runFreshAuthAction(async () => {
        const result = handleErrorMessage(
          await webapp_client.conat_client.callHubApi({
            name: "system.applyCloudflareTunnelSettings",
            args: [{ browser_id: webapp_client.browser_id }],
            timeout: 5 * 60_000,
          }),
        );
        setTunnelStatus({
          running: !!result.running,
          message: result.running
            ? "Saved tunnel settings applied; the tunnel is running."
            : "Tunnel settings applied, but the tunnel is not running. Check saved configuration and retry.",
        });
      });
      if (!completed)
        setTunnelStatus({
          running: false,
          message: "Tunnel security verification cancelled. Retry when ready.",
        });
    } catch {
      setTunnelStatus({
        running: false,
        message:
          "Could not apply saved tunnel settings. Check saved configuration and retry.",
      });
    } finally {
      setTunnelApplying(false);
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
    <>
      <FreshAuthModal {...freshAuthModalProps} />
      <Modal
        open={open}
        onCancel={requestClose}
        closable={!operationBusy}
        keyboard={!operationBusy}
        modalRender={(node) => (
          <KeyboardBoundary boundary="cloudflare-config">
            {node}
          </KeyboardBoundary>
        )}
        footer={[
          <Button key="close" onClick={requestClose} disabled={operationBusy}>
            Close
          </Button>,
          <Button
            key="apply"
            type="primary"
            icon={<Icon name="save" />}
            onClick={applySettings}
            disabled={applyDisabled || operationBusy}
            loading={applying}
            title={buttonDisabledReason}
          >
            Apply Settings
          </Button>,
        ]}
        title="Cloudflare Configuration Wizard"
        width={920}
      >
        <Form component="div" disabled={operationBusy}>
          <Space vertical style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              title="Configure Cloudflare Tunnel + R2 in one pass."
              description="This wizard fills in the Cloudflare settings for Launchpad. Advanced users can edit fields manually."
            />
            <WizardStep title="Step 1 - Cloudflare mode">
              <Radio.Group
                name="cloudflare-mode"
                value={mode}
                onChange={(e) => {
                  setBootstrapToken("");
                  setMode(e.target.value);
                }}
              >
                <Space vertical>
                  <Radio value="none">No Cloudflare (self-hosted only)</Radio>
                  <Radio value="self">Use my own Cloudflare account</Radio>
                </Space>
              </Radio.Group>
            </WizardStep>
            {showSelfConfig && (
              <>
                <WizardStep title="Step 2 - External domain">
                  <Paragraph type="secondary">
                    This domain must be under a DNS zone managed by Cloudflare
                    in your account. It is used by the hub and project hosts.
                  </Paragraph>
                  <FormItem label="Domain name" htmlFor="cf-domain">
                    <Input
                      id="cf-domain"
                      placeholder="cocalc.example.edu"
                      value={externalDomain}
                      onChange={(e) => setExternalDomain(e.target.value)}
                    />
                  </FormItem>
                </WizardStep>
                <Radio.Group
                  aria-label="Cloudflare setup path"
                  name="cloudflare-setup-path"
                  value={setupPath}
                  onChange={(e) => {
                    setBootstrapToken("");
                    setSetupPath(e.target.value);
                  }}
                >
                  <Space vertical>
                    <Radio value="bootstrap">Recommended bootstrap</Radio>
                    <Radio value="manual">Advanced manual setup</Radio>
                  </Space>
                </Radio.Group>
                {setupPath === "bootstrap" && open && (
                  <CloudflareBootstrap
                    disabled={applying || provisioning || tunnelApplying}
                    runFreshAuthAction={runFreshAuthAction}
                    token={bootstrapToken}
                    setToken={setBootstrapToken}
                    domain={externalDomain}
                    tunnelPrefix={tunnelPrefix}
                    hostSuffix={hostSuffix}
                    r2BucketPrefix={r2BucketPrefix}
                    onBusy={setBootstrapping}
                    onSaved={(result) => {
                      // Only copy known non-secret settings. The server already saved
                      // the durable tokens; never pass result.values to onApply.
                      const values: Record<string, string> = {};
                      for (const key of [
                        "dns",
                        "cloudflare_mode",
                        "project_hosts_cloudflare_tunnel_enabled",
                        "project_hosts_cloudflare_tunnel_account_id",
                        "project_hosts_cloudflare_tunnel_prefix",
                        "project_hosts_cloudflare_tunnel_host_suffix",
                        "r2_account_id",
                        "r2_bucket_prefix",
                      ]) {
                        if (typeof result.values[key] === "string")
                          values[key] = result.values[key];
                      }
                      setSavedData((current) => ({ ...current, ...values }));
                      setSavedIsSet((current) => ({
                        ...current,
                        project_hosts_cloudflare_tunnel_api_token: true,
                        r2_api_token: true,
                      }));
                      setAccountId(
                        values.project_hosts_cloudflare_tunnel_account_id ??
                          result.account_id ??
                          "",
                      );
                      setExternalDomain(values.dns ?? externalDomain);
                      setTunnelPrefix(
                        values.project_hosts_cloudflare_tunnel_prefix ??
                          tunnelPrefix,
                      );
                      setHostSuffix(
                        values.project_hosts_cloudflare_tunnel_host_suffix ??
                          hostSuffix,
                      );
                      setR2BucketPrefix(
                        values.r2_bucket_prefix ?? r2BucketPrefix,
                      );
                      setApiToken("");
                      setR2ApiToken("");
                      setBlobResult(undefined);
                    }}
                  />
                )}
                {setupPath === "manual" && (
                  <>
                    <WizardStep title="Step 3 - Cloudflare account ID">
                      <Paragraph>
                        Go to{" "}
                        <Link
                          href="https://dash.cloudflare.com/"
                          target="_blank"
                          rel="noreferrer"
                        >
                          https://dash.cloudflare.com/
                        </Link>
                        .
                        <br />
                        Use the left sidebar Quick search to find "account id".
                        <br />
                        Click the result to copy it and paste into the box
                        below.
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
                        htmlFor="cf-account"
                      >
                        <Input
                          id="cf-account"
                          placeholder="Cloudflare Account ID"
                          value={accountId}
                          onChange={(e) => setAccountId(e.target.value)}
                        />
                      </FormItem>
                    </WizardStep>
                    <WizardStep title="Step 4 - Cloudflare API token">
                      <Paragraph>
                        Go to{" "}
                        <Link
                          href="https://dash.cloudflare.com/profile/api-tokens"
                          target="_blank"
                          rel="noreferrer"
                        >
                          https://dash.cloudflare.com/profile/api-tokens
                        </Link>
                        .
                        <br />
                        Create a custom durable token with the permissions
                        below, or switch to Recommended bootstrap to let CoCalc
                        configure them automatically.
                      </Paragraph>
                      <ul>
                        <li>
                          Scope account permissions to your selected account:
                          Cloudflare Tunnel Edit, Workers Scripts Edit, and
                          Workers R2 Storage Edit.
                        </li>
                        <li>
                          Scope zone permissions to your site's zone: Zone Read,
                          DNS Edit, Workers Routes Edit, Config Rules Edit, and
                          Managed Headers Edit.
                        </li>
                        <li>
                          Do not grant API-token-management permission to this
                          durable token. Paste it below; this token will be
                          saved, unlike the temporary bootstrap token.
                        </li>
                      </ul>
                      <FormItem label="Cloudflare API Token" htmlFor="cf-token">
                        <SecretSettingInput
                          id="cf-token"
                          placeholder="Cloudflare API Token"
                          value={apiToken}
                          isSet={
                            isSet?.project_hosts_cloudflare_tunnel_api_token
                          }
                          onChange={setApiToken}
                        />
                      </FormItem>
                    </WizardStep>
                    <WizardStep title="Step 5 - Visitor Location Headers">
                      <Paragraph type="secondary">
                        CoCalc can pick good default regions for users and sort
                        host regions by distance.
                      </Paragraph>
                      <Paragraph>
                        Go to{" "}
                        <Link
                          href={managedTransformsUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {managedTransformsUrl}
                        </Link>
                        .
                        <br />
                        If the link above does not work, search in Cloudflare
                        for Managed Transforms and select your domain.
                        <br />
                        Enable: <Text strong>Add visitor location headers</Text>
                        .
                      </Paragraph>
                    </WizardStep>
                  </>
                )}
                <WizardStep title="Step 6 - R2 backups">
                  <Paragraph type="secondary">
                    R2 S3 object credentials are separate from the Cloudflare
                    REST automation token. Bootstrap saves the REST token, not
                    these access keys. Create S3 credentials for object reads
                    and writes in the required backup and blob buckets, then
                    apply them here.
                  </Paragraph>
                  <Paragraph>
                    Go to{" "}
                    <Link href={r2TokenUrl} target="_blank" rel="noreferrer">
                      {r2TokenUrl}
                    </Link>
                    .
                    <br />
                    Choose the narrowest object read/write scope covering the
                    required buckets.
                    <br />
                    Once the token is created, fill in the fields below.
                  </Paragraph>
                  {setupPath === "manual" && (
                    <FormItem label="R2 API Token" htmlFor="cf-r2-token">
                      <SecretSettingInput
                        id="cf-r2-token"
                        placeholder="R2 API Token"
                        value={r2ApiToken}
                        isSet={savedIsSet.r2_api_token}
                        onChange={setR2ApiToken}
                      />
                    </FormItem>
                  )}
                  <FormItem label="R2 Access Key ID" htmlFor="cf-access">
                    <Input
                      id="cf-access"
                      placeholder="R2 Access Key ID"
                      value={r2AccessKey}
                      onChange={(e) => setR2AccessKey(e.target.value)}
                    />
                  </FormItem>
                  <FormItem label="R2 Secret Access Key" htmlFor="cf-secret">
                    <SecretSettingInput
                      id="cf-secret"
                      placeholder="R2 Secret Access Key"
                      value={r2SecretKey}
                      isSet={isSet?.r2_secret_access_key}
                      onChange={setR2SecretKey}
                    />
                  </FormItem>
                </WizardStep>
                <WizardStep title="Step 7 - Resource names">
                  <Paragraph type="secondary">
                    These names are used for Cloudflare and backup resources
                    created by CoCalc. The defaults are suitable for one CoCalc
                    site in this Cloudflare account.
                  </Paragraph>
                  <FormItem label="R2 bucket prefix" htmlFor="cf-bucket-prefix">
                    <Input
                      id="cf-bucket-prefix"
                      placeholder={DEFAULT_CLOUDFLARE_PREFIX}
                      value={r2BucketPrefix}
                      onChange={(e) => setR2BucketPrefix(e.target.value)}
                    />
                  </FormItem>
                  <FormItem
                    label="Tunnel name prefix"
                    htmlFor="cf-tunnel-prefix"
                  >
                    <Input
                      id="cf-tunnel-prefix"
                      placeholder={DEFAULT_CLOUDFLARE_PREFIX}
                      value={tunnelPrefix}
                      onChange={(e) => setTunnelPrefix(e.target.value)}
                    />
                  </FormItem>
                  <FormItem
                    label="Project-host hostname suffix"
                    htmlFor="cf-suffix"
                  >
                    <Input
                      id="cf-suffix"
                      placeholder={`Leave blank for default ${defaultHostSuffix}`}
                      value={hostSuffix}
                      onChange={(e) => setHostSuffix(e.target.value)}
                    />
                  </FormItem>
                </WizardStep>
                <WizardStep title="Step 8 - Diagnostics">
                  <Paragraph>
                    Create or update the tunnel and restart cloudflared using
                    saved settings, without restarting the hub.
                  </Paragraph>
                  <Button
                    onClick={applySavedTunnelSettings}
                    loading={tunnelApplying}
                    disabled={
                      hasUnsavedDraft ||
                      operationBusy ||
                      !savedIsSet.project_hosts_cloudflare_tunnel_api_token
                    }
                  >
                    Apply saved tunnel settings
                  </Button>
                  <div role="status" aria-live="polite">
                    {tunnelApplying && (
                      <Paragraph>Applying saved tunnel settings...</Paragraph>
                    )}
                    {tunnelStatus && (
                      <Alert
                        type={tunnelStatus.running ? "success" : "warning"}
                        title={tunnelStatus.message}
                      />
                    )}
                  </div>
                  <Paragraph>
                    Blob provisioning uses saved credentials and is safe to
                    retry. It creates a private bucket and public-read Worker,
                    and activates blob serving only after health checks pass.
                    Apply any S3 credential changes first.
                  </Paragraph>
                  <Button
                    onClick={provisionBlobs}
                    loading={provisioning}
                    disabled={hasUnsavedDraft || !!missing || operationBusy}
                  >
                    Provision or retry blob storage
                  </Button>
                  <div role="status" aria-live="polite">
                    {provisioning && (
                      <Paragraph>
                        Provisioning blob storage and checking health...
                      </Paragraph>
                    )}
                    {blobResult && (
                      <Alert
                        type={blobResult.ok ? "success" : "warning"}
                        title={
                          blobResult.ok
                            ? "Blob storage is healthy and active"
                            : "Blob storage needs attention; retry after correcting settings"
                        }
                        description={
                          <>
                            <Paragraph>{blobResult.message}</Paragraph>
                            <Descriptions column={1} size="small">
                              {codeItem("Bucket", blobResult.bucket)}
                              {codeItem("Worker", blobResult.worker)}
                              {codeItem("Public URL", blobResult.public_url)}
                            </Descriptions>
                          </>
                        }
                      />
                    )}
                  </div>
                  <Alert
                    type={hasUnsavedDraft ? "warning" : "info"}
                    showIcon
                    title={
                      hasUnsavedDraft
                        ? "Apply settings before testing."
                        : "Settings saved. Test visitor location headers and R2 backup credentials."
                    }
                  />
                  <Space vertical style={{ width: "100%" }}>
                    <Space vertical style={{ width: "100%" }}>
                      <Button
                        onClick={testVisitorLocationHeaders}
                        loading={locationHeadersTesting}
                        disabled={hasUnsavedDraft}
                      >
                        Test Visitor Location Headers
                      </Button>
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
                          type={
                            locationHeadersResult.ok ? "success" : "warning"
                          }
                          showIcon
                          title={
                            locationHeadersResult.ok
                              ? "Public domain location headers are present"
                              : "Location headers are incomplete"
                          }
                          description={
                            <Descriptions size="small" column={1}>
                              {codeItem(
                                "Tested URL",
                                locationHeadersResult.url,
                              )}
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
                    <Space vertical style={{ width: "100%" }}>
                      <Button
                        onClick={testSavedR2Credentials}
                        loading={r2Testing}
                        disabled={hasUnsavedDraft}
                      >
                        Test R2 Backup Credentials
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
            {applyError ? (
              <Alert
                type="error"
                showIcon
                title="Cloudflare settings were not saved"
                description={applyError}
              />
            ) : null}
          </Space>
        </Form>
      </Modal>
    </>
  );
}
