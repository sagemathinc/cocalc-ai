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
import cloudflareManagedTransformImg from "./assets/cloudflare-managed-transform-location-headers.png";

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

interface VisitorLocationHeaderResult {
  ok: boolean;
  missing: string[];
  details: {
    country: string;
    region: string;
    regionCode: string;
    city: string;
    continent: string;
    timezone: string;
    latitude: string;
    longitude: string;
  };
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
  const [locationHeadersTesting, setLocationHeadersTesting] = useState(false);
  const [locationHeadersTestError, setLocationHeadersTestError] = useState("");
  const [locationHeadersResult, setLocationHeadersResult] =
    useState<VisitorLocationHeaderResult | null>(null);
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
      setLocationHeadersTesting(false);
      setLocationHeadersTestError("");
      setLocationHeadersResult(null);
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
    setLocationHeadersTesting(false);
    setLocationHeadersTestError("");
    setLocationHeadersResult(null);
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

  async function testVisitorLocationHeaders() {
    setLocationHeadersTesting(true);
    setLocationHeadersTestError("");
    setLocationHeadersResult(null);
    try {
      const response = await fetch("/customize", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(
          `GET /customize failed: ${response.status} ${response.statusText}`,
        );
      }
      const payload = await response.json();
      const configuration = payload?.configuration ?? {};
      const details = {
        country: trimOrEmpty(configuration.country),
        region: trimOrEmpty(configuration.cloudflare_region),
        regionCode: trimOrEmpty(configuration.cloudflare_region_code),
        city: trimOrEmpty(configuration.cloudflare_city),
        continent: trimOrEmpty(configuration.cloudflare_continent),
        timezone: trimOrEmpty(configuration.cloudflare_timezone),
        latitude: trimOrEmpty(configuration.cloudflare_latitude),
        longitude: trimOrEmpty(configuration.cloudflare_longitude),
      };
      const missing: string[] = [];
      if (!details.country) missing.push("country");
      if (!details.city) missing.push("city");
      if (!details.continent) missing.push("continent");
      if (!details.latitude) missing.push("latitude");
      if (!details.longitude) missing.push("longitude");
      const result = {
        ok: missing.length === 0,
        missing,
        details,
      };
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
              <strong>Step 5 - Enable Visitor Location Headers</strong>
              <div style={{ marginTop: "6px", color: "#666" }}>
                Enable this managed transform in Cloudflare so CoCalc can pick
                good default regions for users and sort host regions by
                distance.
              </div>
              <div style={{ marginTop: "8px" }}>
                <StaticMarkdown
                  value={`Open this Cloudflare page:

- ${managedTransformsUrl}

Enable: **Add visitor location headers**.

If the link above does not work, search in Cloudflare for **Managed Transforms** and select your domain.`}
                />
              </div>
              <img
                src={cloudflareManagedTransformImg}
                alt='Cloudflare managed transform "Add visitor location headers"'
                style={{
                  marginTop: "10px",
                  width: "100%",
                  maxWidth: "900px",
                  border: "1px solid #d9d9d9",
                  borderRadius: "6px",
                }}
              />
              <div style={{ marginTop: "10px" }}>
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <Button
                    onClick={testVisitorLocationHeaders}
                    loading={locationHeadersTesting}
                    icon={<Icon name="check" />}
                  >
                    Test Visitor Location Headers
                  </Button>
                  <div style={{ color: "#666" }}>
                    Checks <code>/customize</code> right now to confirm that
                    Cloudflare location fields are reaching the hub.
                  </div>
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
                          ? "Visitor location headers are present"
                          : "Location headers are incomplete"
                      }
                      description={
                        <div style={{ display: "grid", rowGap: "4px" }}>
                          <div>
                            <b>Country:</b>{" "}
                            <code>
                              {locationHeadersResult.details.country ||
                                "(missing)"}
                            </code>
                          </div>
                          <div>
                            <b>Region:</b>{" "}
                            <code>
                              {locationHeadersResult.details.region ||
                                "(missing)"}
                            </code>
                          </div>
                          <div>
                            <b>Region code:</b>{" "}
                            <code>
                              {locationHeadersResult.details.regionCode ||
                                "(missing)"}
                            </code>
                          </div>
                          <div>
                            <b>City:</b>{" "}
                            <code>
                              {locationHeadersResult.details.city || "(missing)"}
                            </code>
                          </div>
                          <div>
                            <b>Continent:</b>{" "}
                            <code>
                              {locationHeadersResult.details.continent ||
                                "(missing)"}
                            </code>
                          </div>
                          <div>
                            <b>Timezone:</b>{" "}
                            <code>
                              {locationHeadersResult.details.timezone ||
                                "(missing)"}
                            </code>
                          </div>
                          <div>
                            <b>Latitude:</b>{" "}
                            <code>
                              {locationHeadersResult.details.latitude ||
                                "(missing)"}
                            </code>
                          </div>
                          <div>
                            <b>Longitude:</b>{" "}
                            <code>
                              {locationHeadersResult.details.longitude ||
                                "(missing)"}
                            </code>
                          </div>
                          {locationHeadersResult.missing.length > 0 ? (
                            <div>
                              Missing required fields:{" "}
                              <code>
                                {locationHeadersResult.missing.join(", ")}
                              </code>
                            </div>
                          ) : (
                            <div>All required location fields are present.</div>
                          )}
                        </div>
                      }
                    />
                  ) : null}
                </Space>
              </div>
            </div>
            <div>
              <strong>Step 6 - R2 backups (required)</strong>
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
              <strong>Step 7 - Tunnel settings (optional)</strong>
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
