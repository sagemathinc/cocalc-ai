/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Checkbox,
  Input,
  Popconfirm,
  Space,
  Typography,
} from "antd";

import type {
  CopyProjectSecretsResult,
  GenerateProjectSshKeySecretResult,
  ProjectSecretMetadata,
} from "@cocalc/conat/hub/api/projects";
import {
  React,
  useIsMountedRef,
  useMemo,
  useState,
} from "@cocalc/frontend/app-framework";
import {
  ErrorDisplay,
  Gap,
  HelpIcon,
  SettingBox,
} from "@cocalc/frontend/components";
import { useProjectSecrets } from "@cocalc/frontend/project/use-project-secrets";
import { SelectProject } from "@cocalc/frontend/projects/select-project";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { humanSize } from "@cocalc/util/misc";
import {
  PROJECT_SECRETS_ENV,
  PROJECT_SECRETS_MAX_COUNT,
  PROJECT_SECRETS_MOUNT_PATH,
  PROJECT_SECRETS_SSH_PRIVATE_KEY_NAME,
  PROJECT_SECRETS_SSH_PRIVATE_KEY_PATH,
  PROJECT_SECRETS_SSH_PUBLIC_KEY_PATH,
  PROJECT_SECRET_NAME_MAX_LENGTH,
  PROJECT_SECRET_VALUE_MAX_BYTES,
} from "@cocalc/util/project-secrets-constants";
import { publishProjectDetailInvalidation } from "../use-project-field";

export const PROJECT_SECRETS_ICON = "key";

interface Props {
  project_id: string;
  mode?: "project" | "flyout";
}

const SECRET_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const SSH_PRIVATE_KEY_RE =
  /-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----[\s\S]*-----END (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----$/;

function formatDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return `${value}`;
  return date.toLocaleString();
}

function validateName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!SECRET_NAME_RE.test(trimmed)) {
    return `Invalid secret name. Use letters, numbers, '_', '.', or '-', up to ${PROJECT_SECRET_NAME_MAX_LENGTH} characters.`;
  }
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    return "Invalid secret name.";
  }
}

function secretPath(name: string): string {
  return `${PROJECT_SECRETS_MOUNT_PATH}/${name}`;
}

function sshPrivateKeyMissingFinalNewline(value: string): boolean {
  return SSH_PRIVATE_KEY_RE.test(value.trimEnd()) && !value.endsWith("\n");
}

function parseNames(value: string): string[] | undefined {
  const names = value
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) return undefined;
  return [...new Set(names)];
}

function upsertMetadata(
  secrets: ProjectSecretMetadata[] | null,
  metadata: ProjectSecretMetadata,
): ProjectSecretMetadata[] {
  const next = (secrets ?? []).filter(
    (secret) => secret.name !== metadata.name,
  );
  return [...next, metadata].sort((a, b) => a.name.localeCompare(b.name));
}

function removeMetadata(
  secrets: ProjectSecretMetadata[] | null,
  name: string,
): ProjectSecretMetadata[] {
  return (secrets ?? []).filter((secret) => secret.name !== name);
}

