/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Checkbox, Input, Modal, Space } from "antd";
import { useEffect, useMemo, useState } from "react";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProviderSetupChallenge } from "@cocalc/conat/hub/api/system";

interface WizardProps {
  open: boolean;
  onClose: () => void;
  onSave: (settings: Record<string, string>) => Promise<void>;
  currentJson?: string;
  domainName?: string;
  computeVm?: boolean;
  // compute_vm_ssh_source_ranges: the setup script opens tcp:22 only to these.
  sshSourceRanges?: string;
}

const START_MARKER = "=== COCALC GCP CONFIG START ===";
const END_MARKER = "=== COCALC GCP CONFIG END ===";

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function defaultUseDirectUpload(): boolean {
  if (typeof window === "undefined") return false;
  return !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
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
    raw.compute_vm_gcp_service_account_json ??
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
  onSave,
  currentJson,
  domainName,
  computeVm = false,
  sshSourceRanges,
}: WizardProps) {
  const trimmedSshSourceRanges = `${sshSourceRanges ?? ""}`.trim();
  const sshRangesEnv =
    computeVm && trimmedSshSourceRanges
      ? `SSH_SOURCE_RANGES=${shQuote(trimmedSshSourceRanges)} `
      : "";
  const defaultServiceAccountName = computeVm
    ? "cocalc-compute-vm"
    : "cocalc-host";
  const [projectId, setProjectId] = useState("");
  const [serviceAccountName, setServiceAccountName] = useState(
    defaultServiceAccountName,
  );
  const [gcloudReady, setGcloudReady] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [challenge, setChallenge] = useState<
    (ProviderSetupChallenge & { token?: string }) | null
  >(null);
  const [useDirectUpload, setUseDirectUpload] = useState(
    defaultUseDirectUpload,
  );
  const [challengeError, setChallengeError] = useState("");
  const [challengeLoading, setChallengeLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setProjectId("");
      setServiceAccountName(defaultServiceAccountName);
      setGcloudReady(false);
      setJsonInput("");
      setChallenge(null);
      setUseDirectUpload(defaultUseDirectUpload());
      setChallengeError("");
      setChallengeLoading(false);
      setSaving(false);
      setCleanupOpen(false);
      return;
    }
    const parsed = normalizeServiceAccountJson(currentJson ?? "");
    if (parsed?.project_id) {
      setProjectId(`${parsed.project_id}`);
    }
    if (parsed?.client_email) {
      const name = `${parsed.client_email}`.split("@")[0].trim();
      if (name) setServiceAccountName(name);
    }
  }, [open, currentJson, defaultServiceAccountName]);

  const trimmedProject = projectId.trim();
  const serviceAccountEmail = trimmedProject
    ? `${serviceAccountName}@${trimmedProject}.iam.gserviceaccount.com`
    : "";

  const scriptUrl = useMemo(() => {
    const basePath = appBasePath === "/" ? "" : appBasePath;
    const trimmedDomain = (domainName ?? "").trim();
    if (trimmedDomain) {
      const withScheme = /^https?:\/\//.test(trimmedDomain)
        ? trimmedDomain
        : `https://${trimmedDomain}`;
      return `${withScheme.replace(/\/+$/, "")}${basePath}/project-host/${computeVm ? "compute-vm-setup.sh" : "gcp-setup.sh"}`;
    }
    if (typeof window !== "undefined") {
      return `${window.location.origin}${basePath}/project-host/${computeVm ? "compute-vm-setup.sh" : "gcp-setup.sh"}`;
    }
    return `http://localhost:9001${basePath}/project-host/${computeVm ? "compute-vm-setup.sh" : "gcp-setup.sh"}`;
  }, [computeVm, domainName]);

  const scriptCommand = useMemo(() => {
    if (!scriptUrl) {
      return "curl -fsSL <software-base-url>/gcp/gcp-setup.sh | bash";
    }
    const uploadUrl =
      useDirectUpload && challenge?.id && typeof window !== "undefined"
        ? `${window.location.origin}${appBasePath === "/" ? "" : appBasePath}/project-host/provider-setup/${challenge.id}/upload`
        : "";
    const uploadEnv =
      uploadUrl && challenge?.token
        ? `COCALC_SETUP_UPLOAD_URL=${shQuote(uploadUrl)} COCALC_SETUP_TOKEN=${shQuote(challenge.token)} `
        : "";
    if (!trimmedProject) {
      return `curl -fsSL \"${scriptUrl}\" | ${uploadEnv}${sshRangesEnv}bash`;
    }
    return `curl -fsSL \"${scriptUrl}\" | ${uploadEnv}${sshRangesEnv}PROJECT_ID=\"${trimmedProject}\" SA_NAME=\"${serviceAccountName}\" bash`;
  }, [
    scriptUrl,
    trimmedProject,
    serviceAccountName,
    challenge,
    useDirectUpload,
    computeVm,
    sshRangesEnv,
  ]);

  const scriptMarkdown = useMemo(
    () => `\`\`\`sh\n${scriptCommand}\n\`\`\``,
    [scriptCommand],
  );

  const cleanupBlock = useMemo(() => {
    if (!trimmedProject) return "";
    const lines = [
      `PROJECT_ID="${trimmedProject}"`,
      `SA_EMAIL="${serviceAccountEmail}"`,
      "",
      'gcloud iam service-accounts delete "$SA_EMAIL" --project "$PROJECT_ID"',
    ];
    return `\`\`\`sh\n${lines.join("\n")}\n\`\`\``;
  }, [serviceAccountEmail, trimmedProject]);

  const parsedJson = normalizeServiceAccountJson(jsonInput.trim());
  const uploadedJson = normalizeServiceAccountJson(
    challenge?.payload == null ? "" : JSON.stringify(challenge.payload),
  );
  const jsonProjectId = parsedJson?.project_id ?? "";
  const jsonEmail = parsedJson?.client_email ?? "";
  const jsonValid = !!parsedJson;
  const uploadedJsonValid = !!uploadedJson;

  async function startUploadChallenge() {
    if (challengeLoading || challenge?.id) return;
    setChallengeLoading(true);
    setChallengeError("");
    try {
      const next =
        await webapp_client.conat_client.hub.system.createProviderSetupChallenge(
          { provider: "gcp" },
        );
      setChallenge(next);
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
    if (!useDirectUpload || !challenge?.id || challenge.status !== "pending") {
      return;
    }
    const timer = setInterval(() => {
      void refreshUploadChallenge();
    }, 2000);
    return () => clearInterval(timer);
  }, [useDirectUpload, challenge?.id, challenge?.status]);

  useEffect(() => {
    if (
      !open ||
      !gcloudReady ||
      !trimmedProject ||
      !useDirectUpload ||
      challenge?.id ||
      challengeError ||
      challengeLoading
    ) {
      return;
    }
    void startUploadChallenge();
  }, [
    open,
    gcloudReady,
    trimmedProject,
    useDirectUpload,
    challenge?.id,
    challengeError,
    challengeLoading,
  ]);

  async function restartUploadChallenge() {
    setChallengeLoading(true);
    setChallengeError("");
    if (challenge?.id) {
      try {
        await webapp_client.conat_client.hub.system.clearProviderSetupChallenge(
          { id: challenge.id },
        );
      } catch {
        // Expired challenges are also removed by routine cleanup.
      }
    }
    setChallenge(null);
    setChallengeLoading(false);
  }

  async function saveChanges() {
    const serviceAccount = useDirectUpload ? uploadedJson : parsedJson;
    if (!serviceAccount) return;
    const payload = useDirectUpload
      ? challenge?.payload
      : extractJsonBlock(jsonInput);
    const settings: Record<string, string> = {
      [computeVm
        ? "compute_vm_gcp_service_account_json"
        : "google_cloud_service_account_json"]: JSON.stringify(
        serviceAccount,
        null,
        2,
      ),
    };
    if (computeVm) {
      settings.compute_vm_gcp_network =
        `${payload?.compute_vm_gcp_network ?? ""}`.trim() ||
        `projects/${serviceAccount.project_id}/global/networks/cocalc-compute-vm`;
    }
    setSaving(true);
    setChallengeError("");
    try {
      await onSave(settings);
      if (challenge?.id) {
        try {
          await webapp_client.conat_client.hub.system.clearProviderSetupChallenge(
            { id: challenge.id },
          );
        } catch {
          // Settings are saved; expired challenge cleanup removes the payload.
        }
      }
      onClose();
    } catch (err) {
      setChallengeError(`${err}`);
    } finally {
      setSaving(false);
    }
  }

  const configurationValid = useDirectUpload ? uploadedJsonValid : jsonValid;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => void saveChanges()}
      okText="Save Changes"
      okButtonProps={{ disabled: !configurationValid }}
      confirmLoading={saving}
      cancelText="Cancel"
      title={
        computeVm
          ? "Connect a dedicated GCP project for Managed Compute VMs"
          : "Connect a dedicated GCP project"
      }
      width={920}
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="Use a GCP project dedicated exclusively to this CoCalc site."
          description={
            computeVm
              ? "This project should only run Managed Compute VMs for this site. Do not share it with project hosts or unrelated workloads. CoCalc creates the service account with a standard name; you do not need to choose one."
              : "Do not share this project with another CoCalc site or unrelated workloads. CoCalc creates the service account with a standard name; you do not need to choose one."
          }
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
              <strong>Step 3 — Run this command in your gcloud terminal</strong>
              {challengeError ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: "8px" }}
                  title="Direct upload setup error"
                  description={
                    <Space orientation="vertical" size={4}>
                      <span>{challengeError}</span>
                      {!challenge?.id ? (
                        <Button
                          size="small"
                          loading={challengeLoading}
                          onClick={() => void restartUploadChallenge()}
                        >
                          Try again
                        </Button>
                      ) : null}
                    </Space>
                  }
                />
              ) : null}
              {computeVm && !trimmedSshSourceRanges ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: "8px" }}
                  title="Set Managed Compute VMs: SSH Source Ranges first"
                  description="The setup script opens port 22 only to the bay and project-host addresses in that setting, and stops when it is empty."
                />
              ) : null}
              {useDirectUpload ? (
                challenge?.id ? (
                  <div style={{ marginTop: "8px" }}>
                    <StaticMarkdown value={scriptMarkdown} />
                  </div>
                ) : (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginTop: "8px" }}
                    title="Preparing a secure setup command..."
                  />
                )
              ) : (
                <div style={{ marginTop: "8px" }}>
                  <StaticMarkdown value={scriptMarkdown} />
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
                </div>
              )}
              {useDirectUpload && challenge?.status === "pending" ? (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: "8px" }}
                  title="Waiting for setup to finish..."
                  description={
                    computeVm
                      ? "The first run creates regional networking and may take several minutes. This page will update automatically."
                      : "This page will update automatically when the command uploads its configuration."
                  }
                />
              ) : null}
              {useDirectUpload && uploadedJsonValid ? (
                <Alert
                  type="success"
                  showIcon
                  style={{ marginTop: "8px" }}
                  title="Setup finished successfully"
                  description={`Ready to save ${uploadedJson.client_email}.`}
                />
              ) : null}
              {useDirectUpload && challenge?.status === "expired" ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: "8px" }}
                  title="This setup command expired"
                  description={
                    <Button
                      size="small"
                      loading={challengeLoading}
                      onClick={() => void restartUploadChallenge()}
                    >
                      Generate a new command
                    </Button>
                  }
                />
              ) : null}
            </div>
            <div style={{ marginTop: "12px" }}>
              <Button danger size="small" onClick={() => setCleanupOpen(true)}>
                Delete Service Account...
              </Button>
            </div>
          </>
        ) : null}
      </Space>
      <Modal
        open={cleanupOpen}
        onCancel={() => setCleanupOpen(false)}
        onOk={() => setCleanupOpen(false)}
        okText="Close"
        cancelButtonProps={{ style: { display: "none" } }}
        title="Delete the GCP service account"
      >
        <Alert
          type="warning"
          showIcon
          title="Use this only to undo the setup"
          description="Deleting the service account immediately prevents CoCalc from managing resources in this GCP project. Existing VMs, disks, and other cloud resources are not deleted automatically."
        />
        <div style={{ marginTop: "12px" }}>
          <StaticMarkdown
            value={cleanupBlock || "Enter a GCP project ID first."}
          />
        </div>
      </Modal>
    </Modal>
  );
}
