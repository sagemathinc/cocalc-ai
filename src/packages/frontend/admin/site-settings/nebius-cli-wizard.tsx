/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Space } from "antd";
import { useMemo, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

interface WizardProps {
  open: boolean;
  onClose: () => void;
  onApply: (values: Record<string, string>) => Promise<void> | void;
}

type RegionConfigEntry = {
  nebius_credentials_json: string;
  nebius_parent_id: string;
  nebius_subnet_id: string;
};

type ParsedValues =
  | {
      kind: "region";
      regionConfig: Record<string, RegionConfigEntry>;
      project_hosts_nebius_prefix?: string;
    }
  | {
      kind: "single";
      nebius_credentials_json: string;
      nebius_parent_id: string;
      nebius_subnet_id: string;
      project_hosts_nebius_prefix?: string;
    };

const START_MARKER = "=== COCALC NEBIUS CONFIG START ===";
const END_MARKER = "=== COCALC NEBIUS CONFIG END ===";

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
  const credsRaw =
    obj.nebius_credentials_json ??
    obj.credentials_json ??
    obj.credentials ??
    obj.nebius_credentials;
  const parent =
    obj.nebius_parent_id ?? obj.parent_id ?? obj.project_id ?? obj.project;
  const subnet = obj.nebius_subnet_id ?? obj.subnet_id ?? obj.subnet;
  if (!credsRaw || !parent || !subnet) return null;
  const creds =
    typeof credsRaw === "string" ? credsRaw : JSON.stringify(credsRaw, null, 2);
  return {
    kind: "single",
    nebius_credentials_json: creds,
    nebius_parent_id: `${parent}`.trim(),
    nebius_subnet_id: `${subnet}`.trim(),
    project_hosts_nebius_prefix:
      prefix == null ? undefined : `${prefix}`.trim(),
  };
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
    new RegExp(
      `${START_MARKER}([\\s\\S]*?)${END_MARKER}`,
      "m",
    ),
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
}: WizardProps) {
  const [output, setOutput] = useState("");
  const [parsed, setParsed] = useState<ParsedValues | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const scriptUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const base = appBasePath === "/" ? "" : appBasePath;
    return `${window.location.origin}${base}/project-host/nebius-setup.sh`;
  }, []);

  const scriptCommand = useMemo(
    () =>
      scriptUrl
        ? `curl -fsSL "${scriptUrl}" | bash`
        : "curl -fsSL <your-cocalc-url>/project-host/nebius-setup.sh | bash",
    [scriptUrl],
  );

  const scriptMarkdown = useMemo(
    () => `Run this once in your terminal (after installing and authenticating \`nebius\`):

\`\`\`sh
${scriptCommand}
\`\`\`

You can review the script here: ${
      scriptUrl
        ? `[${scriptUrl}](${scriptUrl})`
        : "<your-cocalc-url>/project-host/nebius-setup.sh"
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

  async function applySettings() {
    if (!parsed) return;
    const updates: Record<string, string> = {};
    if (parsed.kind === "region") {
      updates.nebius_region_config_json = JSON.stringify(
        parsed.regionConfig,
        null,
        2,
      );
    } else {
      updates.nebius_credentials_json = parsed.nebius_credentials_json;
      updates.nebius_parent_id = parsed.nebius_parent_id;
      updates.nebius_subnet_id = parsed.nebius_subnet_id;
    }
    if (parsed.project_hosts_nebius_prefix) {
      updates.project_hosts_nebius_prefix = parsed.project_hosts_nebius_prefix;
    }
    await onApply(updates);
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
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message="Configure Nebius CLI credentials in one pass."
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
              message={parseError}
            />
          ) : null}
          {parsed ? (
            <Alert
              type="success"
              showIcon
              style={{ marginTop: "8px" }}
              message="Parsed Nebius configuration."
              description={
                parsed.kind === "region" ? (
                  <div>
                    <div>
                      <b>Regions:</b>{" "}
                      {Object.keys(parsed.regionConfig)
                        .sort()
                        .join(", ")}
                    </div>
                    <div>
                      <b>Projects:</b>{" "}
                      {Object.keys(parsed.regionConfig).length}
                    </div>
                    <div>
                      <b>Prefix:</b>{" "}
                      {parsed.project_hosts_nebius_prefix ?? "cocalc-host"}
                    </div>
                    <div>
                      <b>Credentials:</b> detected
                    </div>
                  </div>
                ) : (
                  <div>
                    <div>
                      <b>Project (parent) ID:</b> {parsed.nebius_parent_id}
                    </div>
                    <div>
                      <b>Subnet ID:</b> {parsed.nebius_subnet_id}
                    </div>
                    <div>
                      <b>Prefix:</b>{" "}
                      {parsed.project_hosts_nebius_prefix ?? "cocalc-host"}
                    </div>
                    <div>
                      <b>Credentials:</b> detected
                    </div>
                  </div>
                )
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
        {notice ? <Alert type="success" showIcon message={notice} /> : null}
      </Space>
    </Modal>
  );
}
