/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useProjectSecrets } from "@cocalc/frontend/project/use-project-secrets";
import { publishProjectDetailInvalidation } from "@cocalc/frontend/project/use-project-field";
import { PROJECT_SECRET_VALUE_MAX_BYTES } from "@cocalc/util/project-secrets-constants";

const SECRET_NAME = "ANTHROPIC_API_KEY";

export function ClaudeProjectSecretModal({
  open,
  onClose,
  projectId,
  warning,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  warning: string;
}) {
  const { secrets, refresh, setSecrets } = useProjectSecrets(projectId);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const configured = secrets?.some((secret) => secret.name === SECRET_NAME);
  const valueBytes = new TextEncoder().encode(value).length;

  useEffect(() => {
    if (!open) return;
    setValue("");
    setError("");
    refresh();
  }, [open, refresh]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const { runtime_refresh: _runtimeRefresh, ...metadata } =
        await webapp_client.conat_client.hub.projects.setProjectSecret({
          project_id: projectId,
          name: SECRET_NAME,
          value,
        });
      setSecrets(
        [
          ...(secrets ?? []).filter((secret) => secret.name !== SECRET_NAME),
          metadata,
        ].sort((a, b) => a.name.localeCompare(b.name)),
      );
      publishProjectDetailInvalidation({
        project_id: projectId,
        fields: ["secrets"],
      });
      setValue("");
      onClose();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      aria-label="Claude Code project API key"
      title="Claude Code project API key"
      open={open}
      onCancel={onClose}
      destroyOnHidden
      footer={null}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Alert type="warning" showIcon message={warning} />
        <Typography.Text>
          {configured
            ? "ANTHROPIC_API_KEY is configured. Enter a new key to replace it; the existing value cannot be displayed."
            : "Set ANTHROPIC_API_KEY for this project. The key is not stored in this chat."}
        </Typography.Text>
        <label htmlFor="claude-project-api-key">ANTHROPIC_API_KEY</label>
        <Input.Password
          id="claude-project-api-key"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          aria-invalid={!!error || valueBytes > PROJECT_SECRET_VALUE_MAX_BYTES}
        />
        {valueBytes > PROJECT_SECRET_VALUE_MAX_BYTES && (
          <Alert
            type="error"
            message="API key exceeds the project secret size limit."
          />
        )}
        {error && <Alert type="error" message={error} role="alert" />}
        <Space>
          <Button
            type="primary"
            loading={saving}
            disabled={!value || valueBytes > PROJECT_SECRET_VALUE_MAX_BYTES}
            onClick={() => void save()}
          >
            {configured ? "Replace key" : "Save key"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </Space>
      </Space>
    </Modal>
  );
}
