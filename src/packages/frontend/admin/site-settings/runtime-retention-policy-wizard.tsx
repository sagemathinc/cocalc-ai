/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Col,
  InputNumber,
  Modal,
  Row,
  Space,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cocalc/frontend/components";

interface WizardProps {
  open: boolean;
  onClose: () => void;
  onApply: (values: Record<string, string>) => Promise<void> | void;
  currentJson?: string;
}

type ArtifactKey = "project-host" | "project-bundle" | "tools";

interface ArtifactPolicyState {
  keep_count: number;
  max_bytes?: number;
}

type PolicyState = Record<ArtifactKey, ArtifactPolicyState>;

const DEFAULT_POLICY: PolicyState = {
  "project-host": { keep_count: 10 },
  "project-bundle": { keep_count: 3 },
  tools: { keep_count: 3 },
};

const ARTIFACTS: Array<{
  key: ArtifactKey;
  label: string;
  help: string;
}> = [
  {
    key: "project-host",
    label: "Project Host",
    help: "Critical rollback path for host daemons. Keep this more generous than the others.",
  },
  {
    key: "project-bundle",
    label: "Project Bundle",
    help: "Runtime used by project containers. Running-project references are protected separately.",
  },
  {
    key: "tools",
    label: "Project Tools",
    help: "Auxiliary project runtime tools. Running-project references are protected separately.",
  },
];

function parseNonNegativeInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  const text = `${raw ?? ""}`.trim();
  if (!text) return undefined;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function normalizePolicy(raw: string | undefined): PolicyState {
  let parsed: any = {};
  try {
    parsed = raw?.trim() ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const state = {} as PolicyState;
  for (const artifact of ARTIFACTS) {
    const configured = parsed?.[artifact.key];
    const keep_count =
      parseNonNegativeInt(configured?.keep_count) ??
      DEFAULT_POLICY[artifact.key].keep_count;
    const max_bytes = parseNonNegativeInt(configured?.max_bytes);
    state[artifact.key] = {
      keep_count,
      ...(max_bytes != null ? { max_bytes } : {}),
    };
  }
  return state;
}

function formatBytes(bytes?: number): string {
  if (bytes == null || bytes <= 0) return "none";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function serializePolicy(policy: PolicyState): string {
  const normalized: Record<string, { keep_count: number; max_bytes?: number }> =
    {};
  for (const artifact of ARTIFACTS) {
    const entry = policy[artifact.key];
    normalized[artifact.key] = {
      keep_count: parseNonNegativeInt(entry.keep_count) ?? 0,
      ...(parseNonNegativeInt(entry.max_bytes) != null
        ? { max_bytes: parseNonNegativeInt(entry.max_bytes) }
        : {}),
    };
  }
  return JSON.stringify(normalized, null, 2);
}

export default function RuntimeRetentionPolicyWizard({
  open,
  onClose,
  onApply,
  currentJson,
}: WizardProps) {
  const [policy, setPolicy] = useState<PolicyState>(DEFAULT_POLICY);

  useEffect(() => {
    if (!open) return;
    setPolicy(normalizePolicy(currentJson));
  }, [open, currentJson]);

  const serialized = useMemo(() => serializePolicy(policy), [policy]);

  function updateArtifact(
    artifact: ArtifactKey,
    patch: Partial<ArtifactPolicyState>,
  ) {
    setPolicy((current) => ({
      ...current,
      [artifact]: {
        ...current[artifact],
        ...patch,
      },
    }));
  }

  function applyPreset(name: "balanced" | "rollback-heavy" | "minimal") {
    if (name === "balanced") {
      setPolicy(DEFAULT_POLICY);
      return;
    }
    if (name === "rollback-heavy") {
      setPolicy({
        "project-host": { keep_count: 15, max_bytes: 2 * 1024 * 1024 * 1024 },
        "project-bundle": { keep_count: 5, max_bytes: 4 * 1024 * 1024 * 1024 },
        tools: { keep_count: 5, max_bytes: 2 * 1024 * 1024 * 1024 },
      });
      return;
    }
    setPolicy({
      "project-host": { keep_count: 6 },
      "project-bundle": { keep_count: 2 },
      tools: { keep_count: 2 },
    });
  }

  async function apply() {
    await onApply({
      project_hosts_runtime_retention_policy: serialized,
    });
    onClose();
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => void apply()}
      okText="Apply"
      width={860}
      title="Project Host Runtime Retention Policy Wizard"
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="This sets the durable control-plane default."
          description="Hosts still apply local environment overrides on top of this, and protected rollback/reference versions are never pruned even if a budget is exceeded."
        />
        <div>
          <Typography.Text strong>Presets</Typography.Text>
          <div
            style={{
              marginTop: "8px",
              display: "flex",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            <Button onClick={() => applyPreset("balanced")}>
              Balanced defaults
            </Button>
            <Button onClick={() => applyPreset("rollback-heavy")}>
              More rollback headroom
            </Button>
            <Button onClick={() => applyPreset("minimal")}>
              Tighter disk usage
            </Button>
          </div>
        </div>
        {ARTIFACTS.map((artifact) => (
          <div
            key={artifact.key}
            style={{
              border: "1px solid #e5e5e5",
              borderRadius: "8px",
              padding: "14px",
            }}
          >
            <Typography.Text strong>{artifact.label}</Typography.Text>
            <div
              style={{ color: "#666", marginTop: "4px", marginBottom: "10px" }}
            >
              {artifact.help}
            </div>
            <Row gutter={16}>
              <Col span={12}>
                <Typography.Text>Keep floor</Typography.Text>
                <div style={{ marginTop: "6px" }}>
                  <InputNumber
                    min={0}
                    precision={0}
                    style={{ width: "100%" }}
                    value={policy[artifact.key].keep_count}
                    onChange={(value) =>
                      updateArtifact(artifact.key, {
                        keep_count: parseNonNegativeInt(value) ?? 0,
                      })
                    }
                  />
                </div>
              </Col>
              <Col span={12}>
                <Typography.Text>Byte budget</Typography.Text>
                <div style={{ marginTop: "6px" }}>
                  <InputNumber
                    min={0}
                    precision={0}
                    style={{ width: "100%" }}
                    placeholder="optional"
                    value={policy[artifact.key].max_bytes}
                    onChange={(value) =>
                      updateArtifact(artifact.key, {
                        max_bytes: parseNonNegativeInt(value),
                      })
                    }
                  />
                </div>
                <div style={{ marginTop: "6px", color: "#666" }}>
                  Current: {formatBytes(policy[artifact.key].max_bytes)}
                </div>
              </Col>
            </Row>
          </div>
        ))}
        <Alert
          type="success"
          showIcon
          icon={<Icon name="code" />}
          title="JSON preview"
          description={
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: "240px",
                overflow: "auto",
              }}
            >
              {serialized}
            </pre>
          }
        />
      </Space>
    </Modal>
  );
}
