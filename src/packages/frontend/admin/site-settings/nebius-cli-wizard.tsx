/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Space } from "antd";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProviderSetupChallenge } from "@cocalc/conat/hub/api/system";

interface WizardProps {
  open: boolean;
  onClose: () => void;
  onApply: (values: Record<string, string>) => Promise<void> | void;
  softwareBaseUrl?: string;
}

type RegionConfigEntry = {
  nebius_credentials_json: string;
  nebius_parent_id: string;
  nebius_subnet_id: string;
};

type ParsedValues = {
  kind: "region";
  regionConfig: Record<string, RegionConfigEntry>;
  project_hosts_nebius_prefix?: string;
};

const START_MARKER = "=== COCALC NEBIUS CONFIG START ===";
const END_MARKER = "=== COCALC NEBIUS CONFIG END ===";

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function normalizeRegionEntry(entry: any): RegionConfigEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const credsRaw =
    entry.nebius_credentials_json ??
    entry.credentials_json ??
    entry.credentials ??
    entry.nebius_credentials;
  const parent =
    entry.nebius_parent_id ??
    entry.parent_id ??
    entry.project_id ??
    entry.project;
  const subnet = entry.nebius_subnet_id ?? entry.subnet_id ?? entry.subnet;
  if (!credsRaw || !parent || !subnet) return null;
  const creds =
    typeof credsRaw === "string" ? credsRaw : JSON.stringify(credsRaw, null, 2);
  return {
    nebius_credentials_json: creds,
    nebius_parent_id: `${parent}`.trim(),
    nebius_subnet_id: `${subnet}`.trim(),
  };
}

function normalizeParsed(obj: any): ParsedValues | null {
  if (!obj || typeof obj !== "object") return null;
  const prefix = obj.project_hosts_nebius_prefix ?? obj.nebius_prefix;
  const regionRaw = obj.nebius_region_config_json ?? obj.nebius_region_config;
  if (regionRaw) {
    let regionConfig: any = regionRaw;
    if (typeof regionRaw === "string") {
      try {
        regionConfig = JSON.parse(regionRaw);
      } catch {
        regionConfig = null;
      }
    }
    if (regionConfig && typeof regionConfig === "object") {
      const normalized: Record<string, RegionConfigEntry> = {};
      for (const [region, entry] of Object.entries(regionConfig)) {
        const normalizedEntry = normalizeRegionEntry(entry);
        if (normalizedEntry) {
          normalized[region] = normalizedEntry;
        }
      }
      if (Object.keys(normalized).length) {
        return {
          kind: "region",
          regionConfig: normalized,
          project_hosts_nebius_prefix:
            prefix == null ? undefined : `${prefix}`.trim(),
        };
      }
    }
  }
  return null;
}