export const ProjectSecrets: React.FC<Props> = ({
  project_id,
  mode = "project",
}: Props) => {
  const isFlyout = mode === "flyout";
  const isMountedRef = useIsMountedRef();
  const { secrets, refresh, setSecrets } = useProjectSecrets(project_id);
  const sortedSecrets = useMemo(
    () => [...(secrets ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [secrets],
  );
  const [name, setName] = useState<string>("");
  const [value, setValue] = useState<string>("");
  const [sourceProjectId, setSourceProjectId] = useState<string>("");
  const [copyNames, setCopyNames] = useState<string>("");
  const [overwrite, setOverwrite] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [copyResult, setCopyResult] = useState<CopyProjectSecretsResult | null>(
    null,
  );
  const [sshKeyResult, setSshKeyResult] =
    useState<GenerateProjectSshKeySecretResult | null>(null);
  const [showRestartWarning, setShowRestartWarning] = useState<boolean>(false);

  const trimmedName = name.trim();
  const nameError = trimmedName ? validateName(trimmedName) : undefined;
  const valueBytes = new TextEncoder().encode(value).length;
  const valueTooLarge = valueBytes > PROJECT_SECRET_VALUE_MAX_BYTES;
  const countAtLimit =
    sortedSecrets.length >= PROJECT_SECRETS_MAX_COUNT &&
    !sortedSecrets.some((secret) => secret.name === trimmedName);
  const sshSecretExists = sortedSecrets.some(
    (secret) => secret.name === PROJECT_SECRETS_SSH_PRIVATE_KEY_NAME,
  );
  const sshNewlineWarning = sshPrivateKeyMissingFinalNewline(value);

  async function setSecret(): Promise<void> {
    if (!trimmedName) {
      setError("Secret name is required.");
      return;
    }
    if (nameError) {
      setError(nameError);
      return;
    }
    if (valueTooLarge) {
      setError(
        `Secret value is too large (${valueBytes}/${PROJECT_SECRET_VALUE_MAX_BYTES} bytes).`,
      );
      return;
    }
    if (countAtLimit) {
      setError(
        `This project already has ${PROJECT_SECRETS_MAX_COUNT} secrets.`,
      );
      return;
    }
    setSaving(true);
    setError("");
    setCopyResult(null);
    setSshKeyResult(null);
    try {
      const metadata =
        await webapp_client.conat_client.hub.projects.setProjectSecret({
          project_id,
          name: trimmedName,
          value,
        });
      if (!isMountedRef.current) return;
      setSecrets(upsertMetadata(secrets, metadata));
      setName("");
      setValue("");
      setShowRestartWarning(true);
      publishProjectDetailInvalidation({
        project_id,
        fields: ["secrets"],
      });
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(`${err}`);
    } finally {
      if (isMountedRef.current) {
        setSaving(false);
      }
    }
  }

  async function deleteSecret(secretName: string): Promise<void> {
    setSaving(true);
    setError("");
    setCopyResult(null);
    setSshKeyResult(null);
    try {
      const result =
        await webapp_client.conat_client.hub.projects.deleteProjectSecret({
          project_id,
          name: secretName,
        });
      if (!isMountedRef.current) return;
      if (result.deleted) {
        setSecrets(removeMetadata(secrets, secretName));
        setShowRestartWarning(true);
      }
      publishProjectDetailInvalidation({
        project_id,
        fields: ["secrets"],
      });
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(`${err}`);
    } finally {
      if (isMountedRef.current) {
        setSaving(false);
      }
    }
  }

  async function copySecrets(): Promise<void> {
    const source = sourceProjectId.trim();
    if (!source) {
      setError("Source project id is required.");
      return;
    }
    const names = parseNames(copyNames);
    for (const secretName of names ?? []) {
      const error = validateName(secretName);
      if (error) {
        setError(`Invalid copied secret name "${secretName}".`);
        return;
      }
    }
    setSaving(true);
    setError("");
    setCopyResult(null);
    setSshKeyResult(null);
    try {
      const result =
        await webapp_client.conat_client.hub.projects.copyProjectSecrets({
          source_project_id: source,
          target_project_id: project_id,
          names,
          overwrite,
        });
      if (!isMountedRef.current) return;
      setCopyResult(result);
      if (result.copied.length > 0) {
        const nextSecrets =
          await webapp_client.conat_client.hub.projects.listProjectSecrets({
            project_id,
          });
        if (!isMountedRef.current) return;
        setSecrets(nextSecrets);
        setShowRestartWarning(true);
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(`${err}`);
    } finally {
      if (isMountedRef.current) {
        setSaving(false);
      }
    }
  }

  async function generateSshKeySecret(): Promise<void> {
    if (sshSecretExists) {
      setError(
        `Project secret ${PROJECT_SECRETS_SSH_PRIVATE_KEY_NAME} already exists.`,
      );
      return;
    }
    if (sortedSecrets.length >= PROJECT_SECRETS_MAX_COUNT) {
      setError(
        `This project already has ${PROJECT_SECRETS_MAX_COUNT} secrets.`,
      );
      return;
    }
    setSaving(true);
    setError("");
    setCopyResult(null);
    setSshKeyResult(null);
    try {
      const result =
        await webapp_client.conat_client.hub.projects.generateProjectSshKeySecret(
          {
            project_id,
          },
        );
      if (!isMountedRef.current) return;
      setSecrets(upsertMetadata(secrets, result.secret));
      setSshKeyResult(result);
      setShowRestartWarning(result.restart_required);
      publishProjectDetailInvalidation({
        project_id,
        fields: ["secrets"],
      });
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(`${err}`);
    } finally {
      if (isMountedRef.current) {
        setSaving(false);
      }
    }
  }

  const help = (
    <HelpIcon title="Project Secrets" placement="right" maxWidth="540px">
      <p style={{ marginTop: 0 }}>
        Project secrets are encrypted at rest and mounted as read-only files at{" "}
        <code>{PROJECT_SECRETS_MOUNT_PATH}/&lt;name&gt;</code>. They are not
        stored in project files, backups, rootfs images, downloads, or public
        shares.
      </p>
      <p style={{ marginBottom: 0 }}>
        Any code or collaborator with access to the running project can read
        these files. Use the environment variable{" "}
        <code>{PROJECT_SECRETS_ENV}</code> in scripts instead of hardcoding the
        directory.
      </p>
      <p style={{ marginBottom: 0 }}>
        SSH private keys usually need a final newline. If you paste one
        manually, use the warning below to add the newline before saving.
      </p>
    </HelpIcon>
  );

  const title = <>Project Secrets {help}</>;

  function renderRows(): React.JSX.Element {
    if (sortedSecrets.length === 0) {
      return (
        <Typography.Text type="secondary">
          No project secrets are configured.
        </Typography.Text>
      );
    }
    return (
      <Space direction="vertical" style={{ width: "100%" }} size={8}>
        {sortedSecrets.map((secret) => (
          <div
            key={secret.name}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(120px, 1fr) minmax(180px, 2fr) auto",
              gap: "8px",
              alignItems: "center",
            }}
          >
            <div>
              <Typography.Text strong>{secret.name}</Typography.Text>
              <br />
              <Typography.Text type="secondary">
                {humanSize(secret.value_bytes)}
              </Typography.Text>
            </div>
            <div>
              <Typography.Text code>{secretPath(secret.name)}</Typography.Text>
              <br />
              <Typography.Text type="secondary">
                Updated {formatDate(secret.updated_at)}
              </Typography.Text>
            </div>
            <Popconfirm
              title={`Delete secret "${secret.name}"?`}
              okText="Delete"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteSecret(secret.name)}
            >
              <Button disabled={saving} danger>
                Delete
              </Button>
            </Popconfirm>
          </div>
        ))}
      </Space>
    );
  }

  function renderCopyResult(): React.JSX.Element | undefined {
    if (!copyResult) return;
    const hasProblems =
      copyResult.conflicts.length > 0 || copyResult.missing.length > 0;
    return (
      <Alert
        banner
        showIcon
        type={copyResult.copied.length > 0 ? "success" : "warning"}
        message={`Copied: ${copyResult.copied.length}; conflicts: ${copyResult.conflicts.length}; missing: ${copyResult.missing.length}`}
        description={
          hasProblems ? (
            <>
              {copyResult.conflicts.length > 0 ? (
                <div>Conflicts: {copyResult.conflicts.join(", ")}</div>
              ) : undefined}
              {copyResult.missing.length > 0 ? (
                <div>Missing: {copyResult.missing.join(", ")}</div>
              ) : undefined}
            </>
          ) : undefined
        }
      />
    );
  }

  function renderSshKeyResult(): React.JSX.Element | undefined {
    if (!sshKeyResult) return;
    return (
      <Alert
        banner
        showIcon
        type={sshKeyResult.setup.ok ? "success" : "warning"}
        message={
          sshKeyResult.setup.ok
            ? "Generated SSH deploy key secret."
            : "Generated SSH deploy key secret, but project file setup needs attention."
        }
        description={
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Text>
              Private key secret:{" "}
              <Typography.Text code>
                {secretPath(sshKeyResult.secret_name)}
              </Typography.Text>
            </Typography.Text>
            <Typography.Text>
              Project SSH files:{" "}
              <Typography.Text code>
                {sshKeyResult.setup.private_key_path}
              </Typography.Text>{" "}
              and{" "}
              <Typography.Text code>
                {sshKeyResult.setup.public_key_path}
              </Typography.Text>
            </Typography.Text>
            {!sshKeyResult.setup.ok ? (
              <Typography.Text type="warning">
                Setup error: {sshKeyResult.setup.error}
              </Typography.Text>
            ) : undefined}
            <div>
              <Typography.Text strong>
                Public key to add to GitHub/GitLab:
              </Typography.Text>
              <Input.TextArea
                readOnly
                value={sshKeyResult.public_key}
                autoSize={{ minRows: 2, maxRows: 4 }}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          </Space>
        }
      />
    );
  }

  function renderBody(): React.JSX.Element {
    return (
      <div style={{ padding: "10px" }}>
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          {isFlyout ? (
            <Typography.Text strong>{title}</Typography.Text>
          ) : undefined}
          {error ? <ErrorDisplay banner error={error} /> : undefined}
          {nameError ? <ErrorDisplay banner error={nameError} /> : undefined}
          {valueTooLarge ? (
            <ErrorDisplay
              banner
              error={`Secret value is too large (${valueBytes}/${PROJECT_SECRET_VALUE_MAX_BYTES} bytes).`}
            />
          ) : undefined}
          {countAtLimit ? (
            <Alert
              banner
              showIcon
              type="warning"
              message={`This project already has ${PROJECT_SECRETS_MAX_COUNT} secrets. Delete one before adding another.`}
            />
          ) : undefined}
          <div>
            <Typography.Text strong>
              Secrets ({sortedSecrets.length}/{PROJECT_SECRETS_MAX_COUNT})
            </Typography.Text>
            <Gap />
            <Button disabled={saving} onClick={refresh}>
              Refresh
            </Button>
          </div>
          {renderRows()}
          <div>
            <Typography.Text strong>Set or Replace a Secret</Typography.Text>
            <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
              <Input
                disabled={saving}
                placeholder="SECRET_NAME"
                value={name}
                maxLength={PROJECT_SECRET_NAME_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
              />
              <Input.TextArea
                disabled={saving}
                placeholder="Secret value. Existing values are never shown here."
                value={value}
                autoSize={{ minRows: 3, maxRows: 8 }}
                onChange={(event) => setValue(event.target.value)}
              />
              {sshNewlineWarning ? (
                <Alert
                  banner
                  showIcon
                  type="warning"
                  message="This looks like an SSH private key and does not end with a newline. Some SSH libraries reject that."
                  action={
                    <Button size="small" onClick={() => setValue(`${value}\n`)}>
                      Add newline
                    </Button>
                  }
                />
              ) : undefined}
              <Button
                type="primary"
                disabled={
                  saving || !trimmedName || !!nameError || valueTooLarge
                }
                onClick={setSecret}
              >
                {saving ? "Saving..." : "Set Secret"}
              </Button>
            </Space>
          </div>
          <div>
            <Typography.Text strong>Generate SSH Deploy Key</Typography.Text>
            <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
              <Typography.Text type="secondary">
                Creates a new ed25519 keypair, stores the private key as{" "}
                <Typography.Text code>
                  {PROJECT_SECRETS_SSH_PRIVATE_KEY_NAME}
                </Typography.Text>
                , writes{" "}
                <Typography.Text code>
                  {PROJECT_SECRETS_SSH_PUBLIC_KEY_PATH}
                </Typography.Text>
                , and creates{" "}
                <Typography.Text code>
                  {PROJECT_SECRETS_SSH_PRIVATE_KEY_PATH}
                </Typography.Text>{" "}
                as a symlink to the mounted secret. This refuses to continue if{" "}
                <Typography.Text code>
                  {PROJECT_SECRETS_SSH_PRIVATE_KEY_PATH}
                </Typography.Text>{" "}
                already exists.
              </Typography.Text>
              <Button
                disabled={
                  saving ||
                  sshSecretExists ||
                  sortedSecrets.length >= PROJECT_SECRETS_MAX_COUNT
                }
                onClick={generateSshKeySecret}
              >
                Generate SSH Key Secret
              </Button>
              {sshSecretExists ? (
                <Typography.Text type="secondary">
                  {PROJECT_SECRETS_SSH_PRIVATE_KEY_NAME} already exists.
                </Typography.Text>
              ) : undefined}
              {renderSshKeyResult()}
            </Space>
          </div>
          <div>
            <Typography.Text strong>
              Copy Secrets from Another Project
            </Typography.Text>
            <Space direction="vertical" style={{ width: "100%", marginTop: 8 }}>
              <SelectProject
                exclude={[project_id]}
                value={sourceProjectId || undefined}
                onChange={(sourceProjectId) =>
                  setSourceProjectId(sourceProjectId ?? "")
                }
                style={{ width: "100%" }}
              />
              <Input
                disabled={saving}
                placeholder="Optional names to copy, separated by commas or spaces. Leave blank to copy all."
                value={copyNames}
                onChange={(event) => setCopyNames(event.target.value)}
              />
              <Checkbox
                disabled={saving}
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
              >
                Overwrite existing secrets with the same names
              </Checkbox>
              <Button
                disabled={saving || !sourceProjectId.trim()}
                onClick={copySecrets}
              >
                Copy Secrets
              </Button>
              {renderCopyResult()}
            </Space>
          </div>
          {showRestartWarning ? (
            <Alert
              banner
              showIcon
              type="warning"
              message="Restart this project for mounted secret file changes to take effect."
            />
          ) : undefined}
        </Space>
      </div>
    );
  }

  if (isFlyout) {
    return renderBody();
  }

  return (
    <SettingBox title={title} icon={PROJECT_SECRETS_ICON}>
      {renderBody()}
    </SettingBox>
  );
};
