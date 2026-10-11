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
import { COCALC_CLI_DOWNLOAD_URL } from "@cocalc/util/consts/ui";
import { Project } from "./types";
import { lite } from "@cocalc/frontend/lite";
import { ProjectToProjectSsh } from "./project-to-project-ssh";
import { DocsLink } from "@cocalc/frontend/docs/link";
import { InstallCocalcCli } from "@cocalc/frontend/components/install-cocalc-cli";

const { Text, Paragraph } = Typography;
const COPYABLE_PROPS = {
  inputWidth: "100%",
  inputStyle: { minWidth: 0 },
  outerStyle: { width: "100%" },
  style: { marginTop: 6, width: "100%" },
} as const;

interface Props {
  project: Project;
  account_id?: string;
  mode?: "project" | "flyout";
  embedded?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function SSHPanel({
  project,
  mode = "project",
  embedded = false,
}: Props) {
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
  const cliLoginCommand = `cocalc --api ${shellQuote(apiUrl)} auth login`;
  const setupCommand = `cocalc --api ${shellQuote(apiUrl)} project ssh-config add -w ${shellQuote(projectId)}`;
  const connectCommand = `ssh ${projectId}`;
  const scpUploadCommand = `scp ./local-file ${projectId}:~/`;
  const scpDownloadCommand = `scp ${projectId}:~/remote-file ./`;

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

  return (
    <SSHKeyList
      ssh_keys={ssh_keys}
      project_id={project.get("project_id")}
      mode={mode}
      allowAdd={!useCliSsh}
      title={useCliSsh ? "SSH" : undefined}
      embedded={embedded}
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
        {!useCliSsh && (
          <Paragraph>
            SSH access is full access to this {projectLabelLower}, including
            remote commands, port forwarding, and X11 forwarding when your local
            SSH setup supports them. If the {projectLabelLower} is not running,
            SSH access will request that it starts; if your first attempt only
            wakes it up, try the same command again after a moment.
          </Paragraph>
        )}
        {useCliSsh ? (
          <>
            <Space vertical size={12} style={{ width: "100%" }}>
              <Alert
                type="info"
                showIcon
                title={
                  <>
                    Launchpad SSH is routed through Cloudflare. Install the{" "}
                    <A href={COCALC_CLI_DOWNLOAD_URL}>CoCalc CLI</A> once, then
                    sign in and configure SSH for this {projectLabelLower}.
                  </>
                }
                description={
                  <DocsLink
                    href="/docs/terminal/ssh-access"
                    slug="terminal/ssh-access"
                  >
                    Read the SSH access guide
                  </DocsLink>
                }
              />
              <InstallCocalcCli />
              <div>
                <Text strong>Set up SSH for this {projectLabelLower}</Text>
                <div style={{ marginTop: 6 }}>
                  <Button
                    type="primary"
                    onClick={() => setSetupModalOpen(true)}
                  >
                    Show setup commands
                  </Button>
                </div>
              </div>
              <details>
                <summary style={{ cursor: "pointer" }}>
                  <Text strong>Need scp or sftp help?</Text>
                </summary>
                <Space
                  vertical
                  size={12}
                  style={{ marginTop: 12, width: "100%" }}
                >
                  <Paragraph style={{ marginBottom: 0 }}>
                    After setup, <Text code>scp</Text> and{" "}
                    <Text code>sftp</Text> use the same SSH config entry as{" "}
                    <Text code>ssh</Text>.
                  </Paragraph>
                  <div>
                    <Text strong>Upload a file</Text>
                    <CopyToClipBoard
                      value={scpUploadCommand}
                      {...COPYABLE_PROPS}
                    />
                  </div>
                  <div>
                    <Text strong>Download a file</Text>
                    <CopyToClipBoard
                      value={scpDownloadCommand}
                      {...COPYABLE_PROPS}
                    />
                  </div>
                  <Alert
                    type="warning"
                    showIcon
                    title="If scp or sftp fails because the project image lacks the SFTP server"
                    description={
                      <>
                        Install <Text code>openssh-sftp-server</Text> in the
                        image, for example{" "}
                        <Text code>
                          apt-get update; apt-get install -y openssh-sftp-server
                          && mkdir -p /usr/libexec && ln -sf
                          /usr/lib/openssh/sftp-server /usr/libexec/sftp-server
                        </Text>
                        .
                      </>
                    }
                  />
                </Space>
              </details>
              <div>
                <Text strong>Connect from another CoCalc project</Text>
                <Paragraph type="secondary" style={{ margin: "4px 0 8px" }}>
                  Authorize a dedicated deploy key without signing your CoCalc
                  account into the source project.
                </Paragraph>
                <ProjectToProjectSsh target_project_id={projectId} />
              </div>
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
              <Space vertical size={12} style={{ width: "100%" }}>
                <Paragraph style={{ marginBottom: 0 }}>
                  Run these commands in your terminal. First sign the CoCalc CLI
                  into this site using your browser, then configure SSH for this{" "}
                  {projectLabelLower}. The setup command installs or reuses your
                  local SSH key and writes the route to{" "}
                  <Text code>~/.ssh/config</Text>.
                </Paragraph>
                <div>
                  <Text strong>Sign in to the CoCalc CLI</Text>
                  <CopyToClipBoard
                    value={cliLoginCommand}
                    {...COPYABLE_PROPS}
                  />
                </div>
                <div>
                  <Text strong>Configure SSH</Text>
                  <CopyToClipBoard value={setupCommand} {...COPYABLE_PROPS} />
                </div>
                <div>
                  <Text strong>Connect</Text>
                  <CopyToClipBoard value={connectCommand} {...COPYABLE_PROPS} />
                </div>
                <div>
                  <Text strong>Copy files with scp</Text>
                  <CopyToClipBoard
                    value={scpUploadCommand}
                    {...COPYABLE_PROPS}
                  />
                  <CopyToClipBoard
                    value={scpDownloadCommand}
                    {...COPYABLE_PROPS}
                  />
                </div>
                <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  If you have already signed in to this site with the CoCalc
                  CLI, you can skip the login command. SSH keeps working after
                  setup because it uses your installed public key and the
                  generated <Text code>~/.ssh/config</Text> entry.
                </Paragraph>
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