function extractJsonBlock(text: string): any | null {
  const trimmed = text.trim();
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

export default function NebiusCliWizard({
  open,
  onClose,
  onApply,
  softwareBaseUrl,
}: WizardProps) {
  const [output, setOutput] = useState("");
  const [parsed, setParsed] = useState<ParsedValues | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [challenge, setChallenge] = useState<
    (ProviderSetupChallenge & { token?: string }) | null
  >(null);
  const [challengeError, setChallengeError] = useState("");
  const [challengeLoading, setChallengeLoading] = useState(false);

  const scriptUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const trimmedBase = (softwareBaseUrl ?? "").trim().replace(/\/+$/, "");
    if (trimmedBase) {
      return `${trimmedBase}/nebius/nebius-setup.sh`;
    }
    const base = appBasePath === "/" ? "" : appBasePath;
    return `${window.location.origin}${base}/project-host/nebius-setup.sh`;
  }, [softwareBaseUrl]);

  const scriptCommand = useMemo(() => {
    const uploadUrl =
      challenge?.id && typeof window !== "undefined"
        ? `${window.location.origin}${appBasePath === "/" ? "" : appBasePath}/project-host/provider-setup/${challenge.id}/upload`
        : "";
    const uploadEnv =
      uploadUrl && challenge?.token
        ? `COCALC_SETUP_UPLOAD_URL=${shQuote(uploadUrl)} COCALC_SETUP_TOKEN=${shQuote(challenge.token)} `
        : "";
    return scriptUrl
      ? `curl -fsSL "${scriptUrl}" | ${uploadEnv}bash`
      : `curl -fsSL <software-base-url>/nebius/nebius-setup.sh | ${uploadEnv}bash`;
  }, [scriptUrl, challenge]);

  const scriptMarkdown = useMemo(
    () => `Run this once in your terminal (after installing and authenticating \`nebius\`):

\`\`\`sh
${scriptCommand}
\`\`\`

You can review the script here: ${
      scriptUrl
        ? `[${scriptUrl}](${scriptUrl})`
        : "<software-base-url>/nebius/nebius-setup.sh"
    }
`,
    [scriptCommand, scriptUrl],
  );

  function parseOutput(text: string) {
    setOutput(text);
    setNotice("");
    const raw = extractJsonBlock(text);
    const normalized = normalizeParsed(raw);
    if (!raw || !normalized) {
      setParsed(null);
      if (text.trim().length > 0) {
        setParseError("Could not find a valid Nebius config JSON block.");
      } else {
        setParseError(null);
      }
      return;
    }
    setParseError(null);
    setParsed(normalized);
  }

  async function startUploadChallenge() {
    setChallengeLoading(true);
    setChallengeError("");
    try {
      const next =
        await webapp_client.conat_client.hub.system.createProviderSetupChallenge(
          { provider: "nebius" },
        );
      setChallenge(next);
      setNotice("Direct upload challenge created.");
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
      const normalized = normalizeParsed(next.payload);
      if (normalized) {
        setParsed(normalized);
        setParseError(null);
      }
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

  async function applySettings() {
    if (!parsed) return;
    const updates: Record<string, string> = {};
    updates.nebius_region_config_json = JSON.stringify(
      parsed.regionConfig,
      null,
      2,
    );
    if (parsed.project_hosts_nebius_prefix) {
      updates.project_hosts_nebius_prefix = parsed.project_hosts_nebius_prefix;
    }
    await onApply(updates);
    if (challenge?.id && challenge.status === "uploaded") {
      try {
        await webapp_client.conat_client.hub.system.clearProviderSetupChallenge(
          { id: challenge.id },
        );
      } catch {
        // Non-fatal: settings are applied and expired challenge cleanup will
        // remove the temporary payload later.
      }
    }
    setNotice("Settings applied and saved.");
    onClose();
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      okText="Close"
      title="Nebius Configuration Wizard"
      width={920}
    >
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="Configure Nebius CLI credentials in one pass."
          description="This wizard generates credentials via the Nebius CLI and fills in all required settings."
        />
        <div>
          <strong>Step 1 - Install and authenticate the Nebius CLI</strong>
          <div style={{ marginTop: "6px", color: "#666" }}>
            <StaticMarkdown
              value={`Install and authenticate the Nebius CLI from https://docs.nebius.com/cli/install`}
            />
          </div>
        </div>
        <div>
          <strong>Step 2 - Run this script</strong>
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
          {challenge?.status === "uploaded" && parsed ? (
            <Alert
              type="success"
              showIcon
              style={{ marginTop: "8px" }}
              title="Configuration uploaded."
              description="Review the parsed settings below, then apply them."
            />
          ) : null}
          <StaticMarkdown value={scriptMarkdown} />
        </div>
        <div>
          <strong>Step 3 - Paste the output</strong>
          <Input.TextArea
            rows={8}
            placeholder="Paste the script output here..."
            value={output}
            onChange={(e) => parseOutput(e.target.value)}
          />
          {parseError ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: "8px" }}
              title={parseError}
            />
          ) : null}
          {parsed ? (
            <Alert
              type="success"
              showIcon
              style={{ marginTop: "8px" }}
              title="Parsed Nebius configuration."
              description={
                <div>
                  <div>
                    <b>Regions:</b>{" "}
                    {Object.keys(parsed.regionConfig).sort().join(", ")}
                  </div>
                  <div>
                    <b>Projects:</b> {Object.keys(parsed.regionConfig).length}
                  </div>
                  <div>
                    <b>Prefix:</b>{" "}
                    {parsed.project_hosts_nebius_prefix ?? "cocalc-host"}
                  </div>
                  <div>
                    <b>Credentials:</b> detected
                  </div>
                </div>
              }
            />
          ) : null}
        </div>
        <Button
          type="primary"
          icon={<Icon name="save" />}
          onClick={applySettings}
          disabled={!parsed}
        >
          Apply Settings
        </Button>
        {notice ? <Alert type="success" showIcon title={notice} /> : null}
      </Space>
    </Modal>
  );
}
