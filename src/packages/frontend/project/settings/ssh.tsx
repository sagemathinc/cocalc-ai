/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Modal, Space, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import SSHKeyList from "@cocalc/frontend/account/ssh-keys/ssh-key-list";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { A, CopyToClipBoard, Tooltip } from "@cocalc/frontend/components";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { CopyToClipboard } from "react-copy-to-clipboard";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { Project } from "./types";
import { lite } from "@cocalc/frontend/lite";

const { Text, Paragraph } = Typography;
const COCALC_CLI_DOWNLOAD_URL =
  "https://software.cocalc.ai/software/cocalc/index.html";
const COCALC_CLI_INSTALL_COMMAND =
  "curl -fsSL https://software.cocalc.ai/software/cocalc/install.sh | bash";
const SETUP_KEY_EXPIRE_MS = 60 * 60 * 1000;

interface Props {
  project: Project;
  account_id?: string;
  mode?: "project" | "flyout";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function SSHPanel({ project, mode = "project" }: Props) {
  const intl = useIntl();
  const projectLabelLower = intl.formatMessage(labels.project).toLowerCase();
  const hostInfo = useHostInfo(project.get("host_id"));
  const isLaunchpadSite = useTypedRedux("customize", "is_launchpad");
  const launchpadMode = useTypedRedux("customize", "launchpad_mode");
  const isLaunchpad = !!isLaunchpadSite || !!launchpadMode;
  const projectId = project.get("project_id") as string;
  const sshServer = hostInfo?.get?.("ssh_server");
  const localProxy = !!hostInfo?.get?.("local_proxy");
  const useCliSsh = localProxy || isLaunchpad;
  const [sshCopied, setSshCopied] = useState(false);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | undefined>();
  const [setupApiKey, setSetupApiKey] = useState<string | undefined>();
  const copyTimeoutRef = useRef<number | null>(null);

  const ssh_keys = project.getIn([
    "users",
    webapp_client.account_id as string,
    "ssh_keys",
  ]);
  const sshInfo = (() => {
    if (typeof sshServer !== "string") return null;
    const trimmed = sshServer.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("[")) {
      const match = trimmed.match(/^\[(.*)\]:(\d+)$/);
      if (match) {
        return { host: match[1], port: match[2] };
      }
      return { host: trimmed };
    }
    const match = trimmed.match(/^(.*):(\d+)$/);
    if (match) {
      return { host: match[1], port: match[2] };
    }
    return { host: trimmed };
  })();
  const sshCommand =
    sshInfo && sshInfo.host
      ? sshInfo.port
        ? `ssh -p ${sshInfo.port} ${projectId}@${sshInfo.host}`
        : `ssh ${projectId}@${sshInfo.host}`
      : null;
  const apiUrl =
    typeof window === "undefined" ? "<hub-url>" : window.location.origin;
  const setupCommand = setupApiKey
    ? `COCALC_API_KEY=${shellQuote(setupApiKey)} cocalc --api ${shellQuote(apiUrl)} project ssh-config add -w ${shellQuote(projectId)}`
    : "";
  const connectCommand = `ssh ${shellQuote(projectId)}`;

