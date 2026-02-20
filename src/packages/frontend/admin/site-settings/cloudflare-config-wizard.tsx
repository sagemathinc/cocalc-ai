/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Radio, Space } from "antd";
import { useEffect, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { R2CredentialsTestResult } from "@cocalc/conat/hub/api/system";
import cloudflareApiTokenImg from "./assets/cloudflare-api-token.png";

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
  const [tunnelPrefix, setTunnelPrefix] = useState("cocalc");
  const [mode, setMode] = useState("none");
  const [r2ApiToken, setR2ApiToken] = useState("");
  const [r2AccessKey, setR2AccessKey] = useState("");
  const [r2SecretKey, setR2SecretKey] = useState("");
  const [r2BucketPrefix, setR2BucketPrefix] = useState("");
  const [r2Testing, setR2Testing] = useState(false);
  const [r2TestError, setR2TestError] = useState("");
  const [r2TestResult, setR2TestResult] =
    useState<R2CredentialsTestResult | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!open) {
      setAccountId("");
      setApiToken("");
      setExternalDomain("");
      setHostSuffix("");
      setTunnelPrefix("cocalc");
      setMode("none");
      setR2ApiToken("");
      setR2AccessKey("");
      setR2SecretKey("");
      setR2BucketPrefix("");
      setR2Testing(false);
      setR2TestError("");
      setR2TestResult(null);
      setNotice("");
      return;
    }
    setAccountId(trimOrEmpty(data.project_hosts_cloudflare_tunnel_account_id));
    setApiToken(trimOrEmpty(data.project_hosts_cloudflare_tunnel_api_token));
    setExternalDomain(trimOrEmpty(data.dns));
    setHostSuffix(
      trimOrEmpty(data.project_hosts_cloudflare_tunnel_host_suffix),
    );
    setTunnelPrefix(
      trimOrEmpty(data.project_hosts_cloudflare_tunnel_prefix) || "cocalc",
    );
    const rawMode = trimOrEmpty(data.cloudflare_mode).toLowerCase();
    const inferredMode =
      rawMode === "self" || rawMode === "managed" || rawMode === "none"
        ? rawMode
        : trimOrEmpty(data.project_hosts_cloudflare_tunnel_enabled) !== "no"
          ? "self"
          : "none";
    setMode(inferredMode);
    setR2ApiToken(trimOrEmpty(data.r2_api_token));
    setR2AccessKey(trimOrEmpty(data.r2_access_key_id));
    setR2SecretKey(trimOrEmpty(data.r2_secret_access_key));
    setR2BucketPrefix(trimOrEmpty(data.r2_bucket_prefix));
    setR2Testing(false);
    setR2TestError("");
    setR2TestResult(null);
  }, [open, data]);

  const showSelfConfig = mode === "self";
  const r2TokenUrl = accountId
    ? `https://dash.cloudflare.com/${accountId}/r2/api-tokens/create?type=user`
    : "https://dash.cloudflare.com/<account_id>/r2/api-tokens/create?type=user";
  const accountIdTrimmed = accountId.trim();
  const invalidAccountId =
    accountIdTrimmed.length > 0 && !/^[a-f0-9]{32}$/.test(accountIdTrimmed);

  function renderSecretNote(settingName: string) {
    if (!isSet?.[settingName]) return null;
    return (
      <div
        style={{
          marginTop: "6px",
          color: "#237804",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          fontWeight: 500,
        }}
      >
        <Icon name="check" />
        Saved in the database already. Leave blank to keep the current value.
      </div>
    );
  }

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
    return null;
  }

  const missing = missingLabel();
  const applyDisabled = mode === "self" && !!missing;

  async function applySettings() {
    const updates: Record<string, string> = {};
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
      if (externalDomain) updates.dns = externalDomain;
      if (accountId) updates.r2_account_id = accountId;
      if (r2ApiToken) updates.r2_api_token = r2ApiToken;
      if (r2AccessKey) updates.r2_access_key_id = r2AccessKey;
      if (r2SecretKey) updates.r2_secret_access_key = r2SecretKey;
      if (r2BucketPrefix) updates.r2_bucket_prefix = r2BucketPrefix;
    } else {
      updates.project_hosts_cloudflare_tunnel_api_token = "";
    }
    await onApply(updates);
    setNotice("Settings applied and saved.");
    onClose();
  }

  async function testSavedR2Credentials() {
    setR2Testing(true);
    setR2TestError("");
    setR2TestResult(null);
    try {
      const result = await webapp_client.conat_client.hub.system.testR2Credentials(
        {},
      );
      setR2TestResult(result);
    } catch (err) {
      setR2TestError(`${err}`);
    } finally {
      setR2Testing(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      okText="Close"
      title="Cloudflare Configuration Wizard"
      width={920}
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="Configure Cloudflare Tunnel + R2 in one pass."
          description="This wizard fills in the Cloudflare settings for Launchpad. Advanced users can edit fields manually."
        />
        <div>
          <div style={{ marginBottom: "8px" }}>
            <strong>Step 1 - Choose Cloudflare mode</strong>
          </div>
          <Radio.Group
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            style={{ marginTop: "8px" }}
          >
            <Space orientation="vertical">
              <Radio value="none">No Cloudflare (self-hosted only)</Radio>
              <Radio value="self">Use my own Cloudflare account</Radio>
              <Radio value="managed">
                Use CoCalc-managed Cloudflare (included with membership)
              </Radio>
            </Space>
          </Radio.Group>
        </div>
        {showSelfConfig && (
          <>
            <div>
              <strong>Step 2 - External domain</strong>
              <Input
                placeholder="cocalc.example.edu"
                value={externalDomain}
                onChange={(e) => setExternalDomain(e.target.value)}
              />
              <div style={{ marginTop: "6px", color: "#666" }}>
                This domain <b>must</b> be managed by Cloudflare (a DNS zone in
                your account). It is used by the hub and project hosts.
              </div>
            </div>
            <div>
              <strong>Step 3 - Cloudflare account ID</strong>
              <div style={{ marginTop: "6px", color: "#666" }}>
                <StaticMarkdown
                  value={`Open https://dash.cloudflare.com/ and use the left sidebar **Quick search** to find "account id". Click the result to copy it.`}
                />
              </div>
              {invalidAccountId ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: "8px" }}
                  title="Account IDs are 32 lowercase hex characters."
                />
              ) : null}
              <div
                style={{
                  marginTop: "10px",
                  display: "grid",
                  gridTemplateColumns: "260px minmax(0,1fr)",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                <div>
                  <b>Cloudflare Account ID</b>
                  <div style={{ color: "#666" }}>
                    Paste the Account ID here.
                  </div>
                </div>
                <Input
                  placeholder="Cloudflare Account ID"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                />
              </div>
            </div>
            <div>
              <strong>Step 4 - Cloudflare API token</strong>
              <div style={{ marginTop: "6px", color: "#666" }}>
                <StaticMarkdown
                  value={`Create a token at https://dash.cloudflare.com/profile/api-tokens, then match this configuration, except with your domain name (instead of cocalc.ai):`}
                />
              </div>
              <img
                src={cloudflareApiTokenImg}
                alt="Cloudflare API token configuration"
                style={{
                  marginTop: "10px",
                  width: "100%",
                  maxWidth: "760px",
                  border: "1px solid #d9d9d9",
                  borderRadius: "6px",
                }}
              />
              <Input.Password
                style={{ marginTop: "8px" }}
                placeholder="Cloudflare API Token"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
              />
              {renderSecretNote("project_hosts_cloudflare_tunnel_api_token")}
            </div>
            <div>
              <strong>Step 5 - R2 backups (required)</strong>
              <div style={{ marginTop: "6px", color: "#666" }}>
                R2 is required for Launchpad backups. You must create a separate
                R2 API token with full Admin Read &amp; Write access.
              </div>
              <div style={{ marginTop: "8px" }}>
                <StaticMarkdown
                  value={`R2 token link (uses your Account ID):

- ${r2TokenUrl}

Required R2 token permissions:

- **Admin Read & Write**: Allows the ability to create, list, and delete buckets, edit bucket configuration, read, write, and list objects, and read and write access to data catalog tables and associated metadata.`}
                />
              </div>
              <div
                style={{
                  marginTop: "10px",
                  display: "grid",
                  gridTemplateColumns: "260px minmax(0,1fr)",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                <div>
                  <b>Cloudflare R2 API Token</b>
                  <div style={{ color: "#666" }}>
                    Token with Admin Read &amp; Write permissions.
                  </div>
                </div>
                <div>
                  <Input.Password
                    placeholder="Cloudflare R2 API Token"
                    value={r2ApiToken}
                    onChange={(e) => setR2ApiToken(e.target.value)}
                  />
                  {renderSecretNote("r2_api_token")}
                </div>
              </div>
              <div
                style={{
                  marginTop: "10px",
                  display: "grid",
                  gridTemplateColumns: "260px minmax(0,1fr)",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                <div>
                  <b>R2 Access Key ID</b>
                  <div style={{ color: "#666" }}>
                    From the R2 API token you created.
                  </div>
                </div>
                <Input
                  placeholder="R2 Access Key ID"
                  value={r2AccessKey}
                  onChange={(e) => setR2AccessKey(e.target.value)}
                />
              </div>
              <div
                style={{
                  marginTop: "10px",
                  display: "grid",
                  gridTemplateColumns: "260px minmax(0,1fr)",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                <div>
                  <b>R2 Secret Access Key</b>
                  <div style={{ color: "#666" }}>
                    From the R2 API token you created.
                  </div>
                </div>
                <div>
                  <Input.Password
                    placeholder="R2 Secret Access Key"
                    value={r2SecretKey}
                    onChange={(e) => setR2SecretKey(e.target.value)}
                  />
                  {renderSecretNote("r2_secret_access_key")}
                </div>
              </div>
              <div
                style={{
                  marginTop: "10px",
                  display: "grid",
                  gridTemplateColumns: "260px minmax(0,1fr)",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                <div>
                  <b>R2 bucket prefix (optional)</b>
                  <div style={{ color: "#666" }}>
                    Optional. Leave blank unless you want to namespace buckets.
                  </div>
                </div>
                <Input
                  placeholder="R2 bucket prefix (optional)"
                  value={r2BucketPrefix}
                  onChange={(e) => setR2BucketPrefix(e.target.value)}
                />
              </div>
              <div style={{ marginTop: "12px" }}>
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Button
                    onClick={testSavedR2Credentials}
                    loading={r2Testing}
                    icon={<Icon name="check" />}
                  >
                    Test Saved R2 Credentials
                  </Button>
                  <div style={{ color: "#666" }}>
                    Uses currently saved server settings (not unsaved edits in
                    this wizard).
                  </div>
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
                        <div style={{ display: "grid", rowGap: "4px" }}>
                          <div>
                            <b>Account:</b>{" "}
                            <code>{r2TestResult.account_id || "(missing)"}</code>
                          </div>
                          <div>
                            <b>Endpoint:</b>{" "}
                            <code>{r2TestResult.endpoint || "(missing)"}</code>
                          </div>
                          <div>
                            <b>Cloudflare API token:</b>{" "}
                            {r2TestResult.api_token.ok
                              ? `OK (visible buckets: ${r2TestResult.api_token.bucket_count ?? 0})`
                              : `Failed (${r2TestResult.api_token.error ?? "unknown error"})`}
                          </div>
                          <div>
                            <b>R2 S3 keys:</b>{" "}
                            {r2TestResult.s3.ok
                              ? `OK (visible buckets: ${r2TestResult.s3.bucket_count ?? 0})`
                              : `Failed (${r2TestResult.s3.error ?? "unknown error"})`}
                          </div>
                          {r2TestResult.bucket_prefix ? (
                            <div>
                              <b>Bucket prefix:</b>{" "}
                              <code>{r2TestResult.bucket_prefix}</code>
                            </div>
                          ) : null}
                          {r2TestResult.bucket_prefix ? (
                            <div>
                              <b>Matching buckets:</b>{" "}
                              {r2TestResult.matched_buckets.length > 0
                                ? r2TestResult.matched_buckets.join(", ")
                                : "(none yet)"}
                            </div>
                          ) : null}
                          {r2TestResult.notes?.length ? (
                            <div>{r2TestResult.notes.join(" ")}</div>
                          ) : null}
                        </div>
                      }
                    />
                  ) : null}
                </Space>
              </div>
            </div>
            <div>
              <strong>Step 6 - Tunnel settings (optional)</strong>
              <div style={{ marginTop: "6px", color: "#666" }}>
                These control how CoCalc names Cloudflare tunnel resources for
                project hosts. Defaults are fine.
              </div>
              <div
                style={{
                  marginTop: "10px",
                  display: "grid",
                  gridTemplateColumns: "260px minmax(0,1fr)",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                <div>
                  <b>Tunnel name prefix</b>
                  <div style={{ color: "#666" }}>
                    Prefix for tunnel names (e.g., cocalc-...).
                  </div>
                </div>
                <Input
                  placeholder="Tunnel name prefix (e.g., cocalc)"
                  value={tunnelPrefix}
                  onChange={(e) => setTunnelPrefix(e.target.value)}
                />
              </div>
              <div
                style={{
                  marginTop: "10px",
                  display: "grid",
                  gridTemplateColumns: "260px minmax(0,1fr)",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                <div>
                  <b>Project-host hostname suffix</b>
                  <div style={{ color: "#666" }}>
                    Leave blank for the default "-&lt;External Domain Name&gt;".
                  </div>
                </div>
                <Input
                  placeholder="Project-host hostname suffix (optional, e.g., -hosts.cocalc.ai)"
                  value={hostSuffix}
                  onChange={(e) => setHostSuffix(e.target.value)}
                />
              </div>
            </div>
          </>
        )}
        <Button
          type="primary"
          icon={<Icon name="save" />}
          onClick={applySettings}
          disabled={applyDisabled}
        >
          Apply Settings
        </Button>
        {applyDisabled && missing ? (
          <Alert
            type="warning"
            showIcon
            title={`Fill in required field: ${missing}`}
          />
        ) : null}
        {notice ? <Alert type="success" showIcon title={notice} /> : null}
      </Space>
    </Modal>
  );
}
