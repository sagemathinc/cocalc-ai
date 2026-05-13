/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Checkbox, Input, Modal, Space } from "antd";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProviderSetupChallenge } from "@cocalc/conat/hub/api/system";

interface WizardProps {
  open: boolean;
  onClose: () => void;
  onApplyJson: (json: string) => void;
  currentJson?: string;
  domainName?: string;
}

const START_MARKER = "=== COCALC GCP CONFIG START ===";
const END_MARKER = "=== COCALC GCP CONFIG END ===";

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function extractJsonBlock(input: string): any | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // ignore
  }
  const markerMatch = trimmed.match(
    new RegExp(`${START_MARKER}([\\s\\S]*?)${END_MARKER}`, "m"),
  );
  if (markerMatch?.[1]) {
    try {
      return JSON.parse(markerMatch[1].trim());
    } catch {
      // ignore
    }
  }
  const candidates = trimmed.match(/\{[\s\S]*\}/g);
  if (!candidates) return null;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      // keep trying
    }
  }
  return null;
}

function normalizeServiceAccountJson(input: string): any | null {
  const raw = extractJsonBlock(input);
  if (!raw) return null;
  let candidate =
    raw.google_cloud_service_account_json ??
    raw.service_account_json ??
    raw.service_account ??
    raw;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (candidate?.type === "service_account") return candidate;
  return null;
}