  useEffect(() => {
    setSshCopied(false);
    if (copyTimeoutRef.current != null) {
      window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
  }, [sshCommand]);

  if (lite) {
    return null;
  }

  const handleCopy = () => {
    setSshCopied(true);
    if (copyTimeoutRef.current != null) {
      window.clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = window.setTimeout(() => {
      setSshCopied(false);
      copyTimeoutRef.current = null;
    }, 1200);
  };

  const createSshSetupKey = async () => {
    setSetupModalOpen(true);
    if (setupApiKey || setupLoading) return;
    setSetupError(undefined);
    setSetupLoading(true);
    try {
      const title = project.get("title") || project.get("name") || projectId;
      const response = await webapp_client.account_client.api_keys({
        action: "create",
        name: `SSH setup for ${title}`,
        expire: new Date(Date.now() + SETUP_KEY_EXPIRE_MS),
      });
      const secret = response?.[0]?.secret;
      if (!secret) {
        throw Error("failed to create account API key");
      }
      setSetupApiKey(secret);
    } catch (err) {
      setSetupError(`${err}`);
    } finally {
      setSetupLoading(false);
    }
  };

  return (
    <SSHKeyList
      ssh_keys={ssh_keys}
      project_id={project.get("project_id")}
      mode={mode}
    >
      <>
        {!useCliSsh && (
          <p>
            To SSH to your {projectLabelLower} add your public key below, or{" "}
            <Button
              type="link"
              onClick={() => {
                redux
                  .getProjectActions(project.get("project_id"))
                  .open_file({ path: ".ssh/authorized_keys" });
              }}
            >
              add your key to ~/.ssh/authorized_keys
            </Button>
          </p>
        )}
        <Paragraph>
          SSH access is full OpenSSH access to this {projectLabelLower},
          including remote commands, port forwarding, and X11 forwarding when
          your local SSH setup supports them. If the {projectLabelLower} is not
          running, SSH access will request that it starts; if your first attempt
          only wakes it up, try the same command again after a moment.
        </Paragraph>
        {useCliSsh ? (
          <>
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Paragraph style={{ marginBottom: 0 }}>
                Launchpad SSH is routed through Cloudflare. Use the{" "}
                <A href={COCALC_CLI_DOWNLOAD_URL}>CoCalc CLI</A> to configure a
                standard <Text code>~/.ssh/config</Text> entry for this{" "}
                {projectLabelLower}.
              </Paragraph>
              <div>
                <Text strong>1. Install CoCalc CLI</Text>
                <CopyToClipBoard
                  value={COCALC_CLI_INSTALL_COMMAND}
                  inputWidth="100%"
                  style={{ marginTop: 6 }}
                />
              </div>
              <div>
                <Text strong>
                  2. Configure SSH for this {projectLabelLower}
                </Text>
                <div style={{ marginTop: 6 }}>
                  <Button
                    type="primary"
                    loading={setupLoading}
                    onClick={createSshSetupKey}
                  >
                    Generate setup command
                  </Button>
                </div>
              </div>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                The setup command creates a one-hour account API key, creates or
                reuses your local SSH key, installs the public key in this{" "}
                {projectLabelLower}, and writes the SSH route to{" "}
                <Text code>~/.ssh/config</Text>. The API key is not stored in
                your SSH config.
              </Paragraph>
            </Space>
            <Modal
              open={setupModalOpen}
              title="Set up SSH for this project"
              onCancel={() => setSetupModalOpen(false)}
              footer={
                <Button onClick={() => setSetupModalOpen(false)}>Close</Button>
              }
              width={760}
            >
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Paragraph style={{ marginBottom: 0 }}>
                  Run this once in your terminal. It uses a temporary one-hour
                  account API key to install SSH access for this{" "}
                  {projectLabelLower}.
                </Paragraph>
                {setupError && (
                  <Alert
                    type="error"
                    showIcon
                    message="Unable to create setup command"
                    description={setupError}
                  />
                )}
                {setupLoading && (
                  <Alert
                    type="info"
                    showIcon
                    message="Creating a one-hour account API key..."
                  />
                )}
                {setupCommand && (
                  <>
                    <div>
                      <Text strong>Configure SSH</Text>
                      <CopyToClipBoard
                        value={setupCommand}
                        inputWidth="100%"
                        style={{ marginTop: 6 }}
                      />
                    </div>
                    <div>
                      <Text strong>Connect</Text>
                      <CopyToClipBoard
                        value={connectCommand}
                        inputWidth="100%"
                        style={{ marginTop: 6 }}
                      />
                    </div>
                    <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                      Existing SSH access keeps working after this API key
                      expires because SSH uses the installed public key and the
                      generated <Text code>~/.ssh/config</Text> entry.
                    </Paragraph>
                  </>
                )}
              </Space>
            </Modal>
          </>
        ) : sshCommand ? (
          <>
            <p>{localProxy ? "SSH target (via hub):" : "SSH target:"}</p>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 6,
                marginBottom: 4,
              }}
            >
              <CopyButton value={sshCommand} size="small" />
              <CopyToClipboard text={sshCommand} onCopy={handleCopy}>
                <Tooltip title="Copied!" open={sshCopied}>
                  <Text
                    code
                    style={{
                      fontSize: "13pt",
                      padding: "6px 8px",
                      flex: 1,
                      wordBreak: "break-all",
                      cursor: "pointer",
                    }}
                  >
                    {sshCommand}
                  </Text>
                </Tooltip>
              </CopyToClipboard>
            </div>
          </>
        ) : null}
      </>
    </SSHKeyList>
  );
}
