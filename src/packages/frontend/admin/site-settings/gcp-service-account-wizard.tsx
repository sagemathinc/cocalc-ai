/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Checkbox, Input, Modal, Space } from "antd";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";

interface WizardProps {
  open: boolean;
  onClose: () => void;
  onApplyJson: (json: string) => void;
}

function parseJson(input: string): any | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export default function GcpServiceAccountWizard({
  open,
  onClose,
  onApplyJson,
}: WizardProps) {
  const [projectId, setProjectId] = useState("");
  const [serviceAccountName, setServiceAccountName] = useState("cocalc-host");
  const [gcloudReady, setGcloudReady] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [jsonNotice, setJsonNotice] = useState("");

  useEffect(() => {
    if (open) return;
    setProjectId("");
    setServiceAccountName("cocalc-host");
    setGcloudReady(false);
    setJsonInput("");
    setJsonNotice("");
  }, [open]);

  const trimmedProject = projectId.trim();
  const trimmedServiceAccount = serviceAccountName.trim() || "cocalc-host";
  const serviceAccountEmail = trimmedProject
    ? `${trimmedServiceAccount}@${trimmedProject}.iam.gserviceaccount.com`
    : "";

  const commandBlock = useMemo(() => {
    if (!trimmedProject) return "";
    const lines = [
      `PROJECT_ID="${trimmedProject}"`,
      `SA_NAME="${trimmedServiceAccount}"`,
      `SA_EMAIL="${trimmedServiceAccount}@${trimmedProject}.iam.gserviceaccount.com"`,
      "",
      "gcloud config set project \"$PROJECT_ID\"",
      "gcloud services enable compute.googleapis.com",
      "gcloud iam service-accounts create \"$SA_NAME\" --display-name=\"CoCalc Project Hosts\" || true",
      "gcloud projects add-iam-policy-binding \"$PROJECT_ID\" --member=\"serviceAccount:${SA_EMAIL}\" --role=\"roles/editor\"",
      "gcloud iam service-accounts keys create \"cocalc-gcp-key.json\" --iam-account=\"$SA_EMAIL\"",
      "cat \"cocalc-gcp-key.json\"",
    ];
    return `\`\`\`sh\n${lines.join("\n")}\n\`\`\``;
  }, [trimmedProject, trimmedServiceAccount]);

  const cleanupBlock = useMemo(() => {
    if (!trimmedProject) return "";
    const lines = [
      `PROJECT_ID="${trimmedProject}"`,
      `SA_EMAIL="${trimmedServiceAccount}@${trimmedProject}.iam.gserviceaccount.com"`,
      "",
      "gcloud iam service-accounts delete \"$SA_EMAIL\" --project \"$PROJECT_ID\"",
    ];
    return `\`\`\`sh\n${lines.join("\n")}\n\`\`\``;
  }, [trimmedProject, trimmedServiceAccount]);

  const parsedJson = parseJson(jsonInput.trim());
  const jsonIsServiceAccount = parsedJson?.type === "service_account";
  const jsonProjectId = parsedJson?.project_id ?? "";
  const jsonEmail = parsedJson?.client_email ?? "";
  const jsonValid = !!parsedJson && jsonIsServiceAccount;

  async function copyCommands() {
    if (!trimmedProject) return;
    try {
      const raw = commandBlock.replace(/^```sh\n/, "").replace(/\n```$/, "");
      await navigator.clipboard.writeText(raw);
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
    onApplyJson(jsonInput.trim());
    setJsonNotice("Service account JSON applied to the form.");
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
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message="This wizard generates a service account JSON key using gcloud."
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
            onChange={(e) => setGcloudReady(e.target.checked)}
          >
            I opened gcloud (Cloud Shell or local install)
          </Checkbox>
        </div>
        <div>
          <strong>Step 3 — Run these commands</strong>
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
          <div style={{ marginTop: "8px" }}>
            <StaticMarkdown
              value={
                commandBlock ||
                "```sh\n# enter a Project ID to generate commands\n```"
              }
            />
          </div>
          <Button
            icon={<Icon name="copy" />}
            onClick={copyCommands}
            disabled={!trimmedProject || !gcloudReady}
          >
            Copy Commands
          </Button>
        </div>
        <div>
          <strong>Step 4 — Paste the JSON key here</strong>
          <Input.TextArea
            placeholder='{"type":"service_account", ... }'
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            autoSize={{ minRows: 6, maxRows: 10 }}
          />
          {jsonInput.trim() && !jsonValid ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: "8px" }}
              message="This does not look like a service account key JSON."
            />
          ) : null}
          {jsonValid ? (
            <Alert
              type="success"
              showIcon
              style={{ marginTop: "8px" }}
              message={`Detected service account: ${jsonEmail}`}
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
          <Alert type="success" showIcon message={jsonNotice} />
        ) : null}
      </Space>
    </Modal>
  );
}
