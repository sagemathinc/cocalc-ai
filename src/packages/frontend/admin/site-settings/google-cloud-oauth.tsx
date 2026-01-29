/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Space } from "antd";
import { useEffect, useState } from "react";
import api from "@cocalc/frontend/client/api";
import { Gap, Icon } from "@cocalc/frontend/components";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import type { Data } from "./types";

interface GoogleCloudOauthProps {
  data: Data | null;
  reload: () => Promise<void>;
}

function toBool(value: unknown): boolean {
  return value === true || value === "yes" || value === "true";
}

export default function GoogleCloudOauthSetup({
  data,
  reload,
}: GoogleCloudOauthProps) {
  const enabled = toBool(data?.project_hosts_google_cloud_enabled);
  const [projectId, setProjectId] = useState<string>(
    data?.google_cloud_project_id ?? "",
  );
  const [serviceAccountEmail, setServiceAccountEmail] = useState<string>(
    data?.google_cloud_service_account_email ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [clientJson, setClientJson] = useState<string>("");
  const [saveNotice, setSaveNotice] = useState<string>("");

  useEffect(() => {
    if (!data) return;
    setProjectId(data.google_cloud_project_id ?? "");
    setServiceAccountEmail(data.google_cloud_service_account_email ?? "");
  }, [data?.google_cloud_project_id, data?.google_cloud_service_account_email]);

  if (!enabled) {
    return null;
  }

  const connectedAt = data?.google_cloud_oauth_connected_at ?? "";
  const lastValidated = data?.google_cloud_oauth_last_validated_at ?? "";
  const lastError = data?.google_cloud_oauth_last_error ?? "";

  async function connectOAuth() {
    setBusy(true);
    setError("");
    try {
      const result = await api("admin/gcp/oauth/start");
      const url = result?.url;
      if (typeof url !== "string" || url.length === 0) {
        throw Error("OAuth URL missing from response");
      }
      window.location.assign(url);
    } catch (err: any) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  function getRedirectUri(): string {
    if (typeof window === "undefined") {
      return "";
    }
    const base = appBasePath.endsWith("/")
      ? appBasePath.slice(0, -1)
      : appBasePath;
    return `${window.location.origin}${base}/api/v2/admin/gcp/oauth/callback`;
  }

  async function copyRedirectUri() {
    const uri = getRedirectUri();
    try {
      await navigator.clipboard.writeText(uri);
      setSaveNotice("Redirect URI copied.");
    } catch {
      setSaveNotice("Copy failed; please copy manually.");
    }
  }

  async function saveConfig() {
    setBusy(true);
    setError("");
    setSaveNotice("");
    try {
      await api("admin/gcp/oauth/config", {
        project_id: projectId.trim(),
        service_account_email: serviceAccountEmail.trim(),
        client_json: clientJson.trim() || undefined,
      });
      await reload();
      if (clientJson.trim()) {
        setClientJson("");
        setSaveNotice("Saved OAuth client JSON.");
      }
    } catch (err: any) {
      setError(`${err}`);
    } finally {
      setBusy(false);
    }
  }

  const redirectUri = getRedirectUri();

  return (
    <div style={{ marginBottom: "24px" }}>
      <Alert
        type="info"
        showIcon
        message="Google Cloud OAuth + Service Account Impersonation"
        description={
          <div>
            <p style={{ marginBottom: "8px" }}>
              Configure Google Cloud access without JSON keys. Provide the
              project ID + service account email, then connect via OAuth to
              mint short-lived impersonation tokens.
            </p>
            <div style={{ marginBottom: "8px" }}>
              <strong>Authorized redirect URI:</strong>
              <div style={{ marginTop: "4px" }}>
                <Space>
                  <Input
                    readOnly
                    value={redirectUri}
                    style={{ width: "420px" }}
                  />
                  <Button onClick={copyRedirectUri}>Copy</Button>
                </Space>
              </div>
            </div>
            {connectedAt ? (
              <div>
                <strong>Connected:</strong> {connectedAt}
                {lastValidated ? (
                  <div>
                    <strong>Last validated:</strong> {lastValidated}
                  </div>
                ) : null}
              </div>
            ) : (
              <div>
                <strong>Connected:</strong> not yet
              </div>
            )}
            {lastError ? (
              <div style={{ marginTop: "6px" }}>
                <strong>Last error:</strong> {lastError}
              </div>
            ) : null}
          </div>
        }
      />
      {error ? (
        <Alert
          type="error"
          showIcon
          message="Google Cloud setup error"
          description={error}
          style={{ marginTop: "12px" }}
        />
      ) : null}
      {saveNotice ? (
        <Alert
          type="success"
          showIcon
          message={saveNotice}
          style={{ marginTop: "12px" }}
        />
      ) : null}
      <div style={{ marginTop: "12px" }}>
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <div>
            <strong>Project ID</strong>
            <Input
              placeholder="my-gcp-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            />
          </div>
          <div>
            <strong>Service Account Email</strong>
            <Input
              placeholder="cocalc-host@my-gcp-project.iam.gserviceaccount.com"
              value={serviceAccountEmail}
              onChange={(e) => setServiceAccountEmail(e.target.value)}
            />
          </div>
          <div>
            <strong>OAuth Client JSON</strong>
            <Input.TextArea
              placeholder='Paste the OAuth client JSON (type "Web application")'
              value={clientJson}
              onChange={(e) => setClientJson(e.target.value)}
              autoSize={{ minRows: 4, maxRows: 8 }}
            />
          </div>
          <div>
            <Button
              type="default"
              icon={<Icon name="save" />}
              onClick={saveConfig}
              disabled={busy}
            >
              Save Project + Service Account
            </Button>
            <Gap />
            <Button
              type="primary"
              icon={<Icon name="link" />}
              onClick={connectOAuth}
              disabled={busy}
            >
              Connect Google Cloud (OAuth)
            </Button>
          </div>
        </Space>
      </div>
    </div>
  );
}