export default function GcpServiceAccountWizard({
  open,
  onClose,
  onApplyJson,
  currentJson,
  domainName,
}: WizardProps) {
  const [projectId, setProjectId] = useState("");
  const [serviceAccountName, setServiceAccountName] = useState("cocalc-host");
  const [gcloudReady, setGcloudReady] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [jsonNotice, setJsonNotice] = useState("");
  const [challenge, setChallenge] = useState<
    (ProviderSetupChallenge & { token?: string }) | null
  >(null);
  const [challengeError, setChallengeError] = useState("");
  const [challengeLoading, setChallengeLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setProjectId("");
      setServiceAccountName("cocalc-host");
      setGcloudReady(false);
      setJsonInput("");
      setJsonNotice("");
      setChallenge(null);
      setChallengeError("");
      setChallengeLoading(false);
      return;
    }
    const parsed = normalizeServiceAccountJson(currentJson ?? "");
    if (parsed?.project_id) {
      setProjectId(`${parsed.project_id}`);
    }
    if (parsed?.client_email) {
      const name = `${parsed.client_email}`.split("@")[0];
      if (name) setServiceAccountName(name);
    }
  }, [open, currentJson]);

  const trimmedProject = projectId.trim();
  const trimmedServiceAccount = serviceAccountName.trim() || "cocalc-host";
  const serviceAccountEmail = trimmedProject
    ? `${trimmedServiceAccount}@${trimmedProject}.iam.gserviceaccount.com`
    : "";

  const scriptUrl = useMemo(() => {
    const basePath = appBasePath === "/" ? "" : appBasePath;
    const trimmedDomain = (domainName ?? "").trim();
    if (trimmedDomain) {
      const withScheme = /^https?:\/\//.test(trimmedDomain)
        ? trimmedDomain
        : `https://${trimmedDomain}`;
      return `${withScheme.replace(/\/+$/, "")}${basePath}/project-host/gcp-setup.sh`;
    }
    if (typeof window !== "undefined") {
      return `${window.location.origin}${basePath}/project-host/gcp-setup.sh`;
    }
    return `http://localhost:9001${basePath}/project-host/gcp-setup.sh`;
  }, [domainName]);

  const scriptCommand = useMemo(() => {
    if (!scriptUrl) {
      return "curl -fsSL <software-base-url>/gcp/gcp-setup.sh | bash";
    }
    const uploadUrl =
      challenge?.id && typeof window !== "undefined"
        ? `${window.location.origin}${appBasePath === "/" ? "" : appBasePath}/project-host/provider-setup/${challenge.id}/upload`
        : "";
    const uploadEnv =
      uploadUrl && challenge?.token
        ? `COCALC_SETUP_UPLOAD_URL=${shQuote(uploadUrl)} COCALC_SETUP_TOKEN=${shQuote(challenge.token)} `
        : "";
    if (!trimmedProject) {
      return `curl -fsSL \"${scriptUrl}\" | ${uploadEnv}bash`;
    }
    return `curl -fsSL \"${scriptUrl}\" | ${uploadEnv}PROJECT_ID=\"${trimmedProject}\" SA_NAME=\"${trimmedServiceAccount}\" bash`;
  }, [scriptUrl, trimmedProject, trimmedServiceAccount, challenge]);

  const scriptMarkdown = useMemo(
    () =>
      `\`\`\`sh\n${scriptCommand}\n\`\`\`\n\nReview the script here: ${
        scriptUrl
          ? `[${scriptUrl}](${scriptUrl})`
          : "<software-base-url>/gcp/gcp-setup.sh"
      }\n`,
    [scriptCommand, scriptUrl],
  );

  const cleanupBlock = useMemo(() => {
    if (!trimmedProject) return "";
    const lines = [
      `PROJECT_ID="${trimmedProject}"`,
      `SA_EMAIL="${trimmedServiceAccount}@${trimmedProject}.iam.gserviceaccount.com"`,
      "",
      'gcloud iam service-accounts delete "$SA_EMAIL" --project "$PROJECT_ID"',
    ];
    return `\`\`\`sh\n${lines.join("\n")}\n\`\`\``;
  }, [trimmedProject, trimmedServiceAccount]);

  const parsedJson = normalizeServiceAccountJson(jsonInput.trim());
  const uploadedJson = normalizeServiceAccountJson(
    challenge?.payload == null ? "" : JSON.stringify(challenge.payload),
  );
  const jsonProjectId = parsedJson?.project_id ?? "";
  const jsonEmail = parsedJson?.client_email ?? "";
  const jsonValid = !!parsedJson;
  const uploadedJsonValid = !!uploadedJson;

  async function startUploadChallenge() {
    setChallengeLoading(true);
    setChallengeError("");
    try {
      const next =
        await webapp_client.conat_client.hub.system.createProviderSetupChallenge(
          { provider: "gcp" },
        );
      setChallenge(next);
      setJsonNotice("Direct upload challenge created.");
    } catch (err) {
      setChallengeError(`${err}`);
    } finally {
      setChallengeLoading(false);
    }
  }

  async function refreshUploadChallenge() {
    if (!challenge?.id) return;
    setChallengeLoading(true);
    setChallengeError("");
    try {
      const next =
        await webapp_client.conat_client.hub.system.getProviderSetupChallenge({
          id: challenge.id,
        });
      setChallenge({ ...next, token: challenge.token });
    } catch (err) {
      setChallengeError(`${err}`);
    } finally {
      setChallengeLoading(false);
    }
  }

  useEffect(() => {
    if (!challenge?.id || challenge.status !== "pending") return;
    const timer = setInterval(() => {
      void refreshUploadChallenge();
    }, 2000);
    return () => clearInterval(timer);
  }, [challenge?.id, challenge?.status]);

  async function copyCommands() {
    if (!scriptCommand) return;
    try {
      await navigator.clipboard.writeText(scriptCommand);
      setJsonNotice("Commands copied.");
    } catch {
      setJsonNotice("Copy failed; please copy manually.");
    }
  }

  async function copyCleanup() {
    if (!trimmedProject) return;
    try {
      const raw = cleanupBlock.replace(/^```sh\n/, "").replace(/\n```$/, "");
      await navigator.clipboard.writeText(raw);
      setJsonNotice("Cleanup command copied.");
    } catch {
      setJsonNotice("Copy failed; please copy manually.");
    }
  }

  function applyJson() {
    if (!jsonValid) return;
    onApplyJson(JSON.stringify(parsedJson, null, 2));
    setJsonNotice("Service account JSON applied to the form.");
    onClose();
  }

  async function applyUploadedJson() {
    if (!uploadedJsonValid) return;
    onApplyJson(JSON.stringify(uploadedJson, null, 2));
    if (challenge?.id) {
      try {
        await webapp_client.conat_client.hub.system.clearProviderSetupChallenge(
          { id: challenge.id },
        );
      } catch {
        // Non-fatal: settings are applied and expired challenge cleanup will
        // remove the temporary payload later.
      }
    }
    setJsonNotice("Uploaded service account JSON applied to the form.");
    onClose();
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      okText="Close"
      title="Google Cloud Service Account JSON Wizard (gcloud)"
      width={920}
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="This wizard generates a service account JSON key using gcloud."
          description="Advanced users can skip this and paste JSON directly into the setting."
        />
        <div>
          <strong>Step 1 — Project ID</strong>
          <Input
            placeholder="my-gcp-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          />
        </div>
        <div>
          <strong>Step 2 — Open gcloud Shell</strong>
          <div style={{ marginTop: "6px" }}>
            <a
              href="https://shell.cloud.google.com/?show=terminal"
              target="_blank"
              rel="noreferrer"
            >
              Open Google Cloud Shell
            </a>
          </div>
          <Checkbox
            style={{ marginTop: "8px" }}
            checked={gcloudReady}
            disabled={!trimmedProject}
            onChange={(e) => setGcloudReady(e.target.checked)}
          >
            I opened gcloud (Cloud Shell or local install)
          </Checkbox>
        </div>
        {gcloudReady ? (
          <>
            <div>
              <strong>Step 3 — Name your service account</strong>
              <div style={{ marginTop: "6px", color: "#666" }}>
                Service account email:{" "}
                {serviceAccountEmail || "(enter project id first)"}
              </div>
              <Input
                style={{ marginTop: "8px" }}
                placeholder="service account name (no spaces)"
                value={serviceAccountName}
                onChange={(e) => setServiceAccountName(e.target.value)}
              />
            </div>
            <div>
              <strong>
                Step 4 — Run this script to create your service account
              </strong>
              <div style={{ marginTop: "8px" }}>
                <Button
                  size="small"
                  icon={<Icon name="cloud-upload" />}
                  loading={challengeLoading}
                  onClick={startUploadChallenge}
                >
                  Use direct upload instead of paste
                </Button>
                {challenge ? (
                  <Button
                    size="small"
                    style={{ marginLeft: "8px" }}
                    loading={challengeLoading}
                    onClick={refreshUploadChallenge}
                  >
                    Check upload
                  </Button>
                ) : null}
              </div>
              {challengeError ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: "8px" }}
                  title="Direct upload setup error"
                  description={challengeError}
                />
              ) : null}
              {challenge?.status === "uploaded" && uploadedJsonValid ? (
                <Alert
                  type="success"
                  showIcon
                  style={{ marginTop: "8px" }}
                  title="Configuration uploaded."
                  description={
                    <div>
                      <div>
                        <b>Project:</b> {uploadedJson.project_id}
                      </div>
                      <div>
                        <b>Service account:</b> {uploadedJson.client_email}
                      </div>
                      <Button
                        type="primary"
                        style={{ marginTop: "8px" }}
                        onClick={applyUploadedJson}
                      >
                        Apply Uploaded JSON
                      </Button>
                    </div>
                  }
                />
              ) : null}
              <div style={{ marginTop: "8px" }}>
                <StaticMarkdown value={scriptMarkdown} />
              </div>
              <Button
                icon={<Icon name="copy" />}
                onClick={copyCommands}
                disabled={!gcloudReady}
              >
                Copy Commands
              </Button>
            </div>
          </>
        ) : null}
        {gcloudReady ? (
          <div>
            <strong>Step 5 — Paste the output here</strong>
            <Input.TextArea
              placeholder="Paste the output from the script (or just the JSON key)"
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              autoSize={{ minRows: 6, maxRows: 10 }}
            />
            {jsonInput.trim() && !jsonValid ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: "8px" }}
                title="This does not look like a service account key JSON."
              />
            ) : null}
            {jsonValid ? (
              <Alert
                type="success"
                showIcon
                style={{ marginTop: "8px" }}
                title={`Detected service account: ${jsonEmail}`}
                description={`Project ID: ${jsonProjectId}`}
              />
            ) : null}
            <Button
              type="primary"
              icon={<Icon name="save" />}
              style={{ marginTop: "8px" }}
              onClick={applyJson}
              disabled={!jsonValid}
            >
              Apply JSON to Setting
            </Button>
          </div>
        ) : null}
        <div>
          <strong>Cleanup (optional)</strong>
          <div style={{ marginTop: "6px", color: "#666" }}>
            If you need to revoke access, delete the service account:
          </div>
          <div style={{ marginTop: "8px" }}>
            <StaticMarkdown
              value={
                cleanupBlock ||
                "```sh\n# enter a Project ID to generate cleanup command\n```"
              }
            />
          </div>
          <Button
            icon={<Icon name="copy" />}
            onClick={copyCleanup}
            disabled={!trimmedProject}
          >
            Copy Cleanup Command
          </Button>
        </div>
        {jsonNotice ? (
          <Alert type="success" showIcon title={jsonNotice} />
        ) : null}
      </Space>
    </Modal>
  );
}
